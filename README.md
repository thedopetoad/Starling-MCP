# Starling Execution MCP

**The Execution Layer for Agentic Trading.** A local, non-custodial
[MCP](https://modelcontextprotocol.io) server your trading bot connects to over
stdio. It signs **locally** and **never holds your funds**.

It's built to work for *everyone*: the MCP is **modular about where your keys
come from** — paste a plaintext key and go, or layer in the encrypted
[Agent-Wallet-Setup](https://github.com/thedopetoad/Agent-Wallet-Setup) keystore
when you want safety. Same server, same signing, either way.

> **Prerequisite:** Node 20+ on your `PATH`. MCP hosts (Claude Desktop, Cursor)
> don't bundle Node. `starling-mcp doctor` checks this.

## Quick start (easiest path — plaintext)

```bash
npm install && npm run build

# paste your keys and run — zero setup:
STARLING_KEY_SOURCE=env \
STARLING_PK_POLYGON=0x… \
STARLING_PK_HYPERLIQUID=0x… \
STARLING_PK_SOLANA=<base58|hex> \
  node dist/bin/starling-mcp.js verify     # prints the addresses it loaded
```

Plaintext is fine for testnet / small float — the server warns you. When you
want real safety, switch to the encrypted keystore (below) by changing one env var.

## How the MCP gets your keys (modular)

`STARLING_KEY_SOURCE` selects where signing secrets come from. The MCP signs
**identically** regardless — only the source differs.

| `STARLING_KEY_SOURCE` | where keys come from | security | setup |
|---|---|---|---|
| `env` | `STARLING_PK_POLYGON` / `_HYPERLIQUID` / `_SOLANA` | plaintext | paste & go |
| `file` | `keys.plain.json` (`STARLING_KEYS_FILE`) | plaintext | one file |
| `keystore` | encrypted keystore from `agent-wallet` | **encrypted at rest** | one command |
| `auto` *(default)* | first available, most-secure first (keystore → env → file) | — | — |

- **`env` / `file`** are the easy paths. Keys are plaintext (readable by anything
  that can read this process), so the server logs a loud warning. Good for
  testnet and getting started.
- **`keystore`** is the safe path: per-chain keys encrypted with argon2id +
  XChaCha20-Poly1305, created by
  [Agent-Wallet-Setup](https://github.com/thedopetoad/Agent-Wallet-Setup) (which
  needs nothing but Node). Unlocked at boot — see [unlock modes](#unlock-modes-keystore-source).
- **`auto`** means a user who ran `agent-wallet` automatically gets their
  encrypted keystore, while someone who only pasted an env key still just works.

**Add your own source** (OS keychain, cloud KMS, a hosted signer): implement the
`KeySource` interface in `src/keysource/` and register it in `src/keysource/index.ts`.
Nothing else in the server changes — that's the whole point of the layer.

Solana key formats accepted: base58 (32-byte seed or 64-byte secret key) or hex.
EVM: 32-byte hex, with or without `0x`.

## Tools (v1)

| tool | class | does |
|---|---|---|
| `auth_check` | read | network, active key source, per-venue signer status |
| `get_wallet_addresses` | read | the public address per venue |
| `ping` | read | liveness + server clock |

These are the read-only trust-layer tools that prove the handshake. The
money-moving venue tools (`open_position`, `close_position`, `get_quote`, … across
Polymarket / Hyperliquid / Solana) build on the same `getEvmSigner()` /
`getSolanaSigner()` contract and are the next milestone.

Watch it live with the [Starling Agent Dashboard](https://github.com/thedopetoad/Starling-Agent-Dashboard).

## Unlock modes (keystore source)

Only the `keystore` source needs unlocking. Set `STARLING_UNLOCK_MODE`:

| mode | secret source | restart-safe (headless) | resists stolen disk |
|---|---|---|---|
| `keychain` | OS keychain (`agent-wallet unlock`) | only if a GUI/login session persists | yes |
| `env` | `STARLING_KEYSTORE_PASSPHRASE` (via a secrets manager) | yes | partial |
| `tpm` | systemd `LoadCredentialEncrypted` | yes | yes (machine-bound) |
| `kms` | cloud KMS via instance role | yes | yes |
| `file` | a `0400` file | yes | **no** — forbidden on mainnet |

There is **no stdin unlock** for the stdio server: the MCP client launches the
process and immediately speaks JSON-RPC on stdin, so a passphrase can't be piped
in first. For supervised mainnet on a VPS, use `tpm` (see
[starling-agent.service](./starling-agent.service)) or `kms`.

**Honest ceiling:** on an always-on box, anything that can run code as your user
can sign trades. Encryption stops a stolen backup/disk, not a live breach — your
real protection is thin, trade-not-withdraw, expiring wallets.

## Commands

```
starling-mcp            start the stdio MCP server (what your agent host launches)
starling-mcp verify     unlock the active key source and print derived addresses
starling-mcp doctor     hygiene checks (Node, key source, perms, NEXT_PUBLIC leak)
```

## Security invariants

1. Signing happens only inside this Node process; keys never leave the box.
2. No key material in any `NEXT_PUBLIC_*` var (this is a Node-only package with
   no client bundle); `doctor` greps for the mistake anyway.
3. `STARLING_KEY` gates only metered hosted analytics — never the signing path.
4. Decrypted secrets live in `Buffer`s and are zeroized after a signer captures
   them (best-effort; not a guarantee against a live memory dump).

Built on the official [MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk).
Shares `src/keystore/crypto.ts` + a frozen decryption vector with the wallet tool
(see [KEYSTORE_FORMAT.md](./KEYSTORE_FORMAT.md)). License: MIT.
