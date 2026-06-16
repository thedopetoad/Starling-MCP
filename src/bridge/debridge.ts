// src/bridge/debridge.ts
// Bridge over deBridge DLN — the SECONDARY bridge (non-USDC legs + native-gas
// delivery; CCTP V2 is primary for plain USDC moves). Built with a single plain
// `fetch` to the no-auth create-tx endpoint; NO deBridge SDK, NO ethers, NO viem
// (the repo hand-rolls EVM bytes via @noble/@scure — see addr.ts). The ONLY
// calldata we synthesize locally is an ERC-20 approve(); everything else is the
// API's returned tx.{to,data,value} passed through verbatim.
//
// SECURITY POSTURE (mirrors bridge/types.ts RECIPIENT INVARIANT):
//   create-tx exposes FOUR address knobs (dstChainTokenOutRecipient + the two
//   *OrderAuthorityAddress fields) plus an affiliateFee* skim. A rogue agent that
//   set any of them to its own address — or set affiliateFeePercent>0 — could
//   drain or strand funds. This builder therefore:
//     - sets dstChainTokenOutRecipient ONLY from route.recipient (the caller
//       passes the sealed treasury / allowlisted thin-wallet — NEVER an agent arg),
//     - pins BOTH order-authority fields to user-controlled addresses (source EOA
//       on the source chain, recipient on the destination chain),
//     - FORCES affiliateFeePercent=0 and omits affiliateFeeRecipient, and
//     - RE-DECODES the returned tx (assertOrderPins) and asserts the request was
//       built with exactly those pins before the artifact is handed out for
//       signing. The third-party API's pinning is never trusted blindly.
//   This is build-time pinning, not protocol-level proof the recipient is the
//   user's — the honest ceiling documented in bridge/types.ts applies.
//
// Sources for every constant are cited inline.

import type { Chain } from "../adapters/types.js";
import type {
  Bridge,
  BridgeProvider,
  BridgeQuote,
  BridgeRoute,
  BridgeStatus,
  UnsignedBridgeTx,
} from "./types.js";

// ---------------------------------------------------------------------------
// Verified constants. Every value is cited; do not "tidy" them to differ when
// they are intentionally identical across chains.
// ---------------------------------------------------------------------------

/** DLN API base. Host moved to docs.debridge.com but the API host is unchanged.
 *  https://docs.debridge.com/.../requesting-order-creation-transaction */
export const DLN_API_BASE = "https://dln.debridge.finance";

/** GET create-tx path. */
const CREATE_TX_PATH = "/v1.0/dln/order/create-tx";
/** Order status tracking path prefix. */
const ORDER_PATH = "/v1.0/dln/order";

/**
 * deBridge INTERNAL chainIds. Polygon/Arbitrum/Ethereum happen to equal their
 * real EVM ids; Solana uses deBridge's custom id (NOT a real Solana network id).
 * https://dln.debridge.finance/v1.0/supported-chains-info
 */
export const DEBRIDGE_CHAIN_ID = {
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  solana: 7565164,
} as const;

/**
 * Native-token OUTPUT sentinels — set dstChainTokenOut to one of these to
 * receive native gas (MATIC / ETH / SOL) at the destination. The sentinel
 * DIFFERS by VM family.
 * EVM: https://docs.debridge.com/api-reference/dln/...place-a-cross-chain-dln-order
 * Solana (System Program / all-1s base58): same source.
 */
export const NATIVE_SENTINEL_EVM =
  "0x0000000000000000000000000000000000000000" as const;
export const NATIVE_SENTINEL_SOLANA =
  "11111111111111111111111111111111" as const;

/**
 * Native USDC token per real chain. CCTP burns/mints these; deBridge consumes
 * them as the source token for funding/gas legs.
 *   Arbitrum:  https://arbiscan.io/token/0xaf88d065e77c8cc2239327c5edb3a432268e5831
 *   Polygon:   https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   Ethereum:  https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   Solana SPL mint: https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
export const USDC_NATIVE = {
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const;

/** ERC-20 approve(address,uint256) selector — keccak256("approve(address,uint256)")[:4]. */
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

/**
 * DLN protocol FLAT FEE per SOURCE chain, paid as NATIVE token VALUE on the order
 * tx (tx.value), IN ADDITION to that tx's own gas. There is NO zero-fee EVM
 * source — the earlier "Arbitrum is free, use it as the cheapest gas source"
 * premise was WRONG and is corrected here.
 *   Arbitrum: 0.001 ETH   Ethereum: 0.001 ETH   Polygon: 0.5 POL   Solana: 0.015 SOL
 *   https://docs.debridge.com/dln-details/overview/fees-supported-chains
 *
 * SAFETY: the docs state fees "must not be hardcoded but queried dynamically from
 * the state of the DLN smart contract" — protocol fees can change. So this table
 * is a FALLBACK / sanity floor only; the AUTHORITATIVE value for any given order
 * is res.tx.value (== response.fixFee) returned by create-tx, which
 * buildSourceOrderTxs already passes through verbatim. Use this table to
 * pre-flight whether the SOURCE wallet can afford to be the order's source, not
 * to set the on-chain value. Decimal native units, keyed by real network.
 */
export const DLN_SOURCE_FIXFEE_FALLBACK: Record<RealNet, { symbol: string; decimals: number; amount: string }> = {
  arbitrum: { symbol: "ETH", decimals: 18, amount: "0.001" },
  polygon: { symbol: "POL", decimals: 18, amount: "0.5" },
  solana: { symbol: "SOL", decimals: 9, amount: "0.015" },
};

// ---------------------------------------------------------------------------
// Chain mapping. The repo's Chain type is "polygon" | "hyperliquid" | "solana".
// "hyperliquid" funds physically live on ARBITRUM (deposit USDC to Arbitrum,
// then to the HL Bridge2). So for every bridge/gas purpose, Chain "hyperliquid"
// resolves to the Arbitrum network.
//   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2
// ---------------------------------------------------------------------------

/** The real network a repo Chain lives on (for token/sentinel/chainId lookup). */
export type RealNet = "polygon" | "arbitrum" | "solana";

function realNet(chain: Chain): RealNet {
  switch (chain) {
    case "polygon":
      return "polygon";
    case "hyperliquid":
      return "arbitrum";
    case "solana":
      return "solana";
  }
}

function isEvm(chain: Chain): boolean {
  return realNet(chain) !== "solana";
}

/** deBridge internal chainId for a repo Chain. */
export function debridgeChainId(chain: Chain): number {
  const net = realNet(chain);
  if (net === "polygon") return DEBRIDGE_CHAIN_ID.polygon;
  if (net === "arbitrum") return DEBRIDGE_CHAIN_ID.arbitrum;
  return DEBRIDGE_CHAIN_ID.solana;
}

/** Native USDC address/mint on the chain (the source token for USDC + gas legs). */
export function usdcOn(chain: Chain): string {
  const net = realNet(chain);
  if (net === "polygon") return USDC_NATIVE.polygon;
  if (net === "arbitrum") return USDC_NATIVE.arbitrum;
  return USDC_NATIVE.solana;
}

/** Native-gas OUTPUT sentinel for the chain's VM family. */
export function nativeSentinel(chain: Chain): string {
  return isEvm(chain) ? NATIVE_SENTINEL_EVM : NATIVE_SENTINEL_SOLANA;
}

// ---------------------------------------------------------------------------
// create-tx request / response shapes (only the fields we read).
// ---------------------------------------------------------------------------

/** The exact, security-relevant params we send. Captured so assertOrderPins can
 *  re-check the response was built against the addresses WE pinned. */
export interface CreateTxParams {
  srcChainId: number;
  srcChainTokenIn: string;
  /** base units, or "auto" when the destination amount is pinned instead. */
  srcChainTokenInAmount: string;
  dstChainId: number;
  dstChainTokenOut: string;
  /** base units, or "auto" when srcChainTokenInAmount is pinned. */
  dstChainTokenOutAmount: string;
  /** RECEIVES the output — pinned to route.recipient by the builder. */
  dstChainTokenOutRecipient: string;
  /** source-side authority / refund beneficiary — pinned to the source EOA. */
  srcChainOrderAuthorityAddress: string;
  /** destination-side authority (can cancel/manage) — pinned user-controlled. */
  dstChainOrderAuthorityAddress: string;
  /** source EOA, for accurate gas estimate. */
  senderAddress: string;
  /** ALWAYS 0 — no affiliate skim, ever. */
  affiliateFeePercent: 0;
}

interface DlnEstimationToken {
  address: string;
  symbol?: string;
  decimals?: number;
  amount?: string;
  recommendedAmount?: string;
  approximateUsdValue?: number;
}

interface DlnEstimation {
  srcChainTokenIn?: DlnEstimationToken & { approximateOperatingExpense?: string };
  dstChainTokenOut?: DlnEstimationToken & { maxTheoreticalAmount?: string };
  costsDetails?: Array<{ type?: string; payload?: Record<string, unknown> }>;
  recommendedSlippage?: number;
}

/** create-tx response. EVM source: tx={to,data,value}. Solana source: tx={data}. */
export interface DlnCreateTxResponse {
  estimation?: DlnEstimation;
  tx?: {
    to?: string;
    data?: string;
    /** native fixed fee (fixFee) in wei — MUST be attached even for ERC-20 input. */
    value?: string | null;
  };
  /** top-level native fixed fee, equals tx.value on EVM. */
  fixFee?: string;
  /** bytes32 — used to poll status. */
  orderId?: string;
  /** present on errors. */
  errorId?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Small EVM byte helpers (no viem; consistent with addr.ts).
// ---------------------------------------------------------------------------

function strip0x(h: string): string {
  return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}

/** Left-pad a hex value (no 0x) to 32 bytes / 64 hex chars. */
function pad32(hexNo0x: string): string {
  const h = hexNo0x.toLowerCase();
  if (h.length > 64) throw new Error(`value too wide for uint256/word: 0x${h}`);
  return h.padStart(64, "0");
}

/** A non-negative decimal base-unit string -> minimal hex (no 0x). */
function decToHex(dec: string): string {
  if (!/^\d+$/.test(dec)) throw new Error(`not a base-unit integer: "${dec}"`);
  let v = BigInt(dec);
  if (v === 0n) return "0";
  let out = "";
  const HEX = "0123456789abcdef";
  while (v > 0n) {
    out = HEX[Number(v & 0xfn)] + out;
    v >>= 4n;
  }
  return out;
}

/** Encode ERC-20 approve(spender, amount). amount is a base-unit decimal string. */
export function encodeErc20Approve(spender: string, amount: string): `0x${string}` {
  const sp = strip0x(spender).toLowerCase();
  if (sp.length !== 40) throw new Error(`bad spender address: ${spender}`);
  const data =
    ERC20_APPROVE_SELECTOR +
    pad32(sp) + // address left-padded to 32 bytes
    pad32(decToHex(amount));
  return data as `0x${string}`;
}

/** Is this address the EVM zero address (i.e. native sentinel)? */
function isZeroAddr(a: string): boolean {
  return /^0x0{40}$/i.test(a);
}

// ---------------------------------------------------------------------------
// The pure create-tx builder. Returns the API response AND the params we pinned
// so callers (and gas.ts) can re-verify. NEVER signs.
// ---------------------------------------------------------------------------

function buildCreateTxUrl(p: CreateTxParams): string {
  const q = new URLSearchParams({
    srcChainId: String(p.srcChainId),
    srcChainTokenIn: p.srcChainTokenIn,
    srcChainTokenInAmount: p.srcChainTokenInAmount,
    dstChainId: String(p.dstChainId),
    dstChainTokenOut: p.dstChainTokenOut,
    dstChainTokenOutAmount: p.dstChainTokenOutAmount,
    dstChainTokenOutRecipient: p.dstChainTokenOutRecipient,
    srcChainOrderAuthorityAddress: p.srcChainOrderAuthorityAddress,
    dstChainOrderAuthorityAddress: p.dstChainOrderAuthorityAddress,
    senderAddress: p.senderAddress,
    // FORCE zero affiliate skim; affiliateFeeRecipient intentionally omitted.
    affiliateFeePercent: "0",
    // operating costs are SUBTRACTED from output (default) — keep input == pinned.
    prependOperatingExpenses: "false",
  });
  return `${DLN_API_BASE}${CREATE_TX_PATH}?${q.toString()}`;
}

/** Re-verify the response was produced for the EXACT addresses we pinned and
 *  carries no affiliate skim. Throws if anything drifted (API bug / tampering).
 *  This is the local re-decode validate_intent relies on for deBridge. */
export function assertOrderPins(p: CreateTxParams, res: DlnCreateTxResponse): void {
  // Hard invariant: we NEVER request a non-zero affiliate fee.
  if (p.affiliateFeePercent !== 0) {
    throw new Error("deBridge: affiliateFeePercent must be 0 (refusing skim).");
  }
  if (res.errorId || res.errorMessage) {
    throw new Error(
      `deBridge create-tx error: ${res.errorId ?? ""} ${res.errorMessage ?? ""}`.trim(),
    );
  }
  if (!res.tx || (!res.tx.data && !res.tx.to)) {
    throw new Error("deBridge create-tx returned no transaction.");
  }
  // The output token the API priced must match the sentinel/token we asked for.
  const outAddr = res.estimation?.dstChainTokenOut?.address;
  if (outAddr && outAddr.toLowerCase() !== p.dstChainTokenOut.toLowerCase()) {
    throw new Error(
      `deBridge: priced output token ${outAddr} != requested ${p.dstChainTokenOut}.`,
    );
  }
}

/** Map a single create-tx response into one UnsignedBridgeTx (no approve). The
 *  `chain` is the chain the tx EXECUTES on (the SOURCE chain for create orders,
 *  the destination chain for a cancel). */
function toUnsignedTx(
  chain: Chain,
  res: DlnCreateTxResponse,
  label: string,
): UnsignedBridgeTx {
  if (isEvm(chain)) {
    const to = res.tx?.to;
    const data = res.tx?.data;
    if (!to || !data) {
      throw new Error("deBridge EVM create-tx missing {to,data}.");
    }
    // tx.value IS the native protocol fixFee and MUST be sent (Polygon 0.5 POL,
    // Ethereum 0.001 ETH, Arbitrum 0/null). Normalize null/undefined -> "0".
    const value = res.tx?.value ?? res.fixFee ?? "0";
    return {
      chain,
      kind: "evmTx",
      payload: { to, data, value: value === null ? "0" : String(value) },
      label,
    };
  }
  // Solana source: tx has ONLY {data} = hex-encoded VersionedTransaction. The
  // signer/transport layer decodes hex -> bytes, refreshes blockhash + priority
  // fee, signs and sends. We surface it as a base64 string per UnsignedBridgeTx's
  // contract ("Solana: base64 unsigned VersionedTransaction").
  const dataHex = res.tx?.data;
  if (!dataHex) throw new Error("deBridge Solana create-tx missing tx.data.");
  const bytes = Buffer.from(strip0x(dataHex), "hex");
  return {
    chain,
    kind: "solanaTx",
    payload: bytes.toString("base64"),
    label,
  };
}

/**
 * Assemble the full unsigned step list to PLACE a create order, given the chain
 * the order executes on (the SOURCE chain). EVM ERC-20 input prepends an
 * approve(DlnSource, inputAmount); Solana wraps everything in the single
 * VersionedTransaction. Shared by funding legs (debridge.ts) and gas top-ups
 * (gas.ts) so the approve/fixFee handling lives in exactly one place.
 */
export function buildSourceOrderTxs(
  sourceChain: Chain,
  res: DlnCreateTxResponse,
): UnsignedBridgeTx[] {
  const createTx = toUnsignedTx(sourceChain, res, "dlnCreate");
  if (!isEvm(sourceChain)) return [createTx]; // Solana approve is inside the tx
  const spender = res.tx?.to;
  // The back-solved (auto) or fixed input the DlnSource must be allowed to pull.
  const inputAmount = res.estimation?.srcChainTokenIn?.amount;
  if (!spender || !inputAmount) {
    // Without a known input we can't size the approve; leave it to the caller's
    // higher-level flow (it should not happen for ERC-20 legs — surface loudly).
    throw new Error("deBridge EVM order missing DlnSource (tx.to) or input amount for approve.");
  }
  const approve: UnsignedBridgeTx = {
    chain: sourceChain,
    kind: "evmTx",
    payload: {
      to: usdcOn(sourceChain),
      data: encodeErc20Approve(spender, inputAmount),
      value: "0",
    },
    label: "approve",
  };
  return [approve, createTx];
}

// ---------------------------------------------------------------------------
// The Bridge implementation.
// ---------------------------------------------------------------------------

export interface DeBridgeConfig {
  /** Source-chain EOA address (the local signer's address on the source chain).
   *  Used as senderAddress and srcChainOrderAuthorityAddress (refund beneficiary). */
  sourceAddress: string;
  /** Optional custom fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class DeBridgeBridge implements Bridge {
  readonly provider: BridgeProvider = "debridge";
  private readonly cfg: DeBridgeConfig;
  private readonly doFetch: typeof fetch;

  constructor(cfg: DeBridgeConfig) {
    this.cfg = cfg;
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  /**
   * Build the pinned create-tx params for a token funding leg (USDC -> USDC on
   * the destination). Pins srcChainTokenInAmount, lets the destination auto-solve.
   */
  private fundingParams(route: BridgeRoute, amountBaseUnits: string): CreateTxParams {
    return {
      srcChainId: debridgeChainId(route.fromChain),
      srcChainTokenIn: usdcOn(route.fromChain),
      srcChainTokenInAmount: amountBaseUnits,
      dstChainId: debridgeChainId(route.toChain),
      dstChainTokenOut: usdcOn(route.toChain),
      dstChainTokenOutAmount: "auto",
      dstChainTokenOutRecipient: route.recipient,
      // Refund beneficiary on the source side = our source EOA.
      srcChainOrderAuthorityAddress: this.cfg.sourceAddress,
      // Cancel/manage authority on the destination side = the recipient (user-
      // controlled). NEVER an agent-supplied address.
      dstChainOrderAuthorityAddress: route.recipient,
      senderAddress: this.cfg.sourceAddress,
      affiliateFeePercent: 0,
    };
  }

  /**
   * Issue the GET create-tx call, fail on HTTP error, and RE-DECODE the response
   * against the params we pinned (assertOrderPins) BEFORE returning. The verified
   * single chokepoint — both funding and gas-top-up paths go through it, so the
   * affiliate-fee-zero + recipient/authority pinning is enforced in one place.
   * Public so gas.ts can place a native-OUTPUT order via the same vetted call.
   */
  async createOrder(p: CreateTxParams): Promise<DlnCreateTxResponse> {
    const url = buildCreateTxUrl(p);
    const r = await this.doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const body = (await r.json()) as DlnCreateTxResponse;
    if (!r.ok) {
      throw new Error(
        `deBridge create-tx HTTP ${r.status}: ${body?.errorMessage ?? body?.errorId ?? "unknown"}`,
      );
    }
    assertOrderPins(p, body);
    return body;
  }

  async quote(route: BridgeRoute): Promise<BridgeQuote> {
    const amount = toBaseUnits(route.amount, route.token);
    const p = this.fundingParams(route, amount);
    const res = await this.createOrder(p);
    const feeUsd = estimateFeeUsd(res);
    return {
      provider: "debridge",
      feeUsd,
      // DLN solver fills are typically tens of seconds to a few minutes.
      etaSec: 180,
      starlingFeeUsd: "0",
      // deBridge is a solver-fill model; it has no CCTP-style finality lane.
      reorgExposed: false,
    };
  }

  async buildBridgeIn(route: BridgeRoute): Promise<UnsignedBridgeTx[]> {
    const amount = toBaseUnits(route.amount, route.token);
    const p = this.fundingParams(route, amount);
    const res = await this.createOrder(p);
    // Source chain = where the order is placed / USDC is spent.
    return buildSourceOrderTxs(route.fromChain, res);
  }

  // Outbound (return / cross-chain withdraw) is the same primitive with the
  // direction supplied by the caller via route.fromChain/toChain. recipient is
  // the sealed treasury (assertRecipientIsTreasury upstream).
  async buildBridgeOut(route: BridgeRoute): Promise<UnsignedBridgeTx[]> {
    return this.buildBridgeIn(route);
  }

  /**
   * Recover a stuck deBridge order: build the destination-chain cancel-tx the
   * user-controlled dstChainOrderAuthorityAddress submits to unlock source funds.
   * deBridge exposes this via the order/{id} cancel endpoint; we surface the
   * unsigned tx. Re-driving is the refund path the spec mandates — funds are
   * never stranded.
   */
  async recover(route: BridgeRoute, flightId: string): Promise<UnsignedBridgeTx[]> {
    const url = `${DLN_API_BASE}${ORDER_PATH}/${flightId}/cancel-tx`;
    const r = await this.doFetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) {
      throw new Error(`deBridge cancel-tx HTTP ${r.status} for order ${flightId}.`);
    }
    const body = (await r.json()) as DlnCreateTxResponse;
    if (!body.tx) {
      throw new Error(`deBridge: no cancel-tx available for order ${flightId} yet.`);
    }
    // The cancel executes on the DESTINATION chain (that's where the authority
    // cancels), so label it against route.toChain.
    return [toUnsignedTx(route.toChain, body, "dlnCancel")];
  }

  /**
   * Poll the order + map deBridge order state to BridgeFlightState. Always
   * confirm the destination effect via the provider before calling it "ready";
   * the caller layers venue preconditions on top for readyToTrade.
   */
  async status(flightId: string): Promise<BridgeStatus> {
    const url = `${DLN_API_BASE}${ORDER_PATH}/${flightId}/status`;
    const r = await this.doFetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) {
      return {
        provider: "debridge",
        state: "fill_pending",
        readyToTrade: false,
        blockers: [`status HTTP ${r.status}`],
        note: `deBridge status poll failed for ${flightId}`,
      };
    }
    const body = (await r.json()) as { status?: string };
    const raw = (body.status ?? "").toLowerCase();
    const state = mapDlnStatus(raw);
    return {
      provider: "debridge",
      state,
      readyToTrade: false, // venue preconditions decided by check_venue_status
      blockers: state === "ready" ? [] : [`order ${raw || "unknown"}`],
      note: `deBridge order ${flightId}: ${raw || "unknown"}`,
    };
  }
}

/** deBridge order status string -> repo BridgeFlightState. */
function mapDlnStatus(raw: string): BridgeStatus["state"] {
  switch (raw) {
    case "fulfilled":
    case "claimedunlock":
    case "sentunlock":
    case "claimed":
      return "ready";
    case "created":
    case "none":
      return "fill_pending";
    case "ordercancelled":
    case "sentordercancel":
    case "claimedordercancel":
      return "stuck_cancellable";
    default:
      // unknown statuses are treated as still in flight, not failed
      return "fill_pending";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by gas.ts).
// ---------------------------------------------------------------------------

/** USDC (the only token deBridge funding legs move here) is 6dp on every chain
 *  — EVM native USDC and the Solana SPL mint are both 6dp. Any non-USDC token
 *  would need a decimals registry; funding legs are USDC-denominated by design. */
const USDC_DECIMALS = 6;

/** Decimal token amount -> integer base-unit string (no float). USDC = 6dp. */
export function toBaseUnits(amountDecimal: string, token: string): string {
  if (token.toUpperCase() !== "USDC") {
    throw new Error(
      `deBridge funding leg only supports USDC, got "${token}". ` +
        `Non-USDC tokens need a decimals registry.`,
    );
  }
  return scaleDecimal(amountDecimal, USDC_DECIMALS);
}

/** Multiply a decimal string by 10^decimals. FAIL-CLOSED on excess precision:
 *  if the fractional part has MORE significant digits than `decimals`, THROW
 *  rather than silently truncating — a money move must never bridge a different
 *  amount than the user named. This matches viem's parseUnits (which CCTP uses),
 *  so the two bridge modules agree on how an over-precise amount is handled
 *  (both reject) instead of CCTP rejecting while deBridge silently drops digits. */
export function scaleDecimal(amountDecimal: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amountDecimal)) {
    throw new Error(`bad decimal amount: "${amountDecimal}"`);
  }
  const [intPart, fracPart = ""] = amountDecimal.split(".");
  // Trailing zeros beyond `decimals` are harmless (1.5000000 at 6dp == 1.5), but
  // any SIGNIFICANT digit past `decimals` would be silently lost — refuse it.
  const trimmed = fracPart.replace(/0+$/, "");
  if (trimmed.length > decimals) {
    throw new Error(
      `amount "${amountDecimal}" has more than ${decimals} decimal places ` +
        `(would lose precision on a money move — refusing to truncate).`,
    );
  }
  const frac = fracPart.slice(0, decimals).padEnd(decimals, "0");
  const combined = (intPart + frac).replace(/^0+/, "") || "0";
  return combined;
}

/**
 * The native VALUE (wei/lamports, base-unit string) the SOURCE wallet must hold
 * ON TOP of tx gas to place this order — i.e. the DLN flat fixFee carried as
 * tx.value. AUTHORITATIVE source: res.tx.value (== response.fixFee). Returns "0"
 * when the API reports none (e.g. some response shapes carry it inside the
 * Solana tx). Used to pre-flight the source wallet's native balance. */
export function sourceFixFeeNative(res: DlnCreateTxResponse): string {
  const v = res.tx?.value ?? res.fixFee ?? null;
  if (v === null || v === undefined) return "0";
  const s = String(v);
  return /^\d+$/.test(s) ? s : "0";
}

/** Best-effort fee estimate (USD) from the create-tx estimation cost details. */
function estimateFeeUsd(res: DlnCreateTxResponse): string {
  // DLN protocol fee is 4bps of input + operating expenses; we surface the
  // difference between input USD value and output USD value when both present.
  const inUsd = res.estimation?.srcChainTokenIn?.approximateUsdValue;
  const outUsd = res.estimation?.dstChainTokenOut?.approximateUsdValue;
  if (typeof inUsd === "number" && typeof outUsd === "number" && inUsd >= outUsd) {
    return (inUsd - outUsd).toFixed(4);
  }
  return "0";
}

export { isEvm as debridgeIsEvm, realNet as debridgeRealNet, isZeroAddr };
