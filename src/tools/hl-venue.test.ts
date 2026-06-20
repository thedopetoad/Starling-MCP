// src/tools/hl-venue.test.ts
// The hl_* TOOL guardrails (with a recording HlVenueOps stub): signer-gating,
// not-wired refusal, idempotent replay (a replayed key is NOT re-run), hl_order's
// risk-cap gate + recordOpen accounting, and hl_cancel arg validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMoneyTool, type ToolDeps, type HlVenueOps, type PmBridgeOps } from "./index.js";
import { makeIntentStore, makeReconciler, makeGasPlanner, makeFundingPlanner } from "./deps.js";
import { makeRealVenueEnabler } from "../adapters/venue-enabler.js";
import type { SealedTreasury } from "../withdraw/allowlist.js";
import type { RiskLimits } from "../policy/limits.js";

const stubPm: PmBridgeOps = { async depositAddresses() { throw new Error("unused"); }, async withdraw() { throw new Error("unused"); } };
const UNLIMITED: RiskLimits = { perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false };
const parse = (p: Promise<{ content: { text: string }[] }>) => p.then((r) => JSON.parse(r.content[0].text));

function recordingHlVenue() {
  const calls: Array<[string, unknown]> = [];
  const ops: HlVenueOps = {
    async account() { return { kind: "account" }; },
    async order(a) { calls.push(["order", a]); return { posted: true, status: "resting", orderId: "7" }; },
    async cancel(a) { calls.push(["cancel", a]); return { posted: true, status: "accepted" }; },
    async updateLeverage(a) { calls.push(["lev", a]); return { posted: true, status: "accepted" }; },
    async updateIsolatedMargin(a) { calls.push(["iso", a]); return { posted: true, status: "accepted" }; },
    async usdClassTransfer(a) { calls.push(["class", a]); return { posted: true, status: "accepted" }; },
    async vaultTransfer(a) { calls.push(["vault", a]); return { posted: true, status: "accepted" }; },
    async stake(a) { calls.push(["stake", a]); return { posted: true, status: "accepted" }; },
    async delegate(a) { calls.push(["deleg", a]); return { posted: true, status: "accepted" }; },
    async twapOrder(a) { calls.push(["twapO", a]); return { posted: true, status: "accepted" }; },
    async twapCancel(a) { calls.push(["twapC", a]); return { posted: true, status: "accepted" }; },
  };
  return { ops, calls };
}

function depsWith(hlVenue: HlVenueOps | undefined, opts: { signer?: boolean; limits?: RiskLimits } = {}): { deps: ToolDeps; opened: string[] } {
  const opened: string[] = [];
  const t: SealedTreasury = { sealed: false, byChain: {} };
  const deps: ToolDeps = {
    botId: "test",
    adapters: {},
    bridges: {},
    store: makeIntentStore(),
    reconciler: makeReconciler(),
    treasury: async () => t,
    gas: makeGasPlanner({ readNativeBalance: async () => "0", sourceAddressFor: () => null }),
    funding: makeFundingPlanner({ readNativeBalance: async () => "0", sourceAddressFor: () => null }),
    enabler: makeRealVenueEnabler(),
    pmBridge: stubPm,
    hlVenue,
    executor: { async exec() { throw new Error("unused"); }, async execSequence() { return []; } },
    dailyRelayerQuota: 100,
    signerLoaded: () => opts.signer ?? true,
    limits: () => opts.limits ?? UNLIMITED,
    dailyUsage: () => ({ dayKey: "2026-06-19", openedNotionalUsd: "0", realizedLossUsd: "0" }),
    recordOpen: (n) => { opened.push(n); },
    selfAddress: () => null,
    nativeGas: async () => 0,
  };
  return { deps, opened };
}

test("hl_account: not-wired refusal, signer-gating, and happy read", async () => {
  const { ops } = recordingHlVenue();
  assert.equal((await parse(handleMoneyTool("hl_account", {}, depsWith(undefined).deps))).ok, false);
  assert.equal((await parse(handleMoneyTool("hl_account", {}, depsWith(ops, { signer: false }).deps))).code, "signer_missing");
  const okRes = await parse(handleMoneyTool("hl_account", {}, depsWith(ops).deps));
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.account, { kind: "account" });
});

test("hl_order: happy path executes once, records notional, and is idempotent", async () => {
  const { ops, calls } = recordingHlVenue();
  const { deps, opened } = depsWith(ops);
  const args = { idempotencyKey: "o1", marketId: "hl:BTC", side: "buy", amount: "50", amountKind: "collateral", worstPrice: "60000", tif: "Gtc" };
  const res = await parse(handleMoneyTool("hl_order", args, deps));
  assert.equal(res.ok, true);
  assert.equal(res.notionalUsd, "50");
  assert.equal(calls.length, 1);
  assert.deepEqual(opened, ["50"]); // recordOpen called once
  // Replay: NOT re-run.
  const again = await parse(handleMoneyTool("hl_order", args, deps));
  assert.equal(again.replayed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(opened, ["50"]);
});

test("hl_order: risk cap blocks BEFORE executing", async () => {
  const { ops, calls } = recordingHlVenue();
  const { deps, opened } = depsWith(ops, { limits: { ...UNLIMITED, perTradeMaxUsd: "1" } });
  const res = await parse(handleMoneyTool("hl_order", { idempotencyKey: "o2", marketId: "hl:BTC", side: "buy", amount: "50", amountKind: "collateral", worstPrice: "60000" }, deps));
  assert.equal(res.ok, false);
  assert.equal(res.code, "risk_blocked");
  assert.equal(res.policyCode, "per_trade_cap");
  assert.equal(calls.length, 0); // never reached the venue
  assert.deepEqual(opened, []);
});

test("hl_order: not wired => internal refusal, nothing executes", async () => {
  const res = await parse(handleMoneyTool("hl_order", { idempotencyKey: "o3", marketId: "hl:BTC", side: "buy", amount: "5", amountKind: "collateral", worstPrice: "60000" }, depsWith(undefined).deps));
  assert.equal(res.ok, false);
  assert.match(res.message, /not wired/);
});

test("hl_cancel: needs oid/cloid/all; passes the parsed args through", async () => {
  const { ops, calls } = recordingHlVenue();
  const { deps } = depsWith(ops);
  const bad = await parse(handleMoneyTool("hl_cancel", { idempotencyKey: "c0", marketId: "hl:BTC" }, deps));
  assert.equal(bad.code, "bad_args");
  const okRes = await parse(handleMoneyTool("hl_cancel", { idempotencyKey: "c1", marketId: "hl:BTC", oid: 123 }, deps));
  assert.equal(okRes.ok, true);
  assert.deepEqual(calls[0], ["cancel", { marketId: "hl:BTC", oid: 123, cloid: undefined, all: undefined }]);
});

test("hl_stake + hl_delegate: execute once and replay-guard", async () => {
  const { ops, calls } = recordingHlVenue();
  const { deps } = depsWith(ops);
  await parse(handleMoneyTool("hl_stake", { idempotencyKey: "s1", direction: "deposit", hype: "0.1" }, deps));
  const replay = await parse(handleMoneyTool("hl_stake", { idempotencyKey: "s1", direction: "deposit", hype: "0.1" }, deps));
  assert.equal(replay.replayed, true);
  await parse(handleMoneyTool("hl_delegate", { idempotencyKey: "d1", validator: "0x" + "c".repeat(40), hype: "0.1" }, deps));
  assert.deepEqual(calls.map((c) => c[0]), ["stake", "deleg"]);
});

test("hl_twap: place routes to twapOrder, cancel routes to twapCancel", async () => {
  const { ops, calls } = recordingHlVenue();
  const { deps } = depsWith(ops);
  await parse(handleMoneyTool("hl_twap", { idempotencyKey: "t1", action: "place", marketId: "hl:ETH", side: "sell", size: "1.5", minutes: 30 }, deps));
  await parse(handleMoneyTool("hl_twap", { idempotencyKey: "t2", action: "cancel", marketId: "hl:ETH", twapId: 9 }, deps));
  assert.deepEqual(calls.map((c) => c[0]), ["twapO", "twapC"]);
});
