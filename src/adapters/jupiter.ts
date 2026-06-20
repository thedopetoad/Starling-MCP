// src/adapters/jupiter.ts
// The Jupiter (Solana spot swap) VenueAdapter. Builds an UNSIGNED v0
// VersionedTransaction via the keyless Jupiter Swap API v1; the local ed25519 key
// signs it (solana-tx.ts) and the broadcast/confirm layer (solana-broadcast.ts)
// lands it.
//   - keyless base: https://lite-api.jup.ag/swap/v1  (NO API key — nothing to leak)
//   - GET /quote -> quoteResponse ; POST /swap -> { swapTransaction(b64 v0), lastValidBlockHeight }
//   - wrapAndUnwrapSol:true handles native-SOL wrap + ALWAYS closes wSOL (no dust)
//   - FIXED slippageBps on the quote bounds the fill (dynamicSlippage is deprecated)
//   - ZERO platform fee on the keyless lite-api (verified: quote.platformFee == null)
//
// ARBITRARY TOKENS (any SPL mint, any pair — not just SOL/USDC). The marketId is a
// PAIR: the FIRST mint is the quote currency, the SECOND is the asset.
//   - "jup:<assetMint>"            -> SOL is the quote (back-compat shorthand)
//   - "jup:<quoteMint>:<assetMint>" (or .../<assetMint>) -> explicit quote currency,
//      e.g. "jup:<USDC>:<BONK>" trades BONK priced in USDC.
// side maps onto the asset (the second mint):
//   "buy"  -> spend the QUOTE to acquire the ASSET  (amount in the quote token)
//   "sell" -> dispose the ASSET back to the QUOTE   (amount in the asset token)
// worstPrice is an ABSOLUTE floor = MINIMUM output units per 1 input unit, enforced
// against the quote's GUARANTEED minOut (otherAmountThreshold). Token decimals are
// resolved for ANY mint (Jupiter token API v2 -> RPC getTokenSupply fallback), cached.
import type {
  VenueAdapter,
  OpenIntent,
  CloseIntent,
  SolanaTxResult,
  PositionState,
} from "./types.js";
import { getSolanaSigner } from "../signers/index.js";
import { SolanaRpc } from "./solana-rpc.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const KNOWN_DECIMALS: Record<string, number> = { [SOL_MINT]: 9, [USDC_MINT]: 6 };
const KNOWN_SYMBOL: Record<string, string> = { [SOL_MINT]: "SOL", [USDC_MINT]: "USDC" };

const DEFAULT_BASE = "https://lite-api.jup.ag/swap/v1";
const DEFAULT_TOKEN_BASE = "https://lite-api.jup.ag/tokens/v2";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any; // pass the WHOLE quote object back to /swap unchanged
}

export interface JupiterSwapBuild {
  swapTransaction: string; // base64 unsigned v0 VersionedTransaction
  lastValidBlockHeight: number;
}

export interface TokenMeta {
  decimals: number;
  symbol: string;
}

export class JupiterAdapter implements VenueAdapter {
  readonly venue = "jupiter" as const;
  readonly chain = "solana" as const;

  private readonly base: string;
  private readonly tokenBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rpc: Pick<SolanaRpc, "getTokenSupply">;
  private readonly maxPriorityLamports: number;
  private readonly metaCache = new Map<string, TokenMeta>();

  constructor(opts: { base?: string; tokenBase?: string; fetchImpl?: typeof fetch; rpc?: Pick<SolanaRpc, "getTokenSupply">; maxPriorityLamports?: number } = {}) {
    this.base = opts.base ?? process.env.STARLING_JUP_BASE ?? DEFAULT_BASE;
    this.tokenBase = opts.tokenBase ?? process.env.STARLING_JUP_TOKEN_BASE ?? DEFAULT_TOKEN_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rpc = opts.rpc ?? new SolanaRpc({ fetchImpl: this.fetchImpl });
    this.maxPriorityLamports = opts.maxPriorityLamports ?? Number(process.env.STARLING_JUP_MAX_PRIORITY_LAMPORTS ?? 1_000_000);
  }

  async health(): Promise<{ up: boolean; orderModel: "solanaTx"; note?: string }> {
    try {
      await this.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amountBaseUnits: "1000000", slippageBps: 50 });
      return { up: true, orderModel: "solanaTx" };
    } catch (e) {
      return { up: false, orderModel: "solanaTx", note: (e as Error).message };
    }
  }

  /**
   * Resolve a mint's decimals + symbol for ANY SPL token. Order: a known constant
   * (SOL/USDC, instant) -> the in-memory cache -> the Jupiter token API v2 (keyless,
   * carries the symbol) -> on-chain getTokenSupply (universal truth, catches brand-new
   * mints the index hasn't picked up). Cached so a hot pair costs at most one lookup.
   */
  async resolveTokenMeta(mint: string): Promise<TokenMeta> {
    if (KNOWN_DECIMALS[mint] !== undefined) return { decimals: KNOWN_DECIMALS[mint], symbol: KNOWN_SYMBOL[mint] ?? mint.slice(0, 4) };
    const cached = this.metaCache.get(mint);
    if (cached) return cached;

    let meta: TokenMeta | null = null;
    // 1. Jupiter token API v2 search (keyless; gives the symbol).
    try {
      const res = await this.fetchImpl(`${this.tokenBase}/search?query=${encodeURIComponent(mint)}`);
      if (res.ok) {
        const arr = (await res.json()) as Array<{ id: string; decimals: number; symbol?: string }>;
        const hit = Array.isArray(arr) ? arr.find((t) => t.id === mint) : undefined;
        if (hit && Number.isInteger(hit.decimals)) meta = { decimals: hit.decimals, symbol: hit.symbol || mint.slice(0, 4) };
      }
    } catch {
      // fall through to the on-chain read
    }
    // 2. On-chain getTokenSupply — works for any mint, even if Jupiter hasn't indexed it.
    if (!meta) {
      const sup = await this.rpc.getTokenSupply(mint);
      if (!Number.isInteger(sup.decimals)) throw new Error(`could not resolve decimals for mint ${mint}`);
      meta = { decimals: sup.decimals, symbol: mint.slice(0, 4) };
    }
    this.metaCache.set(mint, meta);
    return meta;
  }

  async resolveMarket(marketId: string): Promise<{ ok: boolean; meta: Record<string, unknown> }> {
    let pair: { quoteMint: string; assetMint: string };
    try {
      pair = parseJupPair(marketId);
    } catch (e) {
      return { ok: false, meta: { error: (e as Error).message } };
    }
    try {
      const [asset, quote] = await Promise.all([this.resolveTokenMeta(pair.assetMint), this.resolveTokenMeta(pair.quoteMint)]);
      // Best-effort current price: quote 1 whole quote-unit -> asset. quotePerAsset is
      // the price of 1 asset in the quote currency (what a bot sets worstPrice from).
      let assetPerQuote: number | null = null;
      let quotePerAsset: number | null = null;
      try {
        const q = await this.quote({ inputMint: pair.quoteMint, outputMint: pair.assetMint, amountBaseUnits: String(10 ** quote.decimals), slippageBps: 50 });
        assetPerQuote = Number(q.outAmount) / 10 ** asset.decimals;
        quotePerAsset = assetPerQuote > 0 ? 1 / assetPerQuote : null;
      } catch {
        // price is best-effort; the pair still resolved
      }
      return {
        ok: true,
        meta: {
          quoteMint: pair.quoteMint,
          assetMint: pair.assetMint,
          quoteSymbol: quote.symbol,
          assetSymbol: asset.symbol,
          quoteDecimals: quote.decimals,
          assetDecimals: asset.decimals,
          assetPerQuote,
          quotePerAsset,
          pair: `${asset.symbol}/${quote.symbol}`,
        },
      };
    } catch (e) {
      return { ok: false, meta: { error: `resolve failed: ${(e as Error).message}`, ...pair } };
    }
  }

  /** GET /quote. Returns the full quote object (passed verbatim to /swap). */
  async quote(args: {
    inputMint: string;
    outputMint: string;
    amountBaseUnits: string;
    slippageBps: number;
  }): Promise<JupiterQuote> {
    const u = new URL(`${this.base}/quote`);
    u.searchParams.set("inputMint", args.inputMint);
    u.searchParams.set("outputMint", args.outputMint);
    u.searchParams.set("amount", args.amountBaseUnits);
    u.searchParams.set("slippageBps", String(args.slippageBps));
    u.searchParams.set("restrictIntermediateTokens", "true");
    u.searchParams.set("swapMode", "ExactIn");
    const res = await this.fetchImpl(u.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jupiter /quote -> HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as JupiterQuote;
  }

  /** POST /swap. Returns the unsigned base64 v0 tx + its lastValidBlockHeight. */
  async buildSwap(args: { quoteResponse: JupiterQuote; userPublicKey: string }): Promise<JupiterSwapBuild> {
    const body = {
      quoteResponse: args.quoteResponse,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: this.maxPriorityLamports, priorityLevel: "veryHigh" },
      },
    };
    const res = await this.fetchImpl(`${this.base}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Jupiter /swap -> HTTP ${res.status} ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as JupiterSwapBuild;
    if (!json.swapTransaction) throw new Error("Jupiter /swap returned no swapTransaction");
    return json;
  }

  /**
   * Build a swap as an open. The marketId pair decides the mints; side decides the
   * direction (buy = spend quote -> get asset; sell = spend asset -> get quote).
   *
   * CAVEAT (policy cap): the risk engine's openNotionalUsd treats "collateral" as USD.
   * A USDC-quoted buy sizes intent.amount in USDC (≈ USD) so the per-trade/daily caps
   * are accurate; a SOL-quoted buy still under-counts until the policy layer is
   * asset-aware — prefer a USDC quote currency for cap-sensitive flows. CAVEAT (fee/rent):
   * the adapter can't read balances; the broadcast layer must keep a SOL reserve so a
   * buy can't wrap the whole balance and strand fees + rent.
   */
  async buildOpen(intent: OpenIntent): Promise<SolanaTxResult> {
    if (intent.venue !== "jupiter") throw new Error(`JupiterAdapter got a ${intent.venue} intent`);
    const pair = parseJupPair(intent.marketId);
    const inputMint = intent.side === "buy" ? pair.quoteMint : pair.assetMint;
    const outputMint = intent.side === "buy" ? pair.assetMint : pair.quoteMint;
    const [inMeta, outMeta] = await Promise.all([this.resolveTokenMeta(inputMint), this.resolveTokenMeta(outputMint)]);
    const slippageBps = fracToBps(intent.slippageFrac);

    const amountBaseUnits = toBaseUnits(intent.amount, inMeta.decimals);
    const quote = await this.quote({ inputMint, outputMint, amountBaseUnits, slippageBps });

    // Absolute worst-price floor: worstPrice = MINIMUM acceptable OUTPUT units per 1
    // INPUT unit (a rate). "0" disables it (slippageBps is then the only bound).
    // Checked against otherAmountThreshold = the GUARANTEED minimum out after slippage,
    // so even the worst allowed fill must clear the caller's floor.
    const worst = Number(intent.worstPrice);
    if (worst > 0) {
      const guaranteedOut = Number(quote.otherAmountThreshold) / 10 ** outMeta.decimals;
      const inUi = Number(intent.amount);
      const rate = guaranteedOut / inUi;
      if (!(rate >= worst)) {
        throw new Error(
          `Jupiter quote rate ${rate.toFixed(8)} out/in is below worstPrice floor ${worst} — refusing swap`,
        );
      }
    }

    const { swapTransaction, lastValidBlockHeight } = await this.buildSwap({
      quoteResponse: quote,
      userPublicKey: getSolanaSigner().address, // local signer, like PM/HL adapters
    });
    return { kind: "solanaTx", chain: "solana", unsignedTxB64: swapTransaction, lastValidBlockHeight };
  }

  async buildClose(_intent: CloseIntent): Promise<SolanaTxResult> {
    // Spot swaps have no "position fraction"; sell an explicit amount via
    // open_position(side:"sell") with the same pair.
    throw new Error('jupiter is spot: close by calling open_position side:"sell" with the same marketId pair + an explicit token amount');
  }

  async state(_marketId: string): Promise<PositionState | null> {
    return null; // spot balances are read via the RPC layer, not tracked as positions
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a Jupiter marketId into { quoteMint, assetMint }. The FIRST mint is the
 * quote currency, the SECOND is the asset:
 *   "jup:<asset>"              -> SOL quote (shorthand)
 *   "jup:<quote>:<asset>"      -> explicit quote (": " or "/" separator)
 *   "<quote>/<asset>"          -> prefix optional
 * Throws on a malformed id (not 1-2 base58 mints).
 */
export function parseJupPair(marketId: string): { quoteMint: string; assetMint: string } {
  let s = marketId.trim();
  const i = s.indexOf(":");
  if (i !== -1) {
    const prefix = s.slice(0, i).toLowerCase();
    if (prefix === "jup" || prefix === "jupiter" || prefix === "sol") s = s.slice(i + 1);
  }
  const parts = s.split(/[:/]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    if (!MINT_RE.test(parts[0])) throw new Error(`marketId "${marketId}": expected a base58 SPL mint`);
    return { quoteMint: SOL_MINT, assetMint: parts[0] };
  }
  if (parts.length === 2) {
    if (!MINT_RE.test(parts[0]) || !MINT_RE.test(parts[1])) throw new Error(`marketId "${marketId}": both quote and asset must be base58 SPL mints`);
    return { quoteMint: parts[0], assetMint: parts[1] };
  }
  throw new Error(`marketId "${marketId}": expected "jup:<mint>" or "jup:<quoteMint>:<assetMint>"`);
}

/** Back-compat single-mint strip (SOL-base). Retained for callers/tests that pass
 *  one mint; new code should use parseJupPair. */
export function stripJupPrefix(marketId: string): string {
  const i = marketId.indexOf(":");
  if (i === -1) return marketId;
  const prefix = marketId.slice(0, i).toLowerCase();
  if (prefix === "jup" || prefix === "jupiter" || prefix === "sol") return marketId.slice(i + 1);
  return marketId;
}

export function decimalsOf(mint: string): number {
  const d = KNOWN_DECIMALS[mint];
  if (d === undefined) {
    throw new Error(`unknown decimals for mint ${mint}; use resolveTokenMeta() for arbitrary mints`);
  }
  return d;
}

/** Decimal token amount -> integer base-unit string (no float drift). */
export function toBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount.trim())) throw new Error(`amount "${amount}" must be a non-negative decimal`);
  const [whole, frac = ""] = amount.trim().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) {
    throw new Error(`amount "${amount}" has more precision than ${decimals} decimals`);
  }
  return combined === "" ? "0" : combined;
}

function fracToBps(slippageFrac?: number): number {
  const f = slippageFrac ?? 0.005; // default 0.5%
  if (!(f > 0) || f > 0.5) throw new Error(`slippageFrac ${f} out of range (0, 0.5]`);
  return Math.round(f * 10_000);
}

export const jupiterAdapter = new JupiterAdapter();
