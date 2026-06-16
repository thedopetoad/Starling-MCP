// src/adapters/solana-rpc.ts
// Minimal Solana JSON-RPC client (fetch only) for the broadcast/confirm path. No
// key material here. Endpoint from STARLING_SOLANA_RPC (default mainnet-beta
// public — fine for a small self-test; swap in a paid RPC for production volume).
export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

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
