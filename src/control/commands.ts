// src/control/commands.ts
// Executes the money-moving commands the dashboard queues (close_all / withdraw /
// consolidate) by driving the SAME tool handlers the agent uses. The drain in
// plane.ts handles halt/resume itself and delegates these to the runner built here.
//
// SAFETY: every command is DRY-RUN unless `execute` is true (set by
// STARLING_DASHBOARD_EXECUTE=true). A dry run reports the PLAN and moves nothing;
// only an armed run calls the executing tool path. This mirrors scripts/live.mjs
// being DRY by default — a button click can't fire a real mainnet money move until
// the operator deliberately arms it.
//
// Fully dependency-injected (run / portfolio / treasury / newKey) so the logic is
// unit-tested with no network — see commands.test.ts.
import type { Portfolio } from "./portfolio.js";
import type { Chain } from "../adapters/types.js";
import { murmurNav, murmurDeploy, murmurClose, murmurCashout } from "./murmur.js";

/** Parsed result of a tool call (handleMoneyTool's JSON), or a fake in tests. */
export interface ToolResult {
  ok?: boolean;
  state?: string;
  note?: string;
  error?: string;
  [k: string]: unknown;
}

export interface CommandResult {
  status: "ok" | "error" | "in_progress";
  message: string;
  [k: string]: unknown;
}

export interface CommandDeps {
  /** Armed? false => dry-run (plan only, no execution). */
  execute: boolean;
  /** Current portfolio snapshot (positions + per-wallet balances). */
  portfolio: () => Promise<Portfolio>;
  /** Pinned withdraw destinations per chain (for messaging / preconditions). */
  treasury: () => Partial<Record<Chain, string>>;
  /** Run a money tool by name (server binds this to handleMoneyTool + real deps). */
  run: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** Fresh idempotency key per money move. */
  newKey: () => string;
}

const ARM_HINT = "Set STARLING_DASHBOARD_EXECUTE=true on the MCP to arm real execution.";
const CLOSE_SLIPPAGE = 0.02; // 2% protective bound for a market-ish close

/** Worst acceptable close price from the position's mark + a protective slippage.
 *  Closing a long => we SELL, so the floor is mark*(1-slip); a short => we BUY, so
 *  the ceiling is mark*(1+slip). Returns null if we can't derive a mark. */
export function closeWorstPrice(side: string, sizeStr: string, valueUsd: number): string | null {
  const size = Math.abs(Number(sizeStr));
  if (!(size > 0) || !(valueUsd > 0)) return null;
  const mark = valueUsd / size;
  const worst = side === "buy" ? mark * (1 - CLOSE_SLIPPAGE) : mark * (1 + CLOSE_SLIPPAGE);
  return String(worst);
}

/** Close all open positions, or just the ones whose marketId is in args.marketIds. */
export async function closeAll(d: CommandDeps, args: Record<string, unknown>): Promise<CommandResult> {
  const pf = await d.portfolio();
  let positions = pf.positions;
  const sel = Array.isArray(args.marketIds)
    ? new Set((args.marketIds as unknown[]).filter((x): x is string => typeof x === "string"))
    : null;
  if (sel) positions = positions.filter((p) => sel.has(p.marketId));

  if (!positions.length) {
    return { status: "ok", message: sel ? "none of the selected positions are open" : "flat — no open positions to close" };
  }
  const ids = positions.map((p) => p.marketId);
  if (!d.execute) {
    return { status: "ok", dryRun: true, count: ids.length,
      message: `[dry-run] would close ${ids.length} position(s): ${ids.join(", ")}. ${ARM_HINT}` };
  }

  const results: Array<{ marketId: string; ok: boolean; note?: string }> = [];
  for (const p of positions) {
    const worst = closeWorstPrice(p.side, p.size, p.valueUsd);
    if (worst === null) {
      results.push({ marketId: p.marketId, ok: false, note: "no mark price — skipped" });
      continue;
    }
    const r = await d.run("close_position", {
      venue: p.venue, marketId: p.marketId, fraction: "1",
      worstPrice: worst, slippageFrac: CLOSE_SLIPPAGE, idempotencyKey: d.newKey(),
    });
    results.push({ marketId: p.marketId, ok: r.ok !== false && r.error === undefined, note: r.note ?? r.error });
  }
  const okN = results.filter((r) => r.ok).length;
  return {
    status: okN === results.length ? "ok" : okN > 0 ? "ok" : "error",
    message: `closed ${okN}/${results.length} position(s)`,
    results,
  };
}

/** Withdraw one chain's free USDC to its pinned destination (HL: to your own
 *  Arbitrum address — HL's native off-ramp pins the recipient to the owner). */
export async function withdrawChain(d: CommandDeps, args: Record<string, unknown>): Promise<CommandResult> {
  const chain = String(args.chain || "") as Chain;
  if (!["polygon", "hyperliquid", "solana"].includes(chain)) {
    return { status: "error", message: `unknown chain ${chain}` };
  }
  const dest = d.treasury()[chain];
  if (chain !== "hyperliquid" && !dest) {
    return { status: "error", message: `no withdraw destination set for ${chain} — pin one on the Wallet States page first` };
  }
  const pf = await d.portfolio();
  const w = pf.wallets.find((x) => x.chain === chain);
  const usdc = w ? w.usdc : 0;
  const nativeAmt = w?.native?.amount ?? 0;

  // Solana: a REAL same-chain sweep (USDC + SOL) via withdraw_local — executes.
  if (chain === "solana") {
    if (usdc < 0.001 && nativeAmt < 0.0002) {
      return { status: "ok", message: "nothing to withdraw on solana (only unspendable dust below the network fee)" };
    }
    if (!d.execute) {
      return { status: "ok", dryRun: true,
        message: `[dry-run] would sweep the solana wallet (~${usdc.toFixed(2)} USDC + ${nativeAmt.toFixed(4)} SOL minus fee) -> ${dest}. ${ARM_HINT}` };
    }
    const r = await d.run("withdraw_local", { chain: "solana", idempotencyKey: d.newKey() });
    return { status: r.ok !== false && r.error === undefined ? "ok" : "error",
      message: (r.note as string) ?? r.error ?? "solana withdraw submitted", result: r };
  }

  // Hyperliquid / Polygon via build_withdraw (HL executes to your Arbitrum address;
  // the EVM same-chain sweep broadcast is the next piece after Solana).
  if (usdc <= 0.01) {
    return { status: "ok", message: `nothing to withdraw on ${chain} (USDC ${usdc.toFixed(2)})` };
  }
  const where = chain === "hyperliquid" ? "your own Arbitrum address (HL native off-ramp)" : dest;
  if (!d.execute) {
    return { status: "ok", dryRun: true,
      message: `[dry-run] would withdraw ${usdc.toFixed(2)} USDC on ${chain} -> ${where}. ${ARM_HINT}` };
  }
  const r = await d.run("build_withdraw", { chain, amount: String(usdc), idempotencyKey: d.newKey() });
  if (chain === "hyperliquid") {
    return { status: r.ok ? "ok" : "error",
      message: r.ok ? `HL withdraw submitted: ${usdc.toFixed(2)} USDC -> your Arbitrum address (~5 min, $1 fee)`
                    : `HL withdraw failed: ${r.error ?? r.note ?? "unknown"}`, result: r };
  }
  return { status: "in_progress",
    message: `withdraw on ${chain} resolved to ${dest} and reserved. NOTE: the on-chain ${chain} sweep ` +
      `broadcast isn't wired yet (solana is; EVM next), so funds have NOT moved.`,
    result: r };
}

/** Consolidate every chain's USDC onto one chain, then sweep to its destination.
 *  Armed: closes positions, then fires a cross-chain transfer per source chain
 *  (these DO broadcast). Bridges take minutes, so the final sweep on the target is
 *  left as a follow-up the operator runs once funds land. */
export async function consolidate(d: CommandDeps, args: Record<string, unknown>): Promise<CommandResult> {
  const to = String(args.toChain || "") as Chain;
  if (!["polygon", "hyperliquid", "solana"].includes(to)) {
    return { status: "error", message: `unknown toChain ${to}` };
  }
  const dest = d.treasury()[to];
  if (to !== "hyperliquid" && !dest) {
    return { status: "error", message: `set a ${to} withdraw destination first (Wallet States page)` };
  }
  const pf = await d.portfolio();
  const sources = pf.wallets.filter((w) => w.chain !== to && w.usdc > 0.01);
  const plan = [
    `close ${pf.positions.length} open position(s)`,
    ...sources.map((s) => `bridge ${s.usdc.toFixed(2)} USDC ${s.chain} → ${to}`),
    `sweep on ${to} → ${dest ?? "your own address"}`,
  ];

  if (!d.execute) {
    return { status: "ok", dryRun: true,
      message: `[dry-run] consolidate to ${to}:\n- ${plan.join("\n- ")}\n${ARM_HINT} ` +
        "Cross-chain bridges take minutes — validate on testnet before arming." };
  }

  await closeAll(d, {});
  const moves: Array<{ from: string; ok: boolean; flightId?: unknown; note?: string }> = [];
  for (const s of sources) {
    // Bridge OUT, delivering straight to the pinned withdrawal wallet on `to`.
    const r = await d.run("withdraw_bridge", { fromChain: s.chain, toChain: to, amount: String(s.usdc), idempotencyKey: d.newKey() });
    const okMove = r.ok !== false && r.error === undefined;
    // Kick the flight along once — deBridge self-delivers; CCTP mints once attested.
    if (okMove && r.flightId && r.provider) {
      try { await d.run("advance_bridge", { provider: r.provider, flightId: r.flightId }); } catch { /* advance again later */ }
    }
    moves.push({ from: s.chain, ok: okMove, flightId: r.flightId, note: (r.note as string) ?? r.error });
  }
  const onTarget = pf.wallets.find((w) => w.chain === to && w.usdc > 0.01);
  const okN = moves.filter((m) => m.ok).length;
  return {
    status: okN > 0 || moves.length === 0 ? "in_progress" : "error",
    message:
      `consolidate to ${to}: positions closed; broadcast ${okN}/${moves.length} cross-chain withdraw(s) → ${dest ?? "your address"}. ` +
      `deBridge routes deliver in a few minutes; CCTP routes auto-advance.` +
      (onTarget ? ` NOTE: ${onTarget.usdc.toFixed(2)} USDC is already on ${to} — that needs a same-chain sweep (not yet wired).` : ""),
    moves,
  };
}

/** The runner plane.ts calls for non-halt/resume actions. */
export type CommandRunner = (action: string, args: Record<string, unknown>) => Promise<CommandResult>;

export function makeCommandRunner(d: CommandDeps): CommandRunner {
  return async (action, args) => {
    try {
      if (action === "close_all") return await closeAll(d, args);
      if (action === "withdraw") {
        return (args.mode === "consolidate") ? await consolidate(d, args) : await withdrawChain(d, args);
      }
      if (action === "murmur_nav") return await murmurNav(d, args);
      if (action === "murmur_deploy") return await murmurDeploy(d, args);
      if (action === "murmur_close") return await murmurClose(d, args);
      if (action === "murmur_cashout") return await murmurCashout(d, args);
      return { status: "error", message: `unsupported action ${action}` };
    } catch (e) {
      return { status: "error", message: (e as Error)?.message ?? "command failed" };
    }
  };
}
