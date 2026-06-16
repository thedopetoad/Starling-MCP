// src/keystore/treasury.test.ts — proves the treasury is sealed into the AAD:
// it round-trips, is stored normalized, and a swap makes decrypt THROW.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { encryptKeystore, decryptKeystore } from "./crypto.js";

const PASS = () => Buffer.from("correct horse battery staple", "utf8");
const TREASURY = "0xAbC0000000000000000000000000000000000123";
const ATTACKER = "0x2222222222222222222222222222222222222222";

test("treasury round-trips and is stored NORMALIZED (lowercase EVM)", () => {
  const secret = randomBytes(32);
  const { keystore } = encryptKeystore(secret, PASS(), "polygon", "0xabc", randomUUID(), {
    treasury: TREASURY,
  });
  assert.equal(keystore.treasury, TREASURY.toLowerCase());
  const out = decryptKeystore(keystore, PASS());
  assert.equal(Buffer.compare(secret, out), 0);
});

test("swapping the sealed treasury on disk makes decrypt THROW (AAD tamper-evidence)", () => {
  const { keystore } = encryptKeystore(randomBytes(32), PASS(), "polygon", "0xabc", randomUUID(), {
    treasury: TREASURY,
  });
  const tampered = JSON.parse(JSON.stringify(keystore));
  tampered.treasury = ATTACKER.toLowerCase();
  assert.throws(() => decryptKeystore(tampered, PASS()), /./);
});

test("a keystore with NO treasury still round-trips (legacy compat)", () => {
  const secret = randomBytes(32);
  const { keystore } = encryptKeystore(secret, PASS(), "solana", "pk", randomUUID());
  assert.equal(keystore.treasury, undefined);
  const out = decryptKeystore(keystore, PASS());
  assert.equal(Buffer.compare(secret, out), 0);
});
