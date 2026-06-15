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
import { bootUnlock, loadedAddresses } from "./signers/index.js";

const log = (m: string) => process.stderr.write(`[starling] ${m}\n`);
const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

const EMPTY = { type: "object" as const, properties: {} };

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
];

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const addrs = loadedAddresses();
    switch (req.params.name) {
      case "auth_check":
        return text({
          network: process.env.STARLING_NETWORK ?? "testnet",
          signerBackend: process.env.STARLING_SIGNER_BACKEND ?? "local",
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
        return { content: [{ type: "text" as const, text: `unknown tool ${req.params.name}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  log("MCP server connected on stdio");
  // Do NOT exit on stdin EOF — supervised restarts must not be tripped by it.
}
