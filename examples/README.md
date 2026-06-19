# Starling MCP — examples

Drop-in configs and runnable bots. Start with the **read-only handshake** (no
keys, no money) so you can see the wiring work before you fund anything.

| file | what it is |
|---|---|
| `claude-code-mcp.json` | MCP block for **Claude Code** — save as `.mcp.json` in your project. |
| `cursor-mcp.json` | MCP block for **Cursor** — the plaintext-key easy path. |
| `claude-desktop-mcp.json` | MCP block for **Claude Desktop** — paste into `claude_desktop_config.json`. |
| `api-bot.py` | Python bot: official **MCP SDK** over stdio, driven by the **Anthropic SDK** (Claude). |
| `api-bot.ts` | TypeScript bot: **OpenAI Agents SDK** with `MCPServerStdio`. |

All three host configs launch the MCP the same way — clone Starling-MCP, run
`npm install` (the `prepare` script builds it to `dist/`), and point the config's
`args` at YOUR clone's `dist/bin/starling-mcp.js`. Replace the
`/ABSOLUTE/PATH/TO/Starling-MCP` placeholder with wherever you cloned it. You
only need **Node 20+ on your PATH**.

```bash
git clone https://github.com/thedopetoad/Starling-MCP
cd Starling-MCP
npm install   # the prepare script builds to dist/
```

## Pick a key source

Every config picks where signing keys come from via `STARLING_KEY_SOURCE`:

- `auto` (default) — uses an encrypted keystore from `agent-wallet init` if one
  exists, else falls back to plaintext env keys. Recommended.
- `env` — paste `STARLING_PK_POLYGON` / `_HYPERLIQUID` / `_SOLANA` directly.
  Plaintext; fine for testnet / small float. The server prints a loud warning.

The read-only tools (`auth_check`, `ping`) work with **no keys at all** — great
for confirming the host launched the MCP before you add any secrets.

## Run a bot

Both bots launch the MCP from your local clone — edit the `node` path near the
top of each file to point at your `dist/bin/starling-mcp.js`.

```bash
# Python — Claude as the agent loop
pip install "mcp>=1.0" "anthropic>=0.40"
export ANTHROPIC_API_KEY=sk-ant-...
python examples/api-bot.py "Are you authed, and what addresses do you hold?"

# TypeScript — OpenAI Agents SDK
npm i @openai/agents @openai/agents-core
export OPENAI_API_KEY=sk-...
node --experimental-strip-types examples/api-bot.ts "Are you authed, and what addresses do you hold?"
```
