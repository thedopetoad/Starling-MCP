// src/control/portfolio.ts
// Read-only portfolio snapshot for the dashboard: per-wallet balances (USDC +
// native gas), Hyperliquid account value + open perp positions + unrealized PnL,
// and aggregate totals. Pure reads against public RPC + the HL info endpoint;
// every read is best-effort (returns 0 / null + a `partial` flag on failure) so a
// flaky RPC never crashes the heartbeat. Polled on a SLOW timer (see server.ts)
// and cached — never on the 1.5s control tick.
//
// Honest scope (v1, Analytics is a stated WIP):
//   - USDC is valued at $1. Hyperliquid accountValue is already USD.
//   - Native SOL/MATIC are reported as AMOUNTS (gas), left unpriced (usd:null).
//   - Positions: Hyperliquid perps (enumerable via clearinghouseState). Polymarket
//     and Jupiter positions need per-market ids to enumerate and are deferred.
import { EvmRpc } from "../adapters/evm-rpc.js";
import { SolanaRpc } from "../adapters/solana-rpc.js";
import { USDC_MINT } from "../adapters/jupiter.js";
import { usdcOn } from "../bridge/debridge.js";
import { infoPost, HL_MAINNET, HL_TESTNET } from "../adapters/hl-transport.js";
import type { Chain } from "../adapters/types.js";

export interface PortfolioPosition {
  venue: string;
  marketId: string;
  side: "buy" | "sell";
  size: string;
  entryPrice: string;
  valueUsd: number;
  unrealizedPnlUsd: number;
}

export interface WalletState {
  chain: Chain;
  address: string;
  /** Native gas token (SOL / MATIC). Unpriced in v1 — usd is null. */
  native: { symbol: string; amount: number; usd: number | null };
  /** USDC balance (valued 1:1). */
  usdc: number;
  /** USD value attributable to this wallet (USDC + venue account value). */
  valueUsd: number;
  /** True if any read for this wallet failed and the numbers may be incomplete. */
  partial: boolean;
}

export interface Portfolio {
  ts: string;
  wallets: WalletState[];
  positions: PortfolioPosition[];
  totalValueUsd: number;
  unrealizedPnlUsd: number;
  /** v1 pricing caveat surfaced to the UI. */
  pricingNote: string;
  /** True if ANY read failed (the dashboard can show a "stale/partial" hint). */
  partial: boolean;
}

type Addrs = Partial<Record<Chain, string>>;

/** Per-read timeout so one stalled endpoint (the public Solana RPC is notorious)
 *  can't hang the whole refresh. Rejects after `ms` so the caller's catch marks
 *  the wallet partial and moves on. */
const READ_TIMEOUT_MS = 8_000;
function timed<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${READ_TIMEOUT_MS}ms`)), READ_TIMEOUT_MS).unref(),
    ),
  ]);
}

/** erc20 balanceOf(owner) via eth_call; returns decimal token units. 0 on error. */
async function erc20Balance(rpc: EvmRpc, token: string, owner: string, decimals: number): Promise<number> {
  const data = "0x70a08231" + owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const hex = await rpc.callReadonly({ from: owner, to: token, data });
  const raw = BigInt(hex && hex !== "0x" ? hex : "0x0");
  return Number(raw) / 10 ** decimals;
}

async function readSolana(address: string): Promise<WalletState> {
  const rpc = new SolanaRpc();
  let sol = 0,
    usdc = 0,
    partial = false;
  try {
    sol = Number(await timed(rpc.getBalanceLamports(address), "sol getBalance")) / 1e9;
  } catch {
    partial = true;
  }
  try {
    const t = await timed(rpc.getTokenBalance(address, USDC_MINT), "sol USDC");
    usdc = t?.uiAmount ?? 0;
  } catch {
    partial = true;
  }
  return {
    chain: "solana",
    address,
    native: { symbol: "SOL", amount: sol, usd: null },
    usdc,
    valueUsd: usdc,
    partial,
  };
}

async function readPolygon(address: string): Promise<WalletState> {
  const rpc = new EvmRpc({ net: "polygon" });
  let matic = 0,
    usdc = 0,
    partial = false;
  try {
    matic = Number(await timed(rpc.getBalanceWei(address), "polygon native")) / 1e18;
  } catch {
    partial = true;
  }
  try {
    usdc = await timed(erc20Balance(rpc, usdcOn("polygon"), address, 6), "polygon USDC");
  } catch {
    partial = true;
  }
  return {
    chain: "polygon",
    address,
    native: { symbol: "MATIC", amount: matic, usd: null },
    usdc,
    valueUsd: usdc,
    partial,
  };
}

/** Hyperliquid: perp account value + USDC + open perp positions, via the info API. */
async function readHyperliquid(
  address: string,
  host: string,
): Promise<{ wallet: WalletState; positions: PortfolioPosition[] }> {
  let accountValue = 0,
    spotUsdc = 0,
    unrealized = 0,
    partial = false;
  const positions: PortfolioPosition[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = await timed(infoPost<any>({ type: "clearinghouseState", user: address }, { host }), "hl perp");
    accountValue = Number(cs?.marginSummary?.accountValue ?? 0);
    for (const ap of cs?.assetPositions ?? []) {
      const p = ap?.position;
      const szi = Number(p?.szi ?? 0);
      if (!szi) continue;
      const pnl = Number(p?.unrealizedPnl ?? 0);
      unrealized += pnl;
      positions.push({
        venue: "hyperliquid",
        marketId: `hl:${String(p?.coin)}`,
        side: szi > 0 ? "buy" : "sell",
        size: String(Math.abs(szi)),
        entryPrice: String(p?.entryPx ?? "0"),
        valueUsd: Number(p?.positionValue ?? 0),
        unrealizedPnlUsd: pnl,
      });
    }
  } catch {
    partial = true;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ss = await timed(infoPost<any>({ type: "spotClearinghouseState", user: address }, { host }), "hl spot");
    const b = (ss?.balances ?? []).find((x: { coin?: string }) => String(x?.coin).toUpperCase() === "USDC");
    spotUsdc = Number(b?.total ?? 0);
  } catch {
    partial = true;
  }
  return {
    wallet: {
      chain: "hyperliquid",
      address,
      native: { symbol: "USDC", amount: 0, usd: null },
      usdc: spotUsdc,
      valueUsd: accountValue + spotUsdc,
      partial,
    },
    positions,
  };
}

/**
 * Read the full portfolio for the loaded addresses. `network` selects the HL info
 * host (EVM/Solana RPC use their mainnet defaults). Best-effort: never throws.
 */
export async function readPortfolio(addrs: Addrs, network: string): Promise<Portfolio> {
  const hlHost = network === "mainnet" ? HL_MAINNET : HL_TESTNET;
  const wallets: WalletState[] = [];
  const positions: PortfolioPosition[] = [];

  const jobs: Promise<void>[] = [];
  if (addrs.solana) jobs.push(readSolana(addrs.solana).then((w) => void wallets.push(w)));
  if (addrs.polygon) jobs.push(readPolygon(addrs.polygon).then((w) => void wallets.push(w)));
  if (addrs.hyperliquid)
    jobs.push(
      readHyperliquid(addrs.hyperliquid, hlHost).then((r) => {
        wallets.push(r.wallet);
        positions.push(...r.positions);
      }),
    );
  await Promise.all(jobs);

  // Stable chain order for the UI.
  const order: Chain[] = ["solana", "polygon", "hyperliquid"];
  wallets.sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));

  const totalValueUsd = wallets.reduce((s, w) => s + w.valueUsd, 0);
  const unrealizedPnlUsd = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const partial = wallets.some((w) => w.partial);

  return {
    ts: new Date().toISOString(),
    wallets,
    positions,
    totalValueUsd,
    unrealizedPnlUsd,
    pricingNote: "USDC=$1, HL=accountValue USD; native SOL/MATIC unpriced (gas); PM/Jupiter positions WIP",
    partial,
  };
}
