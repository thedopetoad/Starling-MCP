// src/addr.ts
// Public-address derivation from a decrypted secret. Mirrors the wallet repo's
// keygen helpers so the MCP can confirm a decrypted keystore yields the address
// the keystore claims (used by `verify`, `get_wallet_addresses`, and the shared
// interop test). No viem dependency — keccak via @noble.
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58 } from "@scure/base";

/** EIP-55 checksummed address from a secp256k1 private key. */
export function privateKeyToEvmAddress(secret: Uint8Array): `0x${string}` {
  const pub = secp256k1.getPublicKey(secret, false); // 0x04 || X || Y
  const hashed = keccak_256(pub.slice(1));
  const lower = Buffer.from(hashed.slice(-20)).toString("hex");
  const checkHash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString("hex");
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(checkHash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out as `0x${string}`;
}

/** base58 ed25519 pubkey (Solana address) from a 32-byte seed. */
export function seedToSolanaAddress(seed: Uint8Array): string {
  return base58.encode(ed25519.getPublicKey(seed));
}
