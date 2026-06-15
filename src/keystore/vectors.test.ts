// src/keystore/vectors.test.ts
// Proves THIS repo (the MCP/consumer) decrypts the SHARED frozen keystore vector
// — the same file ships in Agent-Wallet-Setup (the producer). If crypto.ts drifts
// incompatibly, this fails here, guaranteeing the two repos stay interoperable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptKeystore } from "./crypto.js";
import { privateKeyToEvmAddress, seedToSolanaAddress } from "../addr.js";
import { VECTORS, VECTOR_PASSPHRASE } from "./vectors.js";

for (const v of VECTORS) {
  test(`MCP decrypts the shared ${v.chain} vector and re-derives its address`, () => {
    const secret = decryptKeystore(v.keystore, Buffer.from(VECTOR_PASSPHRASE, "utf8"));
    assert.equal(Buffer.from(secret).toString("hex"), v.secretHex);
    const derived =
      v.chain === "solana" ? seedToSolanaAddress(secret) : privateKeyToEvmAddress(secret);
    assert.equal(derived, v.address);
    secret.fill(0);
  });
}
