// src/exec/executor.test.ts
// The Executor's pure pieces, vector-tested: refreshBlockhash does byte-exact
// surgery on the v0 message (and only the blockhash), and planEvmLeg maps a leg's
// chain to the right EVM net + signer venue. The full sign+broadcast path is the
// "caller" role and is proven LIVE (like the broadcasters it wraps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { refreshBlockhash } from "../adapters/solana-tx.js";
import { planEvmLeg, EVM_NET } from "./executor.js";
import type { UnsignedBridgeTx } from "../bridge/types.js";

/** Minimal valid v0 tx: 1 sig slot + [version][header][1 key][blockhash][0 ix]. */
function makeV0Tx(blockhash: Uint8Array): Uint8Array {
  const sigArray = [0x01, ...new Array(64).fill(0)]; // shortvec(1) + 1×64-byte slot
  const message = [
    0x80, // v0 version prefix
    0x01, 0x00, 0x00, // 3-byte header
    0x01, // shortvec numStaticKeys = 1
    ...new Array(32).fill(0xab), // account key 0
    ...blockhash, // 32-byte recent blockhash
    0x00, // shortvec numInstructions = 0
  ];
  return Uint8Array.from([...sigArray, ...message]);
}

const BH_START = 1 + 64 + 1 + 3 + 1 + 32; // 102: shortvec+sig+version+header+keyshortvec+key

test("refreshBlockhash swaps EXACTLY the 32 blockhash bytes, nothing else", () => {
  const buf = makeV0Tx(new Uint8Array(32).fill(0x11));
  const newBh = new Uint8Array(32).fill(0x22);
  const out = Uint8Array.from(
    Buffer.from(refreshBlockhash(Buffer.from(buf).toString("base64"), base58.encode(newBh)), "base64"),
  );
  assert.equal(out.length, buf.length, "length unchanged");
  assert.deepEqual([...out.subarray(BH_START, BH_START + 32)], [...newBh], "blockhash replaced");
  assert.deepEqual([...out.subarray(0, BH_START)], [...buf.subarray(0, BH_START)], "prefix untouched");
  assert.deepEqual([...out.subarray(BH_START + 32)], [...buf.subarray(BH_START + 32)], "suffix untouched");
});

test("refreshBlockhash fails closed on a wrong-length blockhash", () => {
  const b64 = Buffer.from(makeV0Tx(new Uint8Array(32))).toString("base64");
  assert.throws(() => refreshBlockhash(b64, base58.encode(new Uint8Array(31))), /32/);
});

test("planEvmLeg maps chain -> net + signer venue and normalizes the payload", () => {
  const poly: UnsignedBridgeTx = { chain: "polygon", kind: "evmTx", label: "approve", payload: { to: "0xabc", data: "0xdead", value: "5" } };
  const p = planEvmLeg(poly);
  assert.deepEqual([p.net, p.signerVenue, p.to, p.data, p.value], ["polygon", "polymarket", "0xabc", "0xdead", 5n]);

  // "hyperliquid" chain settles on Arbitrum, signed by the hyperliquid EOA.
  const arb: UnsignedBridgeTx = { chain: "hyperliquid", kind: "evmTx", label: "deposit", payload: { to: "0xdef" } };
  const q = planEvmLeg(arb);
  assert.deepEqual([q.net, q.signerVenue, q.data, q.value], ["arbitrum", "hyperliquid", "0x", 0n]);
});

test("planEvmLeg refuses a non-EVM chain and a missing 'to'", () => {
  assert.throws(() => planEvmLeg({ chain: "solana", kind: "evmTx", label: "x", payload: { to: "0xabc" } }), /no EVM net/);
  assert.throws(() => planEvmLeg({ chain: "polygon", kind: "evmTx", label: "x", payload: {} }), /missing 'to'/);
  assert.equal(EVM_NET.solana, undefined);
});
