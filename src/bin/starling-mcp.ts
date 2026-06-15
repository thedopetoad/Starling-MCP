#!/usr/bin/env node
// src/bin/starling-mcp.ts — entrypoint.
//   starling-mcp            start the stdio MCP server (default)
//   starling-mcp serve      same
//   starling-mcp verify     unlock the keystore and print derived addresses (JSON)
//   starling-mcp doctor     hygiene checks
//   starling-mcp --version | --help
import { bootUnlock, loadedAddresses, activeKeySource } from "../signers/index.js";

const VERSION = "1.0.0";
const HELP = `Starling execution MCP — connect your trading bot to every venue.

Usage:
  starling-mcp            Start the stdio MCP server (what your agent host launches)
  starling-mcp verify     Unlock the local keystore and print derived addresses
  starling-mcp doctor     Hygiene checks
  starling-mcp --version

Reads the encrypted keystore created by agent-wallet
(https://github.com/thedopetoad/Agent-Wallet-Setup) from ~/.starling
(override with STARLING_DIR). Unlock mode via STARLING_UNLOCK_MODE
(keychain|env|tpm|kms|file). Keys never leave this process.`;

async function verify(): Promise<void> {
  // Throws on failure (non-zero exit) so CI / the interop test catches it.
  await bootUnlock();
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        network: process.env.STARLING_NETWORK ?? "testnet",
        keySource: activeKeySource(),
        addresses: loadedAddresses(),
      },
      null,
      2,
    ) + "\n",
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case "serve":
      return (await import("../server.js")).startServer();
    case "verify":
      return verify();
    case "doctor":
      return (await import("../doctor.js")).run();
    case "--version":
    case "-v":
      process.stdout.write(VERSION + "\n");
      return;
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      return;
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${HELP}\n`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(`\nstarling-mcp: ${e?.message ?? e}\n`);
  process.exit(1);
});
