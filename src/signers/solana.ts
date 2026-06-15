// src/signers/solana.ts
// In-process ed25519 signer. Re-imports the decrypted 32-byte SEED (the wallet
// tool sealed a raw seed precisely so this works — a non-extractable WebCrypto
// key could not be imported here) and signs with @noble directly (byte-array
// API, no hex-string boundary).
import { ed25519 } from "@noble/curves/ed25519";
import { seedToSolanaAddress } from "../addr.js";

export interface SolanaSigner {
  address: string; // base58 pubkey
  signBytes(message: Uint8Array): Uint8Array; // 64-byte detached signature
}

export function makeSolanaSigner(seed: Uint8Array): SolanaSigner {
  const secret = Uint8Array.from(seed); // own copy
  const address = seedToSolanaAddress(secret);
  return {
    address,
    signBytes(message: Uint8Array): Uint8Array {
      return ed25519.sign(message, secret);
    },
  };
}
