// src/keysource/file.ts
// The EASIEST source: a plaintext JSON file of keys. This is the "I'll just put
// my keys in a file" path — supported on purpose so the MCP works for everyone,
// but it is PLAINTEXT and the server warns loudly. Default path:
// ~/.starling/keys.plain.json (override with STARLING_KEYS_FILE).
//
//   { "polygon": "0x…", "hyperliquid": "0x…", "solana": "<base58|hex>" }
import { promises as fs } from "node:fs";
import path from "node:path";
import { starlingDir } from "../keystore/store.js";
import { parseEvmSecret, parseSolanaSeed } from "./parse.js";
import { CHAINS, type Chain } from "../keystore/format.js";
import type { ChainSecret, KeySource } from "./types.js";

function filePath(): string {
  return process.env.STARLING_KEYS_FILE ?? path.join(starlingDir(), "keys.plain.json");
}

export const fileSource: KeySource = {
  id: "file",
  plaintext: true,
  describe: () => `plaintext key file at ${filePath()}`,
  available: async () =>
    fs
      .access(filePath())
      .then(() => true)
      .catch(() => false),
  load: async (): Promise<ChainSecret[]> => {
    const json = JSON.parse(await fs.readFile(filePath(), "utf8")) as Record<string, string>;
    const out: ChainSecret[] = [];
    for (const chain of CHAINS as readonly Chain[]) {
      const raw = json[chain];
      if (!raw) continue;
      out.push({ chain, secret: chain === "solana" ? parseSolanaSeed(raw) : parseEvmSecret(raw) });
    }
    return out;
  },
};
