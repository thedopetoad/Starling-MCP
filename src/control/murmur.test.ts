// Regression lock for Bug 2 (murmur_close over-liquidation). The realized proceeds
// of a fractional close must never exceed the slice's MARKED value, so a non-close
// pUSD inflow during the close window (concurrent deposit/sweep/trade) can't inflate
// realized and over-drain idle — the failure that crashed a prior withdrawal's NAV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capRealizedProceeds } from "./murmur.js";

test("capRealizedProceeds: honest sell under the marked cap pays true realized", () => {
  // Sold a slice marked at $3.00; the book returned $2.94 after slippage.
  assert.equal(capRealizedProceeds(2_940000n, 3_000000n), 2_940000n);
});

test("capRealizedProceeds: polluted delta is clamped to the marked slice (the incident)", () => {
  // A 5.8% slice was marked ~$3, but the raw pUSD delta read ~$45 because a deposit
  // swept in during the close. Realized must clamp to the marked slice, not $45.
  const rawDelta = 45_000000n; // non-close inflow polluted the balance delta
  const markedSlice = 3_000000n; // true marked value of the 5.8% slice
  assert.equal(capRealizedProceeds(rawDelta, markedSlice), markedSlice);
});

test("capRealizedProceeds: exact-at-cap passes through", () => {
  assert.equal(capRealizedProceeds(5_000000n, 5_000000n), 5_000000n);
});

test("capRealizedProceeds: zero proceeds stay zero", () => {
  assert.equal(capRealizedProceeds(0n, 3_000000n), 0n);
});
