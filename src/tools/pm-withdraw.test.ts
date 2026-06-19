// src/tools/pm-withdraw.test.ts
// The pm_withdraw TOOL guardrails (not just the ops): the recipient is the SEALED
// TREASURY (an agent-passed recipient is ignored), no-treasury / no-signer refuse,
// and a replayed idempotencyKey is NOT re-sent (no double-withdraw).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMoneyTool, type ToolDeps, type PmBridgeOps } from "./index.js";
import { makeIntentStore, makeReconciler, makeGasPlanner, makeFundingPlanner } from "./deps.js";
import { makeRealVenueEnabler } from "../adapters/venue-enabler.js";
import type { SealedTreasury } from "../withdraw/allowlist.js";

const SOL = "23MGLpSTbgejYmCRHApWkpwJh64sGFjjj4XgxDke8ePA";

function depsWith(t: SealedTreasury, pmBridge: PmBridgeOps, signer = true): ToolDeps {
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
    pmBridge,
    executor: { async exec() { throw new Error("unused"); }, async execSequence() { return []; } },
    dailyRelayerQuota: 100,
    signerLoaded: () => signer,
    limits: () => ({ perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false }),
    dailyUsage: () => ({ dayKey: "2026-06-18", openedNotionalUsd: "0", realizedLossUsd: "0" }),
    recordOpen: () => {},
    selfAddress: () => null,
    nativeGas: async () => 0,
  };
}

function recordingBridge() {
  const calls: Array<{ amount: string; toChain: string; recipient: string }> = [];
  const ops: PmBridgeOps = {
    async depositAddresses() {
      return { depositWallet: "0xDW", addresses: { evm: "0x", svm: "s", tron: "t", btc: "b" }, note: "" };
    },
    async withdraw(args) {
      calls.push(args);
      return { ok: true, txHash: "0xTX", deliveredToChain: args.toChain, recipient: args.recipient, blockers: [], note: "ok" };
    },
  };
  return { ops, calls };
}

const dashboardSol: SealedTreasury = { sealed: false, byChain: { solana: SOL }, sourceByChain: { solana: "dashboard" } };
const empty: SealedTreasury = { sealed: false, byChain: {} };

const parse = (p: Promise<{ content: { text: string }[] }>) => p.then((r) => JSON.parse(r.content[0].text));

test("pm_withdraw pins the recipient to the sealed treasury — an agent recipient is ignored", async () => {
  const { ops, calls } = recordingBridge();
  const res = await parse(handleMoneyTool("pm_withdraw", { idempotencyKey: "a1", toChain: "solana", amount: "3", recipient: "0xATTACKER" }, depsWith(dashboardSol, ops)));
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient, SOL); // the pinned treasury, NOT 0xATTACKER
});

test("pm_withdraw with no treasury set is refused — nothing executes", async () => {
  const { ops, calls } = recordingBridge();
  const res = await parse(handleMoneyTool("pm_withdraw", { idempotencyKey: "a2", toChain: "solana", amount: "3" }, depsWith(empty, ops)));
  assert.equal(res.ok, false);
  assert.equal(res.code, "treasury_refused");
  assert.equal(calls.length, 0);
});

test("pm_withdraw is idempotent — a replayed key is NOT re-sent", async () => {
  const { ops, calls } = recordingBridge();
  const deps = depsWith(dashboardSol, ops);
  const first = await parse(handleMoneyTool("pm_withdraw", { idempotencyKey: "dup", toChain: "solana", amount: "3" }, deps));
  const second = await parse(handleMoneyTool("pm_withdraw", { idempotencyKey: "dup", toChain: "solana", amount: "3" }, deps));
  assert.equal(first.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(calls.length, 1); // executed exactly once
});

test("pm_withdraw without a loaded signer is refused", async () => {
  const { ops, calls } = recordingBridge();
  const res = await parse(handleMoneyTool("pm_withdraw", { idempotencyKey: "a3", toChain: "solana", amount: "3" }, depsWith(dashboardSol, ops, false)));
  assert.equal(res.ok, false);
  assert.equal(res.code, "signer_missing");
  assert.equal(calls.length, 0);
});
