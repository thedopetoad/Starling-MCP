// src/tools/jup-venue.test.ts
// The jup_* TOOL guardrails (with a recording JupVenueOps stub): signer-gating (the
// Solana "jupiter" signer), not-wired refusal, idempotent replay (a replayed key is
// NOT re-run), arg pass-through, and the read tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMoneyTool, type ToolDeps, type JupVenueOps, type PmBridgeOps } from "./index.js";
import { makeIntentStore, makeReconciler, makeGasPlanner, makeFundingPlanner } from "./deps.js";
import { makeRealVenueEnabler } from "../adapters/venue-enabler.js";
import type { SealedTreasury } from "../withdraw/allowlist.js";
import type { RiskLimits } from "../policy/limits.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const stubPm: PmBridgeOps = { async depositAddresses() { throw new Error("unused"); }, async withdraw() { throw new Error("unused"); } };
const UNLIMITED: RiskLimits = { perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false };
const parse = (p: Promise<{ content: { text: string }[] }>) => p.then((r) => JSON.parse(r.content[0].text));

function recordingJup() {
  const calls: Array<[string, unknown]> = [];
  const ops: JupVenueOps = {
    async limitCreate(a) { calls.push(["limitCreate", a]); return { posted: true, status: "filled", orderId: "ORDER1", txHashes: ["sig1"] }; },
    async limitCancel(a) { calls.push(["limitCancel", a]); return { posted: true, status: "filled", txHashes: ["sig2"] }; },
    async limitList(s) { calls.push(["limitList", s]); return { orders: [], status: s }; },
    async recurringCreate(a) { calls.push(["recurringCreate", a]); return { posted: true, status: "filled", orderId: "REC1", txHashes: ["sig3"] }; },
    async recurringCancel(a) { calls.push(["recurringCancel", a]); return { posted: true, status: "filled", txHashes: ["sig4"] }; },
    async recurringList(s) { calls.push(["recurringList", s]); return { orders: [], status: s }; },
  };
  return { ops, calls };
}

function depsWith(jupVenue: JupVenueOps | undefined, opts: { signer?: boolean } = {}): ToolDeps {
  const t: SealedTreasury = { sealed: false, byChain: {} };
  return {
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
    jupVenue,
    executor: { async exec() { throw new Error("unused"); }, async execSequence() { return []; } },
    dailyRelayerQuota: 100,
    signerLoaded: () => opts.signer ?? true,
    limits: () => UNLIMITED,
    dailyUsage: () => ({ dayKey: "2026-06-20", openedNotionalUsd: "0", realizedLossUsd: "0" }),
    recordOpen: () => {},
    selfAddress: () => null,
    nativeGas: async () => 0,
  };
}

test("jup_limit_create: executes once, passes args, idempotent replay", async () => {
  const { ops, calls } = recordingJup();
  const deps = depsWith(ops);
  const args = { idempotencyKey: "l1", inputMint: USDC, outputMint: SOL, makingAmount: "10", takingAmount: "0.05" };
  const res = await parse(handleMoneyTool("jup_limit_create", args, deps));
  assert.equal(res.ok, true);
  assert.equal(res.submit.orderId, "ORDER1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { inputMint: USDC, outputMint: SOL, makingAmount: "10", takingAmount: "0.05", slippageBps: undefined, expiredAt: undefined });
  const again = await parse(handleMoneyTool("jup_limit_create", args, deps));
  assert.equal(again.replayed, true);
  assert.equal(calls.length, 1);
});

test("jup_limit_create: signer-gating + not-wired refusals", async () => {
  const { ops } = recordingJup();
  const a = { idempotencyKey: "l2", inputMint: USDC, outputMint: SOL, makingAmount: "10", takingAmount: "0.05" };
  assert.equal((await parse(handleMoneyTool("jup_limit_create", a, depsWith(ops, { signer: false })))).code, "signer_missing");
  const nw = await parse(handleMoneyTool("jup_limit_create", { ...a, idempotencyKey: "l3" }, depsWith(undefined)));
  assert.equal(nw.ok, false);
  assert.match(nw.message, /not wired/);
});

test("jup_limit_cancel + recurring create/cancel pass through", async () => {
  const { ops, calls } = recordingJup();
  const deps = depsWith(ops);
  await parse(handleMoneyTool("jup_limit_cancel", { idempotencyKey: "c1", order: "ORDER1" }, deps));
  await parse(handleMoneyTool("jup_recurring_create", { idempotencyKey: "r1", inputMint: USDC, outputMint: SOL, inAmount: "100", numberOfOrders: 5, interval: 86400 }, deps));
  await parse(handleMoneyTool("jup_recurring_cancel", { idempotencyKey: "rc1", order: "REC1" }, deps));
  assert.deepEqual(calls.map((c) => c[0]), ["limitCancel", "recurringCreate", "recurringCancel"]);
  assert.deepEqual(calls[0][1], { order: "ORDER1" });
  assert.deepEqual(calls[1][1], { inputMint: USDC, outputMint: SOL, inAmount: "100", numberOfOrders: 5, interval: 86400, minPrice: undefined, maxPrice: undefined, startAt: undefined });
});

test("jup_limit_list / jup_recurring_list: read-only, default active, not-wired guarded", async () => {
  const { ops, calls } = recordingJup();
  const ll = await parse(handleMoneyTool("jup_limit_list", {}, depsWith(ops)));
  assert.equal(ll.ok, true);
  assert.equal(ll.status, "active");
  const rl = await parse(handleMoneyTool("jup_recurring_list", { status: "history" }, depsWith(ops)));
  assert.equal(rl.status, "history");
  assert.deepEqual(calls.map((c) => c[0]), ["limitList", "recurringList"]);
  assert.equal((await parse(handleMoneyTool("jup_limit_list", {}, depsWith(undefined)))).ok, false);
});
