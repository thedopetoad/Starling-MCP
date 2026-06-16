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
import { INSTRUCTIONS } from "./instructions.js";
import { utcDayKey, addDecimal, type RiskLimits, type DailyUsage } from "./policy/limits.js";
import { polymarketAdapter } from "./adapters/polymarket.js";
import { hyperliquidAdapter } from "./adapters/hyperliquid.js";
import { jupiterAdapter } from "./adapters/jupiter.js";
import { makeRealVenueEnabler } from "./adapters/venue-enabler.js";
import type { VenueAdapter, Venue } from "./adapters/types.js";
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
} from "./tools/deps.js";

const log = (m: string) => process.stderr.write(`[starling] ${m}\n`);
const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
const raw = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

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
  {
    name: "get_instructions",
    description:
      "Read FIRST. How to drive Starling: the correct call order, the no-key vs key boundary, the safety rules (worst-price required, idempotencyKey required, withdraw-only-to-treasury), funding/gas, venues, and what's live this session.",
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

  // USER-SET risk limits (env; "0" = that check is OFF, the default). For a
  // minimal real-funds test, set e.g. STARLING_PER_TRADE_MAX_USD=5. These are the
  // dial the user controls — the engine only enforces what's set, never imposes.
  const limits: RiskLimits = {
    perTradeMaxUsd: process.env.STARLING_PER_TRADE_MAX_USD ?? "0",
    dailyNotionalCapUsd: process.env.STARLING_DAILY_NOTIONAL_CAP_USD ?? "0",
    dailyLossCapUsd: process.env.STARLING_DAILY_LOSS_CAP_USD ?? "0",
    killSwitch: (process.env.STARLING_KILL_SWITCH ?? "").toLowerCase() === "true",
  };
  // In-memory daily usage; rolls at UTC midnight. (Swap in a persisted store later.)
  let usage: DailyUsage = { dayKey: utcDayKey(), openedNotionalUsd: "0", realizedLossUsd: "0" };
  const rollUsage = () => {
    const today = utcDayKey();
    if (usage.dayKey !== today) usage = { dayKey: today, openedNotionalUsd: "0", realizedLossUsd: "0" };
  };

  // Inject live venue adapters only when their signer is loaded. Polymarket
  // (CLOB V2, sig-0 EOA) and Hyperliquid (L1 IOC actions, signing locked to the
  // SDK vector) are wired build→sign→submit. Jupiter/Solana joins here next.
  const adapters: Partial<Record<Venue, VenueAdapter>> = {};
  if (addrs.polygon) adapters.polymarket = polymarketAdapter;
  if (addrs.hyperliquid) adapters.hyperliquid = hyperliquidAdapter;
  if (addrs.solana) adapters.jupiter = jupiterAdapter;

  return {
    botId: process.env.STARLING_BOT_ID ?? "default",
    adapters,
    bridges: {}, // Phase 3 (CCTP + deBridge) injects here.
    store: makeIntentStore(),
    reconciler: makeReconciler(),
    treasury: loadSealedTreasury,
    gas: makeGasPlanner(),
    funding: makeFundingPlanner(),
    enabler: makeRealVenueEnabler(),
    dailyRelayerQuota: Number(process.env.STARLING_RELAYER_QUOTA ?? 100),
    signerLoaded: (venue) => !!addrs[venueChain[venue]],
    // "0" blocks all withdraws until the user sets an explicit per-call ceiling.
    withdrawMaxPerCall: () => process.env.STARLING_WITHDRAW_MAX ?? "0",
    limits: () => limits,
    dailyUsage: () => {
      rollUsage();
      return usage;
    },
    recordOpen: (n: string) => {
      rollUsage();
      usage = { ...usage, openedNotionalUsd: addDecimal(usage.openedNotionalUsd, n) };
    },
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
      case "get_instructions":
        return raw(INSTRUCTIONS);
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
