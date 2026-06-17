// src/adapters/types.ts
// The normalized VenueAdapter contract + the discriminated BuildResult union.
//
// CORE INVARIANT: an adapter NEVER signs and NEVER broadcasts. It only BUILDS.
// Every buildOpen/buildClose returns an UNSIGNED artifact that the LOCAL signer
// (getEvmSigner(venue) / getSolanaSigner()) signs on the user's box. The three
// launch venues cannot share one calldata shape, so BuildResult is a tagged
// union, not a single tx type:
//
//   - Polymarket: an EIP-712 CLOB order JSON (built + signed client-side with the
//     local secp256k1 key, signatureType=0 EOA) POSTed to the CLOB.
//   - Hyperliquid: a signed-action object posted to the exchange endpoint.
//   - Solana:      an unsigned VersionedTransaction (base64) the ed25519 key signs.
//
// The adapter layer is pure: no network writes happen here. Reads (market params,
// balances) are allowed because they shape the build; writes are the caller's job.

export type Venue = "polymarket" | "hyperliquid" | "jupiter";
export type Chain = "polygon" | "hyperliquid" | "solana";
export type Side = "buy" | "sell";

/**
 * Whether an `amount` is denominated in collateral (USD) or in shares/contracts.
 * Polymarket FOK/FAK BUY orders denominate `amount` in COLLATERAL (USD to spend);
 * SELL denominates in SHARES. Making this explicit and type-checked stops a bot
 * from passing shares to a BUY (a silent under/over-deploy). See verification
 * finding "slippage-cap claim is half-correct".
 */
export type AmountKind = "collateral" | "shares";

export interface OpenIntent {
  venue: Venue;
  /** Venue-prefixed market id, e.g. "pm:<conditionId>", "hl:BTC", "jup:<mint>". */
  marketId: string;
  side: Side;
  amount: string; // decimal string; never a JS number (precision)
  amountKind: AmountKind;
  /**
   * Worst acceptable price (per share / per unit). REQUIRED — there is no
   * "market" order anywhere in this stack; every venue is given an explicit
   * worst-price limit so slippage is always bounded. (HL has no native market
   * type; PM market orders still take a price limit; Jupiter slippageBps IS the
   * cap.) Caller usually sets this from get_quote * (1 +/- slippageFrac).
   */
  worstPrice: string;
  /** Slippage fraction used to derive worstPrice if the caller didn't pin one. */
  slippageFrac?: number; // default 0.05 (5%)
  /** Opaque edge/signal the bot is acting on; recorded for PnL attribution. */
  edgeBps?: number;
  /** REQUIRED on every money-moving call. (botId, idempotencyKey) is unique. */
  idempotencyKey: string;
}

export interface CloseIntent {
  venue: Venue;
  marketId: string;
  /** Fraction of the position to close, (0,1]. 1 = full exit. */
  fraction: string;
  worstPrice: string;
  slippageFrac?: number;
  idempotencyKey: string;
}

/** Polymarket: a client-built, locally-EIP-712-signed CLOB order to POST. */
export interface Eip712OrderResult {
  kind: "eip712Order";
  chain: "polygon";
  /** The verifyingContract the order is signed against. negRisk routes to a
   *  DIFFERENT exchange than standard — wrong flag => "Invalid signature". */
  verifyingContract: `0x${string}`;
  negRisk: boolean;
  tickSize: string;
  /** Unsigned order struct + the EIP-712 typed-data the local signer must sign.
   *  The adapter fills `signature` in-process via getEvmSigner('polymarket'); the
   *  result here carries the typed-data so a caller/test can re-derive the digest. */
  typedData: unknown;
  orderStruct: Record<string, unknown>;
  /** Where the signed order is POSTed. Direct-to-CLOB by default (see README:
   *  the hosted proxy is NOT on the signing path). */
  postUrl: string;
}

/** Hyperliquid: an action object the local key signs, then POSTed to /exchange. */
export interface HlActionResult {
  kind: "hlAction";
  chain: "hyperliquid";
  /** asset INDEX from the meta universe — NEVER the ticker. Re-resolved per build. */
  assetIndex: number;
  action: Record<string, unknown>; // {type:'order', orders:[...], grouping:'na'}
  nonce: number; // ms timestamp
  /**
   * The L1-action signature, produced in-process by getEvmSigner('hyperliquid')
   * over the phantom-agent EIP-712 digest (msgpack(action)+nonce+vault hash).
   * Carried here (like the PM order's `signature`) so submit() can POST it
   * without re-signing. {r,s,v} is the wire shape /exchange expects.
   */
  signature: { r: `0x${string}`; s: `0x${string}`; v: number };
  postUrl: string;
}

/** Solana (Jupiter spot / perps): an unsigned VersionedTransaction. */
export interface SolanaTxResult {
  kind: "solanaTx";
  chain: "solana";
  /** base64 unsigned VersionedTransaction (Jupiter /swap) OR serialized ix set. */
  unsignedTxB64: string;
  /** Bounds the rebroadcast/expiry decision (see confirm/index.ts). */
  lastValidBlockHeight: number;
}

export type BuildResult = Eip712OrderResult | HlActionResult | SolanaTxResult;

/** Normalized open/closed position view across venues. */
export interface PositionState {
  venue: Venue;
  marketId: string;
  side: Side;
  size: string; // shares / contracts
  avgPrice: string;
  unrealizedPnlUsd: string;
  /** Set when a Polymarket market resolved — caller routes to redeem, not close. */
  resolved?: boolean;
}

/** Outcome of submitting a built order to the venue (off-chain order POST for
 *  PM/HL; an on-chain broadcast stays with the caller for Solana). */
export interface SubmitResult {
  posted: boolean;
  orderId?: string;
  status?: string;
  /** on-chain settlement tx hashes if the order matched immediately. */
  txHashes?: string[];
  error?: string;
  raw?: unknown;
}

/**
 * The adapter contract. Implemented by polymarket.ts / hyperliquid.ts /
 * jupiter.ts. Pure builders + reads; the signer + transport live above.
 */
export interface VenueAdapter {
  readonly venue: Venue;
  readonly chain: Chain;
  /** Order/health model so list_venues can route only to live venues. */
  health(): Promise<{ up: boolean; orderModel: BuildResult["kind"]; note?: string }>;
  /** REQUIRED before any build for PM (negRisk + tickSize) / HL (asset index). */
  resolveMarket(marketId: string): Promise<{ ok: boolean; meta: Record<string, unknown> }>;
  buildOpen(intent: OpenIntent): Promise<BuildResult>;
  buildClose(intent: CloseIntent): Promise<BuildResult>;
  state(marketId: string): Promise<PositionState | null>;
  /**
   * Submit an already-locally-signed order to the venue. Present for off-chain
   * order books (PM CLOB / HL exchange) where the signed order is POSTed; absent
   * for venues whose build is an on-chain tx the caller broadcasts. Gated upstream
   * by the risk caps and bounded by the order's own worst price.
   */
  submit?(build: BuildResult): Promise<SubmitResult>;
  /**
   * Withdraw collateral OFF the venue to the account OWNER's own address
   * (Hyperliquid: a user-signed withdraw3 that lands USDC at the same address on
   * Arbitrum, minus HL's $1 flat fee). Present only for venues with a native
   * off-ramp; the recipient is pinned by the VENUE to the owner — never an
   * argument. Gated upstream by the per-call withdraw cap. Absent for venues whose
   * "withdraw" is a plain on-chain sweep (those go through build_withdraw → the
   * sealed treasury instead).
   */
  withdraw?(amount: string, destination?: string): Promise<SubmitResult>;
}
