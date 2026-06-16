// src/keysource/types.ts
// The modular key layer. The MCP signs IDENTICALLY no matter where the secret
// comes from — an encrypted keystore (the safe path), a plaintext env var or
// file (the easy path), or a future source (OS keychain, cloud KMS, a hosted
// signer). Add a source by implementing this interface and registering it in
// ./index.ts. Nothing else in the server changes.
import type { Chain } from "../keystore/format.js";

/** A secret resolved for one chain. The CALLER must zeroize `secret` after use. */
export interface ChainSecret {
  chain: Chain;
  /** 32-byte secp256k1 private key (EVM) or ed25519 seed (Solana). */
  secret: Buffer;
  /** AAD-authenticated sweep/withdraw address, present only from the encrypted
   *  keystore source (where decrypt verified it). Plaintext sources omit it, so
   *  the withdraw guardrail refuses (treasury_not_sealed) until one is sealed. */
  treasury?: string;
}

export interface KeySource {
  /** stable id surfaced in auth_check, e.g. "keystore" | "env" | "file". */
  readonly id: string;
  /** true if the secrets this source returns sit in plaintext (drives a warning). */
  readonly plaintext: boolean;
  /** is this source's material present in the current environment? */
  available(): Promise<boolean>;
  /** one-line human description for logs / auth_check. */
  describe(): string;
  /** load the available secrets per chain. The caller zeroizes each `.secret`. */
  load(): Promise<ChainSecret[]>;
}
