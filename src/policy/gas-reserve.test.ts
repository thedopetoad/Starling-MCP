// src/policy/gas-reserve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { gasReserveFloor, gasReserveStatus } from "./gas-reserve.js";

test("default floors are the bridge-out cost per chain", () => {
  assert.equal(gasReserveFloor("solana").native, "0.02");
  assert.equal(gasReserveFloor("solana").symbol, "SOL");
  assert.equal(gasReserveFloor("polygon").native, "0.15");
  assert.equal(gasReserveFloor("hyperliquid").native, "0.003");
  assert.equal(gasReserveFloor("hyperliquid").symbol, "ETH");
});

test("STARLING_GAS_RESERVE_<CHAIN> overrides the floor", () => {
  process.env.STARLING_GAS_RESERVE_SOLANA = "0.05";
  assert.equal(gasReserveFloor("solana").native, "0.05");
  delete process.env.STARLING_GAS_RESERVE_SOLANA;
  assert.equal(gasReserveFloor("solana").native, "0.02"); // back to default
});

test("a garbage override is ignored (falls back to default)", () => {
  process.env.STARLING_GAS_RESERVE_POLYGON = "lots";
  assert.equal(gasReserveFloor("polygon").native, "0.15");
  delete process.env.STARLING_GAS_RESERVE_POLYGON;
});

test("status: above floor is ok, not critical", () => {
  const s = gasReserveStatus("solana", 0.5);
  assert.equal(s.ok, true);
  assert.equal(s.critical, false);
  assert.equal(s.blocker, undefined);
  assert.match(s.note, /above the 0.02 SOL/);
});

test("status: below floor flags the strand-trap", () => {
  const s = gasReserveStatus("solana", 0.006); // the live trap value
  assert.equal(s.ok, false);
  assert.equal(s.critical, true); // 0.006 < 0.8*0.02
  assert.equal(s.blocker, "below_gas_out_reserve");
  assert.match(s.note, /BELOW the 0.02 SOL bridge-out reserve/);
  assert.match(s.note, /STRANDED/);
});

test("status: between 80% and 100% of floor is not-ok but not critical", () => {
  const s = gasReserveStatus("polygon", 0.13); // 0.8*0.15=0.12 <= 0.13 < 0.15
  assert.equal(s.ok, false);
  assert.equal(s.critical, false);
});

test("status: the live Arbitrum trap value is critical", () => {
  const s = gasReserveStatus("hyperliquid", 0.00051);
  assert.equal(s.ok, false);
  assert.equal(s.critical, true);
});
