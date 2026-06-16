// src/bridge/types.ts
// The Bridge adapter contract. Two directly-wired, individually-vetted bridges
// implement it: CCTP V2 (USDC primary, burn-and-mint, no pool/wrapped token) and
// deBridge DLN (secondary / non-USDC / Solana fallback, no-auth create-tx).
// LayerZero/Stargate are excluded (May-2026 $292M KelpDAO exploit, 1-of-1 DVN).
//
// RECIPIENT INVARIANT (and its honest ceiling):
//   Both protocols expose an ARBITRARY-RECIPIENT primitive — CCTP depositForBurn
//   takes a caller-chosen mintRecipient; deBridge create-tx takes caller-chosen
//   dstChainTokenOutRecipient AND two *OrderAuthorityAddress fields AND optional
//   affiliateFee* skim params. Build-time "pinning" only fixes the recipient the
//   BUILDER chose; it does NOT stop a code-exec'd agent from building a fresh
//   depositForBurn(mintRecipient=attacker) with the local key directly. So:
//
//   - The builder reads the recipient ONLY from the sealed treasury (withdraws)
//     or an allowlisted thin-wallet (rebalances) — never an agent argument.
//   - For deBridge, srcChainOrderAuthorityAddress AND dstChainOrderAuthorityAddress
//     are pinned to user-controlled addresses (NOT agent-supplied), and
//     affiliateFeePercent is forced 0 / affiliateFeeRecipient stripped. Otherwise
//     a rogue agent sets dstChainOrderAuthorityAddress=attacker and cancels the
//     order to itself, or skims up to ~99% via the affiliate fee.
//   - validate_intent RE-DECODES the returned calldata and asserts every address
//     field == an allowlisted address and the affiliate fee == 0, BEFORE the
//     artifact is handed out for signing. The third-party API's pinning is never
//     trusted; it is re-verified locally.
//
//   This is protocol-level immutability AFTER burn, NOT protocol-level proof that
//   the chosen address is the user's. The latter requires the EVM Tier-1 smart
//   account (validator rejects depositForBurn unless mintRecipient==treasury) or
//   the Solana Squads spending-limit account. Documented, not hidden.

import type { Chain } from "../adapters/types.js";

export type BridgeProvider = "cctp" | "debridge";

/**
 * CCTP finality lane. minFinalityThreshold <= 1000 => FAST (Iris attests at the
 * CONFIRMED/soft level; ~8-20s; Circle bears reorg loss via the Fast Transfer
 * Allowance, NOT the recipient). >= 2000 => STANDARD (FINALIZED level; on
 * Polygon PoS finalized is itself fast, but on ETH/Arb ~13-19min). Withdrawals
 * and large treasury sweeps HARD-REQUIRE STANDARD — never let prose-level
 * latency confusion pick the finality lane.
 */
export type CctpLane = "fast" | "standard";

export interface BridgeRoute {
  fromChain: Chain;
  toChain: Chain;
  /** token symbol; CCTP is USDC-only, deBridge handles the rest. */
  token: string;
  amount: string; // decimal string
  /**
   * Where funds land on the destination. The CALLER passes the sealed-treasury
   * (withdraw) or allowlisted thin-wallet (rebalance) — the bridge builder NEVER
   * derives this from an agent argument. Re-verified by validate_intent.
   */
  recipient: string;
  /** Forced for withdraws/large sweeps; ignored by deBridge. */
  lane?: CctpLane;
}

export interface BridgeQuote {
  provider: BridgeProvider;
  feeUsd: string;
  etaSec: number;
  /** ALWAYS "0". No tool accepts a fee/skim/affiliate param. */
  starlingFeeUsd: "0";
  lane?: CctpLane;
  /** finality threshold the route WILL execute at — surfaced so a caller can't
   *  mistake a fast lane for a finalized one. */
  finalityThresholdExecuted?: 1000 | 2000;
  /** true on the Fast lane: pre-hard-finality mint; gate new-position opens. */
  reorgExposed: boolean;
}

/** An unsigned step the LOCAL signer signs + broadcasts. */
export interface UnsignedBridgeTx {
  chain: Chain;
  kind: "evmTx" | "solanaTx";
  /** EVM: {to,data,value}. Solana: base64 unsigned VersionedTransaction. */
  payload: Record<string, unknown> | string;
  /** Human label for the lifecycle log: "approve" | "depositForBurn" |
   *  "receiveMessage" | "dlnCreate" | "dlnCancel". */
  label: string;
}

export type BridgeFlightState =
  | "burn_pending" // source tx not yet confirmed
  | "attestation_pending" // CCTP: burn confirmed, Iris not yet attested
  | "attestation_sla_exceeded" // CCTP: Iris slow past SLA (centralized dep) — consider failover
  | "mint_pending" // CCTP: attested but receiveMessage not landed (ACTIONABLE: re-drive)
  | "fill_pending" // deBridge: order open, solver hasn't filled
  | "stuck_cancellable" // deBridge: unprofitable/expired — cancel on dest chain
  | "ready" // funds landed AND (for trading) venue preconditions met
  | "failed";

export interface BridgeStatus {
  provider: BridgeProvider;
  state: BridgeFlightState;
  /**
   * readyToTrade is a function of the FULL venue precondition set, NOT just a
   * mint balance delta. For Polymarket: native-USDC landed -> converted to the
   * wrap source -> wrapped to pUSD -> pUSD+CTF approvals on-chain -> deposit-wallet
   * registry confirmed. A bare USDC-mint-confirmed flip green-lights open_position
   * ~3 steps before the venue is actually tradable (maker_not_allowed). Defined
   * via check_venue_status returning an empty blockers[].
   */
  readyToTrade: boolean;
  blockers: string[];
  note?: string;
}

export interface Bridge {
  readonly provider: BridgeProvider;
  quote(route: BridgeRoute): Promise<BridgeQuote>;
  /** Build the inbound bridge (CCTP: [approve?, depositForBurn]; deBridge: [create]). */
  buildBridgeIn(route: BridgeRoute): Promise<UnsignedBridgeTx[]>;
  /** Build the outbound/return bridge (withdraw cross-chain). */
  buildBridgeOut(route: BridgeRoute): Promise<UnsignedBridgeTx[]>;
  /**
   * Re-drive a stuck transfer. CCTP: rebuild receiveMessage when burn confirmed
   * but mint overdue (destinationCaller=bytes32(0) => permissionless, self-
   * recoverable). deBridge: build the destination-chain cancel-tx signed by the
   * user-controlled dstChainOrderAuthorityAddress to unlock source funds. Never
   * strands funds — this is the refund path the spec mandates.
   */
  recover(route: BridgeRoute, flightId: string): Promise<UnsignedBridgeTx[]>;
  /** Poll provider + CONFIRM the destination effect ON-CHAIN before "ready". */
  status(flightId: string): Promise<BridgeStatus>;
}
