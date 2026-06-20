// src/adapters/jupiter-rest.ts
// Shared keyless Jupiter REST client + the two execution models the NON-swap Jupiter
// surfaces (trigger/recurring/lend/prediction) use. Every one of them returns an
// UNSIGNED base64 Solana transaction — the EXACT shape the swap adapter already signs
// (solana-tx.ts) and broadcasts (solana-broadcast.ts). Two landing models:
//   - EXECUTE model (Trigger, Recurring): {transaction, requestId} -> sign locally ->
//     POST {signedTransaction, requestId} to the product's /execute; Jupiter lands it.
//   - BROADCAST model (Lend, Prediction): {transaction[, txMeta]} -> sign + send to the
//     Solana RPC yourself (no /execute endpoint).
// Host: keyless `lite-api.jup.ag` by default; an API key (STARLING_JUP_API_KEY) flips to
// `api.jup.ag` + `x-api-key` (the same switch Jupiter's own CLI uses). Keys never sign —
// signing is always the local ed25519 key via getSolanaSigner().
import { getSolanaSigner } from "../signers/index.js";
import { signTransaction, refreshBlockhash } from "./solana-tx.js";
import { signAndSend } from "./solana-broadcast.js";
import { SolanaRpc } from "./solana-rpc.js";
import type { SubmitResult } from "./types.js";

const DEFAULT_KEYLESS = "https://lite-api.jup.ag";
const DEFAULT_KEYED = "https://api.jup.ag";

/** Resolve the host + optional key. A key selects api.jup.ag; else keyless lite-api. */
export function jupHost(): { base: string; apiKey?: string } {
  const apiKey = process.env.STARLING_JUP_API_KEY || undefined;
  const base = process.env.STARLING_JUP_API_BASE || (apiKey ? DEFAULT_KEYED : DEFAULT_KEYLESS);
  return { base, apiKey };
}

function jsonHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

/** GET a Jupiter REST endpoint (reads — markets, orders, positions). */
export async function jupGet<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const { base, apiKey } = jupHost();
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const res = await fetchImpl(u.toString(), { headers: apiKey ? { "x-api-key": apiKey } : {} });
  if (!res.ok) throw new Error(`Jupiter GET ${path} -> HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** POST a Jupiter REST endpoint; parses JSON (tolerates an empty/non-JSON body). */
export async function jupPost<T = unknown>(path: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const { base, apiKey } = jupHost();
  const res = await fetchImpl(base + path, { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(body) });
  const txt = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {};
  try {
    json = txt ? JSON.parse(txt) : {};
  } catch {
    json = { raw: txt };
  }
  if (!res.ok) throw new Error(`Jupiter POST ${path} -> HTTP ${res.status} ${txt.slice(0, 200)}`);
  return json as T;
}

/** DELETE a Jupiter REST endpoint with a JSON body (Prediction exits use this). */
export async function jupDelete<T = unknown>(path: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const { base, apiKey } = jupHost();
  const res = await fetchImpl(base + path, { method: "DELETE", headers: jsonHeaders(apiKey), body: JSON.stringify(body) });
  const txt = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {};
  try {
    json = txt ? JSON.parse(txt) : {};
  } catch {
    json = { raw: txt };
  }
  if (!res.ok) throw new Error(`Jupiter DELETE ${path} -> HTTP ${res.status} ${txt.slice(0, 200)}`);
  return json as T;
}

/**
 * EXECUTE model (Trigger, Recurring): sign the unsigned base64 tx with the local key,
 * then POST it back to the product's /execute endpoint — Jupiter submits + confirms.
 * Returns the on-chain signature + (when present) the created order account.
 */
export async function signAndExecute(args: {
  unsignedTxB64: string;
  requestId: string;
  executePath: string;
  fetchImpl?: typeof fetch;
}): Promise<SubmitResult> {
  const { signedTxB64 } = signTransaction(args.unsignedTxB64, getSolanaSigner());
  const r = await jupPost<{ signature?: string; status?: string; order?: string; error?: string; code?: number }>(
    args.executePath,
    { requestId: args.requestId, signedTransaction: signedTxB64 },
    args.fetchImpl ?? fetch,
  );
  const ok = String(r.status ?? "").toLowerCase() === "success" && !!r.signature;
  return {
    posted: ok,
    status: ok ? "filled" : "rejected",
    orderId: r.order,
    txHashes: r.signature ? [r.signature] : [],
    error: ok ? undefined : r.error ?? `execute status ${r.status ?? "unknown"}`,
    raw: r,
  };
}

/**
 * BROADCAST model (Lend, Prediction): sign + send the tx to the Solana RPC ourselves
 * (these have no /execute endpoint). If no lastValidBlockHeight is supplied we refresh
 * the blockhash to a current one so the signed bytes can land (single-signer txs only).
 */
export async function signAndBroadcast(args: {
  unsignedTxB64: string;
  lastValidBlockHeight?: number;
  fetchImpl?: typeof fetch;
}): Promise<SubmitResult> {
  const rpc = new SolanaRpc({ fetchImpl: args.fetchImpl });
  let unsigned = args.unsignedTxB64;
  let lvbh = args.lastValidBlockHeight;
  if (!lvbh) {
    const bh = await rpc.getLatestBlockhash();
    unsigned = refreshBlockhash(unsigned, bh.blockhash);
    lvbh = bh.lastValidBlockHeight;
  }
  const res = await signAndSend({ kind: "solanaTx", chain: "solana", unsignedTxB64: unsigned, lastValidBlockHeight: lvbh }, getSolanaSigner(), rpc);
  return {
    posted: res.ok,
    status: res.ok ? "filled" : "rejected",
    txHashes: res.txid ? [res.txid] : [],
    error: res.ok ? undefined : `${res.status}${res.err ? ": " + JSON.stringify(res.err) : ""}`,
    raw: res,
  };
}
