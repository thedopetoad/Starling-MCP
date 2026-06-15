// src/keysource/index.ts
// Resolve which key source the MCP should sign from.
//
//   STARLING_KEY_SOURCE = auto (default) | keystore | env | file
//
// `auto` picks the first AVAILABLE source in priority order (most-secure first:
// keystore > env > file). So a user who ran agent-wallet gets their encrypted
// keystore automatically, while someone who only pasted an env key still works
// with zero config. Set it explicitly to force one source.
//
// To add a source (OS keychain, cloud KMS, a hosted signer): implement KeySource
// and add it to REGISTRY. Nothing else changes.
import { keystoreSource } from "./keystore.js";
import { envSource } from "./env.js";
import { fileSource } from "./file.js";
import type { KeySource } from "./types.js";

export type { KeySource, ChainSecret } from "./types.js";

const REGISTRY: KeySource[] = [keystoreSource, envSource, fileSource];

const log = (m: string) => process.stderr.write(`[starling:keysource] ${m}\n`);

export async function resolveKeySource(): Promise<KeySource | null> {
  const want = (process.env.STARLING_KEY_SOURCE ?? "auto").toLowerCase();
  if (want !== "auto") {
    const src = REGISTRY.find((s) => s.id === want);
    if (!src) {
      throw new Error(`unknown STARLING_KEY_SOURCE=${want} (expected: auto|keystore|env|file)`);
    }
    if (!(await src.available())) {
      log(`WARNING: STARLING_KEY_SOURCE=${want} selected but no keys were found for it`);
    }
    return src;
  }
  for (const src of REGISTRY) {
    if (await src.available()) return src;
  }
  return null;
}
