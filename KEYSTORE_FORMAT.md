# Starling Keystore v1 — shared format

This file is the **contract between [Agent-Wallet-Setup](https://github.com/thedopetoad/Agent-Wallet-Setup)
(the producer) and [Starling-MCP](https://github.com/thedopetoad/Starling-MCP)
(the consumer)**. The wallet tool writes these envelopes; the MCP reads
and decrypts them to sign. `src/keystore/crypto.ts` is kept **byte-identical**
in both repos and both ship the same decryption test vector
(`src/keystore/vectors.ts`), so any drift breaks CI in one of them.

> This is **not** EIP-2335. EIP-2335 uses unauthenticated `aes-128-ctr` + a
> separate SHA-256 checksum gate + scrypt. We use an AEAD (`XChaCha20-Poly1305`)
> with a memory-hard KDF (`argon2id`), which is strictly stronger but **not**
> importable into MetaMask/geth — use `agent-wallet export` for a standard file.

## Envelope

```jsonc
{
  "version": 1,
  "chain": "polygon" | "hyperliquid" | "solana",
  "address": "0x… (EVM) | base58 (Solana)",   // public; NEVER the secret
  "crypto": {
    "kdf": {
      "function": "argon2id",
      "params": { "m": 65536, "t": 3, "p": 1, "salt": "<hex, 16 bytes>" }
    },
    "cipher": {
      "function": "xchacha20poly1305",
      "params": { "nonce": "<hex, 24 bytes>" },
      "message": "<hex ciphertext || 16-byte Poly1305 tag>"
    }
  },
  "uuid": "<random>"
}
```

## Sealed plaintext, per chain

| chain        | curve      | sealed secret                                   |
|--------------|------------|-------------------------------------------------|
| `polygon`    | secp256k1  | 32-byte private key (Polymarket owner EOA)      |
| `hyperliquid`| secp256k1  | 32-byte private key (HL **agent** key)          |
| `solana`     | ed25519    | 32-byte **seed** (exportable; not a CryptoKey)  |

## KDF

- `argon2id`, memory `m` in **KiB** (default `65536` = 64 MiB), iterations
  `t=3`, parallelism `p=1`, output `dkLen=32`.
- Low-RAM hosts fall back to the OWASP floor `m=19456` (19 MiB); the params are
  always stored in-file so decryption is self-describing.

## AEAD + the integrity binding (important)

- `XChaCha20-Poly1305`, 32-byte key (the argon2id output), **24-byte random
  nonce** (large enough that random nonces are safe), 16-byte tag.
- A **fresh random salt AND nonce are drawn on every encrypt** (including
  rotate/re-key), so the same passphrase never reuses a key+nonce pair.
- **There is no `aad` field.** The AEAD associated data is the UTF-8 of a
  sorted-key canonical JSON of `{version, chain, kdf:"argon2id", m, t, p, salt,
  cipher:"xchacha20poly1305"}`, **recomputed from the file's own fields at
  decrypt time**. If a tag verifies, those parameters are cryptographically
  confirmed un-tampered — an attacker who can write the file cannot downgrade
  `t`/`m` or swap the salt without failing authentication.

## Canonical AAD byte layout

```
JSON.stringify( sortKeys({
  version: <number>, chain: <string>, kdf: "argon2id",
  m: <number>, t: <number>, p: <number>, salt: <hex string>,
  cipher: "xchacha20poly1305"
}) )  // then UTF-8 encode
```

Sorting is by `Object.keys().sort()` (lexicographic). Reproduce this exactly in
any other implementation or decryption will fail.

## On-disk

- Location: `~/.starling/keystore/<chain>.keystore.json` (override the root with
  `STARLING_DIR`).
- Created atomically with `O_CREAT|O_EXCL|O_WRONLY` at mode `0600` (POSIX) or a
  user-only DACL via `icacls` (Windows). Loaders **refuse** a group/world-
  readable file.

## Version policy

`version` is a hard gate. A consumer that doesn't recognise the version MUST
refuse rather than guess. Bump it for any change to the KDF/AEAD suite or the
canonical-AAD layout.
