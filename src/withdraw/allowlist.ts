// src/withdraw/allowlist.ts
// The withdraw destination guardrail.
//
// ---------------------------------------------------------------------------
// HONEST CEILING (read this before you trust this module):
//
// This is a Tier-0 GUARDRAIL, NOT a cryptographic control. It protects against
// an HONEST agent that voluntarily routes withdrawals through build_withdraw_tx,
// and against fat-finger / wrong-address mistakes. It does NOT stop a rogue or
// code-exec'd agent: that agent holds the same in-process signer (signDigest /
// signBytes sign ARBITRARY bytes) and can construct a raw ERC-20/SPL transfer to
// an attacker without ever calling this code. See README "Threat model".
//
// The ONLY cryptographic withdraw constraints in this stack are:
//   (1) Hyperliquid approveAgent — the agent key is PROTOCOL-blocked from
//       withdraw3 and lands funds at the master's own address. Free, today.
//   (2) Tier-1 smart accounts — ZeroDev Kernel CallPolicy (EVM) / Squads
//       Spending Limit (Solana) enforce recipient==treasury ON-CHAIN.
//
// What this module DOES buy you, cheaply:
//   - The withdraw tool takes NO recipient argument from the agent. The
//     destination is read ONLY from the sealed treasury. "send to address X"
//     is not an expressible capability through the tool surface.
//   - Binding the treasury into the keystore AAD makes an on-disk treasury
//     rewrite TAMPER-EVIDENT: decrypt throws instead of silently signing to a
//     swapped address. (Tamper-EVIDENT, not tamper-RESISTANT — a process that
//     already holds the decrypted key ignores this module entirely.)
// ---------------------------------------------------------------------------

import type { Chain } from "../adapters/types.js";

/** A per-chain sweep destination, read from the decrypted+authenticated keystore. */
export interface SealedTreasury {
  /** Authenticated address per chain. Missing chain => withdraws on it refused. */
  byChain: Partial<Record<Chain, string>>;
  /**
   * True only when the treasury was recovered from inside the AEAD-authenticated
   * keystore (AAD-bound). If false (e.g. legacy plaintext config fallback) the
   * caller MUST refuse to build a withdraw and tell the user to re-run setup.
   */
  sealed: boolean;
}

export class WithdrawError extends Error {
  constructor(
    readonly code:
      | "treasury_not_sealed"
      | "no_treasury_for_chain"
      | "recipient_not_allowed"
      | "amount_exceeds_cap",
    message: string,
  ) {
    super(message);
    this.name = "WithdrawError";
  }
}

export interface WithdrawRequest {
  chain: Chain;
  /** decimal string token amount; validated against the per-call cap. */
  amount: string;
  /** Per-call ceiling (decimal string). Set from risk limits, not the agent. */
  maxPerCall: string;
}

export interface ResolvedWithdraw {
  chain: Chain;
  /** The ONLY destination a withdraw may target — the sealed treasury. */
  recipient: string;
  amount: string;
}

/**
 * Resolve the (only) legal recipient for a withdraw. Deliberately takes NO
 * recipient parameter: the destination is the sealed treasury for the chain or
 * the build is refused. This is the single chokepoint build_withdraw_tx uses.
 *
 * Throws WithdrawError on: unsealed treasury, no treasury for the chain, or an
 * amount over the per-call cap. There is no code path that returns an
 * agent-supplied address.
 */
export function resolveWithdrawRecipient(
  treasury: SealedTreasury,
  req: WithdrawRequest,
): ResolvedWithdraw {
  if (!treasury.sealed) {
    throw new WithdrawError(
      "treasury_not_sealed",
      "Treasury is not sealed into the keystore. Re-run `agent-wallet init` " +
        "with your passphrase to bind a treasury address before withdrawing.",
    );
  }
  const recipient = treasury.byChain[req.chain];
  if (!recipient) {
    throw new WithdrawError(
      "no_treasury_for_chain",
      `No sealed treasury address for chain "${req.chain}".`,
    );
  }
  if (cmpDecimal(req.amount, req.maxPerCall) > 0) {
    throw new WithdrawError(
      "amount_exceeds_cap",
      `Withdraw amount ${req.amount} exceeds per-call cap ${req.maxPerCall}.`,
    );
  }
  return { chain: req.chain, recipient, amount: req.amount };
}

/**
 * Independent second check used by validate_intent on a BUILT withdraw: assert
 * the destination encoded in the built artifact equals the sealed treasury.
 * Catches a builder bug or a tampered intent before the artifact is handed out
 * for signing. (Still co-resident with the key — see honest ceiling above.)
 */
export function assertRecipientIsTreasury(
  treasury: SealedTreasury,
  chain: Chain,
  builtRecipient: string,
): void {
  const expected = treasury.byChain[chain];
  if (!treasury.sealed || !expected) {
    throw new WithdrawError(
      "treasury_not_sealed",
      "Cannot validate withdraw recipient: no sealed treasury for chain.",
    );
  }
  if (!sameAddress(chain, builtRecipient, expected)) {
    throw new WithdrawError(
      "recipient_not_allowed",
      `Built withdraw recipient ${builtRecipient} != sealed treasury ${expected}.`,
    );
  }
}

/** Case-insensitive for EVM (checksum-agnostic); exact for base58 (Solana). */
function sameAddress(chain: Chain, a: string, b: string): boolean {
  if (chain === "solana") return a === b; // base58 is case-significant
  return a.toLowerCase() === b.toLowerCase();
}

/** Compare two non-negative decimal strings without floats. >0 if a>b, etc. */
export function cmpDecimal(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const aI = ai.replace(/^0+/, "") || "0";
  const bI = bi.replace(/^0+/, "") || "0";
  if (aI.length !== bI.length) return aI.length < bI.length ? -1 : 1;
  if (aI !== bI) return aI < bI ? -1 : 1;
  const len = Math.max(af.length, bf.length);
  const aFrac = af.padEnd(len, "0");
  const bFrac = bf.padEnd(len, "0");
  if (aFrac === bFrac) return 0;
  return aFrac < bFrac ? -1 : 1;
}
