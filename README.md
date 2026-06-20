# Starling Execution MCP

**The Execution Layer for Agentic Trading.** A local, non-custodial
[MCP](https://modelcontextprotocol.io) your trading bot connects to over stdio.
It signs **locally** and **never holds your funds**. Clone it, build it, run it
yourself — then point a coding agent (Claude Code, Cursor, Claude Desktop) or
your own bot at it and talk to your money in plain English: *"bridge $100 to
Solana and top up gas,"* *"buy $50 YES on \<market\> under 40c."*

It's built to work for *everyone*: the MCP is **modular about where your keys
come from** — paste a plaintext key and go, or layer in the encrypted
[Agent-Wallet-Setup](https://github.com/thedopetoad/Agent-Wallet-Setup) keystore
when you want safety. Same code, same signing, either way.

---

## Quickstart for coding agents

Clone-and-play in five steps. **Testnet-first** — you don't risk a cent until
you flip to mainnet on purpose.

> **Prerequisite:** Node 20+ on your `PATH`. MCP hosts (Claude Desktop, Cursor,
> Claude Code) do **not** bundle Node — run `node -v` to confirm. `node
> dist/bin/starling-mcp.js doctor` (after step 1) checks this and your key source.

**1. Clone and build it.** `npm install` runs the `prepare` script, which builds
the TypeScript to `dist/`. Then the entrypoint is `dist/bin/starling-mcp.js`:

```bash
git clone https://github.com/thedopetoad/Starling-MCP
cd Starling-MCP
npm install                                # the prepare script builds to dist/
node dist/bin/starling-mcp.js doctor       # Node + key-source + hygiene check
```

**2. Make a wallet** (optional but recommended). This generates per-chain keys
and seals them in an encrypted keystore. Clone + build Agent-Wallet-Setup the
same way (`git clone … && cd Agent-Wallet-Setup && npm install`), then run its
`init`:

```bash
git clone https://github.com/thedopetoad/Agent-Wallet-Setup
cd Agent-Wallet-Setup && npm install
node dist/bin/agent-wallet.js init
```

Skip this and paste a plaintext key instead (see *easy path* below) — the
read-only tools work with **no keys at all**, so you can wire things up first.

**3. Add ONE block to your MCP host.** Copy the matching file from
[`examples/`](./examples) and replace `/ABSOLUTE/PATH/TO/Starling-MCP` with
wherever YOU cloned it:

- **Claude Code** → save [`examples/claude-code-mcp.json`](./examples/claude-code-mcp.json) as `.mcp.json` in your project root.
- **Cursor** → [`examples/cursor-mcp.json`](./examples/cursor-mcp.json) (Settings → MCP → Add, or `.cursor/mcp.json`).
- **Claude Desktop** → merge [`examples/claude-desktop-mcp.json`](./examples/claude-desktop-mcp.json) into `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart.

The canonical block — `node` runs the build from your local clone (swap in the
real path):

```json
{ "mcpServers": { "starling": {
  "command": "node",
  "args": ["/ABSOLUTE/PATH/TO/Starling-MCP/dist/bin/starling-mcp.js"],
  "env": { "STARLING_KEY_SOURCE": "auto", "STARLING_NETWORK": "testnet" }
} } }
```

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
  node dist/bin/starling-mcp.js verify   # prints the addresses it loaded
```

The same three `STARLING_PK_*` vars go straight in the `env` block of any
`mcp.json` (see [`examples/cursor-mcp.json`](./examples/cursor-mcp.json)).

---

## What the agent can do

You drive Starling in natural language; the agent picks the tool. **Honest
status:** the read-only *trust-layer* tools below are what you should run first —
they prove the wallet→MCP handshake without moving funds. The money-moving +
venue tools are **wired** (Polymarket CLOB V2 build→sign→submit, Hyperliquid L1
actions, Jupiter/Solana swaps, CCTP V2 + deBridge for funding — all built on the
**same** local-signer contract). Each one only activates once its venue's signer
(and, for the bridges, the chain RPCs) are loaded — until then it returns a clean
*"not enabled this run"* rather than failing. Check what's actually exposed and
active at any moment by asking your agent to *list its tools*, or run the MCP and
call `tools/list`.

**Read-only trust layer (no keys required) — run these first:**

| ask your agent… | tool | what happens |
|---|---|---|
| *"Read your instructions."* | `get_instructions` | call order, the no-key vs key boundary, safety rules — read FIRST |
| *"Are you authed? Which venues have a signer?"* | `auth_check` | network, active key source, unlock mode, per-venue signer status, gas-reserve, withdraw destination |
| *"What are your wallet addresses?"* | `get_wallet_addresses` | the public address per venue |
| *"Where do withdraws go?"* | `request_withdraw_address` | reports the current withdraw destination (per chain: address, source, 4-byte commitment); takes NO address argument |
| *"Are you alive?"* | `ping` | liveness + server clock |

**Money-moving + venue tools** (same signing contract; testnet-first; require the
relevant signer loaded):

| ask your agent… | tool | what it does |
|---|---|---|
| *"What's the best price for $50 of YES on \<market\>?"* | `get_quote` | reads venue metadata + price so the caller can derive a worst-price (read-only) |
| *"Buy $50 YES on \<market\> under 40c."* | `open_position` | builds an EIP-712 CLOB order (PM) / signed action (HL) / Solana tx (Jupiter), signs locally, submits |
| *"Close half my BTC perp at no worse than 60k."* | `close_position` | builds + signs the exit for a fraction (0,1] with an explicit worst price, then submits |
| *"Rest a limit at 58k / set a stop-loss / buy spot HYPE."* | `hl_order` | advanced Hyperliquid order — perp `hl:<COIN>` or spot `hlspot:<TOKEN>`: tif Gtc/Alo/Ioc, reduceOnly, trigger (tp/sl), cloid |
| *"Cancel my open ETH orders."* | `hl_cancel` | cancel a Hyperliquid order by oid / cloid / all-on-market |
| *"Set 5x on BTC, stake HYPE, deposit to HLP, run a TWAP."* | `hl_update_leverage` · `hl_stake` · `hl_delegate` · `hl_vault_transfer` · `hl_usd_class_transfer` · `hl_update_isolated_margin` · `hl_twap` | the full HyperCore surface — leverage, staking+delegation, vault yield, perp↔spot, isolated margin, TWAP. Read it all with `hl_account` |
| *"What do I hold and what's my PnL?"* | `list_positions` | normalized open positions across venues (pass `marketIds` to read specific ones) |
| *"Get this fresh wallet ready to trade Polymarket."* | `enable_venue` | builds the UNSIGNED on-chain setup a fresh EOA needs (PM approvals + pUSD wrap + deposit-wallet registry; HL deposit; Jupiter ATA) + a `blockers[]` to poll |
| *"What's the fee/ETA to bridge $100 USDC to Solana?"* | `bridge_quote` | fee/ETA/finality for a USDC (CCTP) or non-USDC (deBridge) route (read-only) |
| *"Bridge $100 of USDC home."* | `build_bridge` | builds the UNSIGNED bridge legs ([approve?, depositForBurn] CCTP / [create] deBridge); recipient pinned by the MCP, not an argument |
| *"Move $50 USDC from Polygon to my Solana wallet."* | `transfer` | moves USDC between YOUR OWN wallets, auto-picking the rail (CCTP vs deBridge); recipient is your own address, never an argument |
| *"Top up native gas on Solana."* | `ensure_gas` | builds a deBridge native-output top-up to the per-chain gas floor (paid from USDC), or an empty list if already funded |
| *"Plan funding a fresh EOA on Hyperliquid with $100."* | `plan_funding_route` | ordered UNSIGNED legs: USDC over CCTP + a deBridge native-gas leg, so the dest can trade AND pay gas |
| *"Where's my bridge? Is it ready to trade?"* | `get_bridge_status` | on-chain confirmation + the FULL venue-precondition set (`readyToTrade`), not just a mint balance |
| *"Drive that bridge to completion."* | `advance_bridge` | polls the flight and, for CCTP, broadcasts the mint once Iris attests; call until `delivered=true` |
| *"Sweep everything back to my treasury."* | `build_withdraw` | destination is the **sealed treasury / pinned file only** — the agent cannot name a recipient |

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

## Polymarket: bring your own creds

Polymarket V2 has three independent env knobs. The defaults are the right choice
for a self-custodied bot — you only *have* to set the CLOB L2 creds to place orders.

**1. Deposit-wallet mode (default) vs bare EOA.** By default the adapter trades
through a **deposit wallet** (a UUPS contract deterministically derived from your
local Polygon EOA), signing each order as `POLY_1271` (signatureType 3). The EOA
self-signs the order and self-posts it to the CLOB — Polymarket's relayer is **not**
on the order-placement path. Set `STARLING_PM_DEPOSIT_WALLET=false` to fall back to
the legacy bare-EOA path (signatureType 0), where signer == maker == your EOA.

**2. The gasless relayer (deposit-wallet enable + cash-out).** Deploying the deposit
wallet and setting its on-chain approvals — and pulling pUSD back out of it — go
through Polymarket's **relayer**, which executes those calls **gaslessly** against an
EIP-712 batch your EOA signs. `enable_venue` drives the deploy + approvals; the
relayer is **only** used for that setup and cash-out, never for order placement. It
needs **builder API credentials** from your own Polymarket account (polymarket.com →
Settings → Builder):

```
STARLING_PM_BUILDER_API_KEY=…
STARLING_PM_BUILDER_SECRET=…
STARLING_PM_BUILDER_PASSPHRASE=…
```

These are HMAC secrets — keep them out of the repo (the `.gitignore` already blocks
`.env*`; put them in your `env`-source file or secrets manager). If you run bare-EOA
mode (`STARLING_PM_DEPOSIT_WALLET=false`) against a pre-enabled wallet you can skip
them.

**3. Order attribution (`STARLING_PM_BUILDER_CODE`).** A separate **bytes32 builder
code** stamped on every order for attribution — orders carrying your code earn *you*
the better maker rates / rebates. This is distinct from the HMAC builder API creds
above; leave it unset to forgo attribution (orders still place fine).

**4. CLOB L2 creds (required to POST orders).** Placing an order on the CLOB needs
L2 API credentials for the maker address:

```
STARLING_PM_CLOB_API_KEY=…
STARLING_PM_CLOB_SECRET=…        # url-safe base64
STARLING_PM_CLOB_PASSPHRASE=…
```

Without these, `open_position` / `close_position` build + sign the order but cannot
submit it and return a clear "no CLOB L2 creds" error.

## Tools

See [What the agent can do](#what-the-agent-can-do) for the prompt-driven list.
In short: the read-only trust-layer tools (`get_instructions`, `auth_check`,
`get_wallet_addresses`, `request_withdraw_address`, `ping`) prove the handshake
without moving funds; the money-moving + venue tools (`get_quote`,
`open_position`, `close_position`, `list_positions`, `enable_venue`,
`bridge_quote`, `build_bridge`, `transfer`, `ensure_gas`, `plan_funding_route`,
`get_bridge_status`, `advance_bridge`, `build_withdraw`, the native-bridge tools
(`pm_deposit_address`, `pm_withdraw`, `hl_bridge_out`), and the full Hyperliquid
surface (`hl_account`, `hl_order`, `hl_cancel`, `hl_update_leverage`,
`hl_update_isolated_margin`, `hl_usd_class_transfer`, `hl_vault_transfer`,
`hl_stake`, `hl_delegate`, `hl_twap`) — across Polymarket / Hyperliquid / Solana)
build on the same `getEvmSigner()` / `getSolanaSigner()` contract. Each activates once its venue's signer (and bridge RPCs) are loaded.
Ask your agent to *list its tools* to see exactly what's exposed right now.

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

Run from your clone after `npm install` (which builds `dist/`). The bin dispatches
three subcommands; no argument is the same as `serve`:

```
node dist/bin/starling-mcp.js            start the stdio MCP (what your agent host launches)
node dist/bin/starling-mcp.js verify     unlock the active key source and print derived addresses
node dist/bin/starling-mcp.js doctor     hygiene checks (Node, key source, perms, NEXT_PUBLIC leak)
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
