/**
 * api-bot.ts — drive the Starling Execution MCP from the OpenAI Agents SDK.
 *
 * The Agents SDK speaks MCP natively: point it at the Starling MCP over
 * **stdio**, and every Starling tool becomes a tool the agent can call. No glue
 * code, no manual JSON-RPC — `MCPServerStdio` launches the process (`node` runs
 * your local build) and the `Agent`/`run` loop handles tool dispatch.
 *
 * Run the read-only handshake first (no money moves):
 *
 *   npm i @openai/agents @openai/agents-core
 *   export OPENAI_API_KEY=sk-...
 *   node --experimental-strip-types examples/api-bot.ts "Are you authed, and what addresses do you hold?"
 *
 * Requires a local clone built via `npm install` (the prepare script builds to
 * dist/) and Node 20+ on PATH. Point STARLING_BIN at YOUR clone's
 * dist/bin/starling-mcp.js. The MCP signs locally — this bot only ever sees the
 * public tool surface, never a key.
 *
 * The money-moving tools (open_position, get_quote, build_bridge, ...) are
 * driven by the SAME agent — you only change the prompt, e.g.
 *   "Bridge $100 of USDC to Solana and top up gas, then tell me when it's ready."
 */
import { Agent, run, MCPServerStdio } from "@openai/agents";

// Current model id for this example; swap freely.
const MODEL = "gpt-4.1";

// Point this at YOUR clone's built entrypoint (npm install builds dist/).
const STARLING_BIN =
  process.env.STARLING_BIN ?? "/ABSOLUTE/PATH/TO/Starling-MCP/dist/bin/starling-mcp.js";

async function main(): Promise<void> {
  const prompt =
    process.argv.slice(2).join(" ") ||
    "Call auth_check and get_wallet_addresses, then summarize in one line which " +
      "venues have a loaded signer and their addresses.";

  // Launch the Starling MCP exactly as your mcp.json would: `node` runs the
  // build from your local clone (npm install builds dist/).
  const starling = new MCPServerStdio({
    name: "starling",
    command: "node",
    args: [STARLING_BIN],
    env: {
      ...process.env,
      STARLING_KEY_SOURCE: process.env.STARLING_KEY_SOURCE ?? "auto",
      STARLING_NETWORK: process.env.STARLING_NETWORK ?? "testnet",
    },
  });

  // connect() spawns the server and performs the MCP handshake. Always close()
  // in a finally so the child process is reaped even on error.
  await starling.connect();
  try {
    const agent = new Agent({
      name: "starling-trading-ops",
      model: MODEL,
      instructions:
        "You are a trading-ops agent. You can only act through the Starling MCP " +
        "tools. Never fabricate a result — call a tool to find out. This account " +
        "is on testnet.",
      mcpServers: [starling],
    });

    const result = await run(agent, prompt);
    console.log(result.finalOutput);
  } finally {
    await starling.close();
  }
}

main().catch((err) => {
  console.error(`api-bot: ${err?.message ?? err}`);
  process.exit(1);
});
