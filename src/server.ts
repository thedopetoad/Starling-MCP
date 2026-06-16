// src/server.ts
// The Starling execution MCP (stdio). v1 exposes the read-only trust-layer
// tools that prove the wallet→MCP handshake: auth_check, get_wallet_addresses,
// ping. The money-moving venue tools (open/close/quote/…) build on the same
// getEvmSigner()/getSolanaSigner() contract and land next.
//
// stdio discipline: stdout carries ONLY JSON-RPC; all logging goes to stderr.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { bootUnlock, loadedAddresses, activeKeySource } from "./signers/index.js";
import {
  MONEY_TOOLS,
  MONEY_TOOL_NAMES,
  handleMoneyTool,
  type ToolDeps,
} from "./tools/index.js";
import {
  loadSealedTreasury,
  makeFundingPlanner,
  makeGasPlanner,
  makeIntentStore,
  makeReconciler,
  makeVenueEnabler,
} from "./tools/deps.js";

const log = (m: string) => process.stderr.write(`[starling] ${m}\n`);
const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

const EMPTY = { type: "object" as const, properties: {} };

// The trust-layer read tools (always available) + the money-moving + venue tools
// contributed by the tools registry. The registry owns its own schemas + the
// switch arm via handleMoneyTool, so adding a venue/bridge never touches this file.
const TOOLS = [
  {
    name: "auth_check",
    description:
      "Report signing readiness: network, signer backend, unlock mode, and which venues have a loaded local signer. Never returns key material.",
    inputSchema: EMPTY,
  },
  {
    name: "get_wallet_addresses",
    description: "Return the public address per venue derived from the unlocked local keystore.",
    inputSchema: EMPTY,
  },
  {
    name: "ping",
    description: "Liveness + server clock (ms since epoch).",
    inputSchema: EMPTY,
  },
  ...MONEY_TOOLS,
];

/**
 * Assemble the ToolDeps the registry runs on. This is the seam where the
 * concrete venue adapters, bridges, intent store, reconciler, and planners get
 * plugged in as each phase lands. Today it provides:
 *   - botId + signerLoaded()/treasury() derived from the unlocked keystore,
 *   - empty adapters/bridges maps (each tool returns "not enabled this run"
 *     until its venue/bridge is wired),
 *   - the in-memory IntentStore so idempotency works the moment a build exists.
 * Replace the placeholders below as Phases 1-5 deliver real implementations.
 */
function buildToolDeps(): ToolDeps {
  const addrs = loadedAddresses();
  const venueChain: Record<string, keyof typeof addrs> = {
    polymarket: "polygon",
    hyperliquid: "hyperliquid",
    jupiter: "solana",
  };

  return {
    botId: process.env.STARLING_BOT_ID ?? "default",
    adapters: {}, // Phase 1 (PM) / 4 (HL) / 5 (Jupiter) inject here.
    bridges: {}, // Phase 3 (CCTP + deBridge) injects here.
    store: makeIntentStore(),
    reconciler: makeReconciler(),
    treasury: loadSealedTreasury,
    gas: makeGasPlanner(),
    funding: makeFundingPlanner(),
    enabler: makeVenueEnabler(),
    dailyRelayerQuota: Number(process.env.STARLING_RELAYER_QUOTA ?? 100),
    signerLoaded: (venue) => !!addrs[venueChain[venue]],
    withdrawMaxPerCall: () => process.env.STARLING_WITHDRAW_MAX ?? "0",
  };
}

export async function startServer(): Promise<void> {
  // Best-effort unlock at boot. If it fails (no keystore / no passphrase) we
  // still start so the agent can call auth_check and get a helpful message.
  try {
    await bootUnlock();
  } catch (e) {
    log(`boot unlock failed: ${(e as Error).message}`);
    log("run `agent-wallet init` (https://github.com/thedopetoad/Agent-Wallet-Setup) to create a keystore");
  }

  const server = new Server(
    { name: "starling-execution-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Built once, after unlock, and handed to every money-moving call. This is the
  // single injection point: the registry stays pure (it imports no concrete
  // adapter/bridge/store) and gets its dependencies from here. Until a venue or
  // bridge is wired its map entry is absent and the tool returns a clean
  // "not enabled this run" error instead of crashing.
  const deps = buildToolDeps();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;

    // Money-moving + venue tools live in the registry (own schemas + handlers).
    if (MONEY_TOOL_NAMES.has(name)) {
      return handleMoneyTool(name, req.params.arguments, deps);
    }

    const addrs = loadedAddresses();
    switch (name) {
      case "auth_check":
        return text({
          network: process.env.STARLING_NETWORK ?? "testnet",
          keySource: activeKeySource(),
          unlockMode: process.env.STARLING_UNLOCK_MODE ?? "keychain",
          venues: Object.fromEntries(
            Object.entries(addrs).map(([k, v]) => [k, { signerLoaded: !!v }]),
          ),
        });
      case "get_wallet_addresses":
        return text(addrs);
      case "ping":
        return text({ ok: true, clockMs: Date.now() });
      default:
        return { content: [{ type: "text" as const, text: `unknown tool ${name}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  log("MCP server connected on stdio");
  // Do NOT exit on stdin EOF — supervised restarts must not be tripped by it.
}
