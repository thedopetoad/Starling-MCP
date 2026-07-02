// src/adapters/pm-bridge-ops.test.ts
// The native-bridge ops logic against an injected backend: same-chain vs cross-chain
// routing, the $2 cross-chain min guard, insufficient-pUSD + unsupported-chain +
// no-signer refusals, and the load-bearing property that withdraw transfers pUSD to
// EXACTLY the recipient it's handed (same-chain) or the bridge routing address
// (cross-chain) — it never invents a destination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePmBridgeOps, type PmBridgeBackend } from "./pm-bridge-ops.js";

const DW = "0xB6d49fc5C7A9Dd9bC896e7ee625904241338Ad9B";
const RECIP_SOL = "23MGLpSTbgejYmCRHApWkpwJh64sGFjjj4XgxDke8ePA";
const RECIP_POLY = "0xa6350f11af9bd54603edab09871737539c35d0e0";
const BRIDGE_EVM = "0x4c8171d38D7a8eEdb09872Ea5476A385f74BB43A";

interface Recorder {
  withdrawLookup: Array<{ dwAddress: string; toChainId: string; toTokenAddress: string; recipientAddr: string }>;
  transfers: Array<{ dw: string; to: string; amt: bigint }>;
}

function backend(over: Partial<PmBridgeBackend> = {}): { be: PmBridgeBackend; calls: Recorder } {
  const calls: Recorder = { withdrawLookup: [], transfers: [] };
  const be: PmBridgeBackend = {
    depositWallet: async () => DW,
    bridge: {
      async getDepositAddresses() { return { evm: "0xDEP", svm: "SOLDEP", tron: "T", btc: "b" }; },
      async getWithdrawAddress(args) { calls.withdrawLookup.push(args); return { evm: BRIDGE_EVM, svm: "s", tron: "t", btc: "b" }; },
    },
    async readDwPusd() { return 5_000_000n; }, // 5 pUSD
    async relayTransferPusd(dw, to, amt) { calls.transfers.push({ dw, to, amt }); return "0xRELAYTX"; },
    ...over,
  };
  return { be, calls };
}

test("same-chain polygon withdraw transfers DIRECTLY to the recipient (no bridge lookup)", async () => {
  const { be, calls } = backend();
  const r = await makePmBridgeOps(be).withdraw({ amount: "3", toChain: "polygon", recipient: RECIP_POLY });
  assert.equal(r.ok, true);
  assert.equal(r.txHash, "0xRELAYTX");
  assert.equal(calls.withdrawLookup.length, 0);
  assert.equal(calls.transfers.length, 1);
  assert.equal(calls.transfers[0].to, RECIP_POLY);
  assert.equal(calls.transfers[0].amt, 3_000_000n);
});

test("cross-chain solana withdraw routes pUSD to the BRIDGE address (recipient is the Solana dest)", async () => {
  const { be, calls } = backend();
  const r = await makePmBridgeOps(be).withdraw({ amount: "3", toChain: "solana", recipient: RECIP_SOL });
  assert.equal(r.ok, true);
  assert.equal(calls.withdrawLookup.length, 1);
  assert.equal(calls.withdrawLookup[0].recipientAddr, RECIP_SOL);
  assert.equal(calls.withdrawLookup[0].toChainId, "1151111081099710");
  assert.equal(calls.transfers[0].to, BRIDGE_EVM); // pUSD goes to the bridge, not directly to Solana
});

test("below the $2 cross-chain minimum is refused — nothing moves", async () => {
  const { be, calls } = backend();
  const r = await makePmBridgeOps(be).withdraw({ amount: "1", toChain: "solana", recipient: RECIP_SOL });
  assert.equal(r.ok, false);
  assert.match(r.blockers.join(" "), /minimum/i);
  assert.equal(calls.transfers.length, 0);
});

test("insufficient DW pUSD is refused", async () => {
  const { be, calls } = backend({ async readDwPusd() { return 1_000_000n; } });
  const r = await makePmBridgeOps(be).withdraw({ amount: "3", toChain: "polygon", recipient: RECIP_POLY });
  assert.equal(r.ok, false);
  assert.match(r.blockers.join(" "), /< requested/);
  assert.equal(calls.transfers.length, 0);
});

test("unsupported destination chain is refused", async () => {
  const { be, calls } = backend();
  // @ts-expect-error — exercising an unsupported chain value at runtime
  const r = await makePmBridgeOps(be).withdraw({ amount: "3", toChain: "ethereum", recipient: RECIP_POLY });
  assert.equal(r.ok, false);
  assert.match(r.blockers.join(" "), /not supported/);
  assert.equal(calls.transfers.length, 0);
});

test("no signer loaded => refused, nothing transferred", async () => {
  const { be, calls } = backend({ depositWallet: async () => null });
  const r = await makePmBridgeOps(be).withdraw({ amount: "3", toChain: "polygon", recipient: RECIP_POLY });
  assert.equal(r.ok, false);
  assert.equal(calls.transfers.length, 0);
});

test("a failed relayer transfer surfaces as a blocker (retry-safe)", async () => {
  const { be } = backend({ async relayTransferPusd() { throw new Error("relay 429"); } });
  const r = await makePmBridgeOps(be).withdraw({ amount: "3", toChain: "polygon", recipient: RECIP_POLY });
  assert.equal(r.ok, false);
  assert.match(r.blockers.join(" "), /relayer transfer failed/);
});

test("depositAddresses returns the DW + the bridge address bundle", async () => {
  const info = await makePmBridgeOps(backend().be).depositAddresses();
  assert.equal(info.depositWallet, DW);
  assert.equal(info.addresses.svm, "SOLDEP");
});
