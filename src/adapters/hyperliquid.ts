// src/adapters/hyperliquid.ts
// The Hyperliquid VenueAdapter. Same contract as Polymarket: PURE builder + reads,
// signs the action locally via getEvmSigner('hyperliquid'), and submit() POSTs the
// signed action to /exchange. Hyperliquid is its OWN L1 (HyperCore) — orders are
// msgpack-hashed L1 actions, not EVM txs, and settle on the L1 (no tx hashes).
//
// Trading model (decided):
//   - PERPS: marketId is "hl:<COIN>" (e.g. "hl:BTC"); the COIN resolves to an asset
//     INDEX in the perp meta universe, which is what the order references.
//   - SPOT: marketId is "hlspot:<TOKEN>" (e.g. "hlspot:HYPE"), "hlspot:<BASE>/USDC",
//     or "hlspot:@<pairIndex>". The base token resolves through spotMeta to its USDC
//     pair; the order's asset INDEX is 10000 + the spot pair index (HL's spot asset
//     convention). szDecimals come from the TOKEN; the "position" is the token balance.
//   In both cases the index is RE-RESOLVED per build so a re-listed index can't go stale.
//   - IOC (immediate-or-cancel) limit orders bounded by worstPrice for buildOpen/
//     buildClose. This is the no-resting analogue of PM's FAK. Resting (Gtc/Alo),
//     trigger (tp/sl), TWAP, cancels, leverage, vaults and staking live in hl-venue.ts
//     (the HL-specific tool surface) — this adapter stays the generic open/close path.
//   - AMOUNT-KIND: "collateral" => USD notional (size = usd / price); "shares" =>
//     base-asset size directly. Either way the size is floored to szDecimals so a
//     BUY never deploys more than the budget and a close never exceeds the position.
//
// WORST-PRICE INVARIANT: worstPrice is required and becomes the IOC limit price,
// rounded onto HL's price grid (<=5 significant figures AND <= (maxDecimals - szDecimals)
// decimals, maxDecimals 6 for perps / 8 for spot; integer prices are always valid).

import type {
  VenueAdapter,
  OpenIntent,
  CloseIntent,
  HlActionResult,
  BuildResult,
  PositionState,
  SubmitResult,
} from "./types.js";
import { getEvmSigner } from "../signers/index.js";
import { signL1Action, signWithdraw } from "./hl-signing.js";
import { HL_MAINNET, HL_TESTNET, infoPost, postExchange } from "./hl-transport.js";

/** A resolved HL market: the asset index the order references + size precision. */
export interface ResolvedHl {
  coin: string;
  assetIndex: number;
  szDecimals: number;
  isSpot: boolean;
  /** Spot base-token native wei decimals (used by staking/transfers). Perp: undefined. */
  weiDecimals?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Meta = { universe: { name: string; szDecimals: number }[] } & Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpotMeta = {
  tokens: { name: string; szDecimals: number; weiDecimals: number; index: number }[];
  universe: { tokens: [number, number]; name: string; index: number }[];
} & Record<string, any>;

/** Parse a marketId into {isSpot, query}. "hlspot:" => spot; "hl:"/"hyperliquid:"/bare => perp. */
export function parseHlMarket(marketId: string): { isSpot: boolean; query: string } {
  const i = marketId.indexOf(":");
  if (i !== -1) {
    const prefix = marketId.slice(0, i).toLowerCase();
    if (prefix === "hlspot" || prefix === "spot") return { isSpot: true, query: marketId.slice(i + 1) };
  }
  return { isSpot: false, query: stripHlPrefix(marketId) };
}

/**
 * Resolve a perp or spot market to its asset index + size precision + current mid.
 * Standalone (shared by the adapter AND hl-venue.ts) so the spotMeta math lives in
 * exactly one place. mid is numeric (null if the venue has no quote yet).
 */
export async function resolveHlAsset(
  marketId: string,
  opts: { host: string; fetchImpl?: typeof fetch },
): Promise<{ ok: boolean; resolved?: ResolvedHl; mid: number | null; meta: Record<string, unknown> }> {
  const { isSpot, query } = parseHlMarket(marketId);
  const fetchImpl = opts.fetchImpl;
  try {
    if (!isSpot) {
      const [meta, mids] = await Promise.all([
        infoPost<Meta>({ type: "meta" }, { host: opts.host, fetchImpl }),
        infoPost<Record<string, string>>({ type: "allMids" }, { host: opts.host, fetchImpl }),
      ]);
      const coin = query.toUpperCase();
      const idx = meta.universe.findIndex((u) => String(u.name).toUpperCase() === coin);
      if (idx < 0) return { ok: false, mid: null, meta: { error: `unknown HL perp "${coin}"` } };
      const szDecimals = Number(meta.universe[idx].szDecimals);
      const mid = mids?.[coin] != null ? Number(mids[coin]) : null;
      const resolved: ResolvedHl = { coin, assetIndex: idx, szDecimals, isSpot: false };
      return { ok: true, resolved, mid, meta: { coin, assetIndex: idx, szDecimals, isSpot: false, mid } };
    }
    // Spot: resolve the base token -> its USDC pair -> assetIndex 10000 + pairIndex.
    const [spotMeta, mids] = await Promise.all([
      infoPost<SpotMeta>({ type: "spotMeta" }, { host: opts.host, fetchImpl }),
      infoPost<Record<string, string>>({ type: "allMids" }, { host: opts.host, fetchImpl }),
    ]);
    let pair: SpotMeta["universe"][number] | undefined;
    let baseTok: SpotMeta["tokens"][number] | undefined;
    if (query.startsWith("@")) {
      const pidx = Number(query.slice(1));
      pair = spotMeta.universe.find((u) => u.index === pidx) ?? spotMeta.universe[pidx];
      baseTok = pair ? spotMeta.tokens.find((t) => t.index === pair!.tokens[0]) : undefined;
      if (!pair) return { ok: false, mid: null, meta: { error: `unknown HL spot pair "${query}"` } };
    } else {
      const base = query.split("/")[0].toUpperCase();
      baseTok = spotMeta.tokens.find((t) => String(t.name).toUpperCase() === base);
      if (!baseTok) return { ok: false, mid: null, meta: { error: `unknown HL spot token "${base}"` } };
      // USDC is token index 0; match the canonical base/USDC pair.
      pair = spotMeta.universe.find((u) => u.tokens[0] === baseTok!.index && u.tokens[1] === 0);
      if (!pair) return { ok: false, mid: null, meta: { error: `no USDC spot pair for "${base}"` } };
    }
    const pairIndex = pair.index ?? spotMeta.universe.indexOf(pair);
    const assetIndex = 10000 + pairIndex;
    const szDecimals = Number(baseTok?.szDecimals ?? 0);
    const weiDecimals = Number(baseTok?.weiDecimals ?? 0);
    const coin = String(baseTok?.name ?? query).toUpperCase();
    const midRaw = mids?.[`@${pairIndex}`];
    const mid = midRaw != null ? Number(midRaw) : null;
    const resolved: ResolvedHl = { coin, assetIndex, szDecimals, isSpot: true, weiDecimals };
    return { ok: true, resolved, mid, meta: { coin, assetIndex, pairIndex, tokenIndex: baseTok?.index, szDecimals, weiDecimals, isSpot: true, mid } };
  } catch (e) {
    return { ok: false, mid: null, meta: { error: (e as Error).message } };
  }
}

export class HyperliquidAdapter implements VenueAdapter {
  readonly venue = "hyperliquid" as const;
  readonly chain = "hyperliquid" as const;

  private readonly host: string;
  private readonly isMainnet: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, ResolvedHl>();

  constructor(opts: { fetchImpl?: typeof fetch; mainnet?: boolean } = {}) {
    // mainnet vs testnet decides BOTH the endpoint and the signature `source`.
    this.isMainnet = opts.mainnet ?? (process.env.STARLING_NETWORK ?? "").toLowerCase() === "mainnet";
    this.host = this.isMainnet ? HL_MAINNET : HL_TESTNET;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async health(): Promise<{ up: boolean; orderModel: "hlAction"; note?: string }> {
    try {
      const meta = await infoPost<Meta>({ type: "meta" }, { host: this.host, fetchImpl: this.fetchImpl });
      return { up: Array.isArray(meta?.universe), orderModel: "hlAction" };
    } catch (e) {
      return { up: false, orderModel: "hlAction", note: (e as Error).message };
    }
  }

  async resolveMarket(marketId: string): Promise<{ ok: boolean; meta: Record<string, unknown> }> {
    const r = await resolveHlAsset(marketId, { host: this.host, fetchImpl: this.fetchImpl });
    if (r.ok && r.resolved) this.cache.set(cacheKey(marketId), r.resolved);
    return { ok: r.ok, meta: { ...r.meta, isMainnet: this.isMainnet } };
  }

  async buildOpen(intent: OpenIntent): Promise<HlActionResult> {
    if (intent.venue !== "hyperliquid") throw new Error(`HyperliquidAdapter got a ${intent.venue} intent`);
    const m = await this.require(intent.marketId);
    const isBuy = intent.side === "buy";
    const px = roundPxGrid(Number(intent.worstPrice), m.szDecimals, m.isSpot);
    const rawSize = intent.amountKind === "collateral" ? Number(intent.amount) / px : Number(intent.amount);
    const sz = roundSz(rawSize, m.szDecimals);
    if (!(sz > 0)) throw new Error(`size rounds to 0 at szDecimals=${m.szDecimals} (amount ${intent.amount})`);
    return this.buildAction(m, isBuy, px, sz, false);
  }

  async buildClose(intent: CloseIntent): Promise<HlActionResult> {
    if (intent.venue !== "hyperliquid") throw new Error(`HyperliquidAdapter got a ${intent.venue} intent`);
    const frac = Number(intent.fraction);
    if (!(frac > 0) || frac > 1) throw new Error(`close fraction must be in (0,1], got "${intent.fraction}"`);
    const m = await this.require(intent.marketId);
    const pos = await this.readPosition(m);
    if (!pos) throw new Error(`no HL position to close for ${m.coin}`);
    // Close a long by SELLing, a short by BUYing. Perps use reduceOnly so it can't
    // flip; spot has no position to "reduce" (it's a balance) so reduceOnly is false.
    const isBuy = pos.side === "sell";
    const px = roundPxGrid(Number(intent.worstPrice), m.szDecimals, m.isSpot);
    const sz = roundSz(Number(pos.size) * frac, m.szDecimals);
    if (!(sz > 0)) throw new Error(`close size rounds to 0 (position ${pos.size}, fraction ${intent.fraction})`);
    return this.buildAction(m, isBuy, px, sz, !m.isSpot);
  }

  async state(marketId: string): Promise<PositionState | null> {
    const m = await this.require(marketId);
    return this.readPosition(m);
  }

  async submit(build: BuildResult): Promise<SubmitResult> {
    if (build.kind !== "hlAction") {
      return { posted: false, error: `hyperliquid submit expects an hlAction build, got ${build.kind}` };
    }
    return postExchange(
      { action: build.action, nonce: build.nonce, signature: build.signature, vaultAddress: null },
      { host: this.host, fetchImpl: this.fetchImpl },
    );
  }

  /**
   * Withdraw USDC from HyperCore to the SAME address on Arbitrum (HL's native
   * off-ramp). User-signed action (not an L1 order). HL deducts a $1 fee; funds
   * land on Arbitrum in ~5 min. destination defaults to the signer's own address
   * (HL only releases to the account owner's address). Returns posted:true when
   * HL accepts the signed withdraw. (The CHEAP exit is hl-exit.ts / hl_bridge_out.)
   */
  async withdraw(amount: string, destination?: string): Promise<SubmitResult> {
    const signer = getEvmSigner("hyperliquid");
    const dest = destination ?? signer.address;
    const { action, signature, nonce } = signWithdraw({
      signer,
      destination: dest,
      amount,
      time: Date.now(),
      isMainnet: this.isMainnet,
    });
    return postExchange({ action: action as unknown as Record<string, unknown>, nonce, signature, vaultAddress: null }, { host: this.host, fetchImpl: this.fetchImpl });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async require(marketId: string): Promise<ResolvedHl> {
    const key = cacheKey(marketId);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const r = await this.resolveMarket(marketId);
    if (!r.ok) throw new Error(`resolveMarket failed for ${marketId}: ${String(r.meta.error)}`);
    const again = this.cache.get(key);
    if (!again) throw new Error(`resolveMarket did not cache ${marketId}`);
    return again;
  }

  private buildAction(m: ResolvedHl, isBuy: boolean, px: number, sz: number, reduceOnly: boolean): HlActionResult {
    const signer = getEvmSigner("hyperliquid");
    // Order wire — keys in the SDK's exact order: a,b,p,s,r,t.
    const order = {
      a: m.assetIndex,
      b: isBuy,
      p: floatToWire(px),
      s: floatToWire(sz),
      r: reduceOnly,
      t: { limit: { tif: "Ioc" } },
    };
    const action = { type: "order", orders: [order], grouping: "na" };
    const nonce = Date.now(); // ms; HL's per-action uniqueness field
    const signature = signL1Action({ signer, action, nonce, vaultAddress: null, isMainnet: this.isMainnet });
    return {
      kind: "hlAction",
      chain: "hyperliquid",
      assetIndex: m.assetIndex,
      action,
      nonce,
      signature,
      postUrl: `${this.host}/exchange`,
    };
  }

  private async readPosition(m: ResolvedHl): Promise<PositionState | null> {
    return m.isSpot ? this.readSpotPosition(m) : this.readPerpPosition(m.coin);
  }

  private async readPerpPosition(coin: string): Promise<PositionState | null> {
    const user = getEvmSigner("hyperliquid").address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = await infoPost<any>(
      { type: "clearinghouseState", user },
      { host: this.host, fetchImpl: this.fetchImpl },
    );
    const aps = cs?.assetPositions ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ap = aps.find((p: any) => String(p?.position?.coin).toUpperCase() === coin);
    if (!ap) return null;
    const pos = ap.position;
    const szi = Number(pos.szi); // signed: + long, - short
    if (!szi) return null;
    return {
      venue: "hyperliquid",
      marketId: `hl:${coin}`,
      side: szi > 0 ? "buy" : "sell",
      size: String(Math.abs(szi)),
      avgPrice: String(pos.entryPx ?? "0"),
      unrealizedPnlUsd: String(pos.unrealizedPnl ?? "0"),
    };
  }

  private async readSpotPosition(m: ResolvedHl): Promise<PositionState | null> {
    const user = getEvmSigner("hyperliquid").address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = await infoPost<any>(
      { type: "spotClearinghouseState", user },
      { host: this.host, fetchImpl: this.fetchImpl },
    );
    const balances = cs?.balances ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = balances.find((x: any) => String(x?.coin).toUpperCase() === m.coin);
    const total = Number(b?.total ?? 0);
    if (!(total > 0)) return null;
    // A spot holding is a long token balance — no leverage, no short. avgPrice from
    // entryNtl when present, else 0 (HL doesn't always surface a spot cost basis).
    const entryNtl = Number(b?.entryNtl ?? 0);
    const avg = entryNtl > 0 && total > 0 ? entryNtl / total : 0;
    return {
      venue: "hyperliquid",
      marketId: `hlspot:${m.coin}`,
      side: "buy",
      size: String(total),
      avgPrice: String(avg),
      unrealizedPnlUsd: "0",
    };
  }
}

// ── pure helpers (exported for unit tests) ──────────────────────────────────

/** Cache key that can't collide a perp coin with a spot token of the same name
 *  (HYPE is BOTH a perp and a spot pair). */
function cacheKey(marketId: string): string {
  const { isSpot, query } = parseHlMarket(marketId);
  return `${isSpot ? "spot" : "perp"}:${query.toUpperCase()}`;
}

/** Drop an "hl:" / "hyperliquid:" venue prefix if present. */
export function stripHlPrefix(marketId: string): string {
  const i = marketId.indexOf(":");
  if (i === -1) return marketId;
  const prefix = marketId.slice(0, i).toLowerCase();
  if (prefix === "hl" || prefix === "hyperliquid") return marketId.slice(i + 1);
  return marketId;
}

/**
 * Round a price onto HL's grid: <=5 significant figures AND <= (maxDecimals -
 * szDecimals) decimal places, maxDecimals 6 for perps / 8 for spot. Integer prices
 * are always valid (HL exempts them from the sig-fig rule). Mirrors the documented
 * tick rule so an IOC limit isn't rejected as off-grid.
 */
export function roundPxGrid(px: number, szDecimals: number, isSpot: boolean): number {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error(`px must be a positive number (got ${px})`);
  if (Number.isInteger(px)) return px;
  const sig = Number(px.toPrecision(5));
  const maxDecimals = Math.max(0, (isSpot ? 8 : 6) - szDecimals);
  const factor = 10 ** maxDecimals;
  return Math.round(sig * factor) / factor;
}

/** Perp price grid (maxDecimals 6). Kept for back-compat; delegates to roundPxGrid. */
export function roundPx(px: number, szDecimals: number): number {
  return roundPxGrid(px, szDecimals, false);
}

/** Floor size to szDecimals so a BUY never exceeds budget / a close never exceeds the position. */
export function roundSz(sz: number, szDecimals: number): number {
  if (!Number.isFinite(sz)) throw new Error(`size must be finite (got ${sz})`);
  const factor = 10 ** szDecimals;
  return Math.floor(sz * factor) / factor;
}

/**
 * Port of the SDK's float_to_wire: render with 8 decimals, reject if that loses
 * precision, then strip trailing zeros (and a bare trailing dot). Integers keep
 * their form ("100" -> "100", not "1E2"). This is the EXACT string HL hashes.
 */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire would lose precision for ${x}`);
  let r = rounded === "-0.00000000" ? "0.00000000" : rounded;
  if (r.includes(".")) r = r.replace(/0+$/, "").replace(/\.$/, "");
  return r;
}

/** Default adapter instance (network from STARLING_NETWORK; defaults to testnet). */
export const hyperliquidAdapter = new HyperliquidAdapter();
