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
import { canWithdraw, chainSource, type SealedTreasury } from "./withdraw/allowlist.js";
import { pinnedTreasuryPath } from "./withdraw/pinned-file.js";
import { treasuryCommitment } from "./keystore/treasury-seal.js";
import { CHAINS } from "./keystore/format.js";
import { utcDayKey, addDecimal, type RiskLimits, type DailyUsage } from "./policy/limits.js";
import { gasReserveStatus } from "./policy/gas-reserve.js";
import { polymarketAdapter } from "./adapters/polymarket.js";
import { hyperliquidAdapter } from "./adapters/hyperliquid.js";
import { jupiterAdapter } from "./adapters/jupiter.js";
import { makeRealVenueEnabler } from "./adapters/venue-enabler.js";
import { makeRealPmBridge } from "./adapters/pm-bridge-ops.js";
import { makeRealHlExit } from "./adapters/hl-exit.js";
import { DeBridgeBridge } from "./bridge/debridge.js";
import { cctpBridge } from "./bridge/cctp.js";
import type { NativeBalanceReader } from "./bridge/gas.js";
import { makeExecutor } from "./exec/executor.js";
import { EvmRpc } from "./adapters/evm-rpc.js";
import { SolanaRpc } from "./adapters/solana-rpc.js";
import type { Bridge, BridgeProvider } from "./bridge/types.js";
import type { VenueAdapter, Venue, Chain } from "./adapters/types.js";
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

const CHAIN_ENUM = { type: "string" as const, enum: ["polygon", "hyperliquid", "solana"] };

// Build the per-chain withdraw-destination report shared by auth_check and
// request_withdraw_address. Per chain: the resolved address, its provenance
// (keystore | dashboard | conflict | none) and the 4-byte transcription
// commitment the human compares against their wallet. Addresses are PUBLIC — no
// secret is ever exposed. `sealed` reflects ONLY the AAD-bound keystore source.
async function treasuryReport(t: SealedTreasury) {
  const byChain: Record<string, { address: string | null; source: string; commitment?: string }> = {};
  for (const chain of CHAINS) {
    const source = chainSource(t, chain);
    const address = t.byChain[chain] ?? null;
    if (!address && source === "none") continue; // omit chains with nothing set
    const commitment = address ? await treasuryCommitment({ chain, treasury: address }) : undefined;
    byChain[chain] = { address, source, commitment };
  }
  return {
    sealed: t.sealed,
    withdrawsEnabled: CHAINS.some((c) => canWithdraw(chainSource(t, c))),
    byChain,
  };
}

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
  {
    name: "request_withdraw_address",
    description:
      "Read-only: report the CURRENT withdraw destination (per chain: address, source, 4-byte commitment, " +
      "whether withdraws are enabled). Takes NO address argument — you (the agent) cannot set or change the " +
      "destination, by design, so you never transcribe the address. When the user wants to withdraw and none " +
      "is set, call this and tell them to pin it in the Starling dashboard (`set-treasury`), then retry the withdraw.",
    inputSchema: {
      type: "object" as const,
      properties: { chain: { ...CHAIN_ENUM, description: "Optional: report just this chain." } },
    },
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
export function buildToolDeps(): ToolDeps {
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

  // deBridge DLN (live-validated SOL<->EVM + native-gas legs). Source address is
  // resolved per-route from the loaded signers — NEVER an agent argument.
  const bridges: Partial<Record<BridgeProvider, Bridge>> = {};
  if (addrs.solana || addrs.polygon || addrs.hyperliquid) {
    bridges.debridge = new DeBridgeBridge({
      sourceAddressFor: (chain: Chain) => {
        const a = chain === "solana" ? addrs.solana : chain === "hyperliquid" ? addrs.hyperliquid : addrs.polygon;
        if (!a) throw new Error(`no loaded signer for deBridge source chain ${chain}`);
        return a;
      },
    });
  }
  // CCTP V2 (Circle burn-and-mint, the ~1:1 USDC rail between EVM chains;
  // live-validated Polygon<->Arbitrum). The mintRecipient is pinned by the build
  // from route.recipient (treasury/thin-wallet), never an agent argument. Needs
  // STARLING_RPC_POLYGON / _ARBITRUM for the usedNonces mint-proof + balance reads;
  // tool calls error honestly at call-time if those are unset. Gated on an EVM
  // signer (CCTP is EVM-source; the Solana leg is Stage-2).
  if (addrs.polygon || addrs.hyperliquid) {
    bridges.cctp = cctpBridge;
  }

  // Per-chain loaded-signer address (the pinned recipient / source). null = no key.
  const sourceAddressFor = (chain: Chain): string | null => {
    const a = chain === "solana" ? addrs.solana : chain === "hyperliquid" ? addrs.hyperliquid : addrs.polygon;
    return a ?? null;
  };
  // Native-gas balance (decimal number) of the loaded signer on a chain. Reads the
  // chain's RPC; returns 0 on any error (env unset / network).
  const nativeGasReader = async (chain: Chain): Promise<number> => {
    try {
      if (chain === "solana") {
        if (!addrs.solana) return 0;
        return Number(await new SolanaRpc().getBalanceLamports(addrs.solana)) / 1e9;
      }
      const net: "polygon" | "arbitrum" = chain === "hyperliquid" ? "arbitrum" : "polygon";
      const addr = chain === "hyperliquid" ? addrs.hyperliquid : addrs.polygon;
      if (!addr) return 0;
      return Number(await new EvmRpc({ net }).getBalanceWei(addr)) / 1e18;
    } catch {
      return 0;
    }
  };
  // Decimal-string balance reader the gas planner / ensureGas consume. Reads the
  // ACTUAL address passed (a top-up dest / funding recipient / source authority may
  // differ from the loaded signer), so the gas-leg "already funded?" check is right.
  const readNativeBalance: NativeBalanceReader = async (chain, address) => {
    try {
      if (chain === "solana") {
        return String(Number(await new SolanaRpc().getBalanceLamports(address)) / 1e9);
      }
      const net: "polygon" | "arbitrum" = chain === "hyperliquid" ? "arbitrum" : "polygon";
      return String(Number(await new EvmRpc({ net }).getBalanceWei(address)) / 1e18);
    } catch {
      return "0";
    }
  };

  return {
    botId: process.env.STARLING_BOT_ID ?? "default",
    adapters,
    bridges, // deBridge + CCTP wired (both live-validated).
    store: makeIntentStore(),
    reconciler: makeReconciler(),
    treasury: loadSealedTreasury,
    gas: makeGasPlanner({ readNativeBalance, sourceAddressFor }),
    funding: makeFundingPlanner({ readNativeBalance, sourceAddressFor }),
    enabler: makeRealVenueEnabler(),
    // Native Polymarket bridge — gasless 1:1 deposit-address lookup + pUSD withdraw.
    pmBridge: makeRealPmBridge(),
    // The cheap HL exit (HyperCore->HyperEVM->CCTP). Only when an HL signer exists.
    hlExit: addrs.hyperliquid ? makeRealHlExit() : undefined,
    // Signs + broadcasts + confirms the on-chain legs locally (same broadcasters
    // the harness uses). The on-chain tools call this to EXECUTE, not just build.
    executor: makeExecutor(),
    dailyRelayerQuota: Number(process.env.STARLING_RELAYER_QUOTA ?? 100),
    signerLoaded: (venue) => !!addrs[venueChain[venue]],
    limits: () => limits,
    dailyUsage: () => {
      rollUsage();
      return usage;
    },
    recordOpen: (n: string) => {
      rollUsage();
      usage = { ...usage, openedNotionalUsd: addDecimal(usage.openedNotionalUsd, n) };
    },
    // The loaded signer's OWN address per chain — the pinned `transfer` recipient.
    selfAddress: (chain: Chain) => sourceAddressFor(chain),
    // Destination native-gas balance (decimal units) for the transfer rail decision.
    nativeGas: nativeGasReader,
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
      case "auth_check": {
        // Gas-out reserve per loaded chain: is the wallet above the native-gas
        // floor it needs to ALWAYS be able to bridge funds home? Surfaced here so
        // the agent sees the strand-trap risk up front and tops up (ensure_gas)
        // before it trades a wallet down to where it can't move its own USDC.
        const gasChains: Chain[] = ["polygon", "hyperliquid", "solana"];
        const gasEntries = await Promise.all(
          gasChains
            .filter((c) => (c === "solana" ? addrs.solana : c === "hyperliquid" ? addrs.hyperliquid : addrs.polygon))
            .map(async (c) => {
              const s = gasReserveStatus(c, await deps.nativeGas(c).catch(() => 0));
              return [c, { balance: s.balance, floor: s.floor, symbol: s.symbol, ok: s.ok, critical: s.critical, ...(s.ok ? {} : { warning: s.note }) }] as const;
            }),
        );
        return text({
          network: process.env.STARLING_NETWORK ?? "testnet",
          keySource: activeKeySource(),
          unlockMode: process.env.STARLING_UNLOCK_MODE ?? "keychain",
          venues: Object.fromEntries(
            Object.entries(addrs).map(([k, v]) => [k, { signerLoaded: !!v }]),
          ),
          gasReserve: Object.fromEntries(gasEntries),
          // The withdraw destination(s): keystore-sealed and/or human-pasted via
          // the dashboard. Lets the dashboard render + the human verify the
          // commitment. Re-read each call so a fresh dashboard pin shows up live.
          treasury: await treasuryReport(await deps.treasury()),
        });
      }
      case "request_withdraw_address": {
        const rwaArgs = (req.params.arguments ?? {}) as Record<string, unknown>;
        const want = typeof rwaArgs.chain === "string" ? rwaArgs.chain : undefined;
        const report = await treasuryReport(await deps.treasury());
        const byChain = want ? Object.fromEntries(Object.entries(report.byChain).filter(([c]) => c === want)) : report.byChain;
        const path = pinnedTreasuryPath();
        return text({
          ...report,
          byChain,
          path,
          // The line the agent should SAY to the user when none is set / they want to change it.
          suggestedReply:
            "If you have the Starling Dashboard, please paste the withdraw address into that. " +
            "Otherwise, if you want, I can edit the withdraw address file myself.",
          // Two ways to set it. Prefer the dashboard; the file-edit is a fallback.
          setOptions: [
            {
              method: "dashboard",
              recommended: true,
              how:
                "Ask the user to run `set-treasury` in the Starling dashboard " +
                "(e.g. `python -m starling_dashboard set-treasury`) and paste the address there. " +
                "Cleanest path — you never handle the address bytes.",
            },
            {
              method: "edit_file",
              recommended: false,
              how:
                `If the user has no dashboard and explicitly asks you to — and you can write files — write ${path} ` +
                "using `fileFormat` below and the address the USER gives you (never invent or guess one). Then call " +
                "request_withdraw_address again and show the user the returned `commitment` to confirm it round-tripped uncorrupted.",
            },
          ],
          fileFormat: { version: 1, byChain: { polygon: "0x… (40 hex, EVM)", solana: "… (base58, 32 bytes)" } },
          note:
            "The withdraw tool itself takes NO recipient argument — the destination is read from this file. " +
            "Verify the commitment against your wallet/recovery sheet, not chat.",
        });
      }
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
