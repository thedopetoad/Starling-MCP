// src/intents/store.ts
// The intent / idempotency lifecycle. Every money-moving tool flows through ONE
// tracked intent keyed by the REQUIRED caller idempotencyKey, persisted as a
// UNIQUE (botId, idempotencyKey) row. Replaying a used key returns the ORIGINAL
// intent + its txs — never a second build. (Polymarket's per-order salt makes
// orders UNIQUE, not idempotent, so MCP-side dedupe is mandatory or you double-
// trade.)
//
// HONEST LIMIT (do not overclaim end-to-end idempotency):
//   The MCP builds; the LOCAL signer signs + broadcasts; Starling never does.
//   So the unique row prevents a double-BUILD, but it cannot bind a broadcast the
//   MCP never performs. The dangerous window — broadcast happened, response lost
//   — is closed ONLY by reconcile() against the venue activity feed BEFORE any
//   (re)submit. That is why reconcile is a HARD GATE that mints a single-use
//   submission token bound to the exact signed-order hash / nonce / blockhash,
//   not an optional pre-retry convenience.
//
// Storage is LOCAL (SQLite/JSON) on the signing path — execution + crash-safety
// must not depend on Starling's backend being up. This file defines the
// in-memory contract + a JSON-file impl; swap in better-sqlite3 behind the same
// interface if desired (kept out of the default dep tree).

import type { BuildResult } from "../adapters/types.js";

export type IntentState =
  | "BUILT"
  | "SIGNED"
  | "BROADCAST"
  | "CONFIRMED"
  | "OPEN"
  | "FILLED"
  | "PARTIALLY_FILLED" // distinct terminal-ish state: filledSize < intendedSize
  | "CLOSED"
  | "FAILED";

export type TradeErrorCode =
  | "maker_not_allowed"
  | "allowance_missing"
  | "insufficient_balance"
  | "market_resolved"
  | "no_liquidity"
  | "price_moved"
  | "min_order"
  | "auth_expired"
  | "wrong_chain"
  | "session_expired"
  | "relayer_quota"
  | "registry_lag"
  | "wrap_source_mismatch" // CCTP native-USDC can't feed CollateralOnramp.wrap (USDC.e)
  | "bridge_stuck";

export interface TradeError {
  code: TradeErrorCode;
  message: string;
  recoverable: boolean;
  suggestedAction: string;
}

export interface IntentRecord {
  botId: string;
  idempotencyKey: string;
  kind: "open" | "close" | "withdraw" | "bridge" | "redeem" | "cancel";
  state: IntentState;
  build?: BuildResult;
  /** tx hashes / order hashes seen for this intent (for reconcile + confirm). */
  txHashes: string[];
  /** PM order hash / HL nonce / Solana blockhash the submission token is bound to. */
  submissionBinding?: string;
  filledSize?: string;
  intendedSize?: string;
  error?: TradeError;
  /** per-intent relayer-backed retry count (cap 2). */
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubmissionToken {
  token: string; // single-use
  /** binds the token to the EXACT artifact the bot may broadcast. */
  binding: string;
  expiresAt: number;
}

export interface IntentStore {
  /** Insert-or-get. If (botId,key) exists, returns {created:false, record} with
   *  the ORIGINAL build — the caller MUST NOT rebuild. */
  upsert(rec: Omit<IntentRecord, "createdAt" | "updatedAt" | "retryCount" | "txHashes" | "state"> & {
    state?: IntentState;
  }): Promise<{ created: boolean; record: IntentRecord }>;
  get(botId: string, key: string): Promise<IntentRecord | null>;
  patch(botId: string, key: string, p: Partial<IntentRecord>): Promise<IntentRecord>;
  /** Account-wide daily relayer-submit counter (Polymarket per-builder DAILY
   *  quota is a SHARED budget across intents — separate from per-intent retry). */
  bumpDailyRelayerSubmits(botId: string): Promise<number>;
  dailyRelayerSubmits(botId: string): Promise<number>;
}

/** Per-intent retry cap (relayer-backed flows). 429 = hard stop above this. */
export const MAX_INTENT_RETRIES = 2;

/**
 * HARD GATE before any (re)broadcast. The bot cannot skip reconcile: a fresh
 * reconcile that shows NO existing fill is the only thing that mints a
 * single-use submission token bound to the exact artifact. If a fill already
 * exists this returns already_done and refuses to mint — blocking a double-trade
 * on a lost response.
 */
export interface Reconciler {
  /** Query the venue activity feed (PM /activity+/positions, HL userFills,
   *  Solana getSignatureStatuses) and decide. NEVER trusts a relay .wait(). */
  reconcile(rec: IntentRecord): Promise<
    | { status: "already_done"; filledSize: string }
    | { status: "not_executed"; token: SubmissionToken }
    | { status: "partial"; filledSize: string; intendedSize: string }
  >;
}

/**
 * Decide whether retry_intent may rebuild. Enforces BOTH budgets:
 *   - per-intent attempt < MAX_INTENT_RETRIES, AND
 *   - account-wide daily relayer submits < the Polymarket builder quota.
 * Must be preceded by a reconcile proving non-execution (caller wiring).
 */
export function canRetry(
  rec: IntentRecord,
  dailySubmits: number,
  dailyQuota: number,
): { ok: true } | { ok: false; reason: TradeErrorCode; message: string } {
  if (rec.retryCount >= MAX_INTENT_RETRIES) {
    return {
      ok: false,
      reason: "relayer_quota",
      message: `Intent already retried ${rec.retryCount}x (cap ${MAX_INTENT_RETRIES}).`,
    };
  }
  if (dailySubmits >= dailyQuota) {
    return {
      ok: false,
      reason: "relayer_quota",
      message: `Daily relayer quota reached (${dailySubmits}/${dailyQuota}). Wait, then retry.`,
    };
  }
  return { ok: true };
}

/**
 * Validate a bot's report_signed input against the built intent BEFORE the
 * confirm loop watches the reported hash. The reported hash must bind to the
 * built artifact — a rogue/buggy agent reporting an unrelated hash would
 * otherwise make the MCP watch the wrong tx (stuck, or worse, CONFIRMED off a
 * coincidental success). For EVM: caller fetches the tx and asserts to/data
 * match; for Solana: asserts the signed message matches the built one.
 */
export function bindsToIntent(rec: IntentRecord, reportedBinding: string): boolean {
  if (!rec.submissionBinding) return false;
  return rec.submissionBinding === reportedBinding;
}
