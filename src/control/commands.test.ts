// src/control/commands.test.ts — unit tests for the dashboard command runner.
// Fully injected deps (run/portfolio/treasury/newKey) so nothing touches network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeCommandRunner,
  closeWorstPrice,
  type CommandDeps,
  type ToolResult,
} from "./commands.js";
import type { Portfolio } from "./portfolio.js";

function pf(over: Partial<Portfolio> = {}): Portfolio {
  return {
    ts: "2026-01-01T00:00:00Z",
    wallets: [],
    positions: [],
    totalValueUsd: 0,
    unrealizedPnlUsd: 0,
    pricingNote: "",
    partial: false,
    ...over,
  };
}

function deps(over: Partial<CommandDeps> & { calls?: Array<[string, Record<string, unknown>]> } = {}): CommandDeps {
  const calls = over.calls ?? [];
  return {
    execute: false,
    portfolio: async () => pf(),
    treasury: () => ({ polygon: "0xabc", solana: "Sol111", hyperliquid: "0xabc" }),
    run: async (name, args): Promise<ToolResult> => {
      calls.push([name, args]);
      return { ok: true };
    },
    newKey: () => "k1",
    ...over,
  };
}

// ── closeWorstPrice ───────────────────────────────────────────────────────────
test("closeWorstPrice: long closes below mark, short above", () => {
  // long: size 2, value 200 => mark 100 => sell floor = 98
  assert.equal(closeWorstPrice("buy", "2", 200), String(100 * 0.98));
  // short: mark 100 => buy ceiling = 102
  assert.equal(closeWorstPrice("sell", "2", 200), String(100 * 1.02));
});
test("closeWorstPrice: null when no mark derivable", () => {
  assert.equal(closeWorstPrice("buy", "0", 200), null);
  assert.equal(closeWorstPrice("buy", "2", 0), null);
});

// ── close_all ─────────────────────────────────────────────────────────────────
test("close_all dry-run lists positions and executes nothing", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    calls,
    portfolio: async () => pf({ positions: [
      { venue: "hyperliquid", marketId: "hl:BTC", side: "buy", size: "1", entryPrice: "60000", valueUsd: 61000, unrealizedPnlUsd: 1000 },
    ] }),
  }));
  const r = await run("close_all", {});
  assert.equal(r.status, "ok");
  assert.equal(r.dryRun, true);
  assert.match(r.message, /\[dry-run\].*hl:BTC/);
  assert.equal(calls.length, 0, "dry-run must not call any tool");
});

test("close_all flat => ok, nothing to close", async () => {
  const r = await makeCommandRunner(deps())("close_all", {});
  assert.equal(r.status, "ok");
  assert.match(r.message, /flat/);
});

test("close_all armed closes each position via close_position", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    execute: true,
    calls,
    portfolio: async () => pf({ positions: [
      { venue: "hyperliquid", marketId: "hl:BTC", side: "buy", size: "1", entryPrice: "60000", valueUsd: 61000, unrealizedPnlUsd: 0 },
      { venue: "hyperliquid", marketId: "hl:ETH", side: "sell", size: "10", entryPrice: "3000", valueUsd: 29000, unrealizedPnlUsd: 0 },
    ] }),
  }));
  const r = await run("close_all", {});
  assert.equal(r.status, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "close_position");
  assert.equal(calls[0][1].marketId, "hl:BTC");
  assert.equal(calls[0][1].fraction, "1");
  assert.ok(calls[0][1].worstPrice, "must pass a worstPrice");
});

test("close_all with marketIds only closes the selected subset", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    execute: true,
    calls,
    portfolio: async () => pf({ positions: [
      { venue: "hyperliquid", marketId: "hl:BTC", side: "buy", size: "1", entryPrice: "1", valueUsd: 100, unrealizedPnlUsd: 0 },
      { venue: "hyperliquid", marketId: "hl:ETH", side: "buy", size: "1", entryPrice: "1", valueUsd: 100, unrealizedPnlUsd: 0 },
    ] }),
  }));
  const r = await run("close_all", { marketIds: ["hl:ETH"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].marketId, "hl:ETH");
  assert.equal(r.status, "ok");
});

// ── withdraw (per chain) ──────────────────────────────────────────────────────
test("withdraw dry-run reports plan, executes nothing", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    calls,
    portfolio: async () => pf({ wallets: [
      { chain: "polygon", address: "0x1", native: { symbol: "MATIC", amount: 0, usd: null }, usdc: 50, valueUsd: 50, partial: false },
    ] }),
  }));
  const r = await run("withdraw", { mode: "per_chain", chain: "polygon" });
  assert.equal(r.status, "ok");
  assert.equal(r.dryRun, true);
  assert.match(r.message, /50\.00 USDC on polygon/);
  assert.equal(calls.length, 0);
});

test("withdraw refuses when no destination pinned", async () => {
  const run = makeCommandRunner(deps({
    treasury: () => ({}),
    portfolio: async () => pf({ wallets: [
      { chain: "polygon", address: "0x1", native: { symbol: "MATIC", amount: 0, usd: null }, usdc: 50, valueUsd: 50, partial: false },
    ] }),
  }));
  const r = await run("withdraw", { mode: "per_chain", chain: "polygon" });
  assert.equal(r.status, "error");
  assert.match(r.message, /no withdraw destination/);
});

test("withdraw with zero balance does nothing", async () => {
  const r = await makeCommandRunner(deps())("withdraw", { mode: "per_chain", chain: "polygon" });
  assert.equal(r.status, "ok");
  assert.match(r.message, /nothing to withdraw/);
});

test("withdraw armed on polygon resolves+reserves and reports broadcast NOT wired", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    execute: true,
    calls,
    portfolio: async () => pf({ wallets: [
      { chain: "polygon", address: "0x1", native: { symbol: "MATIC", amount: 0, usd: null }, usdc: 50, valueUsd: 50, partial: false },
    ] }),
  }));
  const r = await run("withdraw", { mode: "per_chain", chain: "polygon" });
  assert.equal(calls[0][0], "build_withdraw");
  assert.equal(r.status, "in_progress");
  assert.match(r.message, /wired/);
});

test("withdraw solana dry-run describes a USDC+SOL sweep", async () => {
  const run = makeCommandRunner(deps({
    portfolio: async () => pf({ wallets: [
      { chain: "solana", address: "S1", native: { symbol: "SOL", amount: 0.2, usd: 30 }, usdc: 5, valueUsd: 35, partial: false },
    ] }),
  }));
  const r = await run("withdraw", { mode: "per_chain", chain: "solana" });
  assert.equal(r.status, "ok");
  assert.equal(r.dryRun, true);
  assert.match(r.message, /sweep the solana wallet/);
});

test("withdraw solana armed calls withdraw_local (the executing sweep)", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    execute: true, calls,
    portfolio: async () => pf({ wallets: [
      { chain: "solana", address: "S1", native: { symbol: "SOL", amount: 0.2, usd: 30 }, usdc: 5, valueUsd: 35, partial: false },
    ] }),
  }));
  const r = await run("withdraw", { mode: "per_chain", chain: "solana" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "withdraw_local");
  assert.equal(calls[0][1].chain, "solana");
  assert.equal(r.status, "ok");
});

// ── consolidate ───────────────────────────────────────────────────────────────
test("consolidate dry-run lists the plan, executes nothing", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    calls,
    portfolio: async () => pf({ wallets: [
      { chain: "polygon", address: "0x1", native: { symbol: "MATIC", amount: 0, usd: null }, usdc: 40, valueUsd: 40, partial: false },
      { chain: "solana", address: "S1", native: { symbol: "SOL", amount: 0, usd: null }, usdc: 0, valueUsd: 0, partial: false },
    ] }),
  }));
  const r = await run("withdraw", { mode: "consolidate", toChain: "solana" });
  assert.equal(r.status, "ok");
  assert.equal(r.dryRun, true);
  assert.match(r.message, /bridge 40\.00 USDC polygon → solana/);
  assert.equal(calls.length, 0);
});

test("consolidate armed closes then transfers each funded source", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = makeCommandRunner(deps({
    execute: true,
    calls,
    portfolio: async () => pf({
      positions: [{ venue: "hyperliquid", marketId: "hl:BTC", side: "buy", size: "1", entryPrice: "1", valueUsd: 100, unrealizedPnlUsd: 0 }],
      wallets: [
        { chain: "polygon", address: "0x1", native: { symbol: "MATIC", amount: 0, usd: null }, usdc: 40, valueUsd: 40, partial: false },
        { chain: "solana", address: "S1", native: { symbol: "SOL", amount: 0, usd: null }, usdc: 0, valueUsd: 0, partial: false },
      ],
    }),
  }));
  const r = await run("withdraw", { mode: "consolidate", toChain: "solana" });
  assert.equal(r.status, "in_progress");
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes("close_position"), "should close positions first");
  assert.ok(names.includes("withdraw_bridge"), "should bridge funded sources to the withdrawal wallet");
  const xfer = calls.find((c) => c[0] === "withdraw_bridge");
  assert.equal(xfer?.[1].fromChain, "polygon");
  assert.equal(xfer?.[1].toChain, "solana");
});

// ── unknown action ────────────────────────────────────────────────────────────
test("unknown action returns error", async () => {
  const r = await makeCommandRunner(deps())("frobnicate", {});
  assert.equal(r.status, "error");
});
