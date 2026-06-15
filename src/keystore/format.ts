// Starling Keystore v1 — the on-disk contract SHARED with the Starling-MCP
// server. This file MUST stay byte-compatible across both repos: the wallet
// tool writes these envelopes, the MCP server reads them. See KEYSTORE_FORMAT.md.

export const KEYSTORE_VERSION = 1 as const;

/** Which key a keystore holds. The MCP server routes by this. */
export type Chain = "polygon" | "hyperliquid" | "solana";

export const CHAINS: readonly Chain[] = ["polygon", "hyperliquid", "solana"];

/**
 * "Starling Keystore v1" envelope.
 *
 * NOTE: this is deliberately NOT EIP-2335. EIP-2335 uses unauthenticated
 * aes-128-ctr + a separate SHA-256 checksum gate + scrypt. We use an AEAD
 * (XChaCha20-Poly1305) with a memory-hard KDF (argon2id), which is strictly
 * stronger but NOT importable into stock Ethereum wallets — use `export` for
 * a standard format.
 *
 * There is intentionally NO `aad` field: the AEAD associated data is
 * recomputed from the other fields at decrypt time (see crypto.ts). Storing it
 * would let an attacker who can write the file weaken the KDF params and still
 * pass authentication.
 */
export interface KeystoreV1 {
  version: typeof KEYSTORE_VERSION;
  chain: Chain;
  /** public address / base58 pubkey — NEVER the secret. */
  address: string;
  crypto: {
    kdf: {
      function: "argon2id";
      params: {
        /** memory in KiB */
        m: number;
        /** iterations */
        t: number;
        /** parallelism */
        p: number;
        /** hex */
        salt: string;
      };
    };
    cipher: {
      function: "xchacha20poly1305";
      params: {
        /** hex, 24 bytes */
        nonce: string;
      };
      /** hex ciphertext||tag */
      message: string;
    };
  };
  uuid: string;
}

export function isKeystoreV1(x: unknown): x is KeystoreV1 {
  if (!x || typeof x !== "object") return false;
  const k = x as Record<string, unknown>;
  return (
    k.version === KEYSTORE_VERSION &&
    typeof k.chain === "string" &&
    typeof k.address === "string" &&
    !!k.crypto &&
    typeof k.crypto === "object"
  );
}
