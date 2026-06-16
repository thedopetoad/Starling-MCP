// src/adapters/jupiter.ts
// The Jupiter (Solana spot swap) VenueAdapter. Builds an UNSIGNED v0
// VersionedTransaction via the keyless Jupiter Swap API v1; the local ed25519 key
// signs it (solana-tx.ts) and the broadcast/confirm layer (solana-broadcast.ts)
// lands it. Grounded in the jupiter-solana-research sweep:
//   - keyless base: https://lite-api.jup.ag/swap/v1  (no API key)
//   - GET /quote -> quoteResponse ; POST /swap -> { swapTransaction(b64 v0), lastValidBlockHeight }
//   - wrapAndUnwrapSol:true handles native-SOL wrap + ALWAYS closes wSOL (no dust)
//   - FIXED slippageBps on the quote bounds the fill (dynamicSlippage is deprecated)
//
// Spot-swap mapping onto the position contract (base asset = SOL):
//   side "buy"  -> spend SOL to acquire marketId's mint  (amount in SOL, "collateral")
//   side "sell" -> dispose marketId's mint back to SOL    (amount in that token, "shares")
// The worst-price guarantee is the slippageBps cap Jupiter enforces as minOut.
import type {
  VenueAdapter,
  OpenIntent,
  CloseIntent,
  SolanaTxResult,
  PositionState,
} from "./types.js";
import { getSolanaSigner } from "../signers/index.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const KNOWN_DECIMALS: Record<string, number> = { [SOL_MINT]: 9, [USDC_MINT]: 6 };

const DEFAULT_BASE = "https://lite-api.jup.ag/swap/v1";

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

export class JupiterAdapter implements VenueAdapter {
  readonly venue = "jupiter" as const;
  readonly chain = "solana" as const;

  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPriorityLamports: number;

  constructor(opts: { base?: string; fetchImpl?: typeof fetch; maxPriorityLamports?: number } = {}) {
    this.base = opts.base ?? process.env.STARLING_JUP_BASE ?? DEFAULT_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxPriorityLamports = opts.maxPriorityLamports ?? Number(process.env.STARLING_JUP_MAX_PRIORITY_LAMPORTS ?? 1_000_000);
  }

  async health(): Promise<{ up: boolean; orderModel: "solanaTx"; note?: string }> {
    try {
      // a tiny quote is the cheapest liveness probe
      await this.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amountBaseUnits: "1000000", slippageBps: 50 });
      return { up: true, orderModel: "solanaTx" };
    } catch (e) {
      return { up: false, orderModel: "solanaTx", note: (e as Error).message };
    }
  }

  async resolveMarket(marketId: string): Promise<{ ok: boolean; meta: Record<string, unknown> }> {
    const mint = stripJupPrefix(marketId);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return { ok: false, meta: { error: `marketId must be a base58 SPL mint, got "${marketId}"` } };
    }
    return { ok: true, meta: { mint, knownDecimals: KNOWN_DECIMALS[mint] ?? null } };
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
   * Build a swap as an open. worstPrice is an ABSOLUTE floor (see below) and is
   * enforced against the quote's GUARANTEED minOut — not just Jupiter's relative
   * slippageBps around its own (possibly stale/manipulated) quote.
   *
   * CAVEAT (policy cap): a "buy" denominates intent.amount in SOL, but the risk
   * engine's openNotionalUsd treats "collateral" as USD — so per-trade/daily caps
   * under-count SOL-denominated buys until the policy layer is asset-aware. Prefer
   * USDC-denominated sizing for cap-sensitive flows. CAVEAT (fee/rent): the adapter
   * can't read balances; the caller (broadcast layer / harness) must keep a SOL
   * reserve so a buy can't wrap the entire balance and strand fees+rent.
   */
  async buildOpen(intent: OpenIntent): Promise<SolanaTxResult> {
    if (intent.venue !== "jupiter") throw new Error(`JupiterAdapter got a ${intent.venue} intent`);
    const targetMint = stripJupPrefix(intent.marketId);
    const inputMint = intent.side === "buy" ? SOL_MINT : targetMint;
    const outputMint = intent.side === "buy" ? targetMint : SOL_MINT;
    const inDecimals = decimalsOf(inputMint);
    const outDecimals = decimalsOf(outputMint);
    const slippageBps = fracToBps(intent.slippageFrac);

    const amountBaseUnits = toBaseUnits(intent.amount, inDecimals);
    const quote = await this.quote({ inputMint, outputMint, amountBaseUnits, slippageBps });

    // Absolute worst-price floor: worstPrice = MINIMUM acceptable OUTPUT units per
    // 1 INPUT unit (a rate). "0" disables it (slippageBps is then the only bound).
    // Checked against otherAmountThreshold = the GUARANTEED minimum out after
    // slippage, so even the worst allowed fill must clear the caller's floor.
    const worst = Number(intent.worstPrice);
    if (worst > 0) {
      const guaranteedOut = Number(quote.otherAmountThreshold) / 10 ** outDecimals;
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
    // open_position(side:"sell"). Surface that instead of guessing a balance.
    throw new Error('jupiter is spot: close by calling open_position side:"sell" with an explicit token amount');
  }

  async state(_marketId: string): Promise<PositionState | null> {
    return null; // spot balances are read via the RPC layer, not tracked as positions
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
    throw new Error(`unknown decimals for mint ${mint}; supply a known mint (SOL/USDC) for now`);
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
