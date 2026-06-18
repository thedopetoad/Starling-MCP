// src/withdraw/allowlist.test.ts
// Proves the two security properties the withdraw guardrail MUST hold at Tier-0:
//
//   (A) A non-allowlisted destination is rejected. build_withdraw_tx exposes no
//       recipient argument; the resolver only ever returns the sealed treasury,
//       and validate_intent's recipient assertion rejects any other address.
//
//   (B) The treasury cannot be SILENTLY changed on disk. The treasury is folded
//       into the keystore AEAD associated data (AAD); flipping it in the file
//       makes decrypt THROW (Poly1305 tag mismatch) instead of returning the key
//       under a swapped destination. (Tamper-EVIDENT — see honest-ceiling note.)
//
// Run: node --test dist/withdraw/allowlist.test.js
//
// The AAD round-trip uses the SAME primitives as keystore/crypto.ts
// (xchacha20poly1305 + a recompute-from-fields canonical AAD) so the test is a
// faithful proxy for the production seal, not a mock.

import test from "node:test";
import assert from "node:assert/strict";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "node:crypto";
import {
  resolveWithdrawRecipient,
  assertRecipientIsTreasury,
  WithdrawError,
  cmpDecimal,
  chainSource,
  canWithdraw,
  type SealedTreasury,
} from "./allowlist.js";
import { canonicalTreasuryFields } from "../keystore/treasury-seal.js";

const TREASURY = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";

const sealed: SealedTreasury = {
  sealed: true,
  byChain: { polygon: TREASURY },
};

// ── (A) recipient guardrail ───────────────────────────────────────────────

test("resolveWithdrawRecipient returns ONLY the sealed treasury", () => {
  const out = resolveWithdrawRecipient(sealed, {
    chain: "polygon",
    amount: "100",
    maxPerCall: "1000",
  });
  assert.equal(out.recipient, TREASURY);
});

test("a built withdraw to a non-allowlisted (attacker) address is rejected", () => {
  // Simulates validate_intent seeing a BUILT artifact whose recipient was swapped.
  assert.throws(
    () => assertRecipientIsTreasury(sealed, "polygon", ATTACKER),
    (e: unknown) =>
      e instanceof WithdrawError && e.code === "recipient_not_allowed",
  );
});

test("the treasury equality check is checksum-agnostic on EVM but exact on Solana", () => {
  // EVM: different checksum casing is still the same address → accepted.
  assert.doesNotThrow(() =>
    assertRecipientIsTreasury(sealed, "polygon", TREASURY.toUpperCase()),
  );
  // Solana: base58 is case-significant → a recased "treasury" is NOT equal.
  const sol: SealedTreasury = { sealed: true, byChain: { solana: "So1aNaTreasuryPubkey111" } };
  assert.throws(
    () => assertRecipientIsTreasury(sol, "solana", "so1anatreasurypubkey111"),
    WithdrawError,
  );
});

test("withdraw refused when no treasury is sealed", () => {
  const unsealed: SealedTreasury = { sealed: false, byChain: {} };
  assert.throws(
    () => resolveWithdrawRecipient(unsealed, { chain: "polygon", amount: "1", maxPerCall: "1000" }),
    (e: unknown) => e instanceof WithdrawError && e.code === "treasury_not_sealed",
  );
});

test("withdraw refused when the chain has no sealed treasury", () => {
  assert.throws(
    () => resolveWithdrawRecipient(sealed, { chain: "solana", amount: "1", maxPerCall: "1000" }),
    (e: unknown) => e instanceof WithdrawError && e.code === "no_treasury_for_chain",
  );
});

test("withdraw refused when amount exceeds the per-call cap (decimal-safe)", () => {
  assert.throws(
    () => resolveWithdrawRecipient(sealed, { chain: "polygon", amount: "1000.01", maxPerCall: "1000" }),
    (e: unknown) => e instanceof WithdrawError && e.code === "amount_exceeds_cap",
  );
  // boundary: exactly the cap is allowed
  assert.doesNotThrow(() =>
    resolveWithdrawRecipient(sealed, { chain: "polygon", amount: "1000.00", maxPerCall: "1000" }),
  );
});

test("cmpDecimal orders by integer length then lexical fraction (no float drift)", () => {
  assert.equal(cmpDecimal("9", "10"), -1); // integer-length compare, not "9">"1"
  assert.equal(cmpDecimal("1.5", "1.50"), 0);
  assert.equal(cmpDecimal("0.2", "0.19"), 1);
});

// ── (A2) dashboard-pinned source + per-chain provenance ───────────────────

test("a dashboard-pinned destination is withdraw-eligible (sealed stays false)", () => {
  const pinned: SealedTreasury = {
    sealed: false, // never raised by the file — only the keystore seals
    byChain: { polygon: TREASURY },
    sourceByChain: { polygon: "dashboard" },
  };
  const out = resolveWithdrawRecipient(pinned, { chain: "polygon", amount: "10", maxPerCall: "100" });
  assert.equal(out.recipient, TREASURY);
});

test("assertRecipientIsTreasury accepts a dashboard-pinned destination", () => {
  const pinned: SealedTreasury = {
    sealed: false,
    byChain: { polygon: TREASURY },
    sourceByChain: { polygon: "dashboard" },
  };
  assert.doesNotThrow(() => assertRecipientIsTreasury(pinned, "polygon", TREASURY));
  assert.throws(
    () => assertRecipientIsTreasury(pinned, "polygon", ATTACKER),
    (e: unknown) => e instanceof WithdrawError && e.code === "recipient_not_allowed",
  );
});

test("a keystore/dashboard conflict refuses the withdraw (fail-closed)", () => {
  const conflicted: SealedTreasury = {
    sealed: true,
    byChain: { polygon: TREASURY },
    sourceByChain: { polygon: "conflict" },
  };
  assert.throws(
    () => resolveWithdrawRecipient(conflicted, { chain: "polygon", amount: "1", maxPerCall: "100" }),
    (e: unknown) => e instanceof WithdrawError && e.code === "treasury_conflict",
  );
  assert.throws(
    () => assertRecipientIsTreasury(conflicted, "polygon", TREASURY),
    (e: unknown) => e instanceof WithdrawError && e.code === "treasury_conflict",
  );
});

test("chainSource: explicit per-chain source wins; legacy {sealed,byChain} derives", () => {
  assert.equal(chainSource({ sealed: true, byChain: { polygon: TREASURY } }, "polygon"), "keystore");
  assert.equal(chainSource({ sealed: false, byChain: {} }, "polygon"), "none");
  assert.equal(
    chainSource({ sealed: false, byChain: { solana: "x" }, sourceByChain: { solana: "dashboard" } }, "solana"),
    "dashboard",
  );
  // per-chain mixed: polygon keystore-sealed, solana dashboard-pinned
  const mixed: SealedTreasury = {
    sealed: true,
    byChain: { polygon: TREASURY, solana: "So1aNa" },
    sourceByChain: { polygon: "keystore", solana: "dashboard" },
  };
  assert.equal(chainSource(mixed, "polygon"), "keystore");
  assert.equal(chainSource(mixed, "solana"), "dashboard");
  assert.deepEqual([canWithdraw("keystore"), canWithdraw("dashboard"), canWithdraw("none"), canWithdraw("conflict")], [true, true, false, false]);
});

// ── (B) the allowlist cannot be SILENTLY changed (AAD tamper-evidence) ─────

// Faithful proxy of keystore/crypto.ts: AAD is recomputed from fields (incl. the
// treasury fragment) and NEVER stored. Swap the on-disk treasury → AAD differs →
// Poly1305 tag mismatch → decrypt throws.
function canonicalAadWithTreasury(meta: {
  chain: "polygon" | "solana";
  treasury?: string;
}): Uint8Array {
  const tf = canonicalTreasuryFields({ chain: meta.chain, treasury: meta.treasury });
  const obj: Record<string, unknown> = {
    version: 1,
    chain: meta.chain,
    kdf: "argon2id",
    cipher: "xchacha20poly1305",
    ...(tf ?? {}), // splice {treasury} only when bound (legacy keystores omit it)
  };
  const sorted = Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((a, k) => ((a[k] = obj[k]), a), {});
  return new TextEncoder().encode(JSON.stringify(sorted));
}

test("(B) silently editing the sealed treasury on disk makes decrypt THROW", () => {
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const secret = randomBytes(32); // stand-in private key
  const chain = "polygon" as const;

  // SEAL: encrypt with the treasury bound into the AAD.
  const goodAad = canonicalAadWithTreasury({ chain, treasury: TREASURY });
  const ct = xchacha20poly1305(key, nonce, goodAad).encrypt(secret);

  // ATTACK: the agent rewrites the treasury field on disk to its own address and
  // tries to decrypt. The AAD is recomputed from the (tampered) field, so it no
  // longer matches the tag.
  const tamperedAad = canonicalAadWithTreasury({ chain, treasury: ATTACKER });
  assert.throws(
    () => xchacha20poly1305(key, nonce, tamperedAad).decrypt(ct),
    /tag|invalid|auth/i,
    "decrypt must throw when the bound treasury was swapped",
  );

  // CONTROL: with the original treasury the same blob decrypts cleanly, so the
  // throw above is caused by the treasury swap, not by setup.
  const back = xchacha20poly1305(key, nonce, goodAad).decrypt(ct);
  assert.deepEqual(Buffer.from(back), Buffer.from(secret));
});

test("(B') legacy keystore with NO bound treasury still authenticates", () => {
  // Forward-compat: a pre-seal keystore omits the treasury fragment from the AAD.
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const secret = randomBytes(32);
  const aad = canonicalAadWithTreasury({ chain: "polygon", treasury: undefined });
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(secret);
  const back = xchacha20poly1305(key, nonce, aad).decrypt(ct);
  assert.deepEqual(Buffer.from(back), Buffer.from(secret));
});
