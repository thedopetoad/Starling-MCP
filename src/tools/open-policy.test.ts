// src/tools/open-policy.test.ts
// Proves the USER-SET risk caps actually gate open_position at the tool layer
// (the safety floor for a real-funds test): an open over the per-trade cap is
// refused before any build, the daily-notional cap counts prior opens, and the
// notional math is decimal-exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMoneyTool, type ToolDeps } from "./index.js";
import { makeIntentStore, makeReconciler, makeGasPlanner, makeFundingPlanner } from "./deps.js";
import { makeRealVenueEnabler } from "../adapters/venue-enabler.js";
import type { VenueAdapter, BuildResult } from "../adapters/types.js";
import { addDecimal, mulDecimal, openNotionalUsd, type RiskLimits, type DailyUsage } from "../policy/limits.js";

const DUMMY_BUILD: BuildResult = {
  kind: "eip712Order",
  chain: "polygon",
  verifyingContract: "0x0000000000000000000000000000000000000000",
  negRisk: false,
  tickSize: "0.01",
  typedData: {},
  orderStruct: {},
  postUrl: "https://clob.polymarket.com/order",
};

const fakeAdapter: VenueAdapter = {
  venue: "polymarket",
  chain: "polygon",
  async health() {
    return { up: true, orderModel: "eip712Order" as const };
  },
  async resolveMarket() {
    return { ok: true, meta: {} };
  },
  async buildOpen() {
    return DUMMY_BUILD;
  },
  async buildClose() {
    return DUMMY_BUILD;
  },
  async state() {
    return null;
  },
};

function makeDeps(limits: RiskLimits): ToolDeps {
  let opened = "0";
  return {
    botId: "test",
    adapters: { polymarket: fakeAdapter },
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
    withdrawMaxPerCall: () => "0",
    limits: () => limits,
    dailyUsage: (): DailyUsage => ({ dayKey: "2026-06-15", openedNotionalUsd: opened, realizedLossUsd: "0" }),
    recordOpen: (n) => {
      opened = addDecimal(opened, n);
    },
    selfAddress: () => null,
    nativeGas: async () => 0,
  };
}

const open = (deps: ToolDeps, amount: string, key: string) =>
  handleMoneyTool(
    "open_position",
    { venue: "polymarket", marketId: "pm:x", side: "buy", amount, amountKind: "collateral", worstPrice: "0.5", idempotencyKey: key },
    deps,
  ).then((r) => JSON.parse(r.content[0].text));

test("open over the per-trade cap is REFUSED before any build", async () => {
  const deps = makeDeps({ perTradeMaxUsd: "5", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false });
  const res = await open(deps, "10", "k1");
  assert.equal(res.ok, false);
  assert.equal(res.code, "risk_blocked");
  assert.equal(res.policyCode, "per_trade_cap");
});

test("open under the cap builds; daily-notional cap then counts prior opens", async () => {
  const deps = makeDeps({ perTradeMaxUsd: "5", dailyNotionalCapUsd: "8", dailyLossCapUsd: "0", killSwitch: false });
  const a = await open(deps, "3", "k1"); // 0+3=3 ok
  assert.equal(a.ok, true);
  assert.ok(a.build, "returns the unsigned build");
  const b = await open(deps, "3", "k2"); // 3+3=6 ok
  assert.equal(b.ok, true);
  const c = await open(deps, "3", "k3"); // 6+3=9 > 8 -> blocked
  assert.equal(c.ok, false);
  assert.equal(c.policyCode, "daily_notional_cap");
});

test("kill switch refuses everything", async () => {
  const deps = makeDeps({ perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: true });
  const res = await open(deps, "1", "k1");
  assert.equal(res.policyCode, "kill_switch_on");
});

test("notional math: collateral is pass-through, shares = shares*price (decimal-exact)", () => {
  assert.equal(openNotionalUsd("50", "collateral", "0.4"), "50");
  assert.equal(openNotionalUsd("100", "shares", "0.4"), "40");
  assert.equal(mulDecimal("0.1", "0.2"), "0.02");
});
