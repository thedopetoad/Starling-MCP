// src/tools/transfer.ts
// The AUTO-RAIL transfer orchestrator: the harness's transfer()/cctp()/route()
// logic, MOVED behind the tool surface so the bot never chooses the rail and never
// leaves the MCP to broadcast. It picks CCTP (both legs EVM + the dest holds
// mint-gas) or deBridge (else / any Solana leg), builds the source leg(s) via the
// bridge, and EXECUTES them through the injected Executor. The recipient is the
// user's OWN address on the destination chain (server-pinned), never an agent arg.
//
// Two-phase by design (an MCP tool must not block 5-15 min): runTransfer broadcasts
// the SOURCE leg(s) and returns a flightId; advanceBridge polls and, for CCTP,
// drives the destination mint when Iris attests (deBridge's solver self-delivers).

import type { Chain } from "../adapters/types.js";
import type { Bridge, BridgeProvider, BridgeRoute, CctpLane } from "../bridge/types.js";
import type { Executor, ExecResult } from "../exec/executor.js";
import { cctpFlightRoute } from "../bridge/cctp.js";

export type Rail = BridgeProvider; // "cctp" | "debridge"

/** The subset of ToolDeps runTransfer/advanceBridge need (so they're testable). */
export interface TransferDeps {
  bridges: Partial<Record<BridgeProvider, Bridge>>;
  executor: Executor;
  /** The loaded signer's OWN address on a chain — the pinned recipient. */
  selfAddress(chain: Chain): string | null;
  /** Destination native-gas balance (decimal units) for the rail decision. */
  nativeGas(chain: Chain): Promise<number>;
}

const EVM_CHAINS: ReadonlySet<Chain> = new Set<Chain>(["polygon", "hyperliquid"]);

/** Native-gas floor the destination needs to pay the CCTP receiveMessage mint.
 *  Below it, CCTP can't complete on the dest, so deBridge (solver-delivered, no
 *  dest gas) is the correct rail. POL on Polygon, ETH on Arbitrum. */
export function destGasFloor(toChain: Chain): number {
  return toChain === "polygon" ? 0.1 : 0.0003;
}

/** PURE rail decision. CCTP when both legs are EVM AND the dest holds enough native
 *  gas to mint; else deBridge. Any Solana leg => deBridge (CCTP Solana is stage-2).
 *  An explicit provider override always wins. */
export function pickRail(input: {
  fromChain: Chain;
  toChain: Chain;
  destNativeGas: number;
  override?: Rail;
}): { rail: Rail; reason: string } {
  if (input.override) return { rail: input.override, reason: `provider override = ${input.override}` };
  if (!EVM_CHAINS.has(input.fromChain) || !EVM_CHAINS.has(input.toChain)) {
    return { rail: "debridge", reason: "a Solana leg routes deBridge (CCTP Solana is stage-2)" };
  }
  const floor = destGasFloor(input.toChain);
  return input.destNativeGas >= floor
    ? { rail: "cctp", reason: `both-EVM + dest gas ${input.destNativeGas} >= ${floor} -> CCTP (~1:1)` }
    : { rail: "debridge", reason: `dest gas ${input.destNativeGas} < ${floor} -> deBridge (solver delivers, no dest gas)` };
}

export interface TransferResult {
  ok: boolean;
  provider: Rail;
  reason: string;
  flightId?: string;
  recipient: string;
  results: ExecResult[];
  note: string;
}

/** Execute the SOURCE leg(s) of a cross-chain USDC transfer and return the flightId
 *  to poll. Does NOT wait for destination delivery — call advanceBridge for that. */
export async function runTransfer(
  deps: TransferDeps,
  args: { fromChain: Chain; toChain: Chain; amount: string; provider?: Rail; lane?: CctpLane },
): Promise<TransferResult> {
  const recipient = deps.selfAddress(args.toChain);
  if (!recipient) throw new Error(`no loaded signer for destination chain ${args.toChain} (can't pin a recipient)`);

  const destNativeGas = await deps.nativeGas(args.toChain).catch(() => 0);
  const { rail, reason } = pickRail({
    fromChain: args.fromChain,
    toChain: args.toChain,
    destNativeGas,
    override: args.provider,
  });

  const bridge = deps.bridges[rail];
  if (!bridge) throw new Error(`bridge "${rail}" is not enabled this run`);
  if (!bridge.placeOrder) throw new Error(`bridge "${rail}" has no placeOrder()`);

  const route: BridgeRoute = {
    fromChain: args.fromChain,
    toChain: args.toChain,
    token: "USDC",
    amount: args.amount,
    recipient, // the user's OWN address — server-pinned, never an agent argument
    lane: args.lane,
  };

  const placed = await bridge.placeOrder(route);
  const results = await deps.executor.execSequence(placed.txs);
  const allOk = results.length === placed.txs.length && results.every((r) => r.ok);

  let flightId = placed.flightId;
  if (allOk && placed.bindLabel && bridge.bindFlight) {
    // CCTP: bind the broadcast burn hash into the flightId so status()/recover() work.
    const leg = results.find((r) => r.label === placed.bindLabel);
    if (leg?.txHash) flightId = bridge.bindFlight(flightId, leg.txHash);
  }

  return {
    ok: allOk,
    provider: rail,
    reason,
    flightId,
    recipient,
    results,
    note: allOk
      ? `Source leg(s) broadcast on ${args.fromChain} via ${rail}. Poll advance_bridge("${rail}","${flightId}") until delivered on ${args.toChain}.`
      : `Source execution failed: ${results.find((r) => !r.ok)?.error ?? "unknown"}. Funds did NOT cross; retry with the same idempotencyKey.`,
  };
}

export interface AdvanceResult {
  ok: boolean;
  provider: Rail;
  flightId: string;
  state: string;
  delivered: boolean;
  action?: ExecResult;
  blockers: string[];
  note: string;
}

/** Poll a transfer and, for CCTP, DRIVE the mint when the attestation is ready
 *  (deBridge needs no action — the solver delivers). Idempotent: re-minting an
 *  already-minted message is a no-op (usedNonces) and status reports ready. Call
 *  repeatedly until delivered=true. */
export async function advanceBridge(
  deps: TransferDeps,
  args: { provider: Rail; flightId: string },
): Promise<AdvanceResult> {
  const bridge = deps.bridges[args.provider];
  if (!bridge) throw new Error(`bridge "${args.provider}" is not enabled this run`);

  let status = await bridge.status(args.flightId);
  let action: ExecResult | undefined;

  if (args.provider === "cctp" && status.state === "mint_pending") {
    // Attested but not yet minted -> build receiveMessage (route reconstructed from
    // the flightId) + execute it on the destination chain.
    const route = cctpFlightRoute(args.flightId);
    const mintTxs = await bridge.recover(route, args.flightId);
    const res = await deps.executor.execSequence(mintTxs);
    action = res[res.length - 1];
    status = await bridge.status(args.flightId); // usedNonces should now prove the mint
  }

  const delivered = status.state === "ready";
  return {
    ok: true,
    provider: args.provider,
    flightId: args.flightId,
    state: status.state,
    delivered,
    action,
    blockers: status.blockers,
    note: delivered
      ? `Delivered on the destination (${status.note ?? "ready"}).`
      : action
        ? `Submitted the mint; ${status.note ?? status.state}. Poll advance_bridge again to confirm.`
        : `In flight: ${status.note ?? status.state}. Poll advance_bridge again.`,
  };
}
