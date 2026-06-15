// src/signers/index.ts
// The boot contract. bootUnlock() unlocks ALL keystores once at startup; the
// decrypted secret is zeroized the instant the signer captures what it needs.
// getEvmSigner()/getSolanaSigner() hand out in-process signers that live ONLY
// in this MCP process and never leave the box.
import { readKeystore } from "../keystore/store.js";
import { decryptKeystore } from "../keystore/crypto.js";
import { CHAINS } from "../keystore/format.js";
import { resolvePassphrase } from "../unlock/index.js";
import { makeEvmSigner, type EvmSigner } from "./evm.js";
import { makeSolanaSigner, type SolanaSigner } from "./solana.js";

// stderr ONLY — the MCP stdio spec forbids non-JSON-RPC bytes on stdout.
const log = (...m: unknown[]) => process.stderr.write(`[starling] ${m.join(" ")}\n`);

let unlocked = false;
let polygon: EvmSigner | null = null;
let hlAgent: EvmSigner | null = null;
let solana: SolanaSigner | null = null;

export async function bootUnlock(): Promise<void> {
  if (unlocked) return;
  const backend = process.env.STARLING_SIGNER_BACKEND ?? "local";
  if (backend === "turnkey") {
    // Tier 2: keys decrypted only inside the provider's enclaves; getEvmSigner/
    // getSolanaSigner would route through the Turnkey SDK. Out of scope for v1.
    throw new Error("STARLING_SIGNER_BACKEND=turnkey is not wired in this build; use 'local'");
  }

  const pass = await resolvePassphrase();
  try {
    for (const chain of CHAINS) {
      const ks = await readKeystore(chain).catch(() => null);
      if (!ks) continue;
      const secret = decryptKeystore(ks, pass);
      try {
        if (chain === "polygon") polygon = makeEvmSigner(secret);
        else if (chain === "hyperliquid") hlAgent = makeEvmSigner(secret);
        else solana = makeSolanaSigner(secret);
      } finally {
        secret.fill(0); // best-effort; see threat model
      }
    }
  } finally {
    pass.fill(0);
  }
  unlocked = true;
  const loaded = Object.entries(loadedAddresses())
    .filter(([, v]) => v)
    .map(([k]) => k);
  log(`keystore unlocked; signers ready for: ${loaded.join(", ") || "(none — run agent-wallet init)"}`);
}

export function getEvmSigner(venue: "polymarket" | "hyperliquid"): EvmSigner {
  const s = venue === "hyperliquid" ? hlAgent : polygon;
  if (!s) throw new Error(`No ${venue} signer. Create one with: agent-wallet init`);
  return s;
}

export function getSolanaSigner(): SolanaSigner {
  if (!solana) throw new Error("No Solana signer. Create one with: agent-wallet init");
  return solana;
}

/** Public addresses of whatever unlocked — for auth_check / verify. */
export function loadedAddresses(): Record<string, string | null> {
  return {
    polygon: polygon?.address ?? null,
    hyperliquid: hlAgent?.address ?? null,
    solana: solana?.address ?? null,
  };
}
