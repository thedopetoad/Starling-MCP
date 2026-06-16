// src/policy/limits.ts
// The local policy/guardrail engine that sits ABOVE the signer.
//
// The ecosystem scan's #1 cross-cutting finding: every venue SDK signs whatever
// it's handed — none enforce limits. This is the layer that says NO *before* an
// order is built for signing. Three independent, decimal-safe checks plus a hard
// manual halt:
//   - per-trade notional cap
//   - rolling daily notional cap (sum of opens in the current UTC day)
//   - daily-loss kill-switch (halt new opens once today's realized loss >= cap)
//   - killSwitch (operator panic stop)
//
// Withdraw DESTINATION is enforced separately (withdraw/allowlist.ts: sweep only
// to the sealed treasury). Together these BOUND THE BLAST RADIUS of a rogue or
// over-eager agent. They are guardrails against honest-but-buggy behaviour, NOT a
// cryptographic control against code-exec on the box (see README threat model).
import { cmpDecimal } from "../withdraw/allowlist.js";

export interface RiskLimits {
  /** max notional (USD, decimal string) for one open. "0" = no per-trade cap. */
  perTradeMaxUsd: string;
  /** max cumulative notional opened per UTC day. "0" = no daily cap. */
  dailyNotionalCapUsd: string;
  /** halt new opens once today's realized loss >= this. "0" = no kill-switch. */
  dailyLossCapUsd: string;
  /** hard manual halt — when true, refuse ALL opens. */
  killSwitch: boolean;
}

export interface DailyUsage {
  /** UTC day key the counters belong to; caller zeroes them when it rolls over. */
  dayKey: string;
  /** sum of notional opened so far today (decimal string). */
  openedNotionalUsd: string;
  /** today's realized loss as a POSITIVE number (decimal string); "0" if flat/up. */
  realizedLossUsd: string;
}

export type PolicyCode =
  | "kill_switch_on"
  | "per_trade_cap"
  | "daily_notional_cap"
  | "daily_loss_halt"
  | "bad_amount";

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: PolicyCode; message: string };

const NON_NEG_DECIMAL = /^\d+(\.\d+)?$/;
function isNonNegDecimal(s: string): boolean {
  return NON_NEG_DECIMAL.test(s);
}
/** A cap of "0" (any zero form) means "unlimited / disabled". */
function unlimited(cap: string): boolean {
  return isNonNegDecimal(cap) && cmpDecimal(cap, "0") === 0;
}

/** Add two non-negative decimal strings exactly (BigInt-scaled; no float drift). */
export function addDecimal(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const len = Math.max(af.length, bf.length);
  const scaled = BigInt(ai + af.padEnd(len, "0")) + BigInt(bi + bf.padEnd(len, "0"));
  if (len === 0) return scaled.toString();
  const s = scaled.toString().padStart(len + 1, "0");
  const intPart = s.slice(0, s.length - len);
  const frac = s.slice(s.length - len).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

/** Multiply two non-negative decimal strings exactly (BigInt-scaled; no float drift). */
export function mulDecimal(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = af.length + bf.length;
  const prod = BigInt((ai + af) || "0") * BigInt((bi + bf) || "0");
  if (scale === 0) return prod.toString();
  const s = prod.toString().padStart(scale + 1, "0");
  const intPart = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

/**
 * The USD notional of an open, for the cap checks. Polymarket BUY amounts are
 * already collateral USD; everything denominated in shares/contracts is
 * shares * price. Decimal-exact.
 */
export function openNotionalUsd(
  amount: string,
  amountKind: "collateral" | "shares",
  price: string,
): string {
  return amountKind === "collateral" ? amount : mulDecimal(amount, price);
}

/**
 * Decide whether an OPEN of `amountUsd` notional is allowed under `limits`,
 * given today's `usage`. Caller passes the trade's USD notional (already
 * normalized to collateral USD). Pure; no wall-clock, no I/O.
 */
export function checkOpen(
  amountUsd: string,
  limits: RiskLimits,
  usage: DailyUsage,
): PolicyDecision {
  if (limits.killSwitch) {
    return { allowed: false, code: "kill_switch_on", message: "Trading is halted by the kill switch." };
  }
  if (!isNonNegDecimal(amountUsd)) {
    return { allowed: false, code: "bad_amount", message: `amount "${amountUsd}" is not a non-negative decimal.` };
  }
  if (!unlimited(limits.dailyLossCapUsd) && cmpDecimal(usage.realizedLossUsd, limits.dailyLossCapUsd) >= 0) {
    return {
      allowed: false,
      code: "daily_loss_halt",
      message: `Today's realized loss ${usage.realizedLossUsd} reached the daily-loss cap ${limits.dailyLossCapUsd}; new opens halted until the next UTC day.`,
    };
  }
  if (!unlimited(limits.perTradeMaxUsd) && cmpDecimal(amountUsd, limits.perTradeMaxUsd) > 0) {
    return {
      allowed: false,
      code: "per_trade_cap",
      message: `Open of ${amountUsd} exceeds the per-trade cap ${limits.perTradeMaxUsd}.`,
    };
  }
  if (!unlimited(limits.dailyNotionalCapUsd)) {
    const projected = addDecimal(usage.openedNotionalUsd, amountUsd);
    if (cmpDecimal(projected, limits.dailyNotionalCapUsd) > 0) {
      return {
        allowed: false,
        code: "daily_notional_cap",
        message: `Open would bring today's notional to ${projected}, over the daily cap ${limits.dailyNotionalCapUsd}.`,
      };
    }
  }
  return { allowed: true };
}

/** Current UTC day key (YYYY-MM-DD) for rolling the daily counters. */
export function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
