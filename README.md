# Starling Execution MCP

**The Execution Layer for Agentic Trading.** A local, non-custodial
[MCP](https://modelcontextprotocol.io) server your trading bot connects to over
stdio. It signs **locally** with keys it reads from the encrypted keystore
created by [Agent-Wallet-Setup](https://github.com/thedopetoad/Agent-Wallet-Setup) —
**your keys never leave your machine, and Starling never holds your funds.**

> **Prerequisite:** Node 20+ on your `PATH`. MCP hosts (Claude Desktop, Cursor)
> do not bundle Node. `starling-mcp doctor` checks this.

## How it fits together

```
Agent-Wallet-Setup (producer)          Starling-MCP (consumer)
  agent-wallet init                       starling-mcp serve
   └─ generates keys, encrypts to   ──▶    └─ reads ~/.starling/keystore,
      ~/.starling/keystore/*.json             unlocks via STARLING_UNLOCK_MODE,
      writes mcp.json                          exposes signers + tools to your bot
```

The two repos share `src/keystore/crypto.ts` (byte-identical) and a frozen
decryption test vector, so a keystore written by the wallet tool **always**
decrypts here. See [KEYSTORE_FORMAT.md](./KEYSTORE_FORMAT.md).

## Quick start

```bash
# 1. create your wallet (in the Agent-Wallet-Setup repo)
agent-wallet init

# 2. run the MCP server (this repo)
npm install && npm run build

# confirm it can unlock the keystore the wallet tool wrote:
STARLING_UNLOCK_MODE=env STARLING_KEYSTORE_PASSPHRASE='…' \
  node dist/bin/starling-mcp.js verify
```

`verify` prints the public address per venue, derived from the decrypted
keystore — if those match what `agent-wallet init` printed, the two tools are
wired correctly.

Point your agent host at `mcp.json` (see [mcp.json.example](./mcp.json.example)).

## Tools (v1)

| tool | class | does |
|---|---|---|
| `auth_check` | read | network, signer backend, unlock mode, which venues have a loaded signer |
| `get_wallet_addresses` | read | the public address per venue from the unlocked keystore |
| `ping` | read | liveness + server clock |

These are the read-only trust-layer tools that prove the wallet→MCP handshake.
The money-moving venue tools (`open_position`, `close_position`, `get_quote`, …
across Polymarket / Hyperliquid / Solana) build on the same
`getEvmSigner()` / `getSolanaSigner()` contract and are the next milestone — see
[EXECUTION_LAYER spec](https://github.com/thedopetoad/Starling-MCP) for the full
tool catalog.

## Unlock at boot

Set `STARLING_UNLOCK_MODE`:

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
can sign trades. The keystore stops a stolen backup/disk, not a live breach —
your real protection is thin, trade-not-withdraw, expiring wallets.

## Security invariants

1. Signing happens only inside this Node process; keys never leave the box.
2. No key material in any `NEXT_PUBLIC_*` var (this is a Node-only package with
   no client bundle); `doctor` greps for the mistake anyway.
3. `STARLING_KEY` gates only metered hosted analytics — never the signing path.
4. Decrypted secrets live in `Uint8Array`s and are zeroized after the signer
   captures them (best-effort; not a guarantee against a live memory dump).

License: MIT.
