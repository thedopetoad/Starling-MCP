// src/policy/limits.test.ts — run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOpen, addDecimal, type RiskLimits, type DailyUsage } from "./limits.js";

const LIMITS: RiskLimits = {
  perTradeMaxUsd: "500",
  dailyNotionalCapUsd: "2000",
  dailyLossCapUsd: "300",
  killSwitch: false,
};
const FRESH: DailyUsage = { dayKey: "2026-06-15", openedNotionalUsd: "0", realizedLossUsd: "0" };

test("kill switch blocks every open", () => {
  const d = checkOpen("1", { ...LIMITS, killSwitch: true }, FRESH);
  assert.equal(d.allowed, false);
  assert.equal(d.allowed === false && d.code, "kill_switch_on");
});

test("non-decimal amount is rejected", () => {
  const d = checkOpen("not-a-number", LIMITS, FRESH);
  assert.equal(d.allowed === false && d.code, "bad_amount");
});

test("per-trade cap: over is blocked, exactly-at-cap is allowed", () => {
  assert.equal(checkOpen("500.01", LIMITS, FRESH).allowed, false);
  assert.equal((checkOpen("500.01", LIMITS, FRESH) as any).code, "per_trade_cap");
  assert.equal(checkOpen("500", LIMITS, FRESH).allowed, true);
});

test("daily notional cap counts prior opens (boundary inclusive)", () => {
  const used: DailyUsage = { ...FRESH, openedNotionalUsd: "1800" };
  // 1800 + 200 = 2000 == cap -> allowed
  assert.equal(checkOpen("200", LIMITS, used).allowed, true);
  // 1800 + 200.01 = 2000.01 > cap -> blocked
  const d = checkOpen("200.01", LIMITS, used);
  assert.equal(d.allowed === false && d.code, "daily_notional_cap");
});

test("daily-loss halt stops new opens once loss >= cap", () => {
  const losing: DailyUsage = { ...FRESH, realizedLossUsd: "300" };
  const d = checkOpen("1", LIMITS, losing);
  assert.equal(d.allowed === false && d.code, "daily_loss_halt");
  // just under the cap still trades
  assert.equal(checkOpen("1", LIMITS, { ...FRESH, realizedLossUsd: "299.99" }).allowed, true);
});

test("a cap of '0' means unlimited / disabled", () => {
  const off: RiskLimits = { perTradeMaxUsd: "0", dailyNotionalCapUsd: "0", dailyLossCapUsd: "0", killSwitch: false };
  assert.equal(checkOpen("999999", off, { ...FRESH, realizedLossUsd: "999999" }).allowed, true);
});

test("addDecimal is exact (no float drift)", () => {
  assert.equal(addDecimal("100", "0.01"), "100.01");
  assert.equal(addDecimal("1.5", "1.5"), "3");
  assert.equal(addDecimal("0", "0"), "0");
  assert.equal(addDecimal("0.1", "0.2"), "0.3"); // the classic 0.30000000000000004 float trap
  assert.equal(addDecimal("999999999999.999999", "0.000001"), "1000000000000");
});
