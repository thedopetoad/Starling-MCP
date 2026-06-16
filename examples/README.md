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

All three MCP-host configs run the server the same way — `npx -y
github:thedopetoad/Starling-MCP` fetches, builds, and runs it from GitHub. No
clone required. You only need **Node 20+ on your PATH**.

## Pick a key source

Every config picks where signing keys come from via `STARLING_KEY_SOURCE`:

- `auto` (default) — uses an encrypted keystore from `agent-wallet init` if one
  exists, else falls back to plaintext env keys. Recommended.
- `env` — paste `STARLING_PK_POLYGON` / `_HYPERLIQUID` / `_SOLANA` directly.
  Plaintext; fine for testnet / small float. The server prints a loud warning.

The read-only tools (`auth_check`, `ping`) work with **no keys at all** — great
for confirming the host launched the server before you add any secrets.

## Run a bot

```bash
# Python — Claude as the agent loop
pip install "mcp>=1.0" "anthropic>=0.40"
export ANTHROPIC_API_KEY=sk-ant-...
python examples/api-bot.py "Are you authed, and what addresses do you hold?"

# TypeScript — OpenAI Agents SDK
npm i @openai/agents @openai/agents-core
export OPENAI_API_KEY=sk-...
npx tsx examples/api-bot.ts "Are you authed, and what addresses do you hold?"
```
