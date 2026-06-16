// src/adapters/polymarket.ts
// The Polymarket VenueAdapter. PURE builder + reads — it NEVER broadcasts and
// only signs the order EIP-712 digest in-process via getEvmSigner('polymarket').
// Everything money-moving leaves this file as an unsigned/locally-signed
// artifact the caller posts through polymarket-transport.ts.
//
// Trading model (decided, not relitigated):
//   - Plain EOAs, signatureType=0. signer == maker == the local Polygon EOA.
//   - We self-sign + self-post; Polymarket's gasless relayer is NOT on the order
//     path, so its per-builder daily quota does not gate order placement.
//   - Collateral is pUSD (6 dp). makerAmount on a BUY is pUSD to spend.
//   - V2 Order EIP-712 struct (verbatim from the deployed exchange):
//       Order(uint256 salt,address maker,address signer,uint256 tokenId,
//             uint256 makerAmount,uint256 takerAmount,uint8 side,
//             uint8 signatureType,uint256 timestamp,bytes32 metadata,
//             bytes32 builder)
//     timestamp is ms and is the per-address uniqueness field (replaces V1
//     nonce); it is NOT an expiration. taker/expiration/nonce/feeRateBps are
//     GONE from the signed struct.
//
// WORST-PRICE INVARIANT: there is no market order anywhere in this stack. Every
// build takes OpenIntent.worstPrice / CloseIntent.worstPrice and bakes it into
// the order as a bounded price limit (FAK semantics). A caller cannot ask for an
// unbounded fill.
//
// AMOUNT-KIND INVARIANT: BUY denominates `amount` in COLLATERAL (pUSD to spend);
// SELL denominates in SHARES. buildOpen asserts the caller's amountKind matches
// the side so a bot can't silently pass shares to a BUY (under/over-deploy).

import { hashTypedData, parseUnits, type TypedDataDomain } from "viem";
import type {
  VenueAdapter,
  OpenIntent,
  CloseIntent,
  Eip712OrderResult,
  BuildResult,
  PositionState,
  Side,
  SubmitResult,
} from "./types.js";
import { getEvmSigner } from "../signers/index.js";
import {
  POLYGON_CHAIN_ID,
  CTF_EXCHANGE_V2,
  NEG_RISK_CTF_EXCHANGE_V2,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_NAME_NEGRISK,
  EIP712_DOMAIN_VERSION,
  CLOB_HOST,
  COLLATERAL_DECIMALS,
  BYTES32_ZERO,
  ROUNDING_CONFIG,
  SIDE_BUY,
  SIDE_SELL,
  SIGNATURE_TYPE_EOA,
  type TickSize,
} from "./polymarket-constants.js";
import {
  fetchTickSize,
  fetchNegRisk,
  fetchPositions,
  postOrder,
  resolveClobCredsFromEnv,
  type ClobOrderPayload,
  type DataApiPosition,
} from "./polymarket-transport.js";

const VALID_TICKS: ReadonlySet<string> = new Set(["0.1", "0.01", "0.001", "0.0001"]);

/** The signed V2 Order EIP-712 type (matches ORDER_TYPE_STRING in the V2 SDK). */
const ORDER_EIP712_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

/**
 * Resolved per-market params needed to build a correct order. Cached per
 * marketId (tokenId) for the life of the process via a small map so repeated
 * builds on the same market don't re-hit the CLOB.
 */
interface ResolvedMarket {
  tokenId: string;
  negRisk: boolean;
  tickSize: TickSize;
}

export class PolymarketAdapter implements VenueAdapter {
  readonly venue = "polymarket" as const;
  readonly chain = "polygon" as const;

  private readonly clobHost: string;
  private readonly fetchImpl: typeof fetch;
  /** Optional builder code (bytes32) attached to every order for attribution. */
  private readonly builderCode: `0x${string}`;
  private readonly resolveCache = new Map<string, ResolvedMarket>();

  constructor(opts: { clobHost?: string; fetchImpl?: typeof fetch; builderCode?: string } = {}) {
    this.clobHost = opts.clobHost ?? CLOB_HOST;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const code = opts.builderCode ?? process.env.STARLING_PM_BUILDER_CODE ?? "";
    this.builderCode = normalizeBytes32(code);
  }

  async health(): Promise<{ up: boolean; orderModel: "eip712Order"; note?: string }> {
    try {
      // /ok is the CLOB liveness probe; fall back to treating any 2xx as up.
      const res = await this.fetchImpl(`${this.clobHost}/ok`);
      return { up: res.ok, orderModel: "eip712Order", note: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (e) {
      return { up: false, orderModel: "eip712Order", note: (e as Error).message };
    }
  }

  /**
   * Resolve negRisk + tickSize for a market. REQUIRED before any build — the
   * wrong exchange (negRisk) makes the signature recover to nothing, and the
   * wrong tickSize rounds amounts to an invalid grid the CLOB rejects.
   */
  async resolveMarket(marketId: string): Promise<{ ok: boolean; meta: Record<string, unknown> }> {
    const tokenId = stripVenuePrefix(marketId);
    if (!/^\d+$/.test(tokenId)) {
      return { ok: false, meta: { error: `marketId must be a numeric CLOB tokenId, got "${marketId}"` } };
    }
    try {
      const [tickSizeRaw, negRisk] = await Promise.all([
        fetchTickSize(tokenId, { host: this.clobHost, fetchImpl: this.fetchImpl }),
        fetchNegRisk(tokenId, { host: this.clobHost, fetchImpl: this.fetchImpl }),
      ]);
      if (!VALID_TICKS.has(tickSizeRaw)) {
        return { ok: false, meta: { error: `unexpected tickSize "${tickSizeRaw}" for token ${tokenId}` } };
      }
      const tickSize = tickSizeRaw as TickSize;
      const resolved: ResolvedMarket = { tokenId, negRisk, tickSize };
      this.resolveCache.set(tokenId, resolved);
      return {
        ok: true,
        meta: {
          tokenId,
          negRisk,
          tickSize,
          verifyingContract: negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2,
        },
      };
    } catch (e) {
      return { ok: false, meta: { error: (e as Error).message } };
    }
  }

  async buildOpen(intent: OpenIntent): Promise<Eip712OrderResult> {
    if (intent.venue !== "polymarket") {
      throw new Error(`PolymarketAdapter got a ${intent.venue} intent`);
    }
    // Amount-kind invariant: BUY spends collateral, SELL delivers shares.
    const expectedKind = intent.side === "buy" ? "collateral" : "shares";
    if (intent.amountKind !== expectedKind) {
      throw new Error(
        `amountKind mismatch: a ${intent.side} order must be "${expectedKind}", got "${intent.amountKind}".`,
      );
    }
    const market = await this.requireResolved(intent.marketId);
    return this.buildSignedOrder({
      market,
      side: intent.side,
      amount: intent.amount,
      worstPrice: intent.worstPrice,
    });
  }

  async buildClose(intent: CloseIntent): Promise<Eip712OrderResult> {
    if (intent.venue !== "polymarket") {
      throw new Error(`PolymarketAdapter got a ${intent.venue} intent`);
    }
    const frac = Number(intent.fraction);
    if (!(frac > 0) || frac > 1) {
      throw new Error(`close fraction must be in (0,1], got "${intent.fraction}"`);
    }
    const market = await this.requireResolved(intent.marketId);

    // A close is a SELL of `fraction` of the held shares (amount = shares).
    const pos = await this.readPosition(market.tokenId);
    if (!pos) throw new Error(`no Polymarket position to close for token ${market.tokenId}`);
    if (pos.resolved) {
      // The CLOB sell book is gone post-resolution; caller must route to redeem.
      throw new Error(`market resolved — route to redeem, not close (token ${market.tokenId})`);
    }
    const shares = mulDecimal(pos.size, intent.fraction);

    return this.buildSignedOrder({
      market,
      side: "sell",
      amount: shares,
      worstPrice: intent.worstPrice,
    });
  }

  async state(marketId: string): Promise<PositionState | null> {
    const tokenId = stripVenuePrefix(marketId);
    return this.readPosition(tokenId);
  }

  /**
   * POST the (already locally-signed) order to the CLOB with L2 auth, FAK
   * (fill-and-kill: marketable up to the bounded worst price, remainder cancelled
   * — never rests an unbounded order). Returns the orderID + any immediate
   * settlement tx hashes. The risk caps already gated the size upstream.
   */
  async submit(build: BuildResult): Promise<SubmitResult> {
    if (build.kind !== "eip712Order") {
      return { posted: false, error: `polymarket submit expects an eip712Order build, got ${build.kind}` };
    }
    const creds = resolveClobCredsFromEnv();
    if (!creds) {
      return {
        posted: false,
        error:
          "no CLOB L2 creds — set STARLING_PM_CLOB_API_KEY / _SECRET / _PASSPHRASE " +
          "(mint them once for your EOA via createOrDeriveApiKey on polymarket.com).",
      };
    }
    const address = getEvmSigner("polymarket").address;
    const payload: ClobOrderPayload = { order: build.orderStruct, owner: creds.key, orderType: "FAK" };
    const res = await postOrder(creds, address, payload, { host: this.clobHost, fetchImpl: this.fetchImpl });
    return {
      posted: res.ok,
      orderId: res.orderID,
      status: res.status,
      txHashes: res.transactionHashes,
      error: res.error,
      raw: res.raw,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async requireResolved(marketId: string): Promise<ResolvedMarket> {
    const tokenId = stripVenuePrefix(marketId);
    const cached = this.resolveCache.get(tokenId);
    if (cached) return cached;
    const r = await this.resolveMarket(marketId);
    if (!r.ok) throw new Error(`resolveMarket failed for ${marketId}: ${String(r.meta.error)}`);
    const again = this.resolveCache.get(tokenId);
    if (!again) throw new Error(`resolveMarket did not cache ${tokenId}`);
    return again;
  }

  /**
   * Build + locally sign the V2 order. Shared by open + close. Picks the
   * exchange (and thus verifyingContract + domain name) from negRisk, rounds
   * amounts on the tick grid the SDK uses, and signs the EIP-712 digest with the
   * in-process Polygon key.
   */
  private buildSignedOrder(args: {
    market: ResolvedMarket;
    side: Side;
    amount: string;
    worstPrice: string;
  }): Eip712OrderResult {
    const { market, side, amount, worstPrice } = args;
    const signer = getEvmSigner("polymarket");
    const maker = signer.address;

    const price = priceCheck(worstPrice, market.tickSize);
    const { makerAmount, takerAmount } = computeAmounts(side, amount, price, market.tickSize);

    const verifyingContract = (
      market.negRisk ? NEG_RISK_CTF_EXCHANGE_V2 : CTF_EXCHANGE_V2
    ) as `0x${string}`;
    const domainName = market.negRisk ? EIP712_DOMAIN_NAME_NEGRISK : EIP712_DOMAIN_NAME;

    const salt = generateOrderSalt();
    const timestamp = Date.now().toString(); // ms — per-address uniqueness, NOT expiry
    const sideUint = side === "buy" ? SIDE_BUY : SIDE_SELL;

    // The struct fields exactly as signed (uint256/address/bytes32 as strings).
    const message = {
      salt: BigInt(salt),
      maker,
      signer: maker, // EOA: signer == maker
      tokenId: BigInt(market.tokenId),
      makerAmount: BigInt(makerAmount),
      takerAmount: BigInt(takerAmount),
      side: sideUint,
      signatureType: SIGNATURE_TYPE_EOA,
      timestamp: BigInt(timestamp),
      metadata: BYTES32_ZERO,
      builder: this.builderCode,
    } as const;

    const domain: TypedDataDomain = {
      name: domainName,
      version: EIP712_DOMAIN_VERSION,
      chainId: POLYGON_CHAIN_ID,
      verifyingContract,
    };

    // Hash the typed data with viem, sign the 32-byte digest with the local key.
    const digest = hashTypedData({
      domain,
      types: ORDER_EIP712_TYPES,
      primaryType: "Order",
      message,
    });
    const signature = signOrderDigest(signer, digest);

    // Wire-shape inner order (numbers/strings as the CLOB expects on POST /order).
    // `side` on the wire is the STRING "BUY"/"SELL"; the uint8 is only in the
    // signed struct. salt is a number per orderToJsonV2(parseInt). taker/
    // expiration are carried as zero for wire-compat with the V2 envelope.
    const orderStruct: Record<string, unknown> = {
      salt: Number(salt),
      maker,
      signer: maker,
      taker: "0x0000000000000000000000000000000000000000",
      tokenId: market.tokenId,
      makerAmount,
      takerAmount,
      side: side === "buy" ? "BUY" : "SELL",
      signatureType: SIGNATURE_TYPE_EOA,
      timestamp,
      expiration: "0",
      metadata: BYTES32_ZERO,
      builder: this.builderCode,
      signature,
    };

    return {
      kind: "eip712Order",
      chain: "polygon",
      verifyingContract,
      negRisk: market.negRisk,
      tickSize: market.tickSize,
      // Carry the typed-data so a caller/test can re-derive the digest.
      typedData: { domain, types: ORDER_EIP712_TYPES, primaryType: "Order", message: serializeMessage(message) },
      orderStruct,
      postUrl: `${this.clobHost}/order`,
    };
  }

  /** Read + normalize a single position from the data API. */
  private async readPosition(tokenId: string): Promise<PositionState | null> {
    const maker = getEvmSigner("polymarket").address;
    const rows = await fetchPositions(maker, { fetchImpl: this.fetchImpl });
    const row = rows.find((p) => p.asset === tokenId);
    if (!row) return null;
    return normalizePosition(tokenId, row);
  }
}

// ── pure helpers (exported for unit tests) ──────────────────────────────────

/** Drop a "pm:" venue prefix if present; otherwise return as-is. */
export function stripVenuePrefix(marketId: string): string {
  const i = marketId.indexOf(":");
  if (i === -1) return marketId;
  const prefix = marketId.slice(0, i).toLowerCase();
  if (prefix === "pm" || prefix === "polymarket") return marketId.slice(i + 1);
  return marketId;
}

/** `${Math.round(Math.random() * Date.now())}` — matches the V2 SDK salt. */
export function generateOrderSalt(): string {
  return `${Math.round(Math.random() * Date.now())}`;
}

/** Validate worstPrice against the tick grid: (tick, 1 - tick). Returns the
 *  price rounded to the tick's price precision (roundNormal in the SDK). */
export function priceCheck(worstPrice: string, tickSize: TickSize): number {
  const p = Number(worstPrice);
  if (!Number.isFinite(p)) throw new Error(`worstPrice "${worstPrice}" is not a number`);
  const tick = parseFloat(tickSize);
  const min = tick;
  const max = 1 - tick;
  if (p < min || p > max) {
    throw new Error(`worstPrice ${p} out of range for tick ${tickSize} (min ${min}, max ${max})`);
  }
  return roundNormal(p, ROUNDING_CONFIG[tickSize].price);
}

/**
 * Compute makerAmount/takerAmount (6-decimal base-unit strings), byte-matching
 * the V2 SDK's getMarketOrderRawAmounts + parseUnits(COLLATERAL_TOKEN_DECIMALS).
 *
 * BUY:  amount = collateral (pUSD) to spend = makerAmount; takerAmount = shares
 *       received = amount / price.
 * SELL: amount = shares to sell = makerAmount; takerAmount = collateral
 *       received = amount * price.
 */
export function computeAmounts(
  side: Side,
  amount: string,
  price: number,
  tickSize: TickSize,
): { makerAmount: string; takerAmount: string } {
  const cfg = ROUNDING_CONFIG[tickSize];
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error(`amount "${amount}" must be a positive number`);
  const rawPrice = roundDown(price, cfg.price);
  if (rawPrice <= 0) throw new Error(`price ${price} rounds to 0 at tick ${tickSize}`);

  const rawMakerAmt = roundDown(amt, cfg.size);
  let rawTakerAmt = side === "buy" ? rawMakerAmt / rawPrice : rawMakerAmt * rawPrice;
  if (decimalPlaces(rawTakerAmt) > cfg.amount) {
    rawTakerAmt = roundUp(rawTakerAmt, cfg.amount + 4);
    if (decimalPlaces(rawTakerAmt) > cfg.amount) {
      rawTakerAmt = roundDown(rawTakerAmt, cfg.amount);
    }
  }

  return {
    makerAmount: parseUnits(toFixedString(rawMakerAmt), COLLATERAL_DECIMALS).toString(),
    takerAmount: parseUnits(toFixedString(rawTakerAmt), COLLATERAL_DECIMALS).toString(),
  };
}

/** Normalize a data-API row into the cross-venue PositionState. */
export function normalizePosition(tokenId: string, row: DataApiPosition): PositionState {
  const cur = row.curPrice ?? row.avgPrice;
  const unrealized = (cur - row.avgPrice) * row.size;
  return {
    venue: "polymarket",
    marketId: `pm:${tokenId}`,
    side: "buy", // data-API rows are long outcome-share holdings
    size: String(row.size),
    avgPrice: String(row.avgPrice),
    unrealizedPnlUsd:
      row.cashPnl !== undefined ? String(row.cashPnl) : unrealized.toFixed(6),
    resolved: row.redeemable === true,
  };
}

// ── numeric primitives, ported verbatim from the V2 SDK rounding helpers ────

export function roundDown(num: number, decimals: number): number {
  if (decimalPlaces(num) <= decimals) return num;
  return Math.floor(num * 10 ** decimals) / 10 ** decimals;
}
export function roundUp(num: number, decimals: number): number {
  if (decimalPlaces(num) <= decimals) return num;
  return Math.ceil(num * 10 ** decimals) / 10 ** decimals;
}
export function roundNormal(num: number, decimals: number): number {
  if (decimalPlaces(num) <= decimals) return num;
  return Math.round(num * 10 ** decimals) / 10 ** decimals;
}
export function decimalPlaces(num: number): number {
  if (Number.isInteger(num)) return 0;
  const arr = num.toString().split(".");
  return arr.length <= 1 ? 0 : arr[1].length;
}

// ── small string/number utilities ───────────────────────────────────────────

/** Multiply a non-negative decimal string by a (0,1] fraction, 6-dp result. */
function mulDecimal(a: string, fracStr: string): string {
  const v = Number(a) * Number(fracStr);
  return toFixedString(roundDown(v, 6));
}

/** parseUnits needs a plain decimal string (no exponent). Number.toString can
 *  emit "1e-7" for tiny values; expand it so parseUnits doesn't choke. */
function toFixedString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`non-finite amount ${n}`);
  if (!/e/i.test(n.toString())) return n.toString();
  // up to 6 dp is all the collateral grid needs.
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/** Normalize a builder code to a 0x-prefixed bytes32, or bytes32(0) if empty. */
function normalizeBytes32(code: string): `0x${string}` {
  const c = code.trim();
  if (!c) return BYTES32_ZERO;
  const hex = c.startsWith("0x") ? c.slice(2) : c;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length > 64) {
    throw new Error(`builder code "${code}" is not a valid bytes32`);
  }
  return `0x${hex.padStart(64, "0")}` as `0x${string}`;
}

/** secp256k1 65-byte rsv (v∈{27,28}) -> 0x-hex order signature. */
function signOrderDigest(signer: { signDigest(d: Uint8Array): Uint8Array }, digest: `0x${string}`): `0x${string}` {
  const bytes = hexToBytes(digest);
  const rsv = signer.signDigest(bytes);
  return `0x${Buffer.from(rsv).toString("hex")}` as `0x${string}`;
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const h = hex.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** BigInt fields aren't JSON-serializable; stringify them for typedData echo. */
function serializeMessage(message: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(message)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out;
}

/** Default adapter instance (env-configured builder code). */
export const polymarketAdapter = new PolymarketAdapter();
