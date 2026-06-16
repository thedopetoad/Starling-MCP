// src/keystore/treasury-seal.ts
// Extends the Starling Keystore v1 integrity binding to cover the per-chain
// treasury (sweep) address.
//
// WHY: today the treasury lives in a PLAINTEXT .starling/config.json the running
// agent can rewrite before calling withdraw. Binding it into the AEAD associated
// data (AAD) — which crypto.ts recomputes from the file's own fields and never
// stores — makes an on-disk treasury edit fail Poly1305 verification: decrypt
// THROWS rather than silently signing a sweep to a swapped address.
//
// SCOPE OF THE GUARANTEE (do not overclaim): this is TAMPER-EVIDENCE for the
// honest withdraw path. It does NOT stop a code-exec'd agent that already holds
// the decrypted key from signing a raw transfer to anywhere (see
// withdraw/allowlist.ts honest ceiling). Cryptographic recipient enforcement is
// HL-native + Tier-1 smart accounts only.
//
// This file is kept BYTE-IDENTICAL with Agent-Wallet-Setup/src/keystore/
// treasury-seal.ts so the canonical AAD matches across producer and consumer.
// The producer (wizard) SEALS; the consumer (MCP) RECOVERS + VERIFIES.

import type { Chain } from "./format.js";

/**
 * The treasury fields that get folded into the canonical AAD. Sorted-key
 * canonical JSON gives a stable byte layout; both repos must build it the same
 * way or decryption breaks cross-repo (the very tamper-evidence we want).
 *
 * `treasury` is an OPTIONAL extension of the v1 AAD. A keystore written before
 * this change has no treasury and recomputes the OLD AAD (treasury absent), so
 * legacy keystores still decrypt — see canonicalTreasuryFields() returning
 * undefined when no address is bound.
 */
export interface TreasuryBinding {
  chain: Chain;
  /** lowercased EVM address / base58 Solana pubkey; "" or undefined = unbound. */
  treasury?: string;
}

/**
 * Produce the canonical treasury fragment to splice into the AEAD AAD object,
 * or `undefined` when no treasury is bound (preserving the legacy AAD shape so
 * old keystores still authenticate). Returned as a stable-ordered plain object;
 * the crypto layer JSON-stringifies the merged, sorted AAD object.
 */
export function canonicalTreasuryFields(
  b: TreasuryBinding,
): { treasury: string } | undefined {
  if (!b.treasury) return undefined;
  const norm = b.chain === "solana" ? b.treasury : b.treasury.toLowerCase();
  return { treasury: norm };
}

/**
 * A short, human-verifiable commitment to the bound treasury, printed on the
 * offline RECOVERY-SHEET so the user can detect drift out-of-band. NOT a
 * security control on its own — a convenience for the human. Uses the same
 * @noble/hashes the keystore already depends on (no new dep).
 */
export async function treasuryCommitment(
  b: TreasuryBinding,
): Promise<string | undefined> {
  const f = canonicalTreasuryFields(b);
  if (!f) return undefined;
  const { sha256 } = await import("@noble/hashes/sha2");
  const bytes = new TextEncoder().encode(`${b.chain}:${f.treasury}`);
  const h = sha256(bytes);
  // first 4 bytes, hex — enough to eyeball, not a full preimage surface.
  return Array.from(h.slice(0, 4))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
