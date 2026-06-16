// src/keystore/crypto.ts
// Starling Keystore v1 — argon2id (memory-hard KDF) + XChaCha20-Poly1305 (AEAD).
//
// This module is the single most security-critical file in the project and is
// kept BYTE-IDENTICAL in the Starling-MCP repo so the two tools interoperate.
// Any change here must keep the shared test vector (test vectors.ts) decrypting.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { argon2id } from "@noble/hashes/argon2";
import { randomBytes } from "node:crypto";
import { KEYSTORE_VERSION, type Chain, type KeystoreV1 } from "./format.js";
import { canonicalTreasuryFields } from "./treasury-seal.js";

// argon2id cost. 64 MiB / t=3 / p=1 is comfortably above OWASP's 2024 minimum.
// On a low-RAM box we fall back to the OWASP floor (19 MiB) and the caller
// surfaces a warning, because at-rest strength then leans on passphrase entropy.
const ARGON2 = { m: 65536, t: 3, p: 1 } as const; // m is in KiB → 64 MiB
export const ARGON2_FLOOR_M = 19456; // 19 MiB

// ---- The integrity binding (do not "optimize" this away) -----------------
// The AEAD associated data is RECOMPUTED from the file's own fields on both
// encrypt and decrypt, and is NEVER written to the file. A sorted-key canonical
// JSON gives a stable byte layout. If an attacker who can write the keystore
// downgrades t=3→t=1 (or shrinks m, or swaps the salt), the recomputed AAD
// differs and Poly1305 verification FAILS — decrypt throws instead of returning
// plaintext under weakened parameters.
function canonicalAad(meta: {
  version: number;
  chain: Chain;
  m: number;
  t: number;
  p: number;
  salt: string;
  /** per-chain sweep/withdraw address bound into the AAD when present. Absent =>
   *  legacy keystore => AAD byte-identical to the pre-treasury format (so old
   *  keystores + the frozen test vectors still decrypt). */
  treasury?: string;
}): Uint8Array {
  const tf = canonicalTreasuryFields({ chain: meta.chain, treasury: meta.treasury });
  const obj: Record<string, unknown> = {
    version: meta.version,
    chain: meta.chain,
    kdf: "argon2id",
    m: meta.m,
    t: meta.t,
    p: meta.p,
    salt: meta.salt,
    cipher: "xchacha20poly1305",
    ...(tf ?? {}), // splice {treasury} ONLY when bound — legacy stays unchanged
  };
  const sorted = Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((a, k) => ((a[k] = obj[k]), a), {});
  return new TextEncoder().encode(JSON.stringify(sorted));
}

// Derive the 32-byte AEAD key. Returns a Buffer the caller MUST fill(0).
function deriveKey(
  passphrase: Uint8Array,
  saltHex: string,
  m: number,
  t: number,
  p: number,
): Buffer {
  const salt = Buffer.from(saltHex, "hex");
  const dk = argon2id(passphrase, salt, { m, t, p, dkLen: 32 });
  return Buffer.from(dk); // copy into a Buffer we own + can zeroize
}

export interface EncryptResult {
  keystore: KeystoreV1;
  loweredKdf: boolean;
}

/**
 * Encrypt a raw secret (32-byte seed / private key) to a Starling Keystore v1.
 * `secret` and `passphrase` are owned by the CALLER and should be zeroized
 * afterwards. A fresh random salt AND 24-byte nonce are drawn on EVERY call, so
 * re-encrypting the same secret under the same passphrase (rotate/re-key) never
 * reuses a nonce.
 */
export function encryptKeystore(
  secret: Uint8Array,
  passphrase: Uint8Array,
  chain: Chain,
  address: string,
  uuid: string,
  opts?: { lowRam?: boolean; treasury?: string },
): EncryptResult {
  const m = opts?.lowRam ? ARGON2_FLOOR_M : ARGON2.m;
  const t = ARGON2.t;
  const p = ARGON2.p;
  const salt = randomBytes(16).toString("hex");
  const nonce = randomBytes(24); // XChaCha20 192-bit nonce — safe under random
  // Store the NORMALIZED treasury so the displayed value == the authenticated one.
  const treasury = canonicalTreasuryFields({ chain, treasury: opts?.treasury })?.treasury;

  const key = deriveKey(passphrase, salt, m, t, p);
  try {
    const aad = canonicalAad({ version: KEYSTORE_VERSION, chain, m, t, p, salt, treasury });
    const ct = xchacha20poly1305(key, nonce, aad).encrypt(secret);
    return {
      loweredKdf: !!opts?.lowRam,
      keystore: {
        version: KEYSTORE_VERSION,
        chain,
        address,
        ...(treasury ? { treasury } : {}),
        uuid,
        crypto: {
          kdf: { function: "argon2id", params: { m, t, p, salt } },
          cipher: {
            function: "xchacha20poly1305",
            params: { nonce: Buffer.from(nonce).toString("hex") },
            message: Buffer.from(ct).toString("hex"),
          },
        },
      },
    };
  } finally {
    key.fill(0); // best-effort zeroization of the derived key
  }
}

/**
 * Decrypt a Starling Keystore v1. Returns the raw secret in a Buffer the CALLER
 * MUST fill(0) immediately after deriving the keypair. Throws on ANY tampering
 * (wrong passphrase OR altered KDF params/salt) — never returns plaintext on a
 * tag mismatch.
 */
export function decryptKeystore(ks: KeystoreV1, passphrase: Uint8Array): Buffer {
  if (ks.version !== KEYSTORE_VERSION) {
    throw new Error(`unsupported keystore version ${ks.version}`);
  }
  if (
    ks.crypto.kdf.function !== "argon2id" ||
    ks.crypto.cipher.function !== "xchacha20poly1305"
  ) {
    throw new Error("unsupported keystore crypto suite");
  }
  const { m, t, p, salt } = ks.crypto.kdf.params;
  const key = deriveKey(passphrase, salt, m, t, p);
  try {
    // AAD recomputed from the file's OWN fields — this is what authenticates them
    // (incl. the bound treasury, if any: a swapped treasury fails the tag).
    const aad = canonicalAad({ version: ks.version, chain: ks.chain, m, t, p, salt, treasury: ks.treasury });
    const nonce = Buffer.from(ks.crypto.cipher.params.nonce, "hex");
    const ct = Buffer.from(ks.crypto.cipher.message, "hex");
    const pt = xchacha20poly1305(key, nonce, aad).decrypt(ct); // throws on bad tag
    return Buffer.from(pt);
  } finally {
    key.fill(0);
  }
}
