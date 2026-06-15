// src/keysource/env.ts
// The EASY source: plaintext private keys in environment variables. Zero setup —
// paste a key and go. It is PLAINTEXT (readable by anything that can read this
// process's env), so it's fine for testnet / small float, and the server logs a
// loud warning. Graduate to the encrypted keystore source for real money.
//
//   STARLING_PK_POLYGON=0x…          (secp256k1 hex)
//   STARLING_PK_HYPERLIQUID=0x…      (secp256k1 hex)
//   STARLING_PK_SOLANA=<base58|hex>  (32-byte seed or 64-byte secret key)
import { parseEvmSecret, parseSolanaSeed } from "./parse.js";
import type { Chain } from "../keystore/format.js";
import type { ChainSecret, KeySource } from "./types.js";

const ENV: Record<Chain, string> = {
  polygon: "STARLING_PK_POLYGON",
  hyperliquid: "STARLING_PK_HYPERLIQUID",
  solana: "STARLING_PK_SOLANA",
};

export const envSource: KeySource = {
  id: "env",
  plaintext: true,
  describe: () => {
    const set = (Object.keys(ENV) as Chain[]).filter((c) => process.env[ENV[c]]);
    return `plaintext env vars (${set.length ? set.join(", ") : "none set"})`;
  },
  available: async () => (Object.keys(ENV) as Chain[]).some((c) => !!process.env[ENV[c]]),
  load: async (): Promise<ChainSecret[]> => {
    const out: ChainSecret[] = [];
    for (const chain of Object.keys(ENV) as Chain[]) {
      const raw = process.env[ENV[chain]];
      if (!raw) continue;
      out.push({ chain, secret: chain === "solana" ? parseSolanaSeed(raw) : parseEvmSecret(raw) });
    }
    return out;
  },
};
