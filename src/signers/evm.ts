// src/signers/evm.ts
// In-process secp256k1 signer built from a decrypted secret. Signs 32-byte
// digests (EVM tx/EIP-712/HL action hashes are all "sign this digest"). The
// raw secret is captured into an internal Uint8Array; callers never see it.
import { secp256k1 } from "@noble/curves/secp256k1";
import { privateKeyToEvmAddress } from "../addr.js";

export interface EvmSigner {
  address: `0x${string}`;
  /** Sign a 32-byte digest. Returns a 65-byte rsv signature (r||s||v, v∈{27,28}). */
  signDigest(digest: Uint8Array): Uint8Array;
}

export function makeEvmSigner(secret: Uint8Array): EvmSigner {
  const key = Uint8Array.from(secret); // own copy; caller zeroizes its buffer
  const address = privateKeyToEvmAddress(key);
  return {
    address,
    signDigest(digest: Uint8Array): Uint8Array {
      const sig = secp256k1.sign(digest, key); // RFC6979 deterministic
      const rsv = new Uint8Array(65);
      rsv.set(sig.toCompactRawBytes(), 0);
      rsv[64] = 27 + (sig.recovery ?? 0);
      return rsv;
    },
  };
}
