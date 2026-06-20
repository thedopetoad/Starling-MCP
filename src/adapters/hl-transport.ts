// src/adapters/hl-transport.ts
// Thin Hyperliquid HTTP transport. Reads go to POST /info; the signed order goes
// to POST /exchange. No signing here (the adapter signs locally via hl-signing);
// no key material ever touches this file. Mainnet vs testnet is the caller's
// choice and MUST match the `source` ("a"/"b") baked into the signature.
import type { RsvSignature } from "./hl-signing.js";
import type { SubmitResult } from "./types.js";

export const HL_MAINNET = "https://api.hyperliquid.xyz";
export const HL_TESTNET = "https://api.hyperliquid-testnet.xyz";

export interface HlTransportOpts {
  host: string;
  fetchImpl?: typeof fetch;
}

/** POST /info with a typed request body; returns the parsed JSON (throws on !ok). */
export async function infoPost<T = unknown>(
  body: Record<string, unknown>,
  opts: HlTransportOpts,
): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.host}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL /info ${String(body.type)} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface HlExchangePayload {
  action: Record<string, unknown>;
  nonce: number;
  signature: RsvSignature;
  /** null for a plain EOA (no vault/sub-account). Must match what was signed. */
  vaultAddress: string | null;
}

/**
 * POST a locally-signed action to /exchange and normalize the reply into a
 * SubmitResult. HL settles on HyperCore (its own L1), so there are no EVM tx
 * hashes — fills carry an order id + avg px instead.
 */
export async function postExchange(payload: HlExchangePayload, opts: HlTransportOpts): Promise<SubmitResult> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.host}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return classifyHlResponse(res.ok, json);
}

/**
 * Map an /exchange reply to SubmitResult. HL uses TWO error/result shapes and we
 * MUST check both or a rejection is misread as success:
 *   - order / cancel / modify: data.statuses ARRAY of
 *       {filled:{totalSz,avgPx,oid}} | {resting:{oid}} | {error:"…"}
 *   - twap (and other single-result actions): data.status OBJECT —
 *       {error:"…"} on rejection or {running:{twapId}} on accept
 *   - actions with no payload (leverage / transfers / staking): {type:"default"}.
 * Anything with status!="ok", a string error, or an embedded {error} is a rejection
 * — we DON'T pretend a posted-but-unfilled IOC (or a too-small TWAP) succeeded.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyHlResponse(httpOk: boolean, json: any): SubmitResult {
  if (json?.status !== "ok") {
    const msg = typeof json?.response === "string" ? json.response : JSON.stringify(json ?? {});
    return { posted: false, status: "rejected", error: httpOk ? msg : `HTTP error: ${msg}`, raw: json };
  }
  const data = json?.response?.data;
  // Order / cancel / modify: a per-item `statuses` ARRAY.
  if (Array.isArray(data?.statuses)) {
    const first = data.statuses[0] ?? {};
    if (first.error) return { posted: false, status: "rejected", error: String(first.error), raw: json };
    const filled = first.filled;
    const resting = first.resting;
    const oid = filled?.oid ?? resting?.oid;
    return {
      posted: true,
      orderId: oid !== undefined ? String(oid) : undefined,
      status: filled ? "filled" : resting ? "resting" : "accepted",
      raw: json,
    };
  }
  // TWAP (and other single-result actions): a SINGULAR `status` OBJECT.
  const single = data?.status;
  if (single && typeof single === "object") {
    if (single.error) return { posted: false, status: "rejected", error: String(single.error), raw: json };
    const twapId = single.running?.twapId;
    return { posted: true, orderId: twapId !== undefined && twapId !== null ? String(twapId) : undefined, status: "accepted", raw: json };
  }
  // No data payload (e.g. {type:"default"} for leverage / transfers / staking) => OK.
  return { posted: true, status: "accepted", raw: json };
}
