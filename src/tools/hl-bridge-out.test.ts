// src/tools/hl-bridge-out.test.ts
// The hl_bridge_out TOOL guardrails: recipient pinned to the SEALED TREASURY (an
// agent-passed recipient is ignored), toChain->dest mapping (hyperliquid=Arbitrum),
// no-treasury / not-wired refusals, and idempotent replay (no double-run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMoneyTool, type ToolDeps, type HlExitOps, type PmBridgeOps } from "./index.js";
import { makeIntentStore, makeReconciler, makeGasPlanner, makeFundingPlanner } from "./deps.js";
import { makeRealVenueEnabler } from "../adapters/venue-enabler.js";
import type { SealedTreasury } from "../withdraw/allowlist.js";

const ARB = "0x92c0d39f947d371bc9a8323ce3f110ab4663effd";
const stubPm: PmBridgeOps = { async depositAddresses() { throw new Error("unused"); }, async withdraw() { throw new Error("unused"); } };

function depsWith(t: SealedTreasury, hlExit: HlExitOps | undefined, signer = true): ToolDeps {
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
    hlExit,
    executor: { async exec() { throw new Error("unused"); }, async execSequence() { return []; } },
    dailyRelayerQuota: 100,
    signerLoaded: () => signer,
    limits: () => ({ perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false }),
    dailyUsage: () => ({ dayKey: "2026-06-19", openedNotionalUsd: "0", realizedLossUsd: "0" }),
    recordOpen: () => {},
    selfAddress: () => null,
    nativeGas: async () => 0,
  };
}

function recordingHlExit() {
  const calls: Array<{ amount: string; dest: string; recipient: string }> = [];
  const ops: HlExitOps = {
    async bridgeOut(args) {
      calls.push(args);
      return { ok: true, txHashes: ["0xTX"], burnTxHash: "0xBURN", blockers: [], note: "ok" };
    },
  };
  return { ops, calls };
}

const treasuryArb: SealedTreasury = { sealed: false, byChain: { hyperliquid: ARB }, sourceByChain: { hyperliquid: "dashboard" } };
const empty: SealedTreasury = { sealed: false, byChain: {} };
const parse = (p: Promise<{ content: { text: string }[] }>) => p.then((r) => JSON.parse(r.content[0].text));

test("hl_bridge_out pins recipient to the treasury + maps toChain hyperliquid -> Arbitrum", async () => {
  const { ops, calls } = recordingHlExit();
  const res = await parse(handleMoneyTool("hl_bridge_out", { idempotencyKey: "h1", toChain: "hyperliquid", amount: "5", recipient: "0xATTACKER" }, depsWith(treasuryArb, ops)));
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient, ARB); // the pinned treasury, NOT 0xATTACKER
  assert.equal(calls[0].dest, "arbitrum");
});

test("hl_bridge_out with no treasury is refused — nothing executes", async () => {
  const { ops, calls } = recordingHlExit();
  const res = await parse(handleMoneyTool("hl_bridge_out", { idempotencyKey: "h2", toChain: "hyperliquid", amount: "5" }, depsWith(empty, ops)));
  assert.equal(res.ok, false);
  assert.equal(res.code, "treasury_refused");
  assert.equal(calls.length, 0);
});

test("hl_bridge_out is idempotent — a replayed key is NOT re-run", async () => {
  const { ops, calls } = recordingHlExit();
  const deps = depsWith(treasuryArb, ops);
  await parse(handleMoneyTool("hl_bridge_out", { idempotencyKey: "dup", toChain: "hyperliquid", amount: "5" }, deps));
  const second = await parse(handleMoneyTool("hl_bridge_out", { idempotencyKey: "dup", toChain: "hyperliquid", amount: "5" }, deps));
  assert.equal(second.replayed, true);
  assert.equal(calls.length, 1);
});

test("hl_bridge_out without the hlExit dep reports not-wired", async () => {
  const res = await parse(handleMoneyTool("hl_bridge_out", { idempotencyKey: "h3", toChain: "hyperliquid", amount: "5" }, depsWith(treasuryArb, undefined)));
  assert.equal(res.ok, false);
  assert.match(res.message, /not wired/);
});
