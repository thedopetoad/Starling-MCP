// src/validate/inspect.ts
// Inspect-before-sign: never trust the artifact a builder (ours or a third-party
// bridge API) hands back — RE-DECODE its calldata and assert the destination is
// what we intended, BEFORE the local signer touches it.
//
// This closes the escapes the bridge/withdraw red-team flagged:
//   - a withdraw/bridge whose recipient was swapped to an attacker,
//   - an `approve(attacker, MAX)` smuggled in (the approve+transferFrom drain
//     that a recipient-only check misses — we gate the SPENDER too),
//   - calldata aimed at an unexpected `to` (typosquatted/MITM contract).
//
// Pure functions over viem decoders; no network, no signing. Throws InspectError
// (caught by validate_intent and turned into a structured envelope) on any miss.
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
]);

const CCTP_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);

export class InspectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InspectError";
  }
}

/** Checksum-agnostic address equality; throws via getAddress on a malformed addr. */
export function addrEq(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

/** tx.to MUST be one of the pinned/known contracts (anti typosquat / MITM calldata). */
export function assertTargetAllowed(to: string, allowed: readonly string[]): void {
  if (!allowed.some((a) => addrEq(a, to))) {
    throw new InspectError("target_not_allowed", `tx target ${to} is not a pinned contract`);
  }
}

export function decodeTransfer(data: Hex): { recipient: string; amount: bigint } | null {
  try {
    const d = decodeFunctionData({ abi: ERC20_ABI, data });
    if (d.functionName !== "transfer") return null;
    const [to, amount] = d.args as readonly [string, bigint];
    return { recipient: getAddress(to), amount };
  } catch {
    return null;
  }
}

export function decodeApprove(data: Hex): { spender: string; amount: bigint } | null {
  try {
    const d = decodeFunctionData({ abi: ERC20_ABI, data });
    if (d.functionName !== "approve") return null;
    const [spender, amount] = d.args as readonly [string, bigint];
    return { spender: getAddress(spender), amount };
  } catch {
    return null;
  }
}

/** A withdraw/bridge ERC-20 transfer MUST send to the sealed treasury — nowhere else. */
export function assertTransferToTreasury(data: Hex, treasury: string): void {
  const t = decodeTransfer(data);
  if (!t) throw new InspectError("not_a_transfer", "calldata is not an ERC-20 transfer");
  if (!addrEq(t.recipient, treasury)) {
    throw new InspectError(
      "recipient_not_treasury",
      `transfer recipient ${t.recipient} != sealed treasury ${getAddress(treasury)}`,
    );
  }
}

/**
 * An approve's SPENDER must be an allowlisted venue/bridge contract. Without this,
 * a rogue agent slips in approve(attackerContract, MAX) on a token a
 * recipient-only check would wave through, then drains via transferFrom later.
 */
export function assertApproveSpenderAllowed(data: Hex, allowedSpenders: readonly string[]): void {
  const a = decodeApprove(data);
  if (!a) throw new InspectError("not_an_approve", "calldata is not an ERC-20 approve");
  if (!allowedSpenders.some((s) => addrEq(s, a.spender))) {
    throw new InspectError(
      "approve_spender_not_allowed",
      `approve spender ${a.spender} is not an allowlisted venue/bridge contract`,
    );
  }
}

/** CCTP depositForBurn mintRecipient (bytes32, left-padded) MUST be the treasury. */
export function assertCctpMintRecipient(data: Hex, treasury: string): void {
  let mintRecipient: string;
  try {
    const d = decodeFunctionData({ abi: CCTP_ABI, data });
    if (d.functionName !== "depositForBurn") {
      throw new InspectError("not_deposit_for_burn", "calldata is not depositForBurn");
    }
    mintRecipient = d.args[2] as string; // bytes32
  } catch (e) {
    if (e instanceof InspectError) throw e;
    throw new InspectError("decode_failed", "could not decode depositForBurn calldata");
  }
  // bytes32 -> EVM address is the low 20 bytes (last 40 hex chars).
  const addr = getAddress(`0x${mintRecipient.slice(-40)}`);
  if (!addrEq(addr, treasury)) {
    throw new InspectError(
      "mint_recipient_not_treasury",
      `CCTP mintRecipient ${addr} != sealed treasury ${getAddress(treasury)}`,
    );
  }
}

/** Address -> bytes32 (left-padded), the form CCTP mintRecipient expects. Exported for builders/tests. */
export function addressToBytes32(addr: string): Hex {
  return `0x000000000000000000000000${getAddress(addr).slice(2).toLowerCase()}` as Hex;
}

// Re-export viem encoders so tests/builders can construct calldata without a second import.
export { encodeFunctionData, ERC20_ABI, CCTP_ABI };
