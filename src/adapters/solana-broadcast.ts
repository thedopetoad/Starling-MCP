// src/adapters/solana-broadcast.ts
// The "caller" role for Solana: take an UNSIGNED build (SolanaTxResult), sign it
// locally (solana-tx), simulate it (free pre-check), broadcast, and confirm —
// bounded by lastValidBlockHeight so a dead blockhash can't make us spin forever
// OR double-send. This is the broadcast layer the adapter contract leaves to the
// caller; signing still happens through the local signer (keys never leave).
import type { SolanaTxResult } from "./types.js";
import { signTransaction, type MessageSigner } from "./solana-tx.js";
import type { SolanaRpc } from "./solana-rpc.js";

export interface BroadcastResult {
  ok: boolean;
  txid: string;
  /** "unknown" = we could not determine the on-chain fate; the caller MUST
   *  reconcile against the chain by txid before re-signing (a re-sign produces a
   *  NEW txid and can double-land if the original actually executed). */
  status: "finalized" | "confirmed" | "failed" | "expired" | "unknown" | "sim_failed";
  err?: unknown;
  simLogs?: string[];
  /** set when the first submit threw; the tx may still have propagated, so we
   *  fall through to the confirm loop rather than reporting non-execution. */
  sendError?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign + simulate + send + confirm. `simulateFirst` (default true) aborts BEFORE
 * spending a fee if the tx would revert. NOTE: simulate() uses replaceRecentBlockhash
 * so it is a REVERT-ONLY pre-check (it does not prove the real blockhash is still
 * valid) — the send path below handles a stale-blockhash send gracefully.
 *
 * Double-land safety is the whole point of the confirm loop's design:
 *  - the first send error is SWALLOWED (a submit failure is NOT proof of
 *    non-execution — the tx may already be gossiped), and we still confirm by txid;
 *  - rebroadcasts reuse the IDENTICAL signed bytes (same blockhash => same txid =>
 *    Solana dedupes), so retrying never double-spends;
 *  - at/after expiry we re-check WITH history search so a tx that landed early and
 *    aged out of the recent cache is seen as confirmed, not falsely "expired";
 *  - if we still can't tell, we return "unknown" (NOT failed/expired) so the caller
 *    reconciles against the chain instead of re-signing a fresh (double-spend) tx.
 * A hard deadline bounds the loop so a lagging/rate-limited RPC can't spin forever.
 */
export async function signAndSend(
  build: SolanaTxResult,
  signer: MessageSigner,
  rpc: SolanaRpc,
  opts: { simulateFirst?: boolean; pollMs?: number; maxWallClockMs?: number } = {},
): Promise<BroadcastResult> {
  const { signedTxB64, txid } = signTransaction(build.unsignedTxB64, signer);

  if (opts.simulateFirst !== false) {
    const sim = await rpc.simulate(signedTxB64);
    if (sim.err) {
      return { ok: false, txid, status: "sim_failed", err: sim.err, simLogs: sim.logs ?? undefined };
    }
  }

  // First send. A throw here is NOT proof of non-execution (the node may have
  // already accepted + gossiped it), so we record it and fall into the confirm
  // loop to observe the chain rather than reporting failure and triggering a re-sign.
  let sendError: string | undefined;
  try {
    await rpc.sendRawTransaction(signedTxB64, { preflightCommitment: "confirmed" });
  } catch (e) {
    sendError = (e as Error).message;
  }

  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + (opts.maxWallClockMs ?? 90_000); // hard cap; ~blockhash lifetime + margin
  for (;;) {
    const st = await rpc.getSignatureStatus(txid);
    if (st?.err) return { ok: false, txid, status: "failed", err: st.err, sendError };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      return { ok: true, txid, status: st.confirmationStatus, sendError };
    }

    const height = await rpc.getBlockHeight("confirmed").catch(() => 0);
    const expired = height > build.lastValidBlockHeight;
    const timedOut = Date.now() > deadline;
    if (expired || timedOut) {
      // Final check WITH history search: catch a tx that landed early + aged out.
      const last = await rpc.getSignatureStatus(txid, true).catch(() => null);
      if (last?.err) return { ok: false, txid, status: "failed", err: last.err, sendError };
      if (last && (last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized")) {
        return { ok: true, txid, status: last.confirmationStatus, sendError };
      }
      // Expired blockhash => the signed bytes can no longer land, so "expired" is
      // safe (no re-sign needed). Timed out while still valid => "unknown" (caller
      // must reconcile by txid, NOT blindly re-sign).
      return { ok: false, txid, status: expired ? "expired" : "unknown", sendError };
    }

    // Rebroadcast the identical bytes (idempotent: same blockhash => same txid).
    await rpc.sendRawTransaction(signedTxB64, { skipPreflight: true, preflightCommitment: "confirmed" }).catch(() => {});
    await sleep(pollMs);
  }
}
