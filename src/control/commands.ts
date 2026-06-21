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
  const pf = await d.portfolio();
  const w = pf.wallets.find((x) => x.chain === chain);
  const usdc = w ? w.usdc : 0;
  const dest = d.treasury()[chain];

  if (chain !== "hyperliquid" && !dest) {
    return { status: "error", message: `no withdraw destination set for ${chain} — pin one on the Wallet States page first` };
  }
  if (usdc <= 0.01) {
    return { status: "ok", message: `nothing to withdraw on ${chain} (USDC ${usdc.toFixed(2)})` };
  }
  const where = chain === "hyperliquid" ? "your own Arbitrum address (HL native off-ramp)" : dest;
  if (!d.execute) {
    return { status: "ok", dryRun: true,
      message: `[dry-run] would withdraw ${usdc.toFixed(2)} USDC on ${chain} → ${where}. ${ARM_HINT}` };
  }

  const r = await d.run("build_withdraw", { chain, amount: String(usdc), idempotencyKey: d.newKey() });
  if (chain === "hyperliquid") {
    return { status: r.ok ? "ok" : "error",
      message: r.ok ? `HL withdraw submitted: ${usdc.toFixed(2)} USDC → your Arbitrum address (~5 min, $1 fee)`
                    : `HL withdraw failed: ${r.error ?? r.note ?? "unknown"}`, result: r };
  }
  // polygon/solana: build_withdraw resolves the treasury + reserves the intent, but
  // the on-chain ERC-20/SPL sweep broadcast is NOT wired in this MCP build yet —
  // report that honestly rather than implying funds moved.
  return { status: "in_progress",
    message: `withdraw on ${chain} resolved to ${dest} and reserved. NOTE: the on-chain ${chain} sweep ` +
      `broadcast isn't wired in this MCP build yet, so funds have NOT moved. (Tracked for a later release.)`,
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
  const moves: Array<{ from: string; ok: boolean; note?: string }> = [];
  for (const s of sources) {
    const r = await d.run("transfer", { fromChain: s.chain, toChain: to, amount: String(s.usdc), idempotencyKey: d.newKey() });
    moves.push({ from: s.chain, ok: r.ok !== false && r.error === undefined, note: r.note ?? r.error });
  }
  return { status: "in_progress",
    message: `consolidation to ${to} started: positions closed + ${moves.length} cross-chain transfer(s) sent. ` +
      `Bridges take several minutes; once funds land on ${to}, run "withdraw ${to}" to sweep to ${dest ?? "your address"}.`,
    moves };
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
      return { status: "error", message: `unsupported action ${action}` };
    } catch (e) {
      return { status: "error", message: (e as Error)?.message ?? "command failed" };
    }
  };
}
