// src/tools/execute-offchain.test.ts
// Proves the OFF-CHAIN execution paths actually FIRE through the tool surface
// (not just build), so a cold agent driving the tools completes the lifecycle:
//   - close_position POSTs the signed close via adapter.submit (like open).
//   - build_withdraw(chain="hyperliquid") EXECUTES the native HL withdraw via the
//     adapter, and NEVER re-posts on a replayed key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMoneyTool, type ToolDeps } from "./index.js";
import { makeIntentStore, makeReconciler, makeGasPlanner, makeFundingPlanner } from "./deps.js";
import { makeRealVenueEnabler } from "../adapters/venue-enabler.js";
import type { VenueAdapter, BuildResult, SubmitResult, PositionState } from "../adapters/types.js";
import { addDecimal, type RiskLimits, type DailyUsage } from "../policy/limits.js";

const HL_BUILD: BuildResult = {
  kind: "hlAction",
  chain: "hyperliquid",
  assetIndex: 0,
  action: { type: "order" },
  nonce: 1,
  signature: { r: "0x", s: "0x", v: 27 },
  postUrl: "https://example/exchange",
};

/** A fake HL adapter that COUNTS submit()/withdraw() calls so a test can prove
 *  the tool actually executed (and didn't double-execute on replay). */
function makeHlAdapter(calls: Record<string, number>): VenueAdapter {
  return {
    venue: "hyperliquid",
    chain: "hyperliquid",
    async health() {
      return { up: true, orderModel: "hlAction" as const };
    },
    async resolveMarket() {
      return { ok: true, meta: {} };
    },
    async buildOpen() {
      return HL_BUILD;
    },
    async buildClose() {
      return HL_BUILD;
    },
    async state(): Promise<PositionState | null> {
      return { venue: "hyperliquid", marketId: "hl:SOL", side: "buy", size: "1", avgPrice: "100", unrealizedPnlUsd: "0" };
    },
    async submit(): Promise<SubmitResult> {
      calls.submit = (calls.submit ?? 0) + 1;
      return { posted: true, orderId: "o1", status: "matched" };
    },
    async withdraw(): Promise<SubmitResult> {
      calls.withdraw = (calls.withdraw ?? 0) + 1;
      return { posted: true, status: "ok" };
    },
  };
}

function makeDeps(adapter: VenueAdapter): ToolDeps {
  let opened = "0";
  return {
    botId: "test",
    adapters: { hyperliquid: adapter },
    bridges: {},
    store: makeIntentStore(),
    reconciler: makeReconciler(),
    treasury: async () => ({ byChain: {}, sealed: false }),
    gas: makeGasPlanner(),
    funding: makeFundingPlanner(),
    enabler: makeRealVenueEnabler(),
    executor: { async exec() { throw new Error("executor not used in this test"); }, async execSequence() { return []; } },
    dailyRelayerQuota: 100,
    signerLoaded: () => true,
    limits: (): RiskLimits => ({ perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false }),
    dailyUsage: (): DailyUsage => ({ dayKey: "2026-06-16", openedNotionalUsd: opened, realizedLossUsd: "0" }),
    recordOpen: (n) => {
      opened = addDecimal(opened, n);
    },
    selfAddress: () => null,
    nativeGas: async () => 0,
  };
}

const call = (deps: ToolDeps, name: string, args: Record<string, unknown>) =>
  handleMoneyTool(name, args, deps).then((r) => JSON.parse(r.content[0].text));

test("close_position POSTs the signed close via adapter.submit (FILLED, not just built)", async () => {
  const calls: Record<string, number> = {};
  const deps = makeDeps(makeHlAdapter(calls));
  const res = await call(deps, "close_position", {
    venue: "hyperliquid",
    marketId: "hl:SOL",
    fraction: "1",
    worstPrice: "99",
    idempotencyKey: "c1",
  });
  assert.equal(res.ok, true);
  assert.equal(res.state, "FILLED");
  assert.equal(calls.submit, 1, "submit called exactly once");
  assert.ok(res.submit?.posted);
});

test("build_withdraw(hyperliquid) EXECUTES the native HL withdraw via the adapter", async () => {
  const calls: Record<string, number> = {};
  const deps = makeDeps(makeHlAdapter(calls));
  const res = await call(deps, "build_withdraw", { chain: "hyperliquid", amount: "4", idempotencyKey: "w1" });
  assert.equal(res.ok, true);
  assert.equal(calls.withdraw, 1);
  assert.match(res.note, /your OWN address on Arbitrum/);
});

test("build_withdraw(hyperliquid) NEVER re-posts on a replayed idempotencyKey", async () => {
  const calls: Record<string, number> = {};
  const deps = makeDeps(makeHlAdapter(calls));
  const first = await call(deps, "build_withdraw", { chain: "hyperliquid", amount: "4", idempotencyKey: "w3" });
  assert.equal(first.ok, true);
  const replay = await call(deps, "build_withdraw", { chain: "hyperliquid", amount: "4", idempotencyKey: "w3" });
  assert.equal(replay.replayed, true);
  assert.equal(calls.withdraw, 1, "withdraw posted exactly ONCE across the replay");
});
