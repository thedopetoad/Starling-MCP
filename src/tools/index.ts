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
  cmpDecimal,
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
  /** Polymarket per-builder daily relayer quota (shared budget) for canRetry. */
  dailyRelayerQuota: number;
  /** Which venues currently have a loaded local signer (gates money moves). */
  signerLoaded(venue: Venue): boolean;
  /** Per-call withdraw ceiling, sourced from risk limits — NOT from the agent. */
  withdrawMaxPerCall(chain: Chain): string;
  /** The USER-SET risk limits (per-trade/daily caps + kill-switch). Not agent-set. */
  limits(): RiskLimits;
  /** Today's accumulated usage for the daily caps (caller rolls it at UTC midnight). */
  dailyUsage(): DailyUsage;
  /** Record a freshly-built open's USD notional toward the daily cap. */
  recordOpen(notionalUsd: string): void;
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

  // Off-chain order books (PM CLOB / HL exchange) expose submit() — POST the
  // locally-signed order now. Venues whose build is an on-chain tx have no
  // submit(); they return the build for the caller to broadcast.
  let submit: SubmitResult | undefined;
  if (!res.replayed && res.build && adapter.submit) {
    submit = await adapter.submit(res.build);
    await deps.store.patch(deps.botId, intent.idempotencyKey, {
      state: submit.posted ? "FILLED" : "FAILED",
      txHashes: submit.txHashes ?? [],
      error: submit.posted ? undefined : { code: "no_liquidity", message: submit.error ?? "order rejected", recoverable: true, suggestedAction: "re-quote and retry with the same idempotencyKey" },
    });
  }

  return ok({
    ok: submit ? submit.posted : true,
    replayed: res.replayed,
    state: submit ? (submit.posted ? "FILLED" : "FAILED") : res.record.state,
    notionalUsd,
    intent: { venue, marketId: intent.marketId, side: intent.side, amount: intent.amount },
    submit,
    build: res.build,
    note: res.replayed
      ? "idempotencyKey already used — returning the ORIGINAL result, not a new order."
      : submit
        ? submit.posted
          ? "Order POSTed to the venue (locally signed, bounded by worstPrice + caps)."
          : `Order rejected: ${submit.error}`
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

  // Off-chain order books (PM CLOB / HL exchange) expose submit() — POST the
  // locally-signed close NOW, mirroring open_position. Without this a tool-driven
  // close would build a signed order and never post it, so the position never
  // closes. Venues whose build is an on-chain tx have no submit() and return the
  // build for the caller to broadcast.
  let submit: SubmitResult | undefined;
  if (!res.replayed && res.build && adapter.submit) {
    submit = await adapter.submit(res.build);
    await deps.store.patch(deps.botId, intent.idempotencyKey, {
      state: submit.posted ? "FILLED" : "FAILED",
      txHashes: submit.txHashes ?? [],
      error: submit.posted
        ? undefined
        : { code: "no_liquidity", message: submit.error ?? "close order rejected", recoverable: true, suggestedAction: "re-quote and retry with the same idempotencyKey" },
    });
  }

  return ok({
    ok: submit ? submit.posted : true,
    replayed: res.replayed,
    state: submit ? (submit.posted ? "FILLED" : "FAILED") : res.record.state,
    intent: { venue, marketId: intent.marketId, fraction: intent.fraction },
    submit,
    build: res.build,
    note: res.replayed
      ? "idempotencyKey already used — returning the ORIGINAL result, not a new close."
      : submit
        ? submit.posted
          ? "Close POSTed to the venue (locally signed, bounded by worstPrice)."
          : `Close rejected: ${submit.error}`
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
  // treasury-sweep path below; we still enforce the per-call cap, then EXECUTE it
  // via the adapter (it POSTs to /exchange like an order). $1 flat HL fee, ~5 min
  // to land. Reserve the intent FIRST so a replayed key can never post twice.
  if (chain === "hyperliquid") {
    const cap = deps.withdrawMaxPerCall(chain);
    if (cmpDecimal(amount, cap) > 0) {
      return fail("treasury_refused", `Withdraw amount ${amount} exceeds the per-call cap ${cap}. Set STARLING_WITHDRAW_MAX.`, {
        withdrawCode: "amount_exceeds_cap",
      });
    }
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
    // resolveWithdrawRecipient takes NO agent recipient — it reads the sealed
    // treasury for the chain or throws. Amount is capped by risk limits, NOT
    // by any agent input.
    resolved = resolveWithdrawRecipient(treasury, {
      chain,
      amount,
      maxPerCall: deps.withdrawMaxPerCall(chain),
    });
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

  // Recipient is pinned by the MCP, NEVER from an agent argument:
  //  - direction "out" (withdraw): the sealed treasury for toChain.
  //  - direction "in"  (funding):  also resolved server-side (treasury / thin-wallet).
  // We read it from the sealed treasury here; an allowlisted thin-wallet getter
  // can be substituted in ToolDeps later. Either way the agent cannot set it.
  let recipient: string;
  try {
    const treasury = await deps.treasury();
    const t = treasury.byChain[toChain];
    if (!t) {
      return fail("treasury_refused", `no sealed/allowlisted recipient for ${toChain}`, {
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

  // Recipient pinned server-side (treasury / allowlisted thin-wallet), not agent.
  let recipient: string;
  try {
    const treasury = await deps.treasury();
    const t = treasury.byChain[toChain];
    if (!t) {
      return fail("treasury_refused", `no sealed/allowlisted recipient for ${toChain}`, {
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
