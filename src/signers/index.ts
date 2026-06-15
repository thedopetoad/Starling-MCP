// src/signers/index.ts
// The boot contract. bootUnlock() resolves a KeySource (encrypted keystore,
// plaintext env/file, or a future source) and builds in-process signers from
// whatever secrets it returns — the rest of the server is agnostic to where the
// keys came from. Decrypted secrets are zeroized the instant a signer captures
// them. Signers live ONLY in this process and never leave the box.
import { resolveKeySource } from "../keysource/index.js";
import { makeEvmSigner, type EvmSigner } from "./evm.js";
import { makeSolanaSigner, type SolanaSigner } from "./solana.js";

// stderr ONLY — the MCP stdio spec forbids non-JSON-RPC bytes on stdout.
const log = (...m: unknown[]) => process.stderr.write(`[starling] ${m.join(" ")}\n`);

let unlocked = false;
let sourceId = "none";
let polygon: EvmSigner | null = null;
let hlAgent: EvmSigner | null = null;
let solana: SolanaSigner | null = null;

export async function bootUnlock(): Promise<void> {
  if (unlocked) return;

  const source = await resolveKeySource();
  if (!source) {
    sourceId = "none";
    unlocked = true;
    log(
      "no key source found. Provide keys via STARLING_PK_* (plaintext), a keys file, " +
        "or run agent-wallet init for an encrypted keystore " +
        "(https://github.com/thedopetoad/Agent-Wallet-Setup).",
    );
    return;
  }

  sourceId = source.id;
  log(`key source: ${source.describe()}`);
  if (source.plaintext) {
    log(
      "WARNING: signing keys are in PLAINTEXT (fine for testnet / small float). " +
        "For encrypted-at-rest keys, see https://github.com/thedopetoad/Agent-Wallet-Setup",
    );
  }

  const secrets = await source.load();
  try {
    for (const { chain, secret } of secrets) {
      if (chain === "polygon") polygon = makeEvmSigner(secret);
      else if (chain === "hyperliquid") hlAgent = makeEvmSigner(secret);
      else if (chain === "solana") solana = makeSolanaSigner(secret);
    }
  } finally {
    for (const s of secrets) s.secret.fill(0); // best-effort; see threat model
  }

  unlocked = true;
  const loaded = Object.entries(loadedAddresses())
    .filter(([, v]) => v)
    .map(([k]) => k);
  log(`signers ready via "${source.id}" for: ${loaded.join(", ") || "(none — no keys for any venue)"}`);
}

export function getEvmSigner(venue: "polymarket" | "hyperliquid"): EvmSigner {
  const s = venue === "hyperliquid" ? hlAgent : polygon;
  if (!s) throw new Error(`No ${venue} signer loaded. See auth_check for the active key source.`);
  return s;
}

export function getSolanaSigner(): SolanaSigner {
  if (!solana) throw new Error("No Solana signer loaded. See auth_check for the active key source.");
  return solana;
}

/** The id of the key source that was used at boot ("keystore"|"env"|"file"|"none"). */
export function activeKeySource(): string {
  return sourceId;
}

/** Public addresses of whatever loaded — for auth_check / verify. */
export function loadedAddresses(): Record<string, string | null> {
  return {
    polygon: polygon?.address ?? null,
    hyperliquid: hlAgent?.address ?? null,
    solana: solana?.address ?? null,
  };
}
