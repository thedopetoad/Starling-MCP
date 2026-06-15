// src/keysource/parse.ts
// Parse a pasted/stored private key string into the raw 32-byte secret the
// signers expect. Shared by the env and file key sources.
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";

/** secp256k1 private key (hex, optional 0x) -> 32-byte Buffer. */
export function parseEvmSecret(input: string): Buffer {
  const hex = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("EVM private key must be 32 bytes of hex (64 chars, optional 0x prefix)");
  }
  const b = Buffer.from(hex, "hex");
  if (!secp256k1.utils.isValidPrivateKey(b)) throw new Error("not a valid secp256k1 private key");
  return b;
}

/**
 * Solana key -> 32-byte ed25519 SEED. Accepts base58 (32-byte seed or 64-byte
 * secret key, the Phantom/solana-keygen format) or hex. For a 64-byte secret
 * key (seed||pubkey) the embedded pubkey is verified against the seed so a
 * malformed paste fails loudly instead of signing for the wrong address.
 */
export function parseSolanaSeed(input: string): Buffer {
  const s = input.trim();
  const hex = s.replace(/^0x/i, "");
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]+$/.test(hex) && (hex.length === 64 || hex.length === 128)) {
    bytes = Buffer.from(hex, "hex");
  } else {
    try {
      bytes = base58.decode(s);
    } catch {
      throw new Error("Solana key must be base58 or hex (32-byte seed or 64-byte secret key)");
    }
  }
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error("Solana key must be 32 bytes (seed) or 64 bytes (secret key)");
  }
  const seed = Buffer.from(bytes.subarray(0, 32));
  if (bytes.length === 64) {
    const derived = ed25519.getPublicKey(seed);
    if (Buffer.compare(Buffer.from(derived), Buffer.from(bytes.subarray(32))) !== 0) {
      throw new Error("Solana 64-byte secret key is malformed (pubkey half does not match the seed)");
    }
  }
  return seed;
}
