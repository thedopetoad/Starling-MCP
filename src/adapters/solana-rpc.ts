// src/adapters/solana-rpc.ts
// Minimal Solana JSON-RPC client (fetch only) for the broadcast/confirm path. No
// key material here. Endpoint from STARLING_SOLANA_RPC (default mainnet-beta
// public — fine for a small self-test; swap in a paid RPC for production volume).
export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
// @noble exposes the curve point as ExtendedPoint (older) or Point (newer).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _Point: any = (ed25519 as any).ExtendedPoint ?? (ed25519 as any).Point;

function _isOnCurve(bytes: Uint8Array): boolean {
  try { _Point.fromHex(bytes); return true; } catch { return false; }
}
function _cat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** Derive the SPL associated token account for (owner, mint) — pure, keyless,
 *  matches @solana/spl-token's getAssociatedTokenAddress. Lets us read a token
 *  balance via the LIGHT getTokenAccountBalance(ata) instead of the heavy
 *  getTokenAccountsByOwner that public RPCs rate-limit. */
export function associatedTokenAddress(owner: string, mint: string): string {
  const seeds = [base58.decode(owner), base58.decode(TOKEN_PROGRAM), base58.decode(mint)];
  const prog = base58.decode(ATA_PROGRAM);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(_cat(...seeds, new Uint8Array([bump]), prog, PDA_MARKER));
    if (!_isOnCurve(h)) return base58.encode(h);
  }
  throw new Error("no off-curve bump for ATA");
}

export interface LatestBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface SimResult {
  err: unknown | null;
  logs: string[] | null;
  unitsConsumed?: number;
}

export interface SigStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export class SolanaRpc {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private id = 0;

  constructor(opts: { url?: string; fetchImpl?: typeof fetch } = {}) {
    this.url = opts.url ?? process.env.STARLING_SOLANA_RPC ?? SOLANA_MAINNET_RPC;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call<T>(method: string, params: any[]): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`Solana RPC ${method} -> HTTP ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
    return json.result as T;
  }

  async getBalanceLamports(address: string): Promise<number> {
    const r = await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    return r.value;
  }

  /** Parsed SPL token balance for (owner, mint), or null if no account exists. */
  async getTokenBalance(
    owner: string,
    mint: string,
  ): Promise<{ amount: string; decimals: number; uiAmount: number } | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await this.call<any>("getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    const acct = r?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
    if (!acct) return null;
    return { amount: acct.amount, decimals: acct.decimals, uiAmount: acct.uiAmount };
  }

  /** Balance of a SPECIFIC token account (e.g. an ATA) — a much lighter call than
   *  getTokenAccountsByOwner, so public RPCs serve it reliably. THROWS if the
   *  account doesn't exist ("could not find account"); callers treat that as 0. */
  async getTokenAccountBalance(account: string): Promise<{ amount: string; decimals: number; uiAmount: number }> {
    const r = await this.call<{ value: { amount: string; decimals: number; uiAmount: number } }>(
      "getTokenAccountBalance",
      [account, { commitment: "confirmed" }],
    );
    return r.value;
  }

  /** Mint decimals (+ total supply) for ANY mint — on-chain truth, works even when
   *  the wallet holds none of it. The universal fallback for token-decimals lookup. */
  async getTokenSupply(mint: string): Promise<{ amount: string; decimals: number }> {
    const r = await this.call<{ value: { amount: string; decimals: number } }>("getTokenSupply", [
      mint,
      { commitment: "confirmed" },
    ]);
    return r.value;
  }

  async getLatestBlockhash(commitment = "confirmed"): Promise<LatestBlockhash> {
    const r = await this.call<{ value: LatestBlockhash }>("getLatestBlockhash", [{ commitment }]);
    return r.value;
  }

  async getBlockHeight(commitment = "confirmed"): Promise<number> {
    return this.call<number>("getBlockHeight", [{ commitment }]);
  }

  /** Simulate WITHOUT signature verification, replacing the blockhash so an
   *  almost-stale one doesn't fail the sim. A non-null `err` means it would revert. */
  async simulate(txB64: string): Promise<SimResult> {
    const r = await this.call<{ value: SimResult }>("simulateTransaction", [
      txB64,
      { encoding: "base64", replaceRecentBlockhash: true, sigVerify: false, commitment: "processed" },
    ]);
    return r.value;
  }

  async sendRawTransaction(
    txB64: string,
    opts: { skipPreflight?: boolean; maxRetries?: number; preflightCommitment?: string } = {},
  ): Promise<string> {
    return this.call<string>("sendTransaction", [
      txB64,
      {
        encoding: "base64",
        skipPreflight: opts.skipPreflight ?? false,
        preflightCommitment: opts.preflightCommitment ?? "confirmed",
        maxRetries: opts.maxRetries ?? 5,
      },
    ]);
  }

  /** `searchHistory` consults the longer transaction-history index (not just the
   *  ~150-slot recent cache) — REQUIRED near/after blockhash expiry so a swap that
   *  landed early and aged out of the cache isn't misread as "never landed". */
  async getSignatureStatus(sig: string, searchHistory = false): Promise<SigStatus | null> {
    const r = await this.call<{ value: (SigStatus | null)[] }>("getSignatureStatuses", [
      [sig],
      { searchTransactionHistory: searchHistory },
    ]);
    return r.value[0] ?? null;
  }
}
