// src/control/murmur.ts
// Murmur fund control-plane actions — the mechanical (NO-LLM) trading layer the
// PolyNews website drives via the Neon command queue → the runner → these.
//
//   murmur_nav     read-only: pool NAV = Σ(position mark) + idle pUSD + loose USDC
//   murmur_deploy  buy each open position pro-rata to its weight with N pUSD
//   murmur_close   sell floor(size·num/den) of each position; pay REALIZED proceeds
//
// All three are DRY-RUN unless d.execute (STARLING_DASHBOARD_EXECUTE=true) — same
// gate as close_all/withdraw. They place NO market orders: every order carries a
// worst-price bound (the adapter's invariant). The poi risk gate is NOT involved
// (it only sizes the LLM's thesis trades); these just scale/unwind what the model
// already opened.
//
// WHY balance-delta for realized (not the order's notional): a FAK close fills at
// the book, not the mark, and settles on-chain async. The honest "realized
// proceeds for this redemption" is the pUSD that actually lands on the deposit
// wallet — so we snapshot pUSD before, close, wait for settlement, and diff. The
// runner processes commands serially, so no concurrent move pollutes the delta.
import type { CommandDeps, CommandResult } from "./commands.js";
import { loadedAddresses } from "../signers/index.js";
import { EvmRpc } from "../adapters/evm-rpc.js";
import { deriveDepositWalletUUPS } from "../adapters/polymarket-deposit-wallet.js";
import { fetchPositions, type DataApiPosition } from "../adapters/polymarket-transport.js";
import { PUSD, USDC_NATIVE, CLOB_HOST } from "../adapters/polymarket-constants.js";
import { encodeFunctionData, decodeFunctionResult, erc20Abi, type Hex } from "viem";

const SLIP = 0.02; // 2% protective bound on every order
const ARM = "Set STARLING_DASHBOARD_EXECUTE=true on the MCP to arm real execution.";

// pUSD / USDC are 6dp. Wire amounts are 6dp base-unit strings.
const toBase = (n: number): bigint => BigInt(Math.round(n * 1e6));
const fromBase = (b: bigint): number => Number(b) / 1e6;

async function erc20Bal(rpc: EvmRpc, token: string, who: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [who as Hex] });
  const res = await rpc.callReadonly({ from: who, to: token, data });
  if (!res || res === "0x") return 0n;
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: res as Hex }) as bigint;
}

const markOf = (p: DataApiPosition): number => p.curPrice ?? p.avgPrice ?? 0;
const valueOf = (p: DataApiPosition): number => Math.abs(p.size) * markOf(p);

interface Book {
  eoa: string;
  depositWallet: string;
  positions: DataApiPosition[]; // open, non-resolved, size>0
  idlePusd: bigint; // 6dp on the deposit wallet
  looseUsdc: bigint; // 6dp native USDC on the EOA (not yet wrapped to pUSD)
  rpc: EvmRpc;
}

async function readBook(): Promise<Book> {
  const eoa = loadedAddresses().polygon;
  if (!eoa) throw new Error("no polygon signer loaded — cannot read the pool book");
  const depositWallet = deriveDepositWalletUUPS(eoa as Hex);
  const rpc = new EvmRpc({ net: "polygon" });
  const all = await fetchPositions(depositWallet);
  const positions = all.filter((p) => !p.redeemable && Math.abs(p.size) > 0);
  const [idlePusd, looseUsdc] = await Promise.all([
    erc20Bal(rpc, PUSD, depositWallet),
    erc20Bal(rpc, USDC_NATIVE, eoa),
  ]);
  return { eoa, depositWallet, positions, idlePusd, looseUsdc, rpc };
}

/** Poll the deposit wallet's pUSD until it stops changing (settlement landed) or
 *  the timeout. FAK fills settle on Polygon in a few seconds. */
async function waitPusdSettle(rpc: EvmRpc, dw: string, tries = 12, gapMs = 3000): Promise<bigint> {
  let last = await erc20Bal(rpc, PUSD, dw);
  let stable = 0;
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, gapMs));
    const cur = await erc20Bal(rpc, PUSD, dw);
    if (cur === last) {
      if (++stable >= 1) return cur; // two equal reads in a row → settled
    } else {
      stable = 0;
      last = cur;
    }
  }
  return last;
}

// ── murmur_nav ────────────────────────────────────────────────────────────────
export async function murmurNav(_d: CommandDeps, _args: Record<string, unknown>): Promise<CommandResult> {
  const b = await readBook();
  const posVal = b.positions.reduce((s, p) => s + valueOf(p), 0);
  const navUsd = posVal + fromBase(b.idlePusd) + fromBase(b.looseUsdc);
  return {
    status: "ok",
    message: `NAV $${navUsd.toFixed(4)} = positions $${posVal.toFixed(2)} (${b.positions.length}) + idle pUSD $${fromBase(b.idlePusd).toFixed(2)} + USDC $${fromBase(b.looseUsdc).toFixed(2)}`,
    navBaseUsdc: toBase(navUsd).toString(),
    positions: b.positions.map((p) => ({ marketId: `pm:${p.asset}`, size: p.size, curPrice: p.curPrice, valueUsd: valueOf(p) })),
    idlePusdBase: b.idlePusd.toString(),
    looseUsdcBase: b.looseUsdc.toString(),
    depositWallet: b.depositWallet,
  };
}

// ── murmur_deploy ───────────────────────────────────────────────────────────────
export async function murmurDeploy(d: CommandDeps, args: Record<string, unknown>): Promise<CommandResult> {
  const amountBase = BigInt(String(args.amountUsdc ?? args.reservedUsdc ?? "0"));
  if (amountBase <= 0n) return { status: "ok", message: "nothing to deploy", deployedUsdc: "0" };
  const b = await readBook();
  const priced = b.positions.filter((p) => markOf(p) > 0);
  if (priced.length === 0) {
    return { status: "ok", message: "book empty / unpriced — funds stay in the accumulator for next cycle", deployedUsdc: "0" };
  }
  const weights = priced.map((p) => toBase(valueOf(p)));
  const totalW = weights.reduce((s, w) => s + w, 0n);
  if (totalW <= 0n) return { status: "ok", message: "positions have no mark value; deferring", deployedUsdc: "0" };

  if (!d.execute) {
    return { status: "ok", dryRun: true, deployedUsdc: "0",
      message: `[dry-run] would deploy $${fromBase(amountBase).toFixed(2)} across ${priced.length} position(s) pro-rata. ${ARM}` };
  }

  // Integer pro-rata; last priced leg absorbs the remainder so Σ === amountBase.
  let remaining = amountBase;
  let deployed = 0n;
  const legs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < priced.length; i++) {
    const p = priced[i];
    const alloc = i === priced.length - 1 ? remaining : (amountBase * weights[i]) / totalW;
    remaining -= alloc;
    if (alloc <= 0n) continue;
    const mark = markOf(p);
    const worst = Math.min(0.999, mark * (1 + SLIP)).toFixed(4);
    const r = await d.run("open_position", {
      venue: "polymarket", marketId: `pm:${p.asset}`, side: "buy",
      amount: fromBase(alloc).toFixed(6), amountKind: "collateral",
      worstPrice: worst, slippageFrac: SLIP, idempotencyKey: d.newKey(),
    });
    const ok = r.ok !== false && r.error === undefined && r.state !== "FAILED";
    if (ok) deployed += alloc;
    legs.push({ marketId: `pm:${p.asset}`, ok, allocUsd: fromBase(alloc), note: r.note ?? r.error });
  }
  return {
    status: deployed > 0n ? "ok" : "error",
    message: `deployed $${fromBase(deployed).toFixed(2)} / $${fromBase(amountBase).toFixed(2)} across ${legs.length} leg(s)`,
    deployedUsdc: deployed.toString(), legs,
  };
}

// ── murmur_close ────────────────────────────────────────────────────────────────
export async function murmurClose(d: CommandDeps, args: Record<string, unknown>): Promise<CommandResult> {
  const num = BigInt(String(args.fractionNum ?? "0"));
  const den = BigInt(String(args.fractionDen ?? "0"));
  if (num <= 0n || den <= 0n || num > den) return { status: "error", message: `bad fraction ${num}/${den}` };
  const fraction = Number(num) / Number(den);
  const b = await readBook();

  // The redeemer's slice of the still-idle pUSD is simply freed (no trade).
  const idleSlice = (b.idlePusd * num) / den;

  if (!d.execute) {
    const est = b.positions.reduce((s, p) => s + valueOf(p) * fraction, 0);
    return { status: "ok", dryRun: true,
      realizedProceedsUsdc: toBase(est + fromBase(idleSlice)).toString(),
      message: `[dry-run] would close ${(fraction * 100).toFixed(3)}% of ${b.positions.length} position(s) (~$${est.toFixed(2)}) + idle slice $${fromBase(idleSlice).toFixed(2)}. ${ARM}` };
  }

  const p0 = b.idlePusd; // pUSD before any close
  const legs: Array<Record<string, unknown>> = [];
  const residual: string[] = [];
  for (const p of b.positions) {
    const mark = markOf(p);
    if (!(mark > 0)) { residual.push(`pm:${p.asset}`); continue; }
    const worst = Math.max(0.001, mark * (1 - SLIP)).toFixed(4);
    const r = await d.run("close_position", {
      venue: "polymarket", marketId: `pm:${p.asset}`, fraction: fraction.toFixed(9),
      worstPrice: worst, slippageFrac: SLIP, idempotencyKey: d.newKey(),
    });
    const ok = r.ok !== false && r.error === undefined && r.state !== "FAILED";
    if (!ok) residual.push(`pm:${p.asset}`);
    legs.push({ marketId: `pm:${p.asset}`, ok, note: r.note ?? r.error });
  }

  // Realized = (pUSD that landed from the sells) + the redeemer's idle slice.
  const p1 = await waitPusdSettle(b.rpc, b.depositWallet);
  const positionProceeds = p1 > p0 ? p1 - p0 : 0n;
  const realized = positionProceeds + idleSlice;
  const okN = legs.filter((l) => l.ok).length;
  return {
    status: residual.length === 0 ? "ok" : "in_progress",
    message: `closed ${okN}/${legs.length} leg(s); realized $${fromBase(realized).toFixed(2)} (sells $${fromBase(positionProceeds).toFixed(2)} + idle $${fromBase(idleSlice).toFixed(2)})${residual.length ? `; RESIDUAL (retry/redeem): ${residual.join(", ")}` : ""}`,
    realizedProceedsUsdc: realized.toString(),
    legs, residual,
  };
}

// ── murmur_cashout ──────────────────────────────────────────────────────────────
// Bring realized pUSD → USDC to the OPERATOR so it can pay the user. Uses the
// native PM bridge (pm_withdraw), whose recipient is the SEALED TREASURY — pin
// the polygon treasury to the operator wallet. This is the security chokepoint:
// the trading key can only ever send funds to the pinned operator, never an
// arbitrary address. The operator (the runner) then transfers the payout to the
// user. DRY-RUN unless armed.
export async function murmurCashout(d: CommandDeps, args: Record<string, unknown>): Promise<CommandResult> {
  const amountBase = BigInt(String(args.amountUsdc ?? "0"));
  if (amountBase <= 0n) return { status: "ok", message: "nothing to cash out", cashedOutUsdc: "0" };
  const amount = fromBase(amountBase).toFixed(6);
  if (!d.execute) {
    return { status: "ok", dryRun: true, cashedOutUsdc: "0",
      message: `[dry-run] would pm_withdraw $${amount} pUSD→USDC to the pinned treasury (operator). ${ARM}` };
  }
  // Snapshot the deposit wallet's pUSD before, so we can reconcile a relayer
  // false-negative (waitMined timing out while the transfer actually lands).
  const eoa = loadedAddresses().polygon;
  const dw = eoa ? deriveDepositWalletUUPS(eoa as Hex) : null;
  const rpc = new EvmRpc({ net: "polygon" });
  const before = dw ? await erc20Bal(rpc, PUSD, dw) : 0n;

  const r = await d.run("pm_withdraw", { toChain: "polygon", amount, idempotencyKey: d.newKey() });
  if (r.ok !== false && r.error === undefined) {
    return { status: "ok", message: `cashed out $${amount} to the operator treasury`, cashedOutUsdc: amountBase.toString(), txHash: r.txHash as string | undefined };
  }

  // Relayer reported failure — VERIFY on-chain before trusting it. The gasless
  // relayer's waitMined often times out though the pUSD transfer mined; poll the
  // dw balance and treat a real ~`amount` drop as success (no double-cashout).
  if (dw) {
    for (let i = 0; i < 12; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      const after = await erc20Bal(rpc, PUSD, dw);
      if (before - after >= (amountBase * 99n) / 100n) {
        return {
          status: "ok",
          message: `relayer reported '${r.error ?? r.note}' but the deposit wallet pUSD dropped $${fromBase(before - after).toFixed(2)} on-chain — cashout LANDED`,
          cashedOutUsdc: amountBase.toString(),
          reconciled: true,
        };
      }
    }
  }
  return { status: "error", message: `cashout failed: ${r.error ?? r.note ?? "unknown"}`, cashedOutUsdc: "0" };
}

// ── murmur_open ─────────────────────────────────────────────────────────────────
// Open (or add to) a specific Polymarket position with N pUSD of collateral.
// This is the admin/seed path — the LLM normally PICKS markets through the poi
// gate; this lets the operator deterministically direct pool capital into a
// market (e.g. to seed a drill or rebalance). Fetches the live ask for a bounded
// worst price. DRY-RUN unless armed.
export async function murmurOpen(d: CommandDeps, args: Record<string, unknown>): Promise<CommandResult> {
  const tokenId = String(args.marketId ?? "").replace(/^pm:/, "");
  const amountBase = BigInt(String(args.amountUsdc ?? "0"));
  if (!tokenId || amountBase <= 0n) return { status: "error", message: "need marketId + amountUsdc>0" };
  const amount = fromBase(amountBase).toFixed(6);

  let price = 0;
  try {
    const res = await fetch(`${CLOB_HOST}/price?token_id=${encodeURIComponent(tokenId)}&side=buy`);
    const j = (await res.json()) as { price?: string | number };
    price = Number(j.price ?? 0);
  } catch { /* leave price 0 -> error below */ }
  if (!(price > 0 && price < 1)) return { status: "error", message: `could not fetch a valid ask for ${tokenId} (got ${price})` };
  const worst = Math.min(0.999, price * (1 + SLIP)).toFixed(4);

  if (!d.execute) {
    return { status: "ok", dryRun: true, message: `[dry-run] would open $${amount} in pm:${tokenId} at ~${price} (worst ${worst}). ${ARM}` };
  }
  const r = await d.run("open_position", {
    venue: "polymarket", marketId: `pm:${tokenId}`, side: "buy",
    amount, amountKind: "collateral", worstPrice: worst, slippageFrac: SLIP, idempotencyKey: d.newKey(),
  });
  const ok = r.ok !== false && r.error === undefined && r.state !== "FAILED";
  return {
    status: ok ? "ok" : "error",
    message: ok ? `opened $${amount} in pm:${tokenId} at worst ${worst}` : `open failed: ${r.error ?? r.note ?? "unknown"}`,
    marketId: `pm:${tokenId}`, notionalUsd: r.notionalUsd, txState: r.state,
  };
}
