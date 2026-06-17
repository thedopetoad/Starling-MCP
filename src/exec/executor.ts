// src/exec/executor.ts
// The "caller" role, MOVED behind the tool surface. Takes an UNSIGNED on-chain tx
// a builder produced (bridge legs, gas top-ups, venue-setup txs, EVM/SOL sweeps),
// optionally RE-DECODES it (inspect-before-sign), SIGNS locally with the per-chain
// signer, BROADCASTS, and CONFIRMS — via the SAME double-spend-safe broadcasters
// the reference harness uses (evm-broadcast / solana-broadcast). This is what turns
// the build-only on-chain tools into execute-through-the-MCP tools.
//
// It owns NO calldata. The recipient was already pinned by the builder (sealed
// treasury / the user's own address); when the calling tool passes an `inspect`,
// the executor re-asserts that pin on the decoded calldata BEFORE the local key
// touches it. Solana legs are opaque base64 — signTransaction already REFUSES a
// foreign fee-payer / multisig, which is the Solana analog of inspect.

import type { Chain } from "../adapters/types.js";
import type { UnsignedBridgeTx } from "../bridge/types.js";
import { EvmRpc } from "../adapters/evm-rpc.js";
import { SolanaRpc } from "../adapters/solana-rpc.js";
import { signAndSendEvm } from "../adapters/evm-broadcast.js";
import { signAndSend } from "../adapters/solana-broadcast.js";
import { refreshBlockhash } from "../adapters/solana-tx.js";
import { getEvmSigner, getSolanaSigner } from "../signers/index.js";

export interface ExecResult {
  ok: boolean;
  chain: Chain;
  kind: "evmTx" | "solanaTx";
  label: string;
  /** EVM tx hash / Solana txid. */
  txHash?: string;
  status: string;
  error?: string;
}

/** Re-decode + assert calldata before signing (throws on violation). Supplied by
 *  the tool that knows the intent — e.g. assert a withdraw transfers to the sealed
 *  treasury, or a depositForBurn mints to the pinned recipient. EVM legs only. */
export type InspectFn = (tx: { to: string; data: string; value: string }) => void;

export interface Executor {
  /** Sign+broadcast+confirm ONE unsigned tx, running `inspect` (if given) before
   *  signing. Solana legs get a fresh blockhash first. */
  exec(tx: UnsignedBridgeTx, inspect?: InspectFn): Promise<ExecResult>;
  /** Execute a list IN ORDER, stopping at (and including) the first failure. */
  execSequence(txs: UnsignedBridgeTx[], inspect?: InspectFn): Promise<ExecResult[]>;
}

/** chain -> EVM network. "hyperliquid" settles on Arbitrum; its signer is the
 *  Arbitrum EOA. Solana is not an EVM net. Exported pure for unit tests. */
export const EVM_NET: Partial<Record<Chain, "polygon" | "arbitrum">> = {
  polygon: "polygon",
  hyperliquid: "arbitrum",
};

/** Pure: normalize an evmTx leg's payload into broadcaster inputs + routing. Throws
 *  on a non-EVM chain or a missing `to`. Exported so a test can assert the mapping
 *  without signing. */
export function planEvmLeg(tx: UnsignedBridgeTx): {
  net: "polygon" | "arbitrum";
  signerVenue: "polymarket" | "hyperliquid";
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
} {
  const net = EVM_NET[tx.chain];
  if (!net) throw new Error(`no EVM net mapping for chain ${tx.chain}`);
  const p = (tx.payload ?? {}) as { to?: string; data?: string; value?: string | number };
  if (!p.to) throw new Error(`evmTx leg "${tx.label}" is missing 'to'`);
  return {
    net,
    signerVenue: tx.chain === "hyperliquid" ? "hyperliquid" : "polymarket",
    to: p.to as `0x${string}`,
    data: (p.data ?? "0x") as `0x${string}`,
    value: p.value !== undefined && p.value !== null && p.value !== "" ? BigInt(p.value) : 0n,
  };
}

export function makeExecutor(): Executor {
  async function execEvm(tx: UnsignedBridgeTx, inspect?: InspectFn): Promise<ExecResult> {
    const plan = planEvmLeg(tx);
    if (inspect) inspect({ to: plan.to, data: plan.data, value: plan.value.toString() });
    const signer = getEvmSigner(plan.signerVenue);
    const rpc = new EvmRpc({ net: plan.net });
    const r = await signAndSendEvm({ to: plan.to, data: plan.data, value: plan.value }, signer, rpc);
    return {
      ok: r.ok,
      chain: tx.chain,
      kind: "evmTx",
      label: tx.label,
      txHash: r.txHash || undefined,
      status: r.status,
      error: r.ok ? undefined : (r.sendError ?? (r.err !== undefined ? String(r.err) : r.status)),
    };
  }

  async function execSolana(tx: UnsignedBridgeTx): Promise<ExecResult> {
    const b64 = typeof tx.payload === "string" ? tx.payload : undefined;
    if (typeof b64 !== "string") throw new Error(`solanaTx leg "${tx.label}" payload is not base64`);
    const rpc = new SolanaRpc();
    // The builder's baked-in blockhash goes stale across build round-trips; refresh
    // to a current one right before signing so the source tx actually lands.
    const bh = await rpc.getLatestBlockhash();
    const refreshed = refreshBlockhash(b64, bh.blockhash);
    const r = await signAndSend(
      { kind: "solanaTx", chain: "solana", unsignedTxB64: refreshed, lastValidBlockHeight: bh.lastValidBlockHeight },
      getSolanaSigner(),
      rpc,
      { simulateFirst: true },
    );
    return {
      ok: r.ok,
      chain: "solana",
      kind: "solanaTx",
      label: tx.label,
      txHash: r.txid || undefined,
      status: r.status,
      error: r.ok ? undefined : (r.sendError ? String(r.sendError) : r.status),
    };
  }

  async function exec(tx: UnsignedBridgeTx, inspect?: InspectFn): Promise<ExecResult> {
    return tx.kind === "solanaTx" ? execSolana(tx) : execEvm(tx, inspect);
  }

  async function execSequence(txs: UnsignedBridgeTx[], inspect?: InspectFn): Promise<ExecResult[]> {
    const out: ExecResult[] = [];
    for (const tx of txs) {
      const r = await exec(tx, inspect);
      out.push(r);
      if (!r.ok) break; // never fire leg N+1 if leg N didn't confirm
    }
    return out;
  }

  return { exec, execSequence };
}
