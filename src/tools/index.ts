// src/tools/index.ts
// The money-moving + read tool registry. This is the SEAM between the MCP
// protocol surface (server.ts: a TOOLS array + a CallTool switch) and the pure
// builder layers (adapters/, bridge/, withdraw/, intents/). It owns NO calldata
// of its own — it validates args, runs every money-moving call through the
// idempotency store, and hands back the UNSIGNED artifact the LOCAL signer will
// sign + broadcast. Nothing here ever signs or broadcasts.
//
// THREE LOAD-BEARING INVARIANTS (the reason this file exists as a chokepoint):
//
//   1. EXECUTION IS GATED, NOT FREE. Off-chain order venues (PM CLOB / HL
//      exchange) locally sign + POST the order INSIDE the tool (open / close /
//      the HL native withdraw) — but only AFTER the policy caps, the worst-price
//      bound, the idempotency store, and (for withdraw) the per-call cap have all
//      passed. On-chain tx builds (bridge / gas / EVM-or-Solana sweep) are still
//      returned UNSIGNED for the executor to sign + broadcast under
//      inspect-before-sign. Either way a buggy/rogue *argument* can only shape a
//      build within those gates: it cannot redirect funds (recipients are pinned
//      server-side — the sealed treasury, or, for the HL withdraw, the owner's own
//      address pinned by HL) nor exceed the caps.
//
//   2. IDEMPOTENT MONEY MOVES. Every money-moving tool REQUIRES an
//      idempotencyKey and goes through IntentStore.upsert FIRST. On a replayed
//      key we return the ORIGINAL stored build — we never rebuild (Polymarket's
//      per-order salt makes a rebuild a *new* order => double-trade). The store's
//      (botId, idempotencyKey) uniqueness is the dedupe key.
//
//   3. WITHDRAW DESTINATION IS NOT AN ARGUMENT. build_withdraw takes no
//      recipient. resolveWithdrawRecipient() reads the sealed treasury or
//      refuses. "send to address X" is not expressible through this tool surface
//      (honest ceiling: a code-exec'd agent holding the key bypasses the whole
//      MCP — see withdraw/allowlist.ts).
//
// Because the concrete adapters/bridges/store are wired at boot (and several are
// still being built), this registry depends on an injected ToolDeps bag rather
// than importing concrete singletons. server.ts builds ToolDeps once and passes
// it into handleMoneyTool(). That keeps this file compiling against the stable
// *interfaces* in adapters/types.ts, bridge/types.ts, intents/store.ts,
// withdraw/allowlist.ts and makes the venues/bridges swappable + unit-testable.

import type {
  AmountKind,
  BuildResult,
  CloseIntent,
  OpenIntent,
  PositionState,
  Side,
  SubmitResult,
  Venue,
} from "../adapters/types.js";
import type { VenueAdapter } from "../adapters/types.js";
import type {
  Bridge,
  BridgeProvider,
  BridgeQuote,
  BridgeRoute,
  BridgeStatus,
  CctpLane,
  UnsignedBridgeTx,
} from "../bridge/types.js";
import type { Chain } from "../adapters/types.js";
import {
  bindsToIntent,
  canRetry,
  type IntentRecord,
  type IntentStore,
  type Reconciler,
} from "../intents/store.js";
import {
  canWithdraw,
  chainSource,
  resolveWithdrawRecipient,
  type ResolvedWithdraw,
  type SealedTreasury,
  WithdrawError,
} from "../withdraw/allowlist.js";
import {
  checkOpen,
  openNotionalUsd,
  type DailyUsage,
  type RiskLimits,
} from "../policy/limits.js";
import type { Executor, ExecResult } from "../exec/executor.js";
import { runTransfer, advanceBridge } from "./transfer.js";

// ── result helpers ──────────────────────────────────────────────────────────
// Matches the shape server.ts already returns: { content: [{type:"text", text}] }.
// JSON, pretty-printed, on a single text block. Errors set isError so the host
// can surface them without parsing the body.

export interface ToolText {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(obj: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function err(obj: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError: true };
}

// A typed error envelope the agent can branch on. `code` mirrors the trade-error
// vocabulary where it applies, plus a few tool-surface-only codes.
type ToolErrorCode =
  | "bad_args"
  | "unknown_tool"
  | "unknown_venue"
  | "unknown_bridge"
  | "signer_missing"
  | "treasury_refused"
  | "not_found"
  | "retry_blocked"
  | "risk_blocked"
  | "binding_mismatch"
  | "internal";

function fail(code: ToolErrorCode, message: string, extra?: Record<string, unknown>): ToolText {
  return err({ ok: false, code, message, ...(extra ?? {}) });
}

// ── injected runtime (built once at boot, passed into handleMoneyTool) ────────

/** Per-chain native-gas minimums + a planner that builds a top-up bridge leg. */
export interface GasPlanner {
  /**
   * The current native-gas balance vs the per-chain floor needed for the next
   * on-chain action (HL deposit, PM approvals/wrap, Solana ATA rent). Pure read.
   */
  check(chain: Chain): Promise<{ chain: Chain; balance: string; floor: string; sufficient: boolean }>;
  /**
   * Build a deBridge native-OUTPUT top-up that lands `floor - balance` of native
   * gas on `chain`, paid from source USDC. Returns UNSIGNED txs (never broadcast).
   * `sufficient` short-circuits to an empty tx list.
   */
  buildTopUp(chain: Chain): Promise<{ sufficient: boolean; txs: UnsignedBridgeTx[]; note?: string }>;
}

/**
 * A full funding plan: USDC over CCTP (primary) + a deBridge native-gas leg, so
 * a freshly-funded destination EOA can both trade AND pay its own gas. Returned
 * as a sequence of UNSIGNED legs the caller signs in order.
 */
export interface FundingPlanner {
  plan(input: {
    fromChain: Chain;
    toChain: Chain;
    usdcAmount: string;
    /** Sealed-treasury or allowlisted thin-wallet — never an agent argument. */
    recipient: string;
    lane?: CctpLane;
  }): Promise<FundingPlan>;
}

export interface FundingLeg {
  /** "usdc_cctp" | "gas_debridge" — what this leg accomplishes. */
  purpose: "usdc_cctp" | "gas_debridge";
  provider: BridgeProvider;
  quote: BridgeQuote;
  txs: UnsignedBridgeTx[];
}

export interface FundingPlan {
  fromChain: Chain;
  toChain: Chain;
  recipient: string;
  legs: FundingLeg[];
  /** Human-orderable: sign legs[0].txs, then legs[1].txs, … */
  note: string;
}

/**
 * Per-venue enablement: the on-chain preconditions a fresh EOA needs before it
 * can trade (PM approvals + wrap + deposit-wallet registry; HL is just a deposit;
 * Jupiter/Solana needs the USDC ATA). Returns UNSIGNED setup txs + a blockers[]
 * the caller polls until empty.
 */
export interface VenueEnabler {
  enable(venue: Venue): Promise<{
    venue: Venue;
    alreadyEnabled: boolean;
    /** UNSIGNED approval/wrap/registry txs to sign, in order. */
    txs: UnsignedBridgeTx[];
    /** Non-empty => not yet tradable; e.g. ["pUSD approval", "registry lag"]. */
    blockers: string[];
    note?: string;
  }>;
}

/** Per-DW deposit addresses from the NATIVE Polymarket bridge (bridge.polymarket.com). */
export interface PmDepositInfo {
  depositWallet: string;
  /** Address family per source-chain kind: send Solana USDC -> svm, EVM USDC -> evm. */
  addresses: { evm: string; svm: string; tron: string; btc: string };
  note: string;
}

export interface PmWithdrawResult {
  ok: boolean;
  txHash?: string;
  deliveredToChain: Chain;
  /** The pinned treasury address the funds were sent to (never an agent argument). */
  recipient: string;
  blockers: string[];
  note: string;
}

/**
 * The NATIVE Polymarket bridge ops (bridge.polymarket.com) — the gasless, 1:1 rail
 * for funding + draining a deposit wallet (vs the deBridge+swap+wrap path). Deposit
 * is address-lookup only (the caller sends funds to the returned address); withdraw
 * EXECUTES a gasless relayer pUSD transfer to a bridge routing address. The recipient
 * is pinned by the tool layer (sealed treasury), never chosen here.
 */
export interface PmBridgeOps {
  depositAddresses(): Promise<PmDepositInfo>;
  withdraw(args: { amount: string; toChain: Chain; recipient: string }): Promise<PmWithdrawResult>;
}

export interface HlBridgeOutResult {
  ok: boolean;
  txHashes: string[];
  burnTxHash?: string;
  blockers: string[];
  note: string;
}

/**
 * The CHEAP Hyperliquid exit (HyperCore -> HyperEVM -> CCTP -> dest): ~$0.003 + ~30s
 * to ANY CCTP chain, vs the $1 / ~5-min / Arbitrum-only native withdraw3. EXECUTES
 * the whole flow (HL actions + the EVM burn/mint) and self-funds HYPE gas. The
 * recipient is pinned by the tool layer (sealed treasury), never chosen here.
 */
export interface HlExitOps {
  bridgeOut(args: { amount: string; dest: "arbitrum" | "polygon"; recipient: string }): Promise<HlBridgeOutResult>;
}

// ── the HL-specific venue surface (everything HyperCore offers beyond a plain IOC
//    open/close) ────────────────────────────────────────────────────────────────
// marketId: "hl:<COIN>" for a perp, "hlspot:<TOKEN>" (or "hlspot:@<pairIndex>") for
// spot. These actions keep funds INSIDE the HL account (orders / margin / vault /
// staking / perp<->spot) — getting USDC OUT is hl_bridge_out / withdraw3, which are
// treasury-pinned. So none of these take a recipient.

/** Advanced order: resting (Gtc) / post-only (Alo) / marketable (Ioc), optional
 *  trigger (stop-loss / take-profit), optional client order id, perp OR spot. */
export interface HlOrderArgs {
  marketId: string;
  side: Side;
  amount: string;
  amountKind: AmountKind;
  worstPrice: string;
  tif?: "Ioc" | "Gtc" | "Alo";
  reduceOnly?: boolean;
  trigger?: { triggerPx: string; isMarket: boolean; tpsl: "tp" | "sl" };
  cloid?: string;
}
export interface HlCancelArgs { marketId: string; oid?: number; cloid?: string; all?: boolean }
export interface HlLeverageArgs { marketId: string; leverage: number; cross: boolean }
export interface HlIsoMarginArgs { marketId: string; usdDelta: string }
export interface HlClassTransferArgs { amount: string; toPerp: boolean }
export interface HlVaultArgs { vaultAddress: string; isDeposit: boolean; usd: string }
export interface HlStakeArgs { direction: "deposit" | "withdraw"; hype: string }
export interface HlDelegateArgs { validator: string; hype: string; undelegate: boolean }
export interface HlTwapOrderArgs { marketId: string; side: Side; size: string; minutes: number; reduceOnly?: boolean; randomize?: boolean }
export interface HlTwapCancelArgs { marketId: string; twapId: number }

/**
 * The full HyperCore surface as an injectable ops object (mirrors HlExitOps /
 * PmBridgeOps). Each write EXECUTES locally (sign + POST /exchange) and returns a
 * SubmitResult. account() is a comprehensive read (perp + spot + open orders +
 * staking). Wired in server.ts only when an HL signer is loaded; absent => the
 * hl_* tools report "not wired".
 */
export interface HlVenueOps {
  account(): Promise<unknown>;
  order(a: HlOrderArgs): Promise<SubmitResult>;
  cancel(a: HlCancelArgs): Promise<SubmitResult>;
  updateLeverage(a: HlLeverageArgs): Promise<SubmitResult>;
  updateIsolatedMargin(a: HlIsoMarginArgs): Promise<SubmitResult>;
  usdClassTransfer(a: HlClassTransferArgs): Promise<SubmitResult>;
  vaultTransfer(a: HlVaultArgs): Promise<SubmitResult>;
  stake(a: HlStakeArgs): Promise<SubmitResult>;
  delegate(a: HlDelegateArgs): Promise<SubmitResult>;
  twapOrder(a: HlTwapOrderArgs): Promise<SubmitResult>;
  twapCancel(a: HlTwapCancelArgs): Promise<SubmitResult>;
}

// ── the Jupiter surface BEYOND spot swap (limit/trigger orders + recurring/DCA;
//    lend + prediction added incrementally) ──────────────────────────────────────
// All keyless REST that returns an unsigned base64 Solana tx the local key signs (the
// swap-adapter pattern). Funds escrow to a user-cancellable order account, so no recipient.

/** A Jupiter limit (Trigger) order. Limit price is implied by makingAmount/takingAmount. */
export interface JupLimitArgs {
  inputMint: string;
  outputMint: string;
  makingAmount: string; // decimal UI amount of inputMint to sell
  takingAmount: string; // decimal UI amount of outputMint wanted (price = taking/making)
  slippageBps?: number;
  expiredAt?: number; // unix seconds
}
export interface JupLimitCancelArgs { order: string }
/** A Jupiter recurring (DCA) order — time-based: buy `inAmount` total over N cycles. */
export interface JupRecurringArgs {
  inputMint: string;
  outputMint: string;
  inAmount: string; // decimal UI total input across all cycles
  numberOfOrders: number;
  interval: number; // seconds between cycles
  minPrice?: number;
  maxPrice?: number;
  startAt?: number; // unix seconds; omit for immediate
}
export interface JupRecurringCancelArgs { order: string }
/** Jupiter Lend EARN: deposit/withdraw a decimal UI `amount` of `asset` (any SPL mint). */
export interface JupLendEarnArgs { asset: string; amount: string }
/** Jupiter Lend BORROW (advanced): one `operate` call. colAmount/debtAmount are SIGNED
 *  RAW-unit strings (+col supply / -col withdraw; +debt borrow / -debt repay).
 *  positionId 0 opens a new position. */
export interface JupLendBorrowArgs { vaultId: number; positionId: number; colAmount: string; debtAmount: string }

/**
 * The Jupiter advanced surface as an injectable ops object (mirrors HlVenueOps). Each
 * write EXECUTES (REST -> local-sign -> land) and returns a SubmitResult; list reads
 * return the raw JSON. Wired in server.ts only when a Solana signer is loaded; absent
 * => the jup_* tools report "not wired".
 */
export interface JupVenueOps {
  limitCreate(a: JupLimitArgs): Promise<SubmitResult>;
  limitCancel(a: JupLimitCancelArgs): Promise<SubmitResult>;
  limitList(status: "active" | "history"): Promise<unknown>;
  recurringCreate(a: JupRecurringArgs): Promise<SubmitResult>;
  recurringCancel(a: JupRecurringCancelArgs): Promise<SubmitResult>;
  recurringList(status: "active" | "history"): Promise<unknown>;
  lendDeposit(a: JupLendEarnArgs): Promise<SubmitResult>;
  lendWithdraw(a: JupLendEarnArgs): Promise<SubmitResult>;
  lendTokens(): Promise<unknown>;
  lendPositions(): Promise<unknown>;
  lendBorrow(a: JupLendBorrowArgs): Promise<SubmitResult>;
  lendVaults(): Promise<unknown>;
  lendBorrowPositions(): Promise<unknown>;
}

/**
 * Everything the tools need, injected. server.ts constructs this once after
 * bootUnlock() and passes it on every call. Keeping it injected (vs importing
 * singletons) is what lets the adapters/bridges be built incrementally and
 * unit-tested with fakes.
 */
export interface ToolDeps {
  /** Stable per-process bot identity; one half of the (botId, idempotencyKey) PK. */
  botId: string;
  /** Live adapters keyed by venue. A missing key => venue not enabled this run. */
  adapters: Partial<Record<Venue, VenueAdapter>>;
  /** Live bridges keyed by provider (cctp primary, debridge secondary). */
  bridges: Partial<Record<BridgeProvider, Bridge>>;
  store: IntentStore;
  reconciler: Reconciler;
  /** Recover the sealed treasury for withdraws. Throws if unsealed. */
  treasury(): Promise<SealedTreasury>;
  gas: GasPlanner;
  funding: FundingPlanner;
  enabler: VenueEnabler;
  /** Native Polymarket bridge (gasless 1:1 PM deposit/withdraw). */
  pmBridge: PmBridgeOps;
  /** The cheap Hyperliquid exit (HyperCore->HyperEVM->CCTP). Optional: only wired
   *  when an HL signer is present; absent => hl_bridge_out reports "not wired". */
  hlExit?: HlExitOps;
  /** The full HyperCore surface (spot, advanced orders, leverage, vaults, staking,
   *  TWAP). Optional: only wired when an HL signer is present; absent => the hl_*
   *  tools report "not wired". */
  hlVenue?: HlVenueOps;
  /** The Jupiter surface beyond swap (limit/trigger orders, recurring/DCA, …).
   *  Optional: only wired when a Solana signer is present; absent => the jup_* tools
   *  report "not wired". */
  jupVenue?: JupVenueOps;
  /** Signs + broadcasts + confirms the UNSIGNED on-chain legs the builders produce
   *  (bridge / gas / venue-setup / EVM+SOL sweep), under inspect-before-sign. This
   *  is what lets the on-chain tools EXECUTE instead of handing back unsigned txs. */
  executor: Executor;
  /** Polymarket per-builder daily relayer quota (shared budget) for canRetry. */
  dailyRelayerQuota: number;
  /** Which venues currently have a loaded local signer (gates money moves). */
  signerLoaded(venue: Venue): boolean;
  /** The USER-SET risk limits (per-trade/daily caps + kill-switch). Not agent-set. */
  limits(): RiskLimits;
  /** Today's accumulated usage for the daily caps (caller rolls it at UTC midnight). */
  dailyUsage(): DailyUsage;
  /** Record a freshly-built open's USD notional toward the daily cap. */
  recordOpen(notionalUsd: string): void;
  /** The loaded signer's OWN address on a chain — the pinned `transfer` recipient
   *  (a transfer moves USDC between the user's own wallets). Never an agent arg. */
  selfAddress(chain: Chain): string | null;
  /** Destination native-gas balance (decimal units) for the transfer rail decision
   *  (CCTP needs dest gas to mint; deBridge does not). */
  nativeGas(chain: Chain): Promise<number>;
}

// ── tool schemas (merged into server.ts's TOOLS array) ───────────────────────
// Hand-written JSON Schema (the SDK validates nothing beyond shape, so the
// argument parsing below is the real gate). idempotencyKey is REQUIRED on every
// money-moving tool; the read tools omit it.

const STR = { type: "string" as const };
const NUM = { type: "number" as const };
const BOOL = { type: "boolean" as const };

const IDEMPOTENCY = {
  idempotencyKey: {
    ...STR,
    description:
      "REQUIRED unique key for this money move. Replaying it returns the ORIGINAL " +
      "build, never a second one. (botId, idempotencyKey) is the dedupe PK.",
  },
};

const VENUE_ENUM = { type: "string" as const, enum: ["polymarket", "hyperliquid", "jupiter"] };
const SIDE_ENUM = { type: "string" as const, enum: ["buy", "sell"] };
const AMOUNTKIND_ENUM = { type: "string" as const, enum: ["collateral", "shares"] };
const CHAIN_ENUM = { type: "string" as const, enum: ["polygon", "hyperliquid", "solana"] };
const PROVIDER_ENUM = { type: "string" as const, enum: ["cctp", "debridge"] };
const LANE_ENUM = { type: "string" as const, enum: ["fast", "standard"] };

export const MONEY_TOOLS = [
  {
    name: "get_quote",
    description:
      "Read-only: resolve a market and return its current marketable price + tick/negRisk " +
      "metadata so the caller can derive worstPrice. No build, no idempotency key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        venue: VENUE_ENUM,
        marketId: { ...STR, description: 'Venue-prefixed id, e.g. "pm:<conditionId>", "hl:BTC".' },
        side: SIDE_ENUM,
      },
      required: ["venue", "marketId"],
    },
  },
  {
    name: "open_position",
    description:
      "Build an UNSIGNED open order (PM EIP-712 order / HL signed action / Solana tx). " +
      "Requires an explicit worstPrice (no market orders anywhere in this stack). Returns " +
      "the artifact for the local signer; does NOT broadcast.",
    inputSchema: {
      type: "object" as const,
      properties: {
        venue: VENUE_ENUM,
        marketId: STR,
        side: SIDE_ENUM,
        amount: { ...STR, description: "Decimal string. Never a JS number (precision)." },
        amountKind: AMOUNTKIND_ENUM,
        worstPrice: { ...STR, description: "REQUIRED worst acceptable price per unit." },
        slippageFrac: { ...NUM, description: "Used to derive worstPrice if not pinned. Default 0.05." },
        edgeBps: NUM,
        ...IDEMPOTENCY,
      },
      required: ["venue", "marketId", "side", "amount", "amountKind", "worstPrice", "idempotencyKey"],
    },
  },
  {
    name: "close_position",
    description:
      "Build an UNSIGNED close for a fraction (0,1] of an open position. Returns the artifact " +
      "for the local signer. If the market resolved, list_positions flags resolved=true and the " +
      "caller routes to redeem instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        venue: VENUE_ENUM,
        marketId: STR,
        fraction: { ...STR, description: "Decimal string in (0,1]. 1 = full exit." },
        worstPrice: STR,
        slippageFrac: NUM,
        ...IDEMPOTENCY,
      },
      required: ["venue", "marketId", "fraction", "worstPrice", "idempotencyKey"],
    },
  },
  {
    name: "list_positions",
    description:
      "Read-only: normalized open positions across the given venue(s) (size, avgPrice, " +
      "unrealizedPnl, resolved). No build, no idempotency key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        venue: { ...VENUE_ENUM, description: "Omit to query every enabled venue." },
        marketIds: { type: "array" as const, items: STR, description: "Optional filter." },
      },
    },
  },
  {
    name: "build_withdraw",
    description:
      "Build an UNSIGNED sweep to the SEALED TREASURY. Takes NO recipient argument — the " +
      "destination is read from the sealed treasury or the build is refused. Amount is capped " +
      "by the per-call risk limit. Returns the artifact for the local signer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chain: CHAIN_ENUM,
        amount: { ...STR, description: "Decimal string. Validated against the per-call cap." },
        ...IDEMPOTENCY,
      },
      required: ["chain", "amount", "idempotencyKey"],
    },
  },
  {
    name: "bridge_quote",
    description:
      "Read-only: fee/ETA/finality for a USDC (CCTP) or non-USDC (deBridge) route. Surfaces " +
      "the finality lane that WILL execute so a caller can't mistake fast for finalized. " +
      "Recipient here is informational only (the real build pins it).",
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: { ...PROVIDER_ENUM, description: "Omit to auto-pick (USDC=>cctp, else debridge)." },
        fromChain: CHAIN_ENUM,
        toChain: CHAIN_ENUM,
        token: STR,
        amount: STR,
        lane: { ...LANE_ENUM, description: "CCTP only. Withdraws/large sweeps force standard." },
      },
      required: ["fromChain", "toChain", "token", "amount"],
    },
  },
  {
    name: "build_bridge",
    description:
      "Build the UNSIGNED inbound bridge legs ([approve?, depositForBurn] for CCTP; [create] for " +
      "deBridge). The recipient is pinned by the MCP (sealed treasury / allowlisted thin-wallet), " +
      "NOT taken from an agent argument. Returns the tx list for the local signer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: PROVIDER_ENUM,
        fromChain: CHAIN_ENUM,
        toChain: CHAIN_ENUM,
        token: STR,
        amount: STR,
        /** direction selects buildBridgeIn vs buildBridgeOut. */
        direction: { type: "string" as const, enum: ["in", "out"] },
        lane: LANE_ENUM,
        ...IDEMPOTENCY,
      },
      required: ["provider", "fromChain", "toChain", "token", "amount", "idempotencyKey"],
    },
  },
  {
    name: "get_bridge_status",
    description:
      "Read-only: poll a bridge flight and CONFIRM the destination effect on-chain. readyToTrade " +
      "is the FULL venue-precondition set, not just a mint balance delta. Returns state + blockers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: PROVIDER_ENUM,
        flightId: { ...STR, description: "CCTP burn tx hash / deBridge orderId from build_bridge." },
      },
      required: ["provider", "flightId"],
    },
  },
  {
    name: "ensure_gas",
    description:
      "Top up native gas on a chain to the per-chain floor via a deBridge native-OUTPUT order " +
      "(paid from source USDC). Returns UNSIGNED top-up txs, or an empty list if already funded. " +
      "CCTP cannot deliver gas, so this is the companion leg to any USDC funding.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chain: CHAIN_ENUM,
        ...IDEMPOTENCY,
      },
      required: ["chain", "idempotencyKey"],
    },
  },
  {
    name: "plan_funding_route",
    description:
      "Plan a full fund-a-fresh-EOA route: USDC over CCTP (primary) + a deBridge native-gas leg, " +
      "so the destination can both trade and pay its own gas. Returns an ORDERED list of UNSIGNED " +
      "legs. Recipient is pinned by the MCP, not the agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fromChain: CHAIN_ENUM,
        toChain: CHAIN_ENUM,
        usdcAmount: { ...STR, description: "Decimal string of USDC to deliver tradable at dest." },
        lane: LANE_ENUM,
        ...IDEMPOTENCY,
      },
      required: ["fromChain", "toChain", "usdcAmount", "idempotencyKey"],
    },
  },
  {
    name: "enable_venue",
    description:
      "Build the UNSIGNED on-chain setup a fresh EOA needs to trade a venue (PM: approvals + " +
      "USDC.e->pUSD wrap + deposit-wallet registry; HL: deposit; Jupiter: USDC ATA). Returns the " +
      "setup txs + a blockers[] the caller polls until empty. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        venue: VENUE_ENUM,
        ...IDEMPOTENCY,
      },
      required: ["venue", "idempotencyKey"],
    },
  },
  {
    name: "pm_deposit_address",
    description:
      "Read-only: the Polymarket deposit wallet's NATIVE bridge deposit addresses (bridge.polymarket.com), " +
      "one per source-chain kind {evm, svm, tron, btc}. Send any supported stable on any supported chain " +
      "(e.g. Solana USDC -> svm, Polygon/EVM USDC -> evm) to the matching address and Polymarket settles pUSD " +
      "INTO the deposit wallet — GASLESS, 1:1, no swap/wrap/deBridge. The cheapest way to fund Polymarket. " +
      "Min ~$2 cross-chain. No build, no idempotency key.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "pm_withdraw",
    description:
      "Withdraw pUSD from the Polymarket deposit wallet to the SEALED TREASURY, GASLESSLY, via the native " +
      "bridge. toChain=polygon is a same-chain relayer transfer to the treasury; cross-chain (solana / " +
      "hyperliquid) routes through bridge.polymarket.com (1:1, no deBridge haircut, no POL). Takes NO recipient " +
      "argument — the destination is the pinned treasury for that chain. Min $2 cross-chain. Idempotent: a " +
      "replayed key is NOT re-sent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        toChain: { ...CHAIN_ENUM, description: "Destination chain. Its treasury address receives the funds." },
        amount: { ...STR, description: "Decimal pUSD to withdraw from the deposit wallet." },
        ...IDEMPOTENCY,
      },
      required: ["toChain", "amount", "idempotencyKey"],
    },
  },
  {
    name: "hl_bridge_out",
    description:
      "Withdraw USDC OUT of Hyperliquid the CHEAP way: HyperCore -> HyperEVM -> CCTP -> the SEALED " +
      "TREASURY on toChain. ~$0.003 + ~30s to any CCTP chain, vs the $1 / ~5-min / Arbitrum-only native " +
      "withdraw3. Self-funds HYPE gas on HyperEVM (a one-time ~$10 float). Takes NO recipient argument " +
      "(pinned treasury). Idempotent. toChain=hyperliquid mints on Arbitrum, polygon on Polygon. For a " +
      "one-off with no HYPE float, the native withdraw3 (build_withdraw chain=hyperliquid) may be simpler.",
    inputSchema: {
      type: "object" as const,
      properties: {
        toChain: { type: "string" as const, enum: ["polygon", "hyperliquid"], description: "Destination: hyperliquid=Arbitrum, polygon=Polygon. Its treasury address receives the USDC." },
        amount: { ...STR, description: "Decimal USDC to bridge out of HyperCore." },
        ...IDEMPOTENCY,
      },
      required: ["toChain", "amount", "idempotencyKey"],
    },
  },
  {
    name: "transfer",
    description:
      "Move USDC between YOUR OWN wallets across chains, AUTO-PICKING the rail: CCTP when both " +
      "legs are EVM and the destination holds mint-gas, else deBridge (and for any Solana leg). " +
      "Executes the source leg(s) and returns a flightId; poll advance_bridge until delivered. " +
      "The recipient is your own address on the destination chain — never an argument.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fromChain: CHAIN_ENUM,
        toChain: CHAIN_ENUM,
        amount: { ...STR, description: "Decimal USDC to move." },
        provider: { ...PROVIDER_ENUM, description: "Omit to auto-pick the rail (recommended)." },
        lane: { ...LANE_ENUM, description: "CCTP finality lane; default standard." },
        ...IDEMPOTENCY,
      },
      required: ["fromChain", "toChain", "amount", "idempotencyKey"],
    },
  },
  {
    name: "advance_bridge",
    description:
      "Drive a transfer/bridge to completion: poll the flight and, for CCTP, broadcast the mint " +
      "(receiveMessage) once Iris attests. deBridge needs no action (the solver delivers). Call " +
      "repeatedly until delivered=true. Reads + acts; idempotent (re-minting is a no-op).",
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: PROVIDER_ENUM,
        flightId: { ...STR, description: "From the transfer result (CCTP id / deBridge orderId)." },
      },
      required: ["provider", "flightId"],
    },
  },
  {
    name: "hl_account",
    description:
      "Read-only: the full Hyperliquid account — perp clearinghouse state (positions, margin, " +
      "withdrawable), spot token balances, open orders (with oid/cloid for cancels), and the staking " +
      "summary + per-validator delegations. No build, no idempotency key.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "hl_order",
    description:
      "Place an advanced Hyperliquid order (PERP via hl:<COIN> or SPOT via hlspot:<TOKEN>). Beyond " +
      "open_position's IOC: tif Gtc (rests on the book) / Alo (post-only) / Ioc, reduceOnly, an " +
      "optional trigger (stop-loss / take-profit), and a client order id (cloid) for later cancel. " +
      "Requires worstPrice (the limit; for a trigger it's the limit AFTER the trigger fires). Bounded " +
      "by the same risk caps as open_position. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { ...STR, description: 'Perp "hl:BTC" or spot "hlspot:HYPE" / "hlspot:@107".' },
        side: SIDE_ENUM,
        amount: { ...STR, description: "Decimal string." },
        amountKind: AMOUNTKIND_ENUM,
        worstPrice: { ...STR, description: "REQUIRED limit price per unit (no market orders)." },
        tif: { type: "string" as const, enum: ["Ioc", "Gtc", "Alo"], description: "Default Gtc (rests). Ioc=marketable-or-cancel; Alo=post-only." },
        reduceOnly: { ...BOOL, description: "Only reduce an existing perp position (never flip)." },
        trigger: {
          type: "object" as const,
          description: "Conditional order. Omit for a plain limit.",
          properties: {
            triggerPx: { ...STR, description: "Price that arms the order." },
            tpsl: { type: "string" as const, enum: ["tp", "sl"], description: "take-profit or stop-loss." },
            isMarket: { ...BOOL, description: "Fire as market (default true) vs limit at worstPrice." },
          },
          required: ["triggerPx", "tpsl"],
        },
        cloid: { ...STR, description: 'Optional client order id "0x"+32 hex, for cancel-by-cloid.' },
        ...IDEMPOTENCY,
      },
      required: ["marketId", "side", "amount", "amountKind", "worstPrice", "idempotencyKey"],
    },
  },
  {
    name: "hl_cancel",
    description:
      "Cancel resting Hyperliquid order(s) on a market: by oid, by cloid, or all:true (every open " +
      "order on that market). Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: STR,
        oid: { ...NUM, description: "Cancel this exchange order id." },
        cloid: { ...STR, description: "Cancel by client order id." },
        all: { ...BOOL, description: "Cancel ALL open orders on this market." },
        ...IDEMPOTENCY,
      },
      required: ["marketId", "idempotencyKey"],
    },
  },
  {
    name: "hl_update_leverage",
    description:
      "Set the leverage for a Hyperliquid PERP, cross or isolated. Affects new positions' margin. " +
      "Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { ...STR, description: 'Perp market, e.g. "hl:BTC".' },
        leverage: { ...NUM, description: "Integer leverage, e.g. 5." },
        cross: { ...BOOL, description: "true = cross margin, false = isolated. Default cross." },
        ...IDEMPOTENCY,
      },
      required: ["marketId", "leverage", "idempotencyKey"],
    },
  },
  {
    name: "hl_update_isolated_margin",
    description:
      "Add or remove isolated margin on a Hyperliquid PERP position. usdDelta positive adds margin, " +
      "negative removes it. The position must be in isolated mode. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: STR,
        usdDelta: { ...STR, description: "Decimal USD; positive adds, negative removes margin." },
        ...IDEMPOTENCY,
      },
      required: ["marketId", "usdDelta", "idempotencyKey"],
    },
  },
  {
    name: "hl_usd_class_transfer",
    description:
      "Move USDC between the Hyperliquid PERP and SPOT sub-accounts (free, instant, internal). " +
      "toPerp=true moves spot->perp; false moves perp->spot. No external recipient. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        amount: { ...STR, description: "Decimal USDC to move." },
        toPerp: { ...BOOL, description: "true = spot->perp; false = perp->spot." },
        ...IDEMPOTENCY,
      },
      required: ["amount", "toPerp", "idempotencyKey"],
    },
  },
  {
    name: "hl_vault_transfer",
    description:
      "Deposit into or withdraw from a Hyperliquid vault (e.g. HLP for market-making yield). Funds " +
      "stay yours (redeemable to your own account); deposits have a lockup (HLP ~4 days). vaultAddress " +
      "is the vault to join. Idempotent. NOTE: depositing to an unknown vault is a trading risk — " +
      "verify the address (HLP is the official liquidity vault).",
    inputSchema: {
      type: "object" as const,
      properties: {
        vaultAddress: { ...STR, description: "The vault's address (0x...). HLP = the official liquidity vault." },
        isDeposit: { ...BOOL, description: "true = deposit, false = withdraw." },
        usd: { ...STR, description: "Decimal USD to deposit/withdraw." },
        ...IDEMPOTENCY,
      },
      required: ["vaultAddress", "isDeposit", "usd", "idempotencyKey"],
    },
  },
  {
    name: "hl_stake",
    description:
      "Move HYPE between your Hyperliquid SPOT balance and your STAKING balance. direction=deposit " +
      "stakes (spot->staking); withdraw unstakes (staking->spot, enters a ~7-day unbonding queue). " +
      "Delegate staked HYPE to a validator with hl_delegate to earn rewards. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        direction: { type: "string" as const, enum: ["deposit", "withdraw"], description: "deposit=stake, withdraw=unstake." },
        hype: { ...STR, description: "Decimal HYPE amount." },
        ...IDEMPOTENCY,
      },
      required: ["direction", "hype", "idempotencyKey"],
    },
  },
  {
    name: "hl_delegate",
    description:
      "Delegate (or undelegate) staked HYPE to a Hyperliquid validator to earn staking rewards. " +
      "Requires HYPE already in the staking balance (hl_stake direction=deposit first). undelegate=true " +
      "removes the delegation (1-day lockup after delegating). Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        validator: { ...STR, description: "Validator address (0x..., 42 chars)." },
        hype: { ...STR, description: "Decimal HYPE to delegate/undelegate." },
        undelegate: { ...BOOL, description: "true = undelegate, false = delegate. Default false." },
        ...IDEMPOTENCY,
      },
      required: ["validator", "hype", "idempotencyKey"],
    },
  },
  {
    name: "hl_twap",
    description:
      "Place or cancel a Hyperliquid TWAP order (slices a large size over `minutes` to reduce impact). " +
      "action=place needs marketId/side/size/minutes; action=cancel needs marketId/twapId. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string" as const, enum: ["place", "cancel"], description: "place a TWAP or cancel a running one." },
        marketId: STR,
        side: { ...SIDE_ENUM, description: "place only." },
        size: { ...STR, description: "place only: base-asset size (shares) to work over the window." },
        minutes: { ...NUM, description: "place only: minutes to spread the order over." },
        reduceOnly: { ...BOOL, description: "place only: only reduce an existing position." },
        randomize: { ...BOOL, description: "place only: randomize slice timing." },
        twapId: { ...NUM, description: "cancel only: the TWAP id to cancel." },
        ...IDEMPOTENCY,
      },
      required: ["action", "marketId", "idempotencyKey"],
    },
  },
  {
    name: "jup_limit_create",
    description:
      "Create a Jupiter LIMIT order (Trigger API) on Solana: sell makingAmount of inputMint for at " +
      "least takingAmount of outputMint (limit price = takingAmount / makingAmount). Amounts are " +
      "decimal UI units. Signs locally + lands via Jupiter. Returns the order account (use it to cancel). " +
      "Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        inputMint: { ...STR, description: "Mint of the token being sold (SPL base58)." },
        outputMint: { ...STR, description: "Mint of the token being bought." },
        makingAmount: { ...STR, description: "Decimal amount of inputMint to sell." },
        takingAmount: { ...STR, description: "Decimal amount of outputMint wanted (sets the limit price)." },
        slippageBps: { ...NUM, description: "Optional slippage cap in bps." },
        expiredAt: { ...NUM, description: "Optional expiry, unix seconds." },
        ...IDEMPOTENCY,
      },
      required: ["inputMint", "outputMint", "makingAmount", "takingAmount", "idempotencyKey"],
    },
  },
  {
    name: "jup_limit_cancel",
    description: "Cancel a Jupiter limit (Trigger) order by its order account address. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        order: { ...STR, description: "The order account (from jup_limit_create / jup_limit_list)." },
        ...IDEMPOTENCY,
      },
      required: ["order", "idempotencyKey"],
    },
  },
  {
    name: "jup_limit_list",
    description: "Read-only: a user's Jupiter limit (Trigger) orders. No idempotency key.",
    inputSchema: {
      type: "object" as const,
      properties: { status: { type: "string" as const, enum: ["active", "history"], description: "Default active." } },
    },
  },
  {
    name: "jup_recurring_create",
    description:
      "Create a Jupiter RECURRING (DCA) order on Solana: buy outputMint with inAmount of inputMint " +
      "split across numberOfOrders cycles, `interval` seconds apart (time-based). Optional min/max price " +
      "guardrails. Amounts are decimal UI units. Signs locally + lands via Jupiter. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        inputMint: STR,
        outputMint: STR,
        inAmount: { ...STR, description: "Decimal TOTAL input across all cycles." },
        numberOfOrders: { ...NUM, description: "Number of cycles." },
        interval: { ...NUM, description: "Seconds between cycles (e.g. 86400 = daily)." },
        minPrice: { ...NUM, description: "Optional min price guardrail." },
        maxPrice: { ...NUM, description: "Optional max price guardrail." },
        startAt: { ...NUM, description: "Optional unix-seconds start; omit for immediate." },
        ...IDEMPOTENCY,
      },
      required: ["inputMint", "outputMint", "inAmount", "numberOfOrders", "interval", "idempotencyKey"],
    },
  },
  {
    name: "jup_recurring_cancel",
    description: "Cancel a Jupiter recurring (DCA) order by its order account address. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        order: { ...STR, description: "The order account (from jup_recurring_list)." },
        ...IDEMPOTENCY,
      },
      required: ["order", "idempotencyKey"],
    },
  },
  {
    name: "jup_recurring_list",
    description: "Read-only: a user's Jupiter recurring (DCA) orders. No idempotency key.",
    inputSchema: {
      type: "object" as const,
      properties: { status: { type: "string" as const, enum: ["active", "history"], description: "Default active." } },
    },
  },
  {
    name: "jup_lend_deposit",
    description:
      "Deposit into Jupiter Lend EARN to earn yield. amount is a decimal UI amount of `asset` (SPL mint). " +
      "Funds stay yours (withdraw anytime). Signs locally + broadcasts. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        asset: { ...STR, description: "Asset mint to deposit (e.g. USDC mint)." },
        amount: { ...STR, description: "Decimal UI amount." },
        ...IDEMPOTENCY,
      },
      required: ["asset", "amount", "idempotencyKey"],
    },
  },
  {
    name: "jup_lend_withdraw",
    description: "Withdraw from Jupiter Lend EARN. amount is a decimal UI amount of `asset`. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        asset: STR,
        amount: { ...STR, description: "Decimal UI amount." },
        ...IDEMPOTENCY,
      },
      required: ["asset", "amount", "idempotencyKey"],
    },
  },
  {
    name: "jup_lend_borrow",
    description:
      "ADVANCED: Jupiter Lend BORROW one-shot `operate`. colAmount/debtAmount are SIGNED RAW-unit strings " +
      "(+col supply collateral / -col withdraw; +debt borrow / -debt repay). positionId 0 opens a new " +
      "position. Read jup_lend_markets first for vaultId + token decimals. Creates DEBT — manage liquidation " +
      "risk. Idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        vaultId: { ...NUM, description: "The borrow vault id (from jup_lend_markets)." },
        positionId: { ...NUM, description: "Borrow position id; 0 = open a new one (default)." },
        colAmount: { ...STR, description: "Signed RAW collateral units (+supply / -withdraw). '0' for none." },
        debtAmount: { ...STR, description: "Signed RAW debt units (+borrow / -repay). '0' for none." },
        ...IDEMPOTENCY,
      },
      required: ["vaultId", "colAmount", "debtAmount", "idempotencyKey"],
    },
  },
  {
    name: "jup_lend_markets",
    description: "Read-only: Jupiter Lend markets — EARN tokens (with APY) + BORROW vaults (with rates/LTV). No idempotency key.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "jup_lend_positions",
    description: "Read-only: a user's Jupiter Lend positions — EARN balances + BORROW positions. No idempotency key.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

/** Tool names this registry owns — used by server.ts to route the switch. */
export const MONEY_TOOL_NAMES: ReadonlySet<string> = new Set(MONEY_TOOLS.map((t) => t.name));

// ── arg parsing (the real validation gate) ───────────────────────────────────

type Args = Record<string, unknown>;

function reqStr(a: Args, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new ArgError(`"${k}" is required and must be a non-empty string`);
  }
  return v;
}

function optStr(a: Args, k: string): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ArgError(`"${k}" must be a string`);
  return v;
}

function optNum(a: Args, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ArgError(`"${k}" must be a finite number`);
  return v;
}

function optBool(a: Args, k: string): boolean | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ArgError(`"${k}" must be a boolean`);
  return v;
}

function reqNum(a: Args, k: string): number {
  const v = a[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ArgError(`"${k}" is required and must be a finite number`);
  return v;
}

function reqBool(a: Args, k: string): boolean {
  const v = a[k];
  if (typeof v !== "boolean") throw new ArgError(`"${k}" is required and must be a boolean`);
  return v;
}

function reqEnum<T extends string>(a: Args, k: string, allowed: readonly T[]): T {
  const v = reqStr(a, k);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ArgError(`"${k}" must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function optEnum<T extends string>(a: Args, k: string, allowed: readonly T[]): T | undefined {
  const v = optStr(a, k);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ArgError(`"${k}" must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

class ArgError extends Error {}

const VENUES = ["polymarket", "hyperliquid", "jupiter"] as const;
const SIDES = ["buy", "sell"] as const;
const AMOUNT_KINDS = ["collateral", "shares"] as const;
const CHAINS = ["polygon", "hyperliquid", "solana"] as const;
const PROVIDERS = ["cctp", "debridge"] as const;
const LANES = ["fast", "standard"] as const;

// ── adapter / bridge resolution ──────────────────────────────────────────────

function getAdapter(deps: ToolDeps, venue: Venue): VenueAdapter {
  const a = deps.adapters[venue];
  if (!a) throw new ResolveError("unknown_venue", `venue "${venue}" is not enabled this run`);
  return a;
}

function getBridge(deps: ToolDeps, provider: BridgeProvider): Bridge {
  const b = deps.bridges[provider];
  if (!b) throw new ResolveError("unknown_bridge", `bridge "${provider}" is not enabled this run`);
  return b;
}

class ResolveError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
  }
}

// ── idempotency wrapper ──────────────────────────────────────────────────────
// The single chokepoint every money-moving build flows through. upsert() FIRST:
// if the key was used, return the ORIGINAL record (and its build) and DO NOT
// rebuild. Otherwise call `build()` exactly once, persist the artifact, and
// return it. This is what stops a replayed key from minting a second order.

async function throughIntent(
  deps: ToolDeps,
  args: {
    idempotencyKey: string;
    kind: IntentRecord["kind"];
    intendedSize?: string;
  },
  build: () => Promise<BuildResult>,
): Promise<{ replayed: boolean; record: IntentRecord; build?: BuildResult }> {
  const { created, record } = await deps.store.upsert({
    botId: deps.botId,
    idempotencyKey: args.idempotencyKey,
    kind: args.kind,
    intendedSize: args.intendedSize,
  });

  if (!created) {
    // Replay: hand back exactly what we built the first time. Never rebuild.
    return { replayed: true, record, build: record.build };
  }

  // First time for this key: build once, persist, return.
  const artifact = await build();
  const patched = await deps.store.patch(deps.botId, args.idempotencyKey, {
    build: artifact,
    state: "BUILT",
  });
  return { replayed: false, record: patched, build: artifact };
}

/**
 * Same chokepoint for bridge / withdraw / setup builds that return
 * UnsignedBridgeTx[] (or a richer plan) rather than a BuildResult. We cannot
 * stuff those into IntentRecord.build (typed BuildResult), so we persist a
 * lightweight binding marker + carry the artifact in the response. Replays
 * return {replayed:true} so the caller knows to re-fetch the prior artifact via
 * the venue/provider feed rather than re-signing a fresh one.
 */
async function reserveIntent(
  deps: ToolDeps,
  idempotencyKey: string,
  kind: IntentRecord["kind"],
): Promise<{ replayed: boolean; record: IntentRecord }> {
  const { created, record } = await deps.store.upsert({
    botId: deps.botId,
    idempotencyKey,
    kind,
  });
  return { replayed: !created, record };
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleGetQuote(deps: ToolDeps, a: Args): Promise<ToolText> {
  const venue = reqEnum(a, "venue", VENUES);
  const marketId = reqStr(a, "marketId");
  const side = optEnum(a, "side", SIDES);
  const adapter = getAdapter(deps, venue);

  const resolved = await adapter.resolveMarket(marketId);
  if (!resolved.ok) {
    return fail("not_found", `could not resolve market "${marketId}" on ${venue}`, { meta: resolved.meta });
  }
  // Current normalized state doubles as the price/metadata read for the caller
  // to derive worstPrice. (Adapters expose price inside meta + state.)
  const state = await adapter.state(marketId);
  return ok({
    ok: true,
    venue,
    marketId,
    side: side ?? null,
    meta: resolved.meta,
    position: state,
  });
}

async function handleOpenPosition(deps: ToolDeps, a: Args): Promise<ToolText> {
  const venue = reqEnum(a, "venue", VENUES);
  if (!deps.signerLoaded(venue)) {
    return fail("signer_missing", `no local signer loaded for ${venue}; see auth_check`);
  }
  const intent: OpenIntent = {
    venue,
    marketId: reqStr(a, "marketId"),
    side: reqEnum(a, "side", SIDES) as Side,
    amount: reqStr(a, "amount"),
    amountKind: reqEnum(a, "amountKind", AMOUNT_KINDS) as AmountKind,
    worstPrice: reqStr(a, "worstPrice"),
    slippageFrac: optNum(a, "slippageFrac"),
    edgeBps: optNum(a, "edgeBps"),
    idempotencyKey: reqStr(a, "idempotencyKey"),
  };
  const adapter = getAdapter(deps, venue);

  // POLICY GATE (the layer above the signer): the USER-SET caps decide before any
  // build. notional = collateral USD for a BUY, else shares * worstPrice.
  const notionalUsd = openNotionalUsd(intent.amount, intent.amountKind, intent.worstPrice);
  const decision = checkOpen(notionalUsd, deps.limits(), deps.dailyUsage());
  if (!decision.allowed) {
    return fail("risk_blocked", decision.message, { policyCode: decision.code, notionalUsd });
  }

  const res = await throughIntent(
    deps,
    { idempotencyKey: intent.idempotencyKey, kind: "open", intendedSize: intent.amount },
    () => adapter.buildOpen(intent),
  );
  // Count it toward the daily cap only on a fresh build (replays already counted).
  if (!res.replayed) deps.recordOpen(notionalUsd);

  // Settle the build so the trade EXECUTES through the tool. Off-chain order books
  // (PM CLOB / HL exchange) expose submit() and we POST the locally-signed order;
  // on-chain venues (Jupiter = a Solana tx) have no submit(), so we sign + broadcast
  // + confirm via the Executor (blockhash refreshed).
  let submit: SubmitResult | undefined;
  let exec: ExecResult | undefined;
  if (!res.replayed && res.build) {
    if (adapter.submit) {
      submit = await adapter.submit(res.build);
      await deps.store.patch(deps.botId, intent.idempotencyKey, {
        state: submit.posted ? "FILLED" : "FAILED",
        txHashes: submit.txHashes ?? [],
        error: submit.posted ? undefined : { code: "no_liquidity", message: submit.error ?? "order rejected", recoverable: true, suggestedAction: "re-quote and retry with the same idempotencyKey" },
      });
    } else if (res.build.kind === "solanaTx") {
      exec = await deps.executor.exec({ chain: "solana", kind: "solanaTx", payload: res.build.unsignedTxB64, label: "open" });
      await deps.store.patch(deps.botId, intent.idempotencyKey, {
        state: exec.ok ? "FILLED" : "FAILED",
        txHashes: exec.txHash ? [exec.txHash] : [],
        error: exec.ok ? undefined : { code: "no_liquidity", message: exec.error ?? "swap did not confirm", recoverable: true, suggestedAction: "re-quote and retry with a NEW idempotencyKey" },
      });
    }
  }

  const filled = submit ? submit.posted : exec ? exec.ok : undefined;
  return ok({
    ok: filled ?? true,
    replayed: res.replayed,
    state: filled === undefined ? res.record.state : filled ? "FILLED" : "FAILED",
    notionalUsd,
    intent: { venue, marketId: intent.marketId, side: intent.side, amount: intent.amount },
    submit,
    exec,
    build: res.build,
    note: res.replayed
      ? "idempotencyKey already used — returning the ORIGINAL result, not a new order."
      : submit
        ? submit.posted
          ? "Order POSTed to the venue (locally signed, bounded by worstPrice + caps)."
          : `Order rejected: ${submit.error}`
        : exec
          ? exec.ok
            ? "Swap signed + broadcast + confirmed on-chain (bounded by worstPrice + caps)."
            : `Swap failed: ${exec.error}`
          : "UNSIGNED build. Sign with the local key, then broadcast.",
  });
}

async function handleClosePosition(deps: ToolDeps, a: Args): Promise<ToolText> {
  const venue = reqEnum(a, "venue", VENUES);
  if (!deps.signerLoaded(venue)) {
    return fail("signer_missing", `no local signer loaded for ${venue}; see auth_check`);
  }
  const intent: CloseIntent = {
    venue,
    marketId: reqStr(a, "marketId"),
    fraction: reqStr(a, "fraction"),
    worstPrice: reqStr(a, "worstPrice"),
    slippageFrac: optNum(a, "slippageFrac"),
    idempotencyKey: reqStr(a, "idempotencyKey"),
  };
  const adapter = getAdapter(deps, venue);

  // Resolved markets are closed via redeem, not a CLOB close — surface it
  // rather than letting the adapter throw a cryptic error.
  const state = await adapter.state(intent.marketId);
  if (state?.resolved) {
    return fail("not_found", `market "${intent.marketId}" has resolved — route to redeem, not close`, {
      resolved: true,
      position: state,
    });
  }

  const res = await throughIntent(
    deps,
    { idempotencyKey: intent.idempotencyKey, kind: "close", intendedSize: intent.fraction },
    () => adapter.buildClose(intent),
  );

  // Settle the close so it EXECUTES through the tool (mirrors open_position): POST
  // the locally-signed close for off-chain venues (PM/HL), or sign+broadcast+confirm
  // the on-chain close swap (Jupiter = a Solana tx) via the Executor. Without this a
  // tool-driven close would build a signed artifact and never settle it.
  let submit: SubmitResult | undefined;
  let exec: ExecResult | undefined;
  if (!res.replayed && res.build) {
    if (adapter.submit) {
      submit = await adapter.submit(res.build);
      await deps.store.patch(deps.botId, intent.idempotencyKey, {
        state: submit.posted ? "FILLED" : "FAILED",
        txHashes: submit.txHashes ?? [],
        error: submit.posted
          ? undefined
          : { code: "no_liquidity", message: submit.error ?? "close order rejected", recoverable: true, suggestedAction: "re-quote and retry with the same idempotencyKey" },
      });
    } else if (res.build.kind === "solanaTx") {
      exec = await deps.executor.exec({ chain: "solana", kind: "solanaTx", payload: res.build.unsignedTxB64, label: "close" });
      await deps.store.patch(deps.botId, intent.idempotencyKey, {
        state: exec.ok ? "FILLED" : "FAILED",
        txHashes: exec.txHash ? [exec.txHash] : [],
        error: exec.ok ? undefined : { code: "no_liquidity", message: exec.error ?? "close swap did not confirm", recoverable: true, suggestedAction: "re-quote and retry with a NEW idempotencyKey" },
      });
    }
  }

  const closed = submit ? submit.posted : exec ? exec.ok : undefined;
  return ok({
    ok: closed ?? true,
    replayed: res.replayed,
    state: closed === undefined ? res.record.state : closed ? "FILLED" : "FAILED",
    intent: { venue, marketId: intent.marketId, fraction: intent.fraction },
    submit,
    exec,
    build: res.build,
    note: res.replayed
      ? "idempotencyKey already used — returning the ORIGINAL result, not a new close."
      : submit
        ? submit.posted
          ? "Close POSTed to the venue (locally signed, bounded by worstPrice)."
          : `Close rejected: ${submit.error}`
        : exec
          ? exec.ok
            ? "Close swap signed + broadcast + confirmed on-chain."
            : `Close swap failed: ${exec.error}`
          : "UNSIGNED close build. Sign with the local key, reconcile, then broadcast.",
  });
}

async function handleListPositions(deps: ToolDeps, a: Args): Promise<ToolText> {
  const one = optEnum(a, "venue", VENUES);
  const filter = Array.isArray(a.marketIds)
    ? (a.marketIds as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  const venues: Venue[] = one ? [one] : (Object.keys(deps.adapters) as Venue[]);
  const positions: PositionState[] = [];
  const errors: { venue: Venue; error: string }[] = [];

  for (const v of venues) {
    const adapter = deps.adapters[v];
    if (!adapter) continue;
    try {
      const ids = filter ?? [];
      if (ids.length === 0) {
        // No filter: the adapter's state() is per-market, so without ids we can
        // only report what we know. Callers pass marketIds for a precise read.
        continue;
      }
      for (const id of ids) {
        const st = await adapter.state(id);
        if (st) positions.push(st);
      }
    } catch (e) {
      errors.push({ venue: v, error: (e as Error).message });
    }
  }

  return ok({
    ok: true,
    venues,
    positions,
    ...(filter ? {} : { note: "Pass marketIds to read specific positions." }),
    ...(errors.length ? { errors } : {}),
  });
}

async function handleBuildWithdraw(deps: ToolDeps, a: Args): Promise<ToolText> {
  const chain = reqEnum(a, "chain", CHAINS) as Chain;
  const amount = reqStr(a, "amount");
  const idempotencyKey = reqStr(a, "idempotencyKey");

  // The signer for the chain must be loaded (polygon/hyperliquid share the EVM
  // venue mapping; solana its own). Map chain -> the venue whose signer guards it.
  const guardVenue: Venue = chain === "solana" ? "jupiter" : chain === "hyperliquid" ? "hyperliquid" : "polymarket";
  if (!deps.signerLoaded(guardVenue)) {
    return fail("signer_missing", `no local signer loaded for chain ${chain}; see auth_check`);
  }

  // Hyperliquid has a NATIVE off-ramp: a user-signed withdraw3 that HL releases
  // ONLY to the account owner's own address (recipient pinned by HL — not the
  // sealed treasury, not an argument). So it does NOT route through the
  // treasury-sweep path below; we EXECUTE it via the adapter (it POSTs to
  // /exchange like an order). $1 flat HL fee, ~5 min to land. Reserve the intent
  // FIRST so a replayed key can never post twice.
  if (chain === "hyperliquid") {
    const adapter = getAdapter(deps, "hyperliquid");
    if (!adapter.withdraw) return fail("internal", "hyperliquid adapter exposes no withdraw()");

    const { replayed } = await reserveIntent(deps, idempotencyKey, "withdraw");
    if (replayed) {
      return ok({
        ok: true,
        replayed: true,
        chain,
        note:
          "idempotencyKey already used — the HL withdraw was already submitted and is NOT re-posted on " +
          "replay (no double-withdraw). Check your Arbitrum balance; use a NEW key to withdraw again.",
      });
    }
    const res = await adapter.withdraw(amount);
    await deps.store.patch(deps.botId, idempotencyKey, { state: res.posted ? "FILLED" : "FAILED" });
    return ok({
      ok: res.posted,
      replayed: false,
      chain,
      amount,
      submit: res,
      note: res.posted
        ? "HL withdraw3 accepted — USDC lands at your OWN address on Arbitrum in ~5 min (HL deducts a $1 " +
          "flat fee). The recipient is pinned by HL to the account owner, not an argument."
        : `HL rejected the withdraw: ${res.error ?? "unknown"}. Verify funds, then retry with a NEW idempotencyKey.`,
    });
  }

  let resolved: ResolvedWithdraw;
  try {
    const treasury = await deps.treasury();
    // resolveWithdrawRecipient takes NO agent recipient — it reads the pinned
    // treasury (keystore-sealed or dashboard-set) for the chain or throws.
    resolved = resolveWithdrawRecipient(treasury, { chain, amount });
  } catch (e) {
    if (e instanceof WithdrawError) {
      return fail("treasury_refused", e.message, { withdrawCode: e.code });
    }
    throw e;
  }

  // Reserve the intent so a replayed key can't build a second sweep.
  const { replayed } = await reserveIntent(deps, idempotencyKey, "withdraw");

  return ok({
    ok: true,
    replayed,
    kind: "withdraw",
    chain,
    // Echo the resolved destination so a caller/test can re-assert it equals the
    // sealed treasury (validate_intent does this independently before signing).
    recipient: resolved.recipient,
    amount: resolved.amount,
    note: replayed
      ? "idempotencyKey already used — withdraw intent already reserved."
      : "Withdraw resolved to the SEALED TREASURY (no agent recipient accepted). " +
        "Hand to the chain-specific build (HL withdraw3 / CCTP-out / SPL transfer) for signing.",
  });
}

function pickBridgeProvider(token: string, explicit?: BridgeProvider): BridgeProvider {
  if (explicit) return explicit;
  // CCTP is USDC-only and primary; everything else routes deBridge.
  return token.toUpperCase() === "USDC" ? "cctp" : "debridge";
}

async function handleBridgeQuote(deps: ToolDeps, a: Args): Promise<ToolText> {
  const token = reqStr(a, "token");
  const provider = pickBridgeProvider(token, optEnum(a, "provider", PROVIDERS));
  const route: BridgeRoute = {
    fromChain: reqEnum(a, "fromChain", CHAINS) as Chain,
    toChain: reqEnum(a, "toChain", CHAINS) as Chain,
    token,
    amount: reqStr(a, "amount"),
    // quote needs a recipient on the route type but it is informational here;
    // the real build pins it from treasury/allowlist. Use a zero placeholder.
    recipient: "",
    lane: optEnum(a, "lane", LANES) as CctpLane | undefined,
  };
  const bridge = getBridge(deps, provider);
  const quote: BridgeQuote = await bridge.quote(route);
  return ok({ ok: true, provider, route: { ...route, recipient: undefined }, quote });
}

async function handleBuildBridge(deps: ToolDeps, a: Args): Promise<ToolText> {
  const token = reqStr(a, "token");
  const provider = pickBridgeProvider(token, reqEnum(a, "provider", PROVIDERS));
  const direction = optEnum(a, "direction", ["in", "out"] as const) ?? "in";
  const idempotencyKey = reqStr(a, "idempotencyKey");

  const fromChain = reqEnum(a, "fromChain", CHAINS) as Chain;
  const toChain = reqEnum(a, "toChain", CHAINS) as Chain;

  // Recipient is pinned by the MCP, NEVER from an agent argument. The source a
  // chain may use depends on DIRECTION:
  //  - "out" (withdraw): keystore-sealed OR human-pasted dashboard pin (canWithdraw).
  //  - "in"  (funding):  KEYSTORE-SEALED ONLY. A dashboard-pinned address is for
  //    sweeps-OUT; it must never become the recipient for INBOUND funds (that would
  //    silently widen a "where my money goes home" pin into "where trading capital
  //    lands"). A per-chain keystore/dashboard disagreement ("conflict") refuses.
  let recipient: string;
  try {
    const treasury = await deps.treasury();
    const src = chainSource(treasury, toChain);
    const t = treasury.byChain[toChain];
    if (src === "conflict") {
      return fail("treasury_refused", `destination conflict for ${toChain}: keystore and dashboard pin disagree — resolve before bridging`, {
        withdrawCode: "treasury_conflict",
      });
    }
    if (direction === "in" && src !== "keystore") {
      return fail("treasury_refused", `funding-in recipient for ${toChain} must be keystore-sealed (a dashboard-pinned address is withdraw-only)`, {
        withdrawCode: src === "none" ? "treasury_not_sealed" : "no_treasury_for_chain",
      });
    }
    if (direction === "out" && !canWithdraw(src)) {
      return fail("treasury_refused", `no withdraw destination for ${toChain} — pin one in the dashboard or seal one at setup`, {
        withdrawCode: "treasury_not_sealed",
      });
    }
    if (!t) {
      return fail("treasury_refused", `no recipient for ${toChain}`, {
        withdrawCode: "no_treasury_for_chain",
      });
    }
    recipient = t;
  } catch (e) {
    if (e instanceof WithdrawError) return fail("treasury_refused", e.message, { withdrawCode: e.code });
    throw e;
  }

  const route: BridgeRoute = {
    fromChain,
    toChain,
    token,
    amount: reqStr(a, "amount"),
    recipient,
    lane: optEnum(a, "lane", LANES) as CctpLane | undefined,
  };
  const bridge = getBridge(deps, provider);

  const { replayed } = await reserveIntent(deps, idempotencyKey, "bridge");
  const txs: UnsignedBridgeTx[] =
    direction === "out" ? await bridge.buildBridgeOut(route) : await bridge.buildBridgeIn(route);

  return ok({
    ok: true,
    replayed,
    provider,
    direction,
    recipient,
    // UNSIGNED legs (e.g. [approve, depositForBurn]); sign in order, never here.
    txs,
    note: replayed
      ? "idempotencyKey already used — bridge intent already reserved."
      : "UNSIGNED bridge legs. validate_intent re-decodes the recipient before signing.",
  });
}

async function handleGetBridgeStatus(deps: ToolDeps, a: Args): Promise<ToolText> {
  const provider = reqEnum(a, "provider", PROVIDERS);
  const flightId = reqStr(a, "flightId");
  const bridge = getBridge(deps, provider);
  const status: BridgeStatus = await bridge.status(flightId);
  return ok({ ok: true, provider, flightId, status });
}

async function handleEnsureGas(deps: ToolDeps, a: Args): Promise<ToolText> {
  const chain = reqEnum(a, "chain", CHAINS) as Chain;
  const idempotencyKey = reqStr(a, "idempotencyKey");

  const { replayed } = await reserveIntent(deps, idempotencyKey, "bridge");
  const top = await deps.gas.buildTopUp(chain);

  return ok({
    ok: true,
    replayed,
    chain,
    sufficient: top.sufficient,
    // Empty when already funded; otherwise UNSIGNED deBridge native-output legs.
    txs: top.txs,
    note:
      top.note ??
      (top.sufficient
        ? "Native gas already at/above the per-chain floor — nothing to sign."
        : "UNSIGNED native-gas top-up (deBridge native-output, paid from USDC). Sign in order."),
  });
}

async function handlePlanFundingRoute(deps: ToolDeps, a: Args): Promise<ToolText> {
  const fromChain = reqEnum(a, "fromChain", CHAINS) as Chain;
  const toChain = reqEnum(a, "toChain", CHAINS) as Chain;
  const usdcAmount = reqStr(a, "usdcAmount");
  const idempotencyKey = reqStr(a, "idempotencyKey");
  const lane = optEnum(a, "lane", LANES) as CctpLane | undefined;

  // Recipient pinned server-side, never an agent argument. Funding-IN lands trading
  // capital, so it must be KEYSTORE-SEALED — the human-pasted dashboard pin is
  // withdraw-only and is rejected here (and on a keystore/dashboard conflict).
  let recipient: string;
  try {
    const treasury = await deps.treasury();
    const src = chainSource(treasury, toChain);
    if (src !== "keystore") {
      return fail("treasury_refused", `funding-in recipient for ${toChain} must be keystore-sealed (a dashboard-pinned address is withdraw-only)`, {
        withdrawCode: src === "conflict" ? "treasury_conflict" : src === "none" ? "treasury_not_sealed" : "no_treasury_for_chain",
      });
    }
    const t = treasury.byChain[toChain];
    if (!t) {
      return fail("treasury_refused", `no sealed recipient for ${toChain}`, {
        withdrawCode: "no_treasury_for_chain",
      });
    }
    recipient = t;
  } catch (e) {
    if (e instanceof WithdrawError) return fail("treasury_refused", e.message, { withdrawCode: e.code });
    throw e;
  }

  const { replayed } = await reserveIntent(deps, idempotencyKey, "bridge");
  const plan: FundingPlan = await deps.funding.plan({ fromChain, toChain, usdcAmount, recipient, lane });

  return ok({
    ok: true,
    replayed,
    plan,
    note: replayed
      ? "idempotencyKey already used — funding plan intent already reserved."
      : "USDC (CCTP) + native-gas (deBridge) legs. Sign legs in order; CCTP cannot deliver gas.",
  });
}

async function handleEnableVenue(deps: ToolDeps, a: Args): Promise<ToolText> {
  const venue = reqEnum(a, "venue", VENUES);
  const idempotencyKey = reqStr(a, "idempotencyKey");
  if (!deps.signerLoaded(venue)) {
    return fail("signer_missing", `no local signer loaded for ${venue}; see auth_check`);
  }

  const { replayed } = await reserveIntent(deps, idempotencyKey, "cancel"); // setup uses the non-trade lane
  const res = await deps.enabler.enable(venue);

  return ok({
    ok: true,
    replayed,
    venue,
    alreadyEnabled: res.alreadyEnabled,
    blockers: res.blockers,
    // UNSIGNED approval/wrap/registry txs; empty when alreadyEnabled.
    txs: res.txs,
    note:
      res.note ??
      (res.alreadyEnabled
        ? `${venue} already enabled — nothing to sign.`
        : `UNSIGNED ${venue} enablement txs. Sign in order, then poll until blockers[] is empty.`),
  });
}

async function handlePmDepositAddress(deps: ToolDeps, _a: Args): Promise<ToolText> {
  if (!deps.signerLoaded("polymarket")) {
    return fail("signer_missing", "no polygon signer loaded for polymarket; see auth_check");
  }
  const info = await deps.pmBridge.depositAddresses();
  return ok({ ok: true, ...info });
}

async function handlePmWithdraw(deps: ToolDeps, a: Args): Promise<ToolText> {
  const toChain = reqEnum(a, "toChain", CHAINS) as Chain;
  const amount = reqStr(a, "amount");
  const idempotencyKey = reqStr(a, "idempotencyKey");
  if (!deps.signerLoaded("polymarket")) {
    return fail("signer_missing", "no polygon signer loaded for polymarket; see auth_check");
  }

  // Recipient is the SEALED TREASURY for toChain — NEVER an agent argument (same
  // chokepoint as build_withdraw). resolveWithdrawRecipient throws on conflict /
  // unset rather than ever returning an agent-supplied address.
  let recipient: string;
  try {
    const treasury = await deps.treasury();
    recipient = resolveWithdrawRecipient(treasury, { chain: toChain, amount }).recipient;
  } catch (e) {
    if (e instanceof WithdrawError) return fail("treasury_refused", e.message, { withdrawCode: e.code });
    throw e;
  }

  // Reserve the intent FIRST so a replayed key can NEVER re-submit the withdraw.
  const { replayed } = await reserveIntent(deps, idempotencyKey, "withdraw");
  if (replayed) {
    return ok({
      ok: true,
      replayed: true,
      toChain,
      note:
        "idempotencyKey already used — the pm_withdraw was already submitted and is NOT re-sent (no " +
        "double-withdraw). Check the destination balance; use a NEW key to withdraw again.",
    });
  }

  const res = await deps.pmBridge.withdraw({ amount, toChain, recipient });
  await deps.store.patch(deps.botId, idempotencyKey, {
    state: res.ok ? "FILLED" : "FAILED",
    txHashes: res.txHash ? [res.txHash] : [],
  });
  if (!res.ok) {
    return fail("internal", res.blockers.join("; ") || "pm_withdraw failed", { blockers: res.blockers, recipient, note: res.note });
  }
  return ok({ ok: true, replayed: false, toChain, amount, recipient, txHash: res.txHash, note: res.note });
}

async function handleHlBridgeOut(deps: ToolDeps, a: Args): Promise<ToolText> {
  const toChain = reqEnum(a, "toChain", ["polygon", "hyperliquid"] as const) as Chain;
  const amount = reqStr(a, "amount");
  const idempotencyKey = reqStr(a, "idempotencyKey");
  if (!deps.signerLoaded("hyperliquid")) {
    return fail("signer_missing", "no hyperliquid signer loaded; see auth_check");
  }
  if (!deps.hlExit) {
    return fail("internal", "the cheap HL exit is not wired this run (no hyperliquid signer at boot).");
  }

  // Recipient = the SEALED TREASURY for the destination chain — never an argument.
  let recipient: string;
  try {
    const treasury = await deps.treasury();
    recipient = resolveWithdrawRecipient(treasury, { chain: toChain, amount }).recipient;
  } catch (e) {
    if (e instanceof WithdrawError) return fail("treasury_refused", e.message, { withdrawCode: e.code });
    throw e;
  }

  // Reserve FIRST so a replayed key can NEVER re-run the multi-step exit.
  const { replayed } = await reserveIntent(deps, idempotencyKey, "withdraw");
  if (replayed) {
    return ok({
      ok: true,
      replayed: true,
      toChain,
      note:
        "idempotencyKey already used — the cheap exit was already started and is NOT re-run (no " +
        "double-spend). Inspect the destination/burn; use a NEW key to retry.",
    });
  }

  const dest = toChain === "polygon" ? "polygon" : "arbitrum"; // hyperliquid -> Arbitrum
  const res = await deps.hlExit.bridgeOut({ amount, dest, recipient });
  await deps.store.patch(deps.botId, idempotencyKey, {
    state: res.ok ? "FILLED" : "FAILED",
    txHashes: res.txHashes,
  });
  if (!res.ok) {
    return fail("internal", res.blockers.join("; ") || "hl_bridge_out failed", { blockers: res.blockers, txHashes: res.txHashes, burnTxHash: res.burnTxHash, recipient, note: res.note });
  }
  return ok({ ok: true, replayed: false, toChain, dest, amount, recipient, txHashes: res.txHashes, burnTxHash: res.burnTxHash, note: res.note });
}

async function handleTransfer(deps: ToolDeps, a: Args): Promise<ToolText> {
  const fromChain = reqEnum(a, "fromChain", CHAINS) as Chain;
  const toChain = reqEnum(a, "toChain", CHAINS) as Chain;
  const amount = reqStr(a, "amount");
  const provider = optEnum(a, "provider", PROVIDERS);
  const lane = optEnum(a, "lane", LANES) as CctpLane | undefined;
  const idempotencyKey = reqStr(a, "idempotencyKey");
  if (fromChain === toChain) throw new ArgError("fromChain and toChain must differ");

  // The SOURCE chain's signer must be loaded — it signs the burn / order.
  const guard: Venue = fromChain === "solana" ? "jupiter" : fromChain === "hyperliquid" ? "hyperliquid" : "polymarket";
  if (!deps.signerLoaded(guard)) {
    return fail("signer_missing", `no local signer loaded for source chain ${fromChain}; see auth_check`);
  }

  // Reserve FIRST so a replayed key can NEVER re-broadcast the source money move.
  const { replayed } = await reserveIntent(deps, idempotencyKey, "bridge");
  if (replayed) {
    return ok({
      ok: true,
      replayed: true,
      note:
        "idempotencyKey already used — the transfer source was already broadcast and is NOT re-sent. " +
        "Poll advance_bridge with the flightId from the original result, or use a NEW key.",
    });
  }
  const res = await runTransfer(deps, { fromChain, toChain, amount, provider, lane });
  return ok({ replayed: false, ...res });
}

async function handleAdvanceBridge(deps: ToolDeps, a: Args): Promise<ToolText> {
  const provider = reqEnum(a, "provider", PROVIDERS);
  const flightId = reqStr(a, "flightId");
  const res = await advanceBridge(deps, { provider, flightId });
  return ok(res);
}

// ── Hyperliquid full-surface handlers ────────────────────────────────────────
// Spot + advanced orders + leverage/margin + perp<->spot + vaults + staking + TWAP.
// Same invariants as the generic tools: signer-gated, idempotent (reserve FIRST so a
// replayed key never re-submits). These actions keep funds INSIDE the HL account, so
// none take a recipient. hl_order additionally runs the open_position risk caps.

const TIFS = ["Ioc", "Gtc", "Alo"] as const;
const TPSLS = ["tp", "sl"] as const;

function parseTrigger(a: Args): { triggerPx: string; isMarket: boolean; tpsl: "tp" | "sl" } | undefined {
  const t = a.trigger;
  if (t === undefined || t === null) return undefined;
  if (typeof t !== "object") throw new ArgError(`"trigger" must be an object {triggerPx, tpsl, isMarket?}`);
  const o = t as Args;
  return { triggerPx: reqStr(o, "triggerPx"), tpsl: reqEnum(o, "tpsl", TPSLS), isMarket: optBool(o, "isMarket") ?? true };
}

/** Shared chokepoint for the HL write tools: signer + wired check, reserve the
 *  intent (replay => NOT re-sent), execute, persist FILLED/FAILED. */
async function runHlVenue(
  deps: ToolDeps,
  idempotencyKey: string,
  kind: IntentRecord["kind"],
  label: string,
  exec: (v: HlVenueOps) => Promise<SubmitResult>,
): Promise<ToolText> {
  if (!deps.signerLoaded("hyperliquid")) return fail("signer_missing", "no hyperliquid signer loaded; see auth_check");
  if (!deps.hlVenue) return fail("internal", "the HL venue surface is not wired this run (no hyperliquid signer at boot).");
  const { replayed } = await reserveIntent(deps, idempotencyKey, kind);
  if (replayed) {
    return ok({ ok: true, replayed: true, note: `idempotencyKey already used — ${label} was already submitted and is NOT re-sent. Use a NEW key to repeat.` });
  }
  const res = await exec(deps.hlVenue);
  await deps.store.patch(deps.botId, idempotencyKey, { state: res.posted ? "FILLED" : "FAILED", txHashes: res.txHashes ?? [] });
  if (!res.posted) return fail("internal", res.error ?? `${label} rejected`, { submit: res });
  return ok({ ok: true, replayed: false, label, submit: res });
}

async function handleHlAccount(deps: ToolDeps): Promise<ToolText> {
  if (!deps.signerLoaded("hyperliquid")) return fail("signer_missing", "no hyperliquid signer loaded; see auth_check");
  if (!deps.hlVenue) return fail("internal", "the HL venue surface is not wired this run (no hyperliquid signer at boot).");
  const account = await deps.hlVenue.account();
  return ok({ ok: true, account });
}

async function handleHlOrder(deps: ToolDeps, a: Args): Promise<ToolText> {
  if (!deps.signerLoaded("hyperliquid")) return fail("signer_missing", "no hyperliquid signer loaded; see auth_check");
  if (!deps.hlVenue) return fail("internal", "the HL venue surface is not wired this run (no hyperliquid signer at boot).");
  const args = {
    marketId: reqStr(a, "marketId"),
    side: reqEnum(a, "side", SIDES) as Side,
    amount: reqStr(a, "amount"),
    amountKind: reqEnum(a, "amountKind", AMOUNT_KINDS) as AmountKind,
    worstPrice: reqStr(a, "worstPrice"),
    tif: optEnum(a, "tif", TIFS),
    reduceOnly: optBool(a, "reduceOnly"),
    trigger: parseTrigger(a),
    cloid: optStr(a, "cloid"),
  };
  const idempotencyKey = reqStr(a, "idempotencyKey");

  // Same policy gate as open_position — hl_order deploys market exposure.
  const notionalUsd = openNotionalUsd(args.amount, args.amountKind, args.worstPrice);
  const decision = checkOpen(notionalUsd, deps.limits(), deps.dailyUsage());
  if (!decision.allowed) return fail("risk_blocked", decision.message, { policyCode: decision.code, notionalUsd });

  const { replayed } = await reserveIntent(deps, idempotencyKey, "open");
  if (replayed) {
    return ok({ ok: true, replayed: true, note: "idempotencyKey already used — hl_order already submitted and is NOT re-sent. Use a NEW key." });
  }
  const res = await deps.hlVenue.order(args);
  await deps.store.patch(deps.botId, idempotencyKey, { state: res.posted ? "FILLED" : "FAILED", txHashes: res.txHashes ?? [] });
  if (!res.posted) return fail("internal", res.error ?? "hl_order rejected", { submit: res, notionalUsd });
  deps.recordOpen(notionalUsd);
  return ok({ ok: true, replayed: false, notionalUsd, submit: res, note: "HL order POSTed (locally signed, bounded by worstPrice + caps)." });
}

async function handleHlCancel(deps: ToolDeps, a: Args): Promise<ToolText> {
  const marketId = reqStr(a, "marketId");
  const oid = optNum(a, "oid");
  const cloid = optStr(a, "cloid");
  const all = optBool(a, "all");
  if (oid == null && !cloid && !all) throw new ArgError("hl_cancel needs one of: oid, cloid, or all:true");
  return runHlVenue(deps, reqStr(a, "idempotencyKey"), "cancel", "hl_cancel", (v) => v.cancel({ marketId, oid, cloid, all }));
}

async function handleHlUpdateLeverage(deps: ToolDeps, a: Args): Promise<ToolText> {
  const marketId = reqStr(a, "marketId");
  const leverage = reqNum(a, "leverage");
  const cross = optBool(a, "cross") ?? true;
  return runHlVenue(deps, reqStr(a, "idempotencyKey"), "open", "hl_update_leverage", (v) => v.updateLeverage({ marketId, leverage, cross }));
}

async function handleHlUpdateIsolatedMargin(deps: ToolDeps, a: Args): Promise<ToolText> {
  const marketId = reqStr(a, "marketId");
  const usdDelta = reqStr(a, "usdDelta");
  return runHlVenue(deps, reqStr(a, "idempotencyKey"), "open", "hl_update_isolated_margin", (v) => v.updateIsolatedMargin({ marketId, usdDelta }));
}

async function handleHlUsdClassTransfer(deps: ToolDeps, a: Args): Promise<ToolText> {
  const amount = reqStr(a, "amount");
  const toPerp = reqBool(a, "toPerp");
  return runHlVenue(deps, reqStr(a, "idempotencyKey"), "bridge", "hl_usd_class_transfer", (v) => v.usdClassTransfer({ amount, toPerp }));
}

async function handleHlVaultTransfer(deps: ToolDeps, a: Args): Promise<ToolText> {
  const vaultAddress = reqStr(a, "vaultAddress");
  const isDeposit = reqBool(a, "isDeposit");
  const usd = reqStr(a, "usd");
  return runHlVenue(deps, reqStr(a, "idempotencyKey"), "bridge", "hl_vault_transfer", (v) => v.vaultTransfer({ vaultAddress, isDeposit, usd }));
}

async function handleHlStake(deps: ToolDeps, a: Args): Promise<ToolText> {
  const direction = reqEnum(a, "direction", ["deposit", "withdraw"] as const);
  const hype = reqStr(a, "hype");
  return runHlVenue(deps, reqStr(a, "idempotencyKey"), "bridge", "hl_stake", (v) => v.stake({ direction, hype }));
}

async function handleHlDelegate(deps: ToolDeps, a: Args): Promise<ToolText> {
  const validator = reqStr(a, "validator");
  const hype = reqStr(a, "hype");
  const undelegate = optBool(a, "undelegate") ?? false;
  return runHlVenue(deps, reqStr(a, "idempotencyKey"), "bridge", "hl_delegate", (v) => v.delegate({ validator, hype, undelegate }));
}

async function handleHlTwap(deps: ToolDeps, a: Args): Promise<ToolText> {
  const action = reqEnum(a, "action", ["place", "cancel"] as const);
  const marketId = reqStr(a, "marketId");
  const idempotencyKey = reqStr(a, "idempotencyKey");
  if (action === "cancel") {
    const twapId = reqNum(a, "twapId");
    return runHlVenue(deps, idempotencyKey, "cancel", "hl_twap_cancel", (v) => v.twapCancel({ marketId, twapId }));
  }
  const side = reqEnum(a, "side", SIDES) as Side;
  const size = reqStr(a, "size");
  const minutes = reqNum(a, "minutes");
  const reduceOnly = optBool(a, "reduceOnly");
  const randomize = optBool(a, "randomize");
  return runHlVenue(deps, idempotencyKey, "open", "hl_twap_order", (v) => v.twapOrder({ marketId, side, size, minutes, reduceOnly, randomize }));
}

// ── Jupiter advanced-surface handlers (limit/trigger + recurring/DCA) ──────────
// Signer-gated (the Solana "jupiter" signer) + idempotent. Funds escrow to a user-
// cancellable order account, so none take a recipient.

async function runJupVenue(
  deps: ToolDeps,
  idempotencyKey: string,
  kind: IntentRecord["kind"],
  label: string,
  exec: (v: JupVenueOps) => Promise<SubmitResult>,
): Promise<ToolText> {
  if (!deps.signerLoaded("jupiter")) return fail("signer_missing", "no solana signer loaded for jupiter; see auth_check");
  if (!deps.jupVenue) return fail("internal", "the Jupiter venue surface is not wired this run (no solana signer at boot).");
  const { replayed } = await reserveIntent(deps, idempotencyKey, kind);
  if (replayed) {
    return ok({ ok: true, replayed: true, note: `idempotencyKey already used — ${label} was already submitted and is NOT re-sent. Use a NEW key.` });
  }
  const res = await exec(deps.jupVenue);
  await deps.store.patch(deps.botId, idempotencyKey, { state: res.posted ? "FILLED" : "FAILED", txHashes: res.txHashes ?? [] });
  if (!res.posted) return fail("internal", res.error ?? `${label} rejected`, { submit: res });
  return ok({ ok: true, replayed: false, label, submit: res });
}

async function handleJupLimitCreate(deps: ToolDeps, a: Args): Promise<ToolText> {
  const args = {
    inputMint: reqStr(a, "inputMint"),
    outputMint: reqStr(a, "outputMint"),
    makingAmount: reqStr(a, "makingAmount"),
    takingAmount: reqStr(a, "takingAmount"),
    slippageBps: optNum(a, "slippageBps"),
    expiredAt: optNum(a, "expiredAt"),
  };
  return runJupVenue(deps, reqStr(a, "idempotencyKey"), "open", "jup_limit_create", (v) => v.limitCreate(args));
}

async function handleJupLimitCancel(deps: ToolDeps, a: Args): Promise<ToolText> {
  const order = reqStr(a, "order");
  return runJupVenue(deps, reqStr(a, "idempotencyKey"), "cancel", "jup_limit_cancel", (v) => v.limitCancel({ order }));
}

async function handleJupLimitList(deps: ToolDeps, a: Args): Promise<ToolText> {
  if (!deps.signerLoaded("jupiter")) return fail("signer_missing", "no solana signer loaded for jupiter; see auth_check");
  const v = deps.jupVenue;
  if (!v) return fail("internal", "the Jupiter venue surface is not wired this run (no solana signer at boot).");
  const status = optEnum(a, "status", ["active", "history"] as const) ?? "active";
  return ok({ ok: true, status, orders: await v.limitList(status) });
}

async function handleJupRecurringCreate(deps: ToolDeps, a: Args): Promise<ToolText> {
  const args = {
    inputMint: reqStr(a, "inputMint"),
    outputMint: reqStr(a, "outputMint"),
    inAmount: reqStr(a, "inAmount"),
    numberOfOrders: reqNum(a, "numberOfOrders"),
    interval: reqNum(a, "interval"),
    minPrice: optNum(a, "minPrice"),
    maxPrice: optNum(a, "maxPrice"),
    startAt: optNum(a, "startAt"),
  };
  return runJupVenue(deps, reqStr(a, "idempotencyKey"), "open", "jup_recurring_create", (v) => v.recurringCreate(args));
}

async function handleJupRecurringCancel(deps: ToolDeps, a: Args): Promise<ToolText> {
  const order = reqStr(a, "order");
  return runJupVenue(deps, reqStr(a, "idempotencyKey"), "cancel", "jup_recurring_cancel", (v) => v.recurringCancel({ order }));
}

async function handleJupRecurringList(deps: ToolDeps, a: Args): Promise<ToolText> {
  if (!deps.signerLoaded("jupiter")) return fail("signer_missing", "no solana signer loaded for jupiter; see auth_check");
  const v = deps.jupVenue;
  if (!v) return fail("internal", "the Jupiter venue surface is not wired this run (no solana signer at boot).");
  const status = optEnum(a, "status", ["active", "history"] as const) ?? "active";
  return ok({ ok: true, status, orders: await v.recurringList(status) });
}

async function handleJupLendDeposit(deps: ToolDeps, a: Args): Promise<ToolText> {
  const args = { asset: reqStr(a, "asset"), amount: reqStr(a, "amount") };
  return runJupVenue(deps, reqStr(a, "idempotencyKey"), "open", "jup_lend_deposit", (v) => v.lendDeposit(args));
}

async function handleJupLendWithdraw(deps: ToolDeps, a: Args): Promise<ToolText> {
  const args = { asset: reqStr(a, "asset"), amount: reqStr(a, "amount") };
  return runJupVenue(deps, reqStr(a, "idempotencyKey"), "open", "jup_lend_withdraw", (v) => v.lendWithdraw(args));
}

async function handleJupLendBorrow(deps: ToolDeps, a: Args): Promise<ToolText> {
  const args = {
    vaultId: reqNum(a, "vaultId"),
    positionId: optNum(a, "positionId") ?? 0,
    colAmount: reqStr(a, "colAmount"),
    debtAmount: reqStr(a, "debtAmount"),
  };
  return runJupVenue(deps, reqStr(a, "idempotencyKey"), "open", "jup_lend_borrow", (v) => v.lendBorrow(args));
}

async function handleJupLendMarkets(deps: ToolDeps): Promise<ToolText> {
  if (!deps.signerLoaded("jupiter")) return fail("signer_missing", "no solana signer loaded for jupiter; see auth_check");
  const v = deps.jupVenue;
  if (!v) return fail("internal", "the Jupiter venue surface is not wired this run (no solana signer at boot).");
  const [earn, borrow] = await Promise.all([v.lendTokens(), v.lendVaults()]);
  return ok({ ok: true, earn, borrow });
}

async function handleJupLendPositions(deps: ToolDeps): Promise<ToolText> {
  if (!deps.signerLoaded("jupiter")) return fail("signer_missing", "no solana signer loaded for jupiter; see auth_check");
  const v = deps.jupVenue;
  if (!v) return fail("internal", "the Jupiter venue surface is not wired this run (no solana signer at boot).");
  const [earn, borrow] = await Promise.all([v.lendPositions(), v.lendBorrowPositions()]);
  return ok({ ok: true, earn, borrow });
}

// ── retry gate (exposed for the confirm/retry wiring) ────────────────────────
// Not a tool itself, but the canonical place the retry decision is made so the
// quota + per-intent caps live next to the builds. server.ts's retry_intent (a
// later phase) calls this AFTER a reconcile proves non-execution.

export async function guardRetry(
  deps: ToolDeps,
  idempotencyKey: string,
): Promise<{ ok: true; record: IntentRecord } | { ok: false; reason: string; message: string }> {
  const rec = await deps.store.get(deps.botId, idempotencyKey);
  if (!rec) return { ok: false, reason: "not_found", message: `no intent for key ${idempotencyKey}` };

  // HARD GATE: a reconcile must prove non-execution and mint a single-use token
  // before any rebuild. We surface the reconcile verdict so the caller can't
  // skip it.
  const verdict = await deps.reconciler.reconcile(rec);
  if (verdict.status === "already_done") {
    return { ok: false, reason: "already_done", message: `already filled ${verdict.filledSize}` };
  }
  if (verdict.status === "partial") {
    return {
      ok: false,
      reason: "partial",
      message: `partially filled ${verdict.filledSize}/${verdict.intendedSize} — reconcile, don't blind-retry`,
    };
  }

  const dailySubmits = await deps.store.dailyRelayerSubmits(deps.botId);
  const can = canRetry(rec, dailySubmits, deps.dailyRelayerQuota);
  if (!can.ok) return { ok: false, reason: can.reason, message: can.message };

  // Bind the minted submission token to the artifact before allowing a rebuild.
  if (verdict.status === "not_executed" && !bindsToIntent(rec, verdict.token.binding)) {
    // The token's binding must match the stored submissionBinding; if the intent
    // has none yet, the caller sets it from the first build. Surface mismatch.
    return { ok: false, reason: "binding_mismatch", message: "submission token does not bind to this intent" };
  }
  return { ok: true, record: rec };
}

// ── dispatcher ───────────────────────────────────────────────────────────────
// server.ts calls this from its CallTool switch for any name in MONEY_TOOL_NAMES.

export async function handleMoneyTool(name: string, rawArgs: unknown, deps: ToolDeps): Promise<ToolText> {
  const a: Args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Args) : {};
  try {
    switch (name) {
      case "get_quote":
        return await handleGetQuote(deps, a);
      case "open_position":
        return await handleOpenPosition(deps, a);
      case "close_position":
        return await handleClosePosition(deps, a);
      case "list_positions":
        return await handleListPositions(deps, a);
      case "build_withdraw":
        return await handleBuildWithdraw(deps, a);
      case "bridge_quote":
        return await handleBridgeQuote(deps, a);
      case "build_bridge":
        return await handleBuildBridge(deps, a);
      case "get_bridge_status":
        return await handleGetBridgeStatus(deps, a);
      case "ensure_gas":
        return await handleEnsureGas(deps, a);
      case "plan_funding_route":
        return await handlePlanFundingRoute(deps, a);
      case "enable_venue":
        return await handleEnableVenue(deps, a);
      case "pm_deposit_address":
        return await handlePmDepositAddress(deps, a);
      case "pm_withdraw":
        return await handlePmWithdraw(deps, a);
      case "hl_bridge_out":
        return await handleHlBridgeOut(deps, a);
      case "transfer":
        return await handleTransfer(deps, a);
      case "advance_bridge":
        return await handleAdvanceBridge(deps, a);
      case "hl_account":
        return await handleHlAccount(deps);
      case "hl_order":
        return await handleHlOrder(deps, a);
      case "hl_cancel":
        return await handleHlCancel(deps, a);
      case "hl_update_leverage":
        return await handleHlUpdateLeverage(deps, a);
      case "hl_update_isolated_margin":
        return await handleHlUpdateIsolatedMargin(deps, a);
      case "hl_usd_class_transfer":
        return await handleHlUsdClassTransfer(deps, a);
      case "hl_vault_transfer":
        return await handleHlVaultTransfer(deps, a);
      case "hl_stake":
        return await handleHlStake(deps, a);
      case "hl_delegate":
        return await handleHlDelegate(deps, a);
      case "hl_twap":
        return await handleHlTwap(deps, a);
      case "jup_limit_create":
        return await handleJupLimitCreate(deps, a);
      case "jup_limit_cancel":
        return await handleJupLimitCancel(deps, a);
      case "jup_limit_list":
        return await handleJupLimitList(deps, a);
      case "jup_recurring_create":
        return await handleJupRecurringCreate(deps, a);
      case "jup_recurring_cancel":
        return await handleJupRecurringCancel(deps, a);
      case "jup_recurring_list":
        return await handleJupRecurringList(deps, a);
      case "jup_lend_deposit":
        return await handleJupLendDeposit(deps, a);
      case "jup_lend_withdraw":
        return await handleJupLendWithdraw(deps, a);
      case "jup_lend_borrow":
        return await handleJupLendBorrow(deps, a);
      case "jup_lend_markets":
        return await handleJupLendMarkets(deps);
      case "jup_lend_positions":
        return await handleJupLendPositions(deps);
      default:
        return fail("unknown_tool", `unknown tool ${name}`);
    }
  } catch (e) {
    if (e instanceof ArgError) return fail("bad_args", e.message);
    if (e instanceof ResolveError) return fail(e.code, e.message);
    if (e instanceof WithdrawError) return fail("treasury_refused", e.message, { withdrawCode: e.code });
    // Adapter/bridge/store failures bubble here. Surface the message; never the
    // stack (could leak local paths) and never any signing material.
    return fail("internal", (e as Error)?.message ?? "tool failed");
  }
}
