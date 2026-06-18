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
//     destination is read ONLY from a pinned source. "send to address X"
//     is not an expressible capability through the tool surface.
//   - Binding the treasury into the keystore AAD makes an on-disk treasury
//     rewrite TAMPER-EVIDENT: decrypt throws instead of silently signing to a
//     swapped address. (Tamper-EVIDENT, not tamper-RESISTANT — a process that
//     already holds the decrypted key ignores this module entirely.)
//
// TWO DESTINATION SOURCES (see chainSource()):
//   - "keystore": the AAD-sealed treasury above (strongest; tamper-evident).
//   - "dashboard": a per-chain address the HUMAN pasted into the Starling
//     dashboard, written to ~/.starling/treasury.json (see withdraw/pinned-file.ts).
//     Its value is UX + TRANSCRIPTION INTEGRITY: the user's exact pasted bytes
//     reach disk without the agent ever re-typing the 40/44-char string into a
//     config (where it could corrupt one character). It is NOT a security
//     control — a code-exec'd agent can rewrite that file (same ceiling above).
//     The 4-byte commitment we surface is a transcription check the human
//     eyeballs, not a cryptographic one. So `sealed` stays true ONLY for the
//     keystore source; the dashboard source is allowed for WITHDRAWS but carries
//     sealed=false. Funding-IN recipients stay keystore-only (tools/index.ts).
//     A keystore and a dashboard pin that DISAGREE on a chain => "conflict" =>
//     the withdraw is refused (fail-closed) until the human resolves it.
// ---------------------------------------------------------------------------

import type { Chain } from "../adapters/types.js";

/**
 * Where a chain's withdraw destination came from. Drives the withdraw/funding-in
 * split and honest reporting in auth_check:
 *   - "keystore"  — the AAD-sealed treasury (strongest, tamper-evident).
 *   - "dashboard" — a human-pasted address from ~/.starling/treasury.json.
 *   - "conflict"  — keystore and dashboard disagree for this chain (refuse).
 *   - "none"      — no destination set for this chain.
 */
export type TreasurySource = "keystore" | "dashboard" | "none" | "conflict";

/** A per-chain sweep destination, read from the keystore and/or the pinned file. */
export interface SealedTreasury {
  /** Resolved address per chain. Missing chain => withdraws on it refused. */
  byChain: Partial<Record<Chain, string>>;
  /**
   * True only when the treasury was recovered from inside the AEAD-authenticated
   * keystore (AAD-bound). NEVER set true for the dashboard-pinned file — `sealed`
   * means cryptographic tamper-evidence and nothing else. A dashboard-only
   * destination carries sealed=false but is still withdraw-eligible via
   * sourceByChain.
   */
  sealed: boolean;
  /**
   * Per-chain provenance. OPTIONAL so legacy callers/tests that build
   * {sealed, byChain} still compile — chainSource() derives the source from
   * `sealed` + presence when this is absent. mergeTreasury() always sets it.
   */
  sourceByChain?: Partial<Record<Chain, TreasurySource>>;
}

/**
 * The provenance of one chain's destination. Prefers the explicit per-chain
 * mark from mergeTreasury(); falls back to the legacy rule (sealed keystore vs
 * nothing) so old {sealed, byChain} values behave exactly as before.
 */
export function chainSource(t: SealedTreasury, chain: Chain): TreasurySource {
  const explicit = t.sourceByChain?.[chain];
  if (explicit) return explicit;
  if (!t.byChain[chain]) return "none";
  return t.sealed ? "keystore" : "none";
}

/** A source whose address a WITHDRAW may sweep to (keystore or dashboard). */
export function canWithdraw(src: TreasurySource): boolean {
  return src === "keystore" || src === "dashboard";
}

/** True if ANY chain has a withdraw-eligible destination (keystore or dashboard). */
function anyChainWithdrawable(t: SealedTreasury): boolean {
  const chains = new Set<Chain>([
    ...(Object.keys(t.byChain) as Chain[]),
    ...((t.sourceByChain ? Object.keys(t.sourceByChain) : []) as Chain[]),
  ]);
  for (const c of chains) if (canWithdraw(chainSource(t, c))) return true;
  return false;
}

export class WithdrawError extends Error {
  constructor(
    readonly code:
      | "treasury_not_sealed"
      | "no_treasury_for_chain"
      | "recipient_not_allowed"
      | "amount_exceeds_cap"
      | "treasury_conflict",
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
 * recipient parameter: the destination is the pinned treasury for the chain
 * (keystore-sealed OR dashboard-pinned) or the build is refused. This is the
 * single chokepoint build_withdraw uses.
 *
 * Throws WithdrawError on: a keystore/dashboard conflict, no destination
 * anywhere, no destination for the chain, or an amount over the per-call cap.
 * There is no code path that returns an agent-supplied address.
 */
export function resolveWithdrawRecipient(
  treasury: SealedTreasury,
  req: WithdrawRequest,
): ResolvedWithdraw {
  const src = chainSource(treasury, req.chain);
  if (src === "conflict") {
    throw new WithdrawError(
      "treasury_conflict",
      `Withdraw destination conflict for "${req.chain}": the keystore-sealed treasury and the ` +
        "dashboard-pinned address disagree. Resolve it (delete the stale entry in " +
        "~/.starling/treasury.json, or re-seal at `agent-wallet init`) before withdrawing.",
    );
  }
  if (!canWithdraw(src)) {
    // Distinguish "nothing set anywhere" from "set, but not for this chain" so
    // the existing error vocabulary stays stable.
    if (!anyChainWithdrawable(treasury)) {
      throw new WithdrawError(
        "treasury_not_sealed",
        "No withdraw destination is set. Paste your address into the Starling dashboard " +
          "(`set-treasury`), or seal one at `agent-wallet init`. No agent recipient is accepted.",
      );
    }
    throw new WithdrawError(
      "no_treasury_for_chain",
      `No withdraw destination for chain "${req.chain}".`,
    );
  }
  const recipient = treasury.byChain[req.chain];
  if (!recipient) {
    throw new WithdrawError(
      "no_treasury_for_chain",
      `No withdraw destination for chain "${req.chain}".`,
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
  const src = chainSource(treasury, chain);
  const expected = treasury.byChain[chain];
  if (src === "conflict") {
    throw new WithdrawError(
      "treasury_conflict",
      `Cannot validate withdraw recipient for "${chain}": keystore and dashboard pin disagree.`,
    );
  }
  if (!canWithdraw(src) || !expected) {
    throw new WithdrawError(
      "treasury_not_sealed",
      "Cannot validate withdraw recipient: no withdraw destination set for chain.",
    );
  }
  if (!sameAddress(chain, builtRecipient, expected)) {
    throw new WithdrawError(
      "recipient_not_allowed",
      `Built withdraw recipient ${builtRecipient} != withdraw destination ${expected}.`,
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
