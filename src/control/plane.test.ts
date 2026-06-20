// src/control/plane.test.ts
// Locks the dashboard kill-switch classification (haltBlocks, the pure no-I/O core of
// isHaltBlocked): trade ENTRY + the DEPOSIT side of vault/stake are blocked; all
// risk-reducing / fund-homing / read tools stay allowed so the user can always get
// flat + get funds out while halted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { haltBlocks } from "./plane.js";

test("haltBlocks: every trade-entry tool is blocked", () => {
  for (const t of [
    "open_position", "hl_order", "hl_twap", "jup_pred_buy",
    "jup_limit_create", "jup_recurring_create", "jup_lend_deposit", "jup_lend_borrow",
  ]) {
    assert.equal(haltBlocks(t), true, `${t} should be blocked`);
  }
});

test("haltBlocks: vault/stake blocked on DEPOSIT, allowed on WITHDRAW (arg-aware)", () => {
  assert.equal(haltBlocks("hl_vault_transfer", { isDeposit: true }), true);
  assert.equal(haltBlocks("hl_vault_transfer", { isDeposit: false }), false);
  assert.equal(haltBlocks("hl_stake", { direction: "deposit" }), true);
  assert.equal(haltBlocks("hl_stake", { direction: "withdraw" }), false);
  // no/garbled args => treat as not-a-deposit (don't block the exit path on bad input)
  assert.equal(haltBlocks("hl_vault_transfer"), false);
  assert.equal(haltBlocks("hl_stake", {}), false);
});

test("haltBlocks: risk-reducing / fund-homing / read tools are NOT blocked", () => {
  for (const t of [
    "close_position", "hl_cancel", "jup_limit_cancel", "jup_recurring_cancel",
    "jup_pred_exit", "jup_pred_claim", "jup_lend_withdraw", "build_withdraw",
    "pm_withdraw", "hl_bridge_out", "transfer", "advance_bridge", "ensure_gas",
    "hl_update_leverage", "hl_update_isolated_margin", "hl_usd_class_transfer",
    "hl_delegate", "get_quote", "list_positions", "hl_account", "jup_lend_markets",
  ]) {
    assert.equal(haltBlocks(t), false, `${t} should stay allowed while halted`);
  }
});
