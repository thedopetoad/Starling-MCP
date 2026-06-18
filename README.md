# Starling Execution MCP

**The Execution Layer for Agentic Trading.** A local, non-custodial
[MCP](https://modelcontextprotocol.io) server your trading bot connects to over
stdio. It signs **locally** and **never holds your funds**. Point a coding agent
(Claude Code, Cursor, Claude Desktop) or your own bot at it and talk to your
money in plain English: *"bridge $100 to Solana and top up gas,"* *"buy $50 YES
on \<market\> under 40c."*

It's built to work for *everyone*: the MCP is **modular about where your keys
come from** — paste a plaintext key and go, or layer in the encrypted
[Agent-Wallet-Setup](https://github.com/thedopetoad/Agent-Wallet-Setup) keystore
when you want safety. Same server, same signing, either way.

---

## Quickstart for coding agents

Download-and-play in five steps. **Testnet-first** — you don't risk a cent until
you flip to mainnet on purpose.

> **Prerequisite:** Node 20+ on your `PATH`. MCP hosts (Claude Desktop, Cursor,
> Claude Code) do **not** bundle Node — run `node -v` to confirm. `npx
> github:thedopetoad/Starling-MCP doctor` checks this and your key source.

**1. Get the server.** You don't have to clone anything — `npx` fetches, builds,
and runs it from GitHub on demand (step 3 does this for you). To poke it by hand:

```bash
npx -y github:thedopetoad/Starling-MCP doctor    # Node + key-source + hygiene check
# (clone instead if you want to hack on it: git clone … && npm install && npm run build)
```

**2. Make a wallet** (optional but recommended). This generates per-chain keys
and seals them in an encrypted keystore — nothing to install but Node:

```bash
npx -y github:thedopetoad/Agent-Wallet-Setup init
```

Skip this and paste a plaintext key instead (see *easy path* below) — the
read-only tools work with **no keys at all**, so you can wire things up first.

**3. Add ONE block to your MCP host.** Copy the matching file from
[`examples/`](./examples) — they're ready to paste:

- **Claude Code** → save [`examples/claude-code-mcp.json`](./examples/claude-code-mcp.json) as `.mcp.json` in your project root.
- **Cursor** → [`examples/cursor-mcp.json`](./examples/cursor-mcp.json) (Settings → MCP → Add, or `.cursor/mcp.json`).
- **Claude Desktop** → merge [`examples/claude-desktop-mcp.json`](./examples/claude-desktop-mcp.json) into `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart.

The canonical block (npx, no clone):

```json
{ "mcpServers": { "starling": {
  "command": "npx",
  "args": ["-y", "github:thedopetoad/Starling-MCP"],
  "env": { "STARLING_KEY_SOURCE": "auto", "STARLING_NETWORK": "testnet" }
} } }
```

(Local clone instead: `"command": "node", "args": ["/path/to/Starling-MCP/dist/bin/starling-mcp.js"]`.)

**4. Fund it.** Send testnet (or, deliberately, mainnet) USDC + a little native
gas to the addresses the server reports. Ask your agent: *"what are your wallet
addresses?"* (it calls `get_wallet_addresses`), then fund those. **Gas is on
you** — the local EOA pays its own gas on every chain; CCTP/deBridge can ride a
small native top-up along with funding, but a brand-new wallet needs a starter
bit of MATIC / ETH / SOL to make its first move.

**5. Talk to it.** In your agent, try:

> *"Are you authed, and which venues have a signer loaded?"*

That round-trips `auth_check` + `get_wallet_addresses` and proves the whole
handshake without moving a cent. From there, see [What the agent can
do](#what-the-agent-can-do).

**No MCP host? Drive it from code.** [`examples/api-bot.py`](./examples/api-bot.py)
(MCP SDK + Anthropic) and [`examples/api-bot.ts`](./examples/api-bot.ts) (OpenAI
Agents SDK) each connect over stdio and run a real tool-calling loop in ~80
lines.

### Easy path — plaintext key, zero setup

Don't want a keystore yet? Paste a key into the env and go (the server prints a
loud warning; fine for testnet / small float):

```bash
STARLING_KEY_SOURCE=env \
STARLING_PK_POLYGON=0x… \
STARLING_PK_HYPERLIQUID=0x… \
STARLING_PK_SOLANA=<base58|hex> \
  npx -y github:thedopetoad/Starling-MCP verify   # prints the addresses it loaded
```

The same three `STARLING_PK_*` vars go straight in the `env` block of any
`mcp.json` (see [`examples/cursor-mcp.json`](./examples/cursor-mcp.json)).

---

## What the agent can do

You drive Starling in natural language; the agent picks the tool. **Honest
status:** the read-only *trust-layer* tools below are **live today** and are what
you should run first — they prove the wallet→MCP handshake without moving funds.
The money-moving tools are the documented execution surface this server is being
built toward (Polymarket → Hyperliquid → Solana, with CCTP V2 + deBridge for
funding); they build on the **same** local-signer contract. Check what's actually
exposed at any moment by asking your agent to *list its tools*, or run `npx -y
github:thedopetoad/Starling-MCP` and call `tools/list`.

**Live now — read-only handshake (no keys required):**

| ask your agent… | tool | what happens |
|---|---|---|
| *"Are you authed? Which venues have a signer?"* | `auth_check` | network, active key source, per-venue signer status |
| *"What are your wallet addresses?"* | `get_wallet_addresses` | the public address per venue |
| *"Are you alive?"* | `ping` | liveness + server clock |

**The execution surface it's built toward** (same signing contract; testnet-first):

| ask your agent… | tool (planned) | what it does |
|---|---|---|
| *"What's the best price for $50 of YES on \<market\>?"* | `get_quote` | reads venue book; returns price + a bounded worst-price |
| *"Buy $50 YES on \<market\> under 40c."* | `open_position` | builds an EIP-712 CLOB order (PM) / signed action (HL), signs locally, posts |
| *"Close half my BTC perp at no worse than 60k."* | `close_position` | builds + signs the exit with an explicit worst price |
| *"What do I hold and what's my PnL?"* | `get_positions` | normalized open positions across venues |
| *"Bridge $100 of USDC to Solana and top up gas."* | `bridge_funds` | CCTP V2 burn-and-mint for USDC + a small deBridge native-output leg for SOL/MATIC/ETH gas |
| *"Where's my bridge? Is it ready to trade?"* | `check_venue_status` | on-chain confirmation + venue preconditions (not just a mint balance) |
| *"Sweep everything back to my treasury."* | `build_withdraw_tx` | destination is the **sealed treasury only** — the agent cannot name a recipient |

> **Every order carries an explicit worst price.** There is no "market" order
> anywhere in this stack — slippage is always bounded. *"under 40c"*, *"no worse
> than 60k"* map straight to that limit; if you don't pin one, a default
> slippage fraction derives it from the quote.

> **Withdraws can only go to a destination YOU set.** The withdraw tool takes **no
> recipient argument** — "send to address X" is not an expressible capability. The
> destination is read from one of two sources: the treasury **sealed** at wallet
> setup, or `~/.starling/treasury.json`. To set it, `request_withdraw_address` offers
> two paths: **preferred** — paste it into the Starling dashboard (`set-treasury`), so
> the agent never transcribes your address; **fallback** — if you have no dashboard
> and ask it to, a file-capable agent can write that file with an address *you* give
> it, then read it back so you confirm the 4-byte commitment. The MCP exposes no
> address-setting tool; the file is the interface. Inbound *funding* recipients stay
> **keystore-only** (the pinned file is withdraw-only). See
> [Security invariants](#security-invariants) for the honest ceiling — the file is UX
> + transcription integrity, not a crypto control against a code-exec'd agent.

## Reference harness (the worked lifecycle)

[`scripts/live.mjs`](./scripts/live.mjs) is the committed, end-to-end reference for
*every* flow in the stack — funding, gas, bridging, and the full trade lifecycle on
each venue. It plays the **caller/agent** role: it drives the same adapters and
bridges the MCP tools use, signs locally with your key, broadcasts, and confirms
on-chain. Two reasons it's in the repo:

- **Read it** to see the exact call sequence for a flow before you ask your agent
  to do it (or before you wire your own bot).
- **Run it** to live-integration-check a venue or rail end to end.

**It is DRY by default.** Every money stage builds + simulates and sends *nothing*;
only the explicit `--live` flag ever broadcasts — so you can dry-run the whole thing
for free and watch each step before committing a cent.

```bash
npm run build                                  # the harness imports from dist/
node --env-file=../starling-test/agent.env scripts/live.mjs balances
node --env-file=../starling-test/agent.env scripts/live.mjs hl-withdraw 4         # DRY: builds + signs only
node --env-file=../starling-test/agent.env scripts/live.mjs hl-withdraw 4 --live  # actually broadcasts
```

Stages: `balances`, `swap`, `bridge`, `hl-deposit`, `hl-trade`, `hl-close`,
`hl-withdraw`, `pm-creds`, `pm-enable`, `poly-swap`, `pm-trade`, `route`, `cctp`,
`transfer`. Run with no stage to print the list. Any key source works; the
`env`-source `--env-file` shown above is just the quickest.

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

## Polymarket: bring your own builder creds

Trading Polymarket V2 from a deposit wallet uses Polymarket's **relayer** (it deploys
your deposit wallet and sets its approvals **gaslessly**) and stamps a **builder
code** on every order. If you run your own bot, **create your OWN builder API
credentials** from your Polymarket account (polymarket.com → Settings → Builder):
orders attributed to your builder code earn *you* the better maker rates / rebates,
and the credentials are what authorize the gasless relayer flow. Set them in the env:

```
STARLING_PM_BUILDER_API_KEY=…
STARLING_PM_BUILDER_SECRET=…
STARLING_PM_BUILDER_PASSPHRASE=…
```

These are HMAC secrets — keep them out of the repo (the `.gitignore` already blocks
`.env*`; put them in your `env`-source file or secrets manager). Without your own,
you forgo the attribution **and** the better economics.

## Tools

See [What the agent can do](#what-the-agent-can-do) for the prompt-driven list.
In short: the read-only trust-layer tools (`auth_check`, `get_wallet_addresses`,
`ping`) are **live now** and prove the handshake without moving funds; the
money-moving venue tools (`get_quote`, `open_position`, `close_position`,
`bridge_funds`, `build_withdraw_tx`, … across Polymarket / Hyperliquid / Solana)
build on the same `getEvmSigner()` / `getSolanaSigner()` contract and are the
in-progress milestones. Ask your agent to *list its tools* to see exactly what's
exposed right now.

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
5. Withdraw destinations are set out-of-band, never as a withdraw argument — the
   keystore-sealed treasury (AAD-bound, tamper-evident) and/or `~/.starling/treasury.json`.
   That file is normally a human paste via the dashboard (UX + transcription
   integrity); a file-capable agent may also write it as a fallback, with the user's
   address + a commitment round-trip to confirm. Either way it is **not**
   crypto-tamper-resistant — a code-exec'd agent can rewrite it (same honest ceiling
   as the sealed treasury) — and the MCP itself exposes **no** address-setting tool;
   it only reads the file. A keystore/file disagreement fails **closed**
   (`treasury_conflict`). Inbound funding recipients accept the keystore source only;
   the pinned file is withdraw-only.

Built on the official [MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk).
Shares `src/keystore/crypto.ts` + a frozen decryption vector with the wallet tool
(see [KEYSTORE_FORMAT.md](./KEYSTORE_FORMAT.md)). License: MIT.
