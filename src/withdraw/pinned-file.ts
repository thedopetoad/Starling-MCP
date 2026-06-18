// src/withdraw/pinned-file.ts
// Reads the HUMAN-pinned withdraw destination written by the Starling dashboard
// (~/.starling/treasury.json) and merges it with the keystore-sealed treasury
// into the single SealedTreasury the withdraw guardrail consumes.
//
// ---------------------------------------------------------------------------
// HONEST CEILING (same as withdraw/allowlist.ts — do not overclaim):
// This file's value is UX + TRANSCRIPTION INTEGRITY, not security. The point is
// that the user pastes a 40/44-char address ONCE, into a dashboard field, and
// those exact bytes reach disk — the agent never re-types the string into a
// config (where it could drop/flip a character and strand a sweep). A code-exec'd
// agent can still rewrite this file; this module does NOT defend against that.
// The 4-byte commitment surfaced elsewhere is a human transcription check, not a
// cryptographic one. So `sealed` is NEVER raised by this file — only the
// AAD-bound keystore sets sealed=true. A dashboard-only chain is withdraw-eligible
// (sourceByChain="dashboard") but carries sealed=false, and funding-IN recipients
// stay keystore-only (see tools/index.ts).
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs";
import path from "node:path";
import { starlingDir } from "../keystore/store.js";
import { CHAINS, type Chain } from "../keystore/format.js";
import {
  chainSource,
  type SealedTreasury,
  type TreasurySource,
} from "./allowlist.js";

const log = (m: string) => process.stderr.write(`[starling:treasury] ${m}\n`);

/** The on-disk shape the dashboard writes. Addresses are public; never secrets. */
export interface PinnedTreasuryFile {
  version: number;
  byChain: Partial<Record<Chain, string>>;
  updatedAt?: string;
  /** Per-chain transcription commitment. Recomputed server-side — not trusted from disk. */
  commitment?: Partial<Record<Chain, string>>;
}

/** Same file path the dashboard writes to (STARLING_DIR honored identically). */
export function pinnedTreasuryPath(): string {
  return path.join(starlingDir(), "treasury.json");
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/; // Bitcoin alphabet — no 0 O I l
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Validate + NORMALIZE one chain's address the way the dashboard writer does:
 * EVM = `0x` + 40 hex, lowercased (matches canonicalTreasuryFields); Solana =
 * base58 that decodes to 32 bytes, kept as-is (base58 is case-significant).
 * Returns the normalized address or null.
 */
export function normalizePinnedAddress(chain: Chain, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (chain === "solana") {
    return BASE58_RE.test(s) && base58ByteLen(s) === 32 ? s : null;
  }
  return EVM_RE.test(s) ? s.toLowerCase() : null;
}

/** Decoded byte length of a base58 string, dep-free (validation only). -1 if invalid. */
function base58ByteLen(s: string): number {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let num = 0n;
  for (const ch of s) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) return -1;
    num = num * 58n + BigInt(idx);
  }
  let bytes = 0;
  while (num > 0n) {
    num >>= 8n;
    bytes++;
  }
  return zeros + bytes;
}

/**
 * Read the dashboard-pinned destinations, or null when the file is absent /
 * unparsable / has no valid address. NEVER throws on absence (the withdraw
 * guardrail then refuses cleanly). Invalid per-chain entries are dropped (logged),
 * not fatal, so one bad paste can't block the others.
 */
export async function readPinnedTreasury(): Promise<PinnedTreasuryFile | null> {
  const p = pinnedTreasuryPath();
  let body: string;
  try {
    body = await fs.readFile(p, "utf8");
  } catch {
    return null;
  }

  // POSIX hygiene: a public-address file isn't secret, but a group/world-WRITABLE
  // one is how a *different* local process could redirect a sweep. Warn loudly;
  // don't hard-fail (that would break the feature for a benign umask on Windows).
  if (process.platform !== "win32") {
    try {
      const st = await fs.stat(p);
      if ((st.mode & 0o022) !== 0) {
        log(`WARNING: ${p} is group/world-writable (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 "${p}"`);
      }
    } catch {
      /* stat failure is non-fatal */
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    log(`ignoring ${p}: not valid JSON`);
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const rawByChain =
    obj.byChain && typeof obj.byChain === "object" ? (obj.byChain as Record<string, unknown>) : {};

  const byChain: Partial<Record<Chain, string>> = {};
  for (const chain of CHAINS) {
    const norm = normalizePinnedAddress(chain, rawByChain[chain]);
    if (norm) byChain[chain] = norm;
    else if (rawByChain[chain] !== undefined) log(`ignoring invalid ${chain} address in ${p}`);
  }
  if (Object.keys(byChain).length === 0) return null;

  return {
    version: typeof obj.version === "number" ? obj.version : 1,
    byChain,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
  };
}

/**
 * The single precedence authority composing the two destination sources.
 * Keystore-sealed addresses WIN; the dashboard file fills chains the keystore
 * doesn't seal; a per-chain DISAGREEMENT is marked "conflict" (the withdraw
 * guardrail then refuses that chain, fail-closed). Pure — unit-tested directly.
 *
 * `sealed` stays = the keystore's sealed flag (AAD-bound). The file never raises
 * it: that keeps `sealed` meaning cryptographic tamper-evidence and nothing else.
 */
export function mergeTreasury(
  keystore: SealedTreasury,
  file: PinnedTreasuryFile | null,
): SealedTreasury {
  const byChain: Partial<Record<Chain, string>> = {};
  const sourceByChain: Partial<Record<Chain, TreasurySource>> = {};

  for (const chain of CHAINS) {
    // Trust the keystore address only when the keystore is genuinely sealed.
    const ks = chainSource(keystore, chain) === "keystore" ? keystore.byChain[chain] : undefined;
    const fl = file?.byChain[chain];

    if (ks && fl) {
      if (sameAddr(chain, ks, fl)) {
        byChain[chain] = ks;
        sourceByChain[chain] = "keystore";
      } else {
        byChain[chain] = ks; // keep the stronger source's address…
        sourceByChain[chain] = "conflict"; // …but refuse until the human resolves it.
      }
    } else if (ks) {
      byChain[chain] = ks;
      sourceByChain[chain] = "keystore";
    } else if (fl) {
      byChain[chain] = fl;
      sourceByChain[chain] = "dashboard";
    }
  }

  return { byChain, sealed: keystore.sealed, sourceByChain };
}

/** Checksum-agnostic for EVM, exact for base58 (Solana) — mirrors allowlist.ts. */
function sameAddr(chain: Chain, a: string, b: string): boolean {
  return chain === "solana" ? a === b : a.toLowerCase() === b.toLowerCase();
}
