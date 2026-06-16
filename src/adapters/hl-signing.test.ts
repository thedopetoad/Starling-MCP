// src/adapters/hl-signing.test.ts
// Lock the hand-rolled HL L1-action signer to the OFFICIAL hyperliquid-python-sdk
// vector (tests/signing_test.py::test_l1_action_signing_order_matches). Matching
// {r,s,v} end-to-end proves the whole chain is byte-exact: msgpack encoding, the
// action-hash construction (nonce/vault tail), the phantom-agent EIP-712 domain,
// and the local secp256k1 signing. One wrong byte anywhere fails this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEvmSigner } from "../signers/evm.js";
import { signL1Action } from "./hl-signing.js";
import { packb } from "./hl-msgpack.js";

// Private key from the SDK test: 0x0123...0123.
function testKeyBytes(): Uint8Array {
  const hex = "0123456789012345678901234567890123456789012345678901234567890123";
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// order_wires_to_order_action([order_request_to_order_wire({ETH, buy, sz 100,
// px 100, Gtc}, asset=1)]) — keys in the SDK's exact insertion order.
const ORDER_ACTION = {
  type: "order",
  orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }],
  grouping: "na",
} as const;

test("L1 order action signature matches the official SDK vector (mainnet)", () => {
  const sig = signL1Action({
    signer: makeEvmSigner(testKeyBytes()),
    action: ORDER_ACTION,
    nonce: 0,
    vaultAddress: null,
    isMainnet: true,
  });
  assert.equal(sig.r, "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e");
  assert.equal(sig.s, "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e");
  assert.equal(sig.v, 28);
});

test("L1 order action signature matches the official SDK vector (testnet)", () => {
  const sig = signL1Action({
    signer: makeEvmSigner(testKeyBytes()),
    action: ORDER_ACTION,
    nonce: 0,
    vaultAddress: null,
    isMainnet: false,
  });
  assert.equal(sig.r, "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54");
  assert.equal(sig.s, "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5");
  assert.equal(sig.v, 27);
});

test("msgpack encodes the order action with the expected map/array framing", () => {
  const b = packb(ORDER_ACTION);
  assert.equal(b[0], 0x83); // fixmap, 3 entries (type, orders, grouping)
  // 'type' key: fixstr len 4
  assert.equal(b[1], 0xa4);
  assert.deepEqual(Array.from(b.subarray(2, 6)), [...Buffer.from("type")]);
});
