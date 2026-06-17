// src/adapters/evm-broadcast.ts
// The "caller" role for EVM — the counterpart of solana-broadcast.ts. Takes an
// UNSIGNED EVM tx ({to,data,value}) a builder produced (Polymarket approvals/wrap,
// the Hyperliquid Arbitrum Bridge2 deposit, deBridge EVM-source legs), fills
// nonce/gas/fees, signs the digest LOCALLY via EvmSigner (keys never leave the
// box — only a 32-byte digest crosses), pre-checks for revert, then broadcasts +
// confirms — bounded so a dead/lagging RPC can't spin forever OR double-spend.
//
// DOUBLE-SPEND SAFETY (the EVM analog of the Solana broadcaster's hard-won design):
//   The idempotency unit on EVM is the NONCE. A signed tx is bound to (nonce,
//   fields, chainId), so:
//    - the first send error is SWALLOWED (a submit failure is NOT proof of
//      non-execution — the tx may already be in the mempool/mined). We confirm by
//      receipt rather than reporting failure and triggering a re-sign.
//    - rebroadcasts reuse the IDENTICAL signed bytes (same nonce => same tx hash;
//      the node dedupes; "already known"/"nonce too low" means it already landed).
//    - if OUR pinned nonce is consumed by a DIFFERENT tx (latest nonce advances
//      past ours with no receipt for our hash), we return "replaced" — the caller
//      MUST reconcile against the chain, NEVER blindly re-sign a fresh-nonce tx.
//    - if we still can't tell at the deadline, we return "unknown"/"send_unconfirmed"
//      (NOT failed) — same rule: reconcile by hash, don't auto-resign.
//   This function NEVER re-derives the nonce inside the loop and NEVER re-signs;
//   re-nonce-ing is a caller decision made only AFTER on-chain reconciliation.

import { serializeTransaction, keccak256, hexToBytes, type Hex } from "viem";
import type { EvmSigner } from "../signers/evm.js";
import type { EvmRpcLike } from "./evm-rpc.js";

export interface UnsignedEvmTxInput {
  to: `0x${string}`;
  data?: `0x${string}`;
  /** wei; default 0n. */
  value?: bigint;
}

export type EvmBroadcastStatus =
  | "success"
  | "reverted"
  | "replaced"
  | "unknown"
  | "precheck_failed"
  | "send_unconfirmed";

export interface EvmBroadcastResult {
  ok: boolean;
  txHash: string;
  status: EvmBroadcastStatus;
  /** The pinned nonce (so a caller reconciling knows which slot to inspect). */
  nonce: number;
  gasUsed?: bigint;
  err?: unknown;
  /** Set when the first submit threw; the tx may still have propagated, so we
   *  fell through to the confirm loop rather than reporting non-execution. */
  sendError?: string;
}

export interface EvmBroadcastOpts {
  /** Skip the free eth_call revert pre-check (default false = run it). */
  skipPrecheck?: boolean;
  /** Override the gas limit (else estimate * 1.25, capped). */
  gasLimit?: bigint;
  /** Hard ceiling on the gas limit so a bad estimate can't authorize a runaway
   *  tx. Default 2,000,000 — comfortably above an ERC-20 approve/wrap/deposit. */
  gasLimitCap?: bigint;
  pollMs?: number;
  maxWallClockMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign + (optionally) revert-pre-check + send + confirm an EIP-1559 EVM tx with
 * the double-spend safety described above. Returns a structured result; the
 * caller maps it to the TradeErrorCode taxonomy. NEVER signs with a fresh nonce
 * on retry — that is the whole point of the design.
 */
export async function signAndSendEvm(
  unsigned: UnsignedEvmTxInput,
  signer: EvmSigner,
  rpc: EvmRpcLike,
  opts: EvmBroadcastOpts = {},
): Promise<EvmBroadcastResult> {
  const from = signer.address;
  const to = unsigned.to;
  const data = (unsigned.data ?? "0x") as Hex;
  const value = unsigned.value ?? 0n;

  // GUARD: the RPC must be on the SAME chain the tx is built for. A chainId
  // mismatch means the signed tx is invalid here (or replayable elsewhere) —
  // refuse BEFORE signing. eth_chainId is cheap and authoritative.
  const liveChainId = await rpc.getChainId();
  if (liveChainId !== rpc.chainId) {
    throw new Error(
      `EVM RPC chainId ${liveChainId} != expected ${rpc.chainId} (${rpc.net}); refusing to sign a tx for the wrong chain.`,
    );
  }

  // FREE revert pre-check (the EVM analog of Solana simulate): abort before
  // paying any gas if the tx would revert at HEAD.
  if (!opts.skipPrecheck) {
    try {
      await rpc.callReadonly({ from, to, data, value });
    } catch (e) {
      return { ok: false, txHash: "", status: "precheck_failed", nonce: -1, err: (e as Error).message };
    }
  }

  // Pin the nonce ONCE. Everything below reuses this exact nonce; we never
  // re-derive it in the confirm loop (that is how a double-spend happens).
  const nonce = await rpc.getPendingNonce(from);

  const gasCap = opts.gasLimitCap ?? 2_000_000n;
  let gas = opts.gasLimit;
  if (gas === undefined) {
    const est = await rpc.estimateGas({ from, to, data, value });
    gas = (est * 125n) / 100n; // +25% headroom
  }
  if (gas > gasCap) {
    throw new Error(
      `EVM gas limit ${gas} exceeds cap ${gasCap}; refusing (bad estimate or unexpectedly heavy tx).`,
    );
  }

  const { maxFeePerGas, maxPriorityFeePerGas } = await rpc.suggestFees();

  const tx = {
    type: "eip1559" as const,
    chainId: rpc.chainId,
    nonce,
    to,
    value,
    data,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  // Sign LOCALLY: digest = keccak256(unsigned-serialized); signer returns 65-byte
  // r||s||v (v in {27,28}). viem's signature wants {r,s,yParity}; yParity = v-27.
  const digest = hexToBytes(keccak256(serializeTransaction(tx)));
  const rsv = signer.signDigest(digest);
  const r = `0x${Buffer.from(rsv.slice(0, 32)).toString("hex")}` as Hex;
  const s = `0x${Buffer.from(rsv.slice(32, 64)).toString("hex")}` as Hex;
  const yParity = rsv[64] - 27;
  const raw = serializeTransaction(tx, { r, s, yParity });

  // The typed-tx hash is keccak256 of the full signed envelope. Compute it up
  // front so the confirm loop can poll for it even if the first send throws.
  const txHash = keccak256(raw);

  // First send. A throw is NOT proof of non-execution -> record + fall through.
  let sendError: string | undefined;
  try {
    await rpc.sendRawTransaction(raw);
  } catch (e) {
    sendError = (e as Error).message;
  }

  const pollMs = opts.pollMs ?? 2500;
  const deadline = Date.now() + (opts.maxWallClockMs ?? 180_000);
  for (;;) {
    const receipt = await rpc.getReceipt(txHash).catch(() => null);
    if (receipt) {
      return {
        ok: receipt.status === "success",
        txHash,
        status: receipt.status,
        nonce,
        gasUsed: receipt.gasUsed,
        sendError,
      };
    }

    // Nonce advanced past ours: either OUR tx mined (its receipt is just lagging
    // on a load-balanced RPC — one node sees the nonce bump while another hasn't
    // indexed the receipt) or a DIFFERENT tx replaced it. Re-poll the receipt a
    // few times before concluding "replaced" — declaring it on a single missed
    // read false-positives constantly on public RPCs. A genuinely-replaced tx
    // never mined, so its receipt stays null across the retries.
    const latestNonce = await rpc.getLatestNonce(from).catch(() => -1);
    if (latestNonce > nonce) {
      for (let i = 0; i < 5; i++) {
        await sleep(pollMs);
        const rc = await rpc.getReceipt(txHash).catch(() => null);
        if (rc) {
          return { ok: rc.status === "success", txHash, status: rc.status, nonce, gasUsed: rc.gasUsed, sendError };
        }
      }
      return { ok: false, txHash, status: "replaced", nonce, sendError };
    }

    if (Date.now() > deadline) {
      // One last receipt check, then hand back a non-failed "unknown" — the
      // caller reconciles by hash and must NOT re-sign a fresh-nonce tx blindly.
      const last = await rpc.getReceipt(txHash).catch(() => null);
      if (last) {
        return { ok: last.status === "success", txHash, status: last.status, nonce, gasUsed: last.gasUsed, sendError };
      }
      return { ok: false, txHash, status: sendError ? "send_unconfirmed" : "unknown", nonce, sendError };
    }

    // Rebroadcast the IDENTICAL bytes (idempotent: same nonce => same hash => the
    // node dedupes). Swallow errors ("already known"/"nonce too low" = it landed).
    await rpc.sendRawTransaction(raw).catch(() => {});
    await sleep(pollMs);
  }
}
