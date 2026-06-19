// src/tools/gas-funding.test.ts
// Proves the gas + funding planners COORDINATE the live bridge code correctly
// (return UNSIGNED legs, pin the recipient, degrade gracefully) WITHOUT hitting
// the network: we drive the no-network short-circuits (already-funded /
// bootstrap-blocked) + the CCTP leg through an injected fake. The deBridge
// order-placement path and the real on-chain effect are covered by bridge/gas.ts's
// own tests + testnet validation.
//
// Run: node --test dist/tools/gas-funding.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGasPlanner, makeFundingPlanner } from "./deps.js";
import type { Chain } from "../adapters/types.js";

const A: Record<string, string> = { polygon: "0xpolygon", hyperliquid: "0xhyperliquid", solana: "SoLAddr" };
const srcAll = (chain: Chain) => A[chain] ?? null;
const reader = (balances: Partial<Record<Chain, string>>) => async (chain: Chain, _addr: string) =>
  balances[chain] ?? "0";

// A network-free CCTP stand-in: returns a fixed quote + one unsigned leg.
const fakeCctp = {
  async quote() {
    return { provider: "cctp" as const, feeUsd: "0.5", etaSec: 60, starlingFeeUsd: "0" as const, reorgExposed: false };
  },
  async buildBridgeIn() {
    return [{ chain: "polygon" as Chain, kind: "evmTx" as const, payload: { to: "0xUSDC", data: "0x", value: "0" }, label: "depositForBurn" }];
  },
};

// ── gas planner ───────────────────────────────────────────────────────────

test("gas check(): sufficient when balance >= floor, else not", async () => {
  const ok = makeGasPlanner({ readNativeBalance: reader({ polygon: "1.0" }), sourceAddressFor: srcAll });
  const r = await ok.check("polygon");
  assert.equal(r.sufficient, true);
  assert.equal(r.floor, "0.05"); // GAS_MINIMUMS.polygon.minNative
  const low = makeGasPlanner({ readNativeBalance: reader({ polygon: "0.001" }), sourceAddressFor: srcAll });
  assert.equal((await low.check("polygon")).sufficient, false);
});

test("gas buildTopUp(): already funded -> sufficient, no txs (no network)", async () => {
  const planner = makeGasPlanner({ readNativeBalance: reader({ polygon: "1.0" }), sourceAddressFor: srcAll });
  const r = await planner.buildTopUp("polygon");
  assert.equal(r.sufficient, true);
  assert.equal(r.txs.length, 0);
});

test("gas buildTopUp(): no source signer -> graceful, no txs", async () => {
  // polygon has a signer; its cross-chain gas source (hyperliquid) does not.
  const planner = makeGasPlanner({
    readNativeBalance: reader({ polygon: "0" }),
    sourceAddressFor: (c) => (c === "polygon" ? A.polygon : null),
  });
  const r = await planner.buildTopUp("polygon");
  assert.equal(r.sufficient, false);
  assert.equal(r.txs.length, 0);
  assert.match(r.note ?? "", /source chain hyperliquid/);
});

// ── funding planner ─────────────────────────────────────────────────────────

test("funding plan(): CCTP leg present + recipient pinned; gas leg skipped when dest already funded", async () => {
  const planner = makeFundingPlanner({
    readNativeBalance: reader({ polygon: "1.0", hyperliquid: "1.0" }),
    sourceAddressFor: srcAll,
    cctp: fakeCctp,
  });
  const plan = await planner.plan({ fromChain: "hyperliquid", toChain: "polygon", usdcAmount: "100", recipient: "0xTREASURY" });
  assert.equal(plan.recipient, "0xTREASURY");
  const cctpLeg = plan.legs.find((l) => l.purpose === "usdc_cctp");
  assert.ok(cctpLeg, "has a CCTP USDC leg");
  assert.equal(cctpLeg?.provider, "cctp");
  assert.ok((cctpLeg?.txs.length ?? 0) > 0);
  assert.equal(plan.legs.some((l) => l.purpose === "gas_debridge"), false);
  assert.match(plan.note, /already holds native gas/);
});

test("funding plan(): gas leg gracefully skipped (bootstrap-blocked) but USDC leg stands", async () => {
  const planner = makeFundingPlanner({
    readNativeBalance: reader({ polygon: "0", hyperliquid: "0" }), // dest low + source low => bootstrap-blocked
    sourceAddressFor: srcAll,
    cctp: fakeCctp,
  });
  const plan = await planner.plan({ fromChain: "hyperliquid", toChain: "polygon", usdcAmount: "100", recipient: "0xTREASURY" });
  assert.ok(plan.legs.some((l) => l.purpose === "usdc_cctp"), "CCTP leg still present");
  assert.equal(plan.legs.some((l) => l.purpose === "gas_debridge"), false);
  assert.match(plan.note, /Gas leg skipped/);
});
