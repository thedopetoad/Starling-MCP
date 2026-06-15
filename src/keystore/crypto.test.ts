// src/keystore/crypto.test.ts — run with `npm test` (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { encryptKeystore, decryptKeystore } from "./crypto.js";

test("round-trips a 32-byte secret", () => {
  const secret = randomBytes(32);
  const pass = Buffer.from("correct horse battery staple", "utf8");
  const { keystore } = encryptKeystore(secret, pass, "polygon", "0xabc", randomUUID());
  const out = decryptKeystore(keystore, Buffer.from("correct horse battery staple", "utf8"));
  assert.equal(Buffer.compare(secret, out), 0);
});

test("rejects a wrong passphrase", () => {
  const { keystore } = encryptKeystore(
    randomBytes(32),
    Buffer.from("right-passphrase-12"),
    "solana",
    "pk",
    randomUUID(),
  );
  assert.throws(() => decryptKeystore(keystore, Buffer.from("wrong-passphrase-12")));
});

test("rejects a KDF-param downgrade (AAD binding authenticates t/m/salt)", () => {
  const pass = () => Buffer.from("correct horse battery staple", "utf8");
  const { keystore } = encryptKeystore(randomBytes(32), pass(), "hyperliquid", "0xdef", randomUUID());
  // Attacker downgrades the argon2id work factor t=3 -> t=1.
  const tampered = JSON.parse(JSON.stringify(keystore));
  tampered.crypto.kdf.params.t = 1;
  assert.throws(() => decryptKeystore(tampered, pass()), /./); // tag mismatch
});

test("fresh nonce + salt on every encrypt (no reuse under same passphrase)", () => {
  const secret = randomBytes(32);
  const pass = Buffer.from("correct horse battery staple", "utf8");
  const a = encryptKeystore(secret, pass, "polygon", "0xabc", randomUUID()).keystore;
  const b = encryptKeystore(secret, pass, "polygon", "0xabc", randomUUID()).keystore;
  assert.notEqual(a.crypto.cipher.params.nonce, b.crypto.cipher.params.nonce);
  assert.notEqual(a.crypto.kdf.params.salt, b.crypto.kdf.params.salt);
});
