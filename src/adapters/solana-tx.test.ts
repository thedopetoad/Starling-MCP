// src/adapters/solana-tx.test.ts
// Self-consistency for the Solana signer: shortvec round-trips, and a synthetic v0
// tx that we sign then verify with ed25519 over the exact message bytes — proving
// the parse offsets, "sign the whole message incl 0x80", and slot-0 placement are
// correct. Also proves we REFUSE a tx whose fee payer isn't us.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import {
  readShortVec,
  writeShortVec,
  readFeePayer,
  signTransaction,
  SolanaTxError,
} from "./solana-tx.js";

test("shortvec encodes/decodes round-trip", () => {
  for (const n of [0, 1, 127, 128, 255, 256, 16383, 16384, 65535]) {
    const bytes = Uint8Array.from(writeShortVec(n));
    const [v, len] = readShortVec(bytes, 0);
    assert.equal(v, n, `value ${n}`);
    assert.equal(len, bytes.length);
  }
  // 0-127 fit in a single byte
  assert.equal(writeShortVec(5).length, 1);
  assert.equal(writeShortVec(200).length, 2);
});

// Build a synthetic UNSIGNED v0 tx: shortvec(1) + 64 zero bytes + message.
// message = 0x80 | header[1,0,0] | shortvec(1) | pubkey32 | blockhash32 |
//           shortvec(0) instrs | shortvec(0) lookups
function syntheticUnsignedTx(feePayerPubkey: Uint8Array): { b64: string; message: Uint8Array } {
  const blockhash = new Uint8Array(32).fill(7);
  const msg = [
    0x80, // v0 version prefix
    1, 0, 0, // header: 1 required sig, 0 ro-signed, 0 ro-unsigned
    1, // shortvec: 1 static account key
    ...feePayerPubkey, // account[0] = fee payer
    ...blockhash, // recent blockhash
    0, // shortvec: 0 instructions
    0, // shortvec: 0 address-table lookups
  ];
  const message = Uint8Array.from(msg);
  const tx = [1 /* shortvec sigCount=1 */, ...new Array(64).fill(0), ...msg];
  return { b64: Buffer.from(Uint8Array.from(tx)).toString("base64"), message };
}

const signerFor = (seed: Uint8Array) => ({
  address: base58.encode(ed25519.getPublicKey(seed)),
  signBytes: (m: Uint8Array) => ed25519.sign(m, seed),
});

test("signTransaction signs the full message, fills slot 0, returns the txid", () => {
  const seed = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(seed);
  const address = base58.encode(pub);

  const { b64, message } = syntheticUnsignedTx(pub);
  const { signedTxB64, txid } = signTransaction(b64, signerFor(seed));

  // The signature ed25519-verifies over the exact message bytes.
  const signed = Uint8Array.from(Buffer.from(signedTxB64, "base64"));
  const slot0 = signed.subarray(1, 65); // after shortvec(1)
  assert.ok(ed25519.verify(slot0, message, pub), "slot-0 signature verifies over the message");
  // txid is base58 of the first signature.
  assert.equal(txid, base58.encode(slot0));
  // readFeePayer agrees account[0] is us.
  assert.equal(readFeePayer(message).feePayer, address);
  assert.equal(readFeePayer(message).numRequiredSignatures, 1);
});

test("readShortVec fails closed on truncation (continuation bit, no next byte)", () => {
  assert.throws(
    () => readShortVec(Uint8Array.from([0x80]), 0),
    (e: unknown) => e instanceof SolanaTxError && e.code === "truncated",
  );
});

test("readFeePayer rejects a too-short message", () => {
  assert.throws(
    () => readFeePayer(Uint8Array.from([0x80, 1])),
    (e: unknown) => e instanceof SolanaTxError && e.code === "truncated",
  );
});

test("signTransaction REFUSES when the fee payer isn't us", () => {
  const seed = ed25519.utils.randomPrivateKey();
  const otherPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  const { b64 } = syntheticUnsignedTx(otherPub);
  assert.throws(
    () => signTransaction(b64, signerFor(seed)),
    (e: unknown) => e instanceof SolanaTxError && e.code === "fee_payer_mismatch",
  );
});
