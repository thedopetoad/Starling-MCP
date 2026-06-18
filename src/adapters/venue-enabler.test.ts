// src/adapters/venue-enabler.test.ts
// The real VenueEnabler: PM emits the scoped approval txs (the precondition a FAK
// fill needs to settle), refuses without a budget, and HL reports nothing to sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnlock } from "../signers/index.js";
import { makeRealVenueEnabler } from "./venue-enabler.js";

process.env.STARLING_KEY_SOURCE = "env";
process.env.STARLING_PK_POLYGON = "0x0000000000000000000000000000000000000000000000000000000000000001";
// These cases exercise the LEGACY bare-EOA enable path (unsigned approval txs). The
// default is now deposit-wallet mode (gasless relayer); see the DW-mode case below.
process.env.STARLING_PM_DEPOSIT_WALLET = "false";
await bootUnlock();

const enabler = makeRealVenueEnabler();

test("polymarket without a budget refuses with a clear blocker", async () => {
  delete process.env.STARLING_PM_COLLATERAL_BUDGET;
  const r = await enabler.enable("polymarket");
  assert.equal(r.txs.length, 0);
  assert.match(r.blockers.join(" "), /STARLING_PM_COLLATERAL_BUDGET/);
});

test("polymarket with a budget emits scoped pUSD + CTF approval txs", async () => {
  process.env.STARLING_PM_COLLATERAL_BUDGET = "5";
  delete process.env.STARLING_PM_WRAP_USDCE;
  const r = await enabler.enable("polymarket");
  // 3 pUSD approvals + 3 CTF setApprovalForAll (default includeCtfApprovals).
  assert.equal(r.txs.length, 6);
  assert.equal(r.blockers.length, 0);
  for (const tx of r.txs) {
    assert.equal(tx.chain, "polygon");
    assert.equal(tx.kind, "evmTx");
    const p = tx.payload as { to: string; data: string; value: string };
    assert.match(p.to, /^0x[0-9a-fA-F]{40}$/);
    assert.match(p.data, /^0x[0-9a-f]+$/);
    assert.equal(p.value, "0");
  }
  const labels = r.txs.map((t) => t.label);
  assert.ok(labels.includes("approve-pusd-ctfExchange"));
  assert.ok(labels.includes("ctf-setApprovalForAll-negRiskAdapter"));
});

test("polymarket with a wrap prepends the USDC.e approve + wrap pair", async () => {
  process.env.STARLING_PM_COLLATERAL_BUDGET = "5";
  process.env.STARLING_PM_WRAP_USDCE = "5";
  const r = await enabler.enable("polymarket");
  // + approve-usdce-onramp + wrap-usdce-to-pusd => 8 txs.
  assert.equal(r.txs.length, 8);
  assert.equal(r.txs[0].label, "approve-usdce-onramp");
  assert.equal(r.txs[1].label, "wrap-usdce-to-pusd");
  delete process.env.STARLING_PM_WRAP_USDCE;
});

test("polymarket DEPOSIT-WALLET mode without builder creds refuses with a clear blocker", async () => {
  delete process.env.STARLING_PM_DEPOSIT_WALLET; // default = deposit-wallet mode
  delete process.env.STARLING_PM_BUILDER_API_KEY;
  delete process.env.STARLING_PM_BUILDER_SECRET;
  delete process.env.STARLING_PM_BUILDER_PASSPHRASE;
  const r = await enabler.enable("polymarket");
  assert.equal(r.txs.length, 0);
  assert.equal(r.alreadyEnabled, false);
  assert.match(r.blockers.join(" "), /builder creds/);
  assert.match(r.note ?? "", /STARLING_PM_BUILDER_API_KEY/);
  process.env.STARLING_PM_DEPOSIT_WALLET = "false"; // restore for any later cases
});

test("hyperliquid reports already-enabled (no approval txs)", async () => {
  const r = await enabler.enable("hyperliquid");
  assert.equal(r.alreadyEnabled, true);
  assert.equal(r.txs.length, 0);
  assert.match(r.note ?? "", /master key/);
});
