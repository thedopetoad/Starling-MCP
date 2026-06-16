// src/adapters/polymarket-transport.ts
// Hand-rolled Polymarket CLOB L2-auth HTTP, ported from the v1 app's
// /api/polymarket/order/route.ts. The v1 app ran this server-side as a CORS
// bypass; here it runs in-process on the user's box — there is no proxy, no
// hosted backend on the signing path (per README: "the hosted proxy is NOT on
// the signing path").
//
// WHY HAND-ROLLED (not @polymarket/clob-client-v2): the SDK drags in ethers +
// axios. Per the repo's lean-deps rule we sign the V2 order with viem
// (polymarket.ts) and do the L2 HMAC with Node's crypto + fetch here.
//
// L2 auth is UNCHANGED in CLOB V2 — POLY_ADDRESS / POLY_API_KEY /
// POLY_PASSPHRASE / POLY_SIGNATURE / POLY_TIMESTAMP. Builder attribution moved
// into the signed order's bytes32 `builder` field (polymarket.ts), so there are
// NO POLY_BUILDER_* headers here.

import { createHmac } from "node:crypto";
import { CLOB_HOST, DATA_API_HOST } from "./polymarket-constants.js";

/** Level-2 CLOB API credentials, derived once per trading EOA. */
export interface ClobCreds {
  /** API key (also the order payload `owner`). */
  key: string;
  /** URL-safe base64 HMAC secret. Converted to standard base64 before use. */
  secret: string;
  passphrase: string;
}

/**
 * Resolve the L2 creds for the trading EOA from the environment. These are NOT
 * signing keys (the secp256k1 key signs the order); they are the CLOB API
 * credentials minted by createOrDeriveApiKey on polymarket.com / via the SDK.
 * Plaintext-in-env is acceptable: a leaked L2 cred can read/cancel orders but
 * cannot move funds (only the local secp256k1 key signs spendable orders).
 *
 *   STARLING_PM_CLOB_API_KEY
 *   STARLING_PM_CLOB_SECRET       (url-safe base64)
 *   STARLING_PM_CLOB_PASSPHRASE
 */
export function resolveClobCredsFromEnv(): ClobCreds | null {
  const key = process.env.STARLING_PM_CLOB_API_KEY;
  const secret = process.env.STARLING_PM_CLOB_SECRET;
  const passphrase = process.env.STARLING_PM_CLOB_PASSPHRASE;
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

/**
 * Build the L2 auth headers exactly as the v1 route + the CLOB SDKs do.
 *
 * CRITICAL base64 handling (load-bearing, ported verbatim from route.ts):
 *   - the secret is URL-SAFE base64; convert to STANDARD base64 (`-`->`+`,
 *     `_`->`/`) BEFORE decoding it into the HMAC key bytes.
 *   - HMAC-SHA256 over (timestamp + method + requestPath + body), digest to
 *     base64, then convert THAT back to URL-SAFE (`+`->`-`, `/`->`_`).
 *   - POLY_TIMESTAMP is unix SECONDS (the order-struct `timestamp` is ms — a
 *     different field in a different unit; never cross them).
 */
export function createL2Headers(
  creds: ClobCreds,
  address: string,
  method: string,
  requestPath: string,
  body: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + requestPath + body;

  // URL-safe base64 secret -> standard base64 -> raw key bytes.
  const standardB64 = creds.secret.replace(/-/g, "+").replace(/_/g, "/");
  const secretBuf = Buffer.from(standardB64, "base64");

  // HMAC-SHA256 -> base64 -> URL-safe base64.
  const sigStandard = createHmac("sha256", secretBuf).update(message).digest("base64");
  const sigUrlSafe = sigStandard.replace(/\+/g, "-").replace(/\//g, "_");

  return {
    POLY_ADDRESS: address,
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
    POLY_SIGNATURE: sigUrlSafe,
    POLY_TIMESTAMP: timestamp,
  };
}

/** What the CLOB returns on a successful (or rejected) POST /order. */
export interface PostOrderResult {
  /** HTTP-ok AND no error/errorMsg in the body. */
  ok: boolean;
  httpStatus: number;
  /** orderID on success. */
  orderID?: string;
  status?: string;
  /** Polygon settlement tx hashes for matched orders (empty when it rests). */
  transactionHashes?: string[];
  /** Raw CLOB error string when !ok (error | errorMsg). */
  error?: string;
  /** Full parsed body for diagnostics / reconcile. */
  raw: unknown;
}

/**
 * The order payload wire shape the CLOB expects: an outer envelope with the
 * inner signed `order`, the `owner` (= L2 api key), and the `orderType`.
 * Mirrors the SDK's orderToJsonV2 output that the v1 proxy forwarded verbatim.
 */
export interface ClobOrderPayload {
  order: Record<string, unknown>;
  owner: string;
  orderType: "FAK" | "FOK" | "GTC" | "GTD";
  /** SDK defaults; harmless when false. */
  postOnly?: boolean;
  deferExec?: boolean;
}

/**
 * POST a signed order to the CLOB with L2 auth. No retry / no onboarding loop
 * here — that policy lives in the intent/reconcile layer (store.ts). This is the
 * thin transport: sign headers, send, classify the response.
 */
export async function postOrder(
  creds: ClobCreds,
  address: string,
  payload: ClobOrderPayload,
  opts: { host?: string; fetchImpl?: typeof fetch } = {},
): Promise<PostOrderResult> {
  const host = opts.host ?? CLOB_HOST;
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify(payload);

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...createL2Headers(creds, address, "POST", "/order", body),
  };

  const res = await doFetch(`${host}/order`, { method: "POST", headers, body });

  // CLOB sometimes returns non-JSON on 5xx / gateway errors; tolerate that.
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = { error: `non-JSON response (HTTP ${res.status})` };
  }

  const obj = (data ?? {}) as Record<string, unknown>;
  const errStr =
    (obj.error as string) || (obj.errorMsg as string) || (obj.error_msg as string) || undefined;
  const ok = res.ok && !errStr;

  // CLOB spells it "transactionsHashes" (note the s); accept both spellings.
  const txs = obj.transactionsHashes ?? obj.transactionHashes;

  return {
    ok,
    httpStatus: res.status,
    orderID: typeof obj.orderID === "string" ? obj.orderID : undefined,
    status: typeof obj.status === "string" ? obj.status : undefined,
    transactionHashes: Array.isArray(txs) ? (txs as string[]) : undefined,
    error: ok ? undefined : (errStr ?? "Order rejected by Polymarket"),
    raw: data,
  };
}

/** Tick size (minimum_tick_size) for a token, from GET /tick-size. */
export async function fetchTickSize(
  tokenId: string,
  opts: { host?: string; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const host = opts.host ?? CLOB_HOST;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${host}/tick-size?token_id=${encodeURIComponent(tokenId)}`);
  if (!res.ok) throw new Error(`tick-size lookup failed for ${tokenId} (HTTP ${res.status})`);
  const data = (await res.json()) as { minimum_tick_size?: number | string };
  if (data.minimum_tick_size === undefined || data.minimum_tick_size === null) {
    throw new Error(`tick-size response missing minimum_tick_size for ${tokenId}`);
  }
  return data.minimum_tick_size.toString();
}

/** neg_risk flag for a token, from GET /neg-risk. */
export async function fetchNegRisk(
  tokenId: string,
  opts: { host?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const host = opts.host ?? CLOB_HOST;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${host}/neg-risk?token_id=${encodeURIComponent(tokenId)}`);
  if (!res.ok) throw new Error(`neg-risk lookup failed for ${tokenId} (HTTP ${res.status})`);
  const data = (await res.json()) as { neg_risk?: boolean };
  return data.neg_risk === true;
}

/** A single position row from the data API (fields used by state()). */
export interface DataApiPosition {
  asset: string; // clobTokenId
  conditionId: string;
  outcome?: string;
  size: number;
  avgPrice: number;
  curPrice?: number;
  cashPnl?: number;
  negativeRisk?: boolean;
  redeemable?: boolean;
}

/**
 * Fetch the trading EOA's positions from the Polymarket data API — the same
 * source-of-truth polymarket.com uses (mirrors the v1 positions route). Used by
 * state() AND by the reconcile gate before any (re)submit.
 */
export async function fetchPositions(
  user: string,
  opts: { host?: string; fetchImpl?: typeof fetch } = {},
): Promise<DataApiPosition[]> {
  const host = opts.host ?? DATA_API_HOST;
  const doFetch = opts.fetchImpl ?? fetch;
  const url =
    `${host}/positions?user=${encodeURIComponent(user.toLowerCase())}` +
    `&sizeThreshold=0.01&sortBy=CURRENT&sortDirection=DESC`;
  const res = await doFetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? (data as DataApiPosition[]) : [];
}
