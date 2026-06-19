// src/tools/funding-recipient.test.ts
// Proves the WITHDRAW-vs-FUNDING-IN split at the TOOL layer (not just the resolver):
// a human-pasted "dashboard" destination may receive a WITHDRAW (build_bridge out)
// but is REFUSED as an inbound-funds recipient (build_bridge in / plan_funding_route).
// Funding-in stays keystore-sealed only, so a dashboard pin can never silently widen
// from "where my money goes home" into "where trading capital lands". A keystore/
// dashboard conflict refuses everywhere.
//
// Run: node --test dist/tools/funding-recipient.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMoneyTool, type ToolDeps } from "./index.js";
import { makeIntentStore, makeReconciler, makeGasPlanner, makeFundingPlanner } from "./deps.js";
import { makeRealVenueEnabler } from "../adapters/venue-enabler.js";
import type { SealedTreasury } from "../withdraw/allowlist.js";
import type { Bridge } from "../bridge/types.js";

const T = "0x1111111111111111111111111111111111111111";

// Minimal bridge — the treasury gate sits BEFORE getBridge for refusals; the
// build_*Bridge calls only matter when the gate passes (keystore / withdraw).
const fakeBridge = {
  provider: "cctp" as const,
  async buildBridgeIn() {
    return [];
  },
  async buildBridgeOut() {
    return [];
  },
} as unknown as Bridge;

function depsWith(t: SealedTreasury): ToolDeps {
  return {
    botId: "test",
    adapters: {},
    bridges: { cctp: fakeBridge },
    store: makeIntentStore(),
    reconciler: makeReconciler(),
    treasury: async () => t,
    gas: makeGasPlanner(),
    funding: makeFundingPlanner(),
    enabler: makeRealVenueEnabler(),
    executor: { async exec() { throw new Error("unused"); }, async execSequence() { return []; } },
    dailyRelayerQuota: 100,
    signerLoaded: () => true,
    limits: () => ({ perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false }),
    dailyUsage: () => ({ dayKey: "2026-06-18", openedNotionalUsd: "0", realizedLossUsd: "0" }),
    recordOpen: () => {},
    selfAddress: () => null,
    nativeGas: async () => 0,
  };
}

const dashboard: SealedTreasury = { sealed: false, byChain: { polygon: T }, sourceByChain: { polygon: "dashboard" } };
const keystore: SealedTreasury = { sealed: true, byChain: { polygon: T }, sourceByChain: { polygon: "keystore" } };
const conflict: SealedTreasury = { sealed: true, byChain: { polygon: T }, sourceByChain: { polygon: "conflict" } };

let n = 0;
const call = (deps: ToolDeps, name: string, args: Record<string, unknown>) =>
  handleMoneyTool(name, { idempotencyKey: `k${n++}`, ...args }, deps).then((r) => JSON.parse(r.content[0].text));

const bridgeArgs = (direction: "in" | "out") => ({
  provider: "cctp",
  fromChain: "solana",
  toChain: "polygon",
  token: "USDC",
  amount: "10",
  direction,
});
const fundingArgs = { fromChain: "solana", toChain: "polygon", usdcAmount: "10" };

test("build_bridge IN: dashboard pin is REFUSED (funding-in must be keystore)", async () => {
  const res = await call(depsWith(dashboard), "build_bridge", bridgeArgs("in"));
  assert.equal(res.ok, false);
  assert.equal(res.code, "treasury_refused");
  assert.match(res.message, /keystore-sealed/);
});

test("build_bridge IN: keystore source PASSES the treasury gate", async () => {
  const res = await call(depsWith(keystore), "build_bridge", bridgeArgs("in"));
  assert.equal(res.ok, true);
  assert.equal(res.recipient, T);
});

test("build_bridge OUT (withdraw): dashboard pin is ALLOWED", async () => {
  const res = await call(depsWith(dashboard), "build_bridge", bridgeArgs("out"));
  assert.equal(res.ok, true);
  assert.equal(res.recipient, T);
});

test("plan_funding_route: dashboard pin is REFUSED (funding-in must be keystore)", async () => {
  const res = await call(depsWith(dashboard), "plan_funding_route", fundingArgs);
  assert.equal(res.ok, false);
  assert.equal(res.code, "treasury_refused");
  assert.match(res.message, /keystore-sealed/);
});

test("plan_funding_route: keystore source PASSES the treasury gate", async () => {
  const res = await call(depsWith(keystore), "plan_funding_route", fundingArgs);
  assert.equal(res.ok, true);
});

test("conflict refuses BOTH funding-in and withdraw-out", async () => {
  const inRes = await call(depsWith(conflict), "build_bridge", bridgeArgs("in"));
  assert.equal(inRes.code, "treasury_refused");
  assert.equal(inRes.withdrawCode, "treasury_conflict");
  const outRes = await call(depsWith(conflict), "build_bridge", bridgeArgs("out"));
  assert.equal(outRes.code, "treasury_refused");
  assert.equal(outRes.withdrawCode, "treasury_conflict");
});
