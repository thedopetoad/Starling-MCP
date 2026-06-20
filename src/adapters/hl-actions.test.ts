// src/adapters/hl-actions.test.ts
// Lock the PURE HL action builders to their exact field ORDER. msgpack hashing
// (actionHash) is insertion-order-sensitive, so a reordered key silently breaks the
// L1 signature — these deepEqual + Object.keys assertions are the regression guard.
// The signer itself is vector-locked in hl-signing.test.ts; proven signer + correct
// struct => correct signature.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderWire,
  buildOrderAction,
  buildCancelAction,
  buildCancelByCloidAction,
  buildUpdateLeverageAction,
  buildUpdateIsolatedMarginAction,
  buildVaultTransferAction,
  buildTwapOrderAction,
  buildTwapCancelAction,
  usdToMicro,
  toWei,
  isCloid,
} from "./hl-actions.js";
import { packb } from "./hl-msgpack.js";

const CLOID = "0x" + "a".repeat(32);

test("buildOrderWire (limit) matches the SDK order wire byte-for-byte", () => {
  const w = buildOrderWire({ assetIndex: 1, isBuy: true, px: 100, sz: 100, reduceOnly: false, tif: "Gtc" });
  // Identical to ORDER_ACTION's order in hl-signing.test.ts (the vector-locked shape).
  assert.deepEqual(Object.keys(w), ["a", "b", "p", "s", "r", "t"]);
  assert.deepEqual(w, { a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } });
});

test("buildOrderWire defaults tif to Gtc when neither tif nor trigger is given", () => {
  const w = buildOrderWire({ assetIndex: 0, isBuy: true, px: 1, sz: 1, reduceOnly: false });
  assert.deepEqual(w.t, { limit: { tif: "Gtc" } });
});

test("buildOrderWire (trigger) keys the order-type as isMarket,triggerPx,tpsl", () => {
  const w = buildOrderWire({ assetIndex: 0, isBuy: false, px: 50, sz: 0.1, reduceOnly: true, trigger: { triggerPx: 55, isMarket: true, tpsl: "sl" } });
  const t = w.t as { trigger: Record<string, unknown> };
  assert.deepEqual(Object.keys(t.trigger), ["isMarket", "triggerPx", "tpsl"]);
  assert.deepEqual(w.t, { trigger: { isMarket: true, triggerPx: "55", tpsl: "sl" } });
});

test("buildOrderWire appends cloid as the LAST key (c)", () => {
  const w = buildOrderWire({ assetIndex: 1, isBuy: true, px: 100, sz: 100, reduceOnly: false, tif: "Ioc", cloid: CLOID });
  assert.deepEqual(Object.keys(w), ["a", "b", "p", "s", "r", "t", "c"]);
  assert.equal(w.c, CLOID);
});

test("buildOrderAction frames {type, orders, grouping}", () => {
  const a = buildOrderAction([buildOrderWire({ assetIndex: 1, isBuy: true, px: 100, sz: 100, reduceOnly: false, tif: "Gtc" })]);
  assert.deepEqual(Object.keys(a), ["type", "orders", "grouping"]);
  assert.equal(a.type, "order");
  assert.equal(a.grouping, "na");
  // msgpack: fixmap with 3 entries (matches hl-signing.test.ts framing assertion).
  assert.equal(packb(a)[0], 0x83);
});

test("buildCancelAction -> {type, cancels:[{a,o}]}", () => {
  const a = buildCancelAction([{ assetIndex: 3, oid: 99 }]);
  assert.deepEqual(a, { type: "cancel", cancels: [{ a: 3, o: 99 }] });
  assert.deepEqual(Object.keys((a.cancels as Record<string, unknown>[])[0]), ["a", "o"]);
});

test("buildCancelByCloidAction -> {type, cancels:[{asset,cloid}]}", () => {
  const a = buildCancelByCloidAction([{ assetIndex: 3, cloid: CLOID }]);
  assert.deepEqual(a, { type: "cancelByCloid", cancels: [{ asset: 3, cloid: CLOID }] });
});

test("buildUpdateLeverageAction -> {type, asset, isCross, leverage}", () => {
  assert.deepEqual(buildUpdateLeverageAction(3, true, 5), { type: "updateLeverage", asset: 3, isCross: true, leverage: 5 });
  assert.throws(() => buildUpdateLeverageAction(3, true, 0), /positive integer/);
});

test("buildUpdateIsolatedMarginAction -> {type, asset, isBuy:true, ntli} (signed micro-USD)", () => {
  assert.deepEqual(buildUpdateIsolatedMarginAction(3, 5_000_000), { type: "updateIsolatedMargin", asset: 3, isBuy: true, ntli: 5_000_000 });
  assert.deepEqual(buildUpdateIsolatedMarginAction(3, -2_000_000).ntli, -2_000_000); // remove margin
});

test("buildVaultTransferAction -> {type, vaultAddress, isDeposit, usd}", () => {
  const vault = "0x" + "1".repeat(40);
  assert.deepEqual(buildVaultTransferAction(vault, true, 20_000_000), { type: "vaultTransfer", vaultAddress: vault, isDeposit: true, usd: 20_000_000 });
  assert.throws(() => buildVaultTransferAction("0xnope", true, 1), /20-byte hex/);
});

test("buildTwapOrderAction -> {type, twap:{a,b,s,r,m,t}}", () => {
  const a = buildTwapOrderAction({ assetIndex: 0, isBuy: true, sz: 1.5, reduceOnly: false, minutes: 30, randomize: true });
  assert.deepEqual(a, { type: "twapOrder", twap: { a: 0, b: true, s: "1.5", r: false, m: 30, t: true } });
  assert.deepEqual(Object.keys((a.twap as Record<string, unknown>)), ["a", "b", "s", "r", "m", "t"]);
});

test("buildTwapCancelAction -> {type, a, t}", () => {
  assert.deepEqual(buildTwapCancelAction(0, 7), { type: "twapCancel", a: 0, t: 7 });
});

test("scaled-unit helpers: usdToMicro + toWei", () => {
  assert.equal(usdToMicro(20), 20_000_000);
  assert.equal(usdToMicro(-5), -5_000_000);
  assert.equal(usdToMicro(1.234567), 1_234_567);
  assert.equal(toWei(0.1, 8), 10_000_000); // HYPE staking unit
  assert.equal(toWei(1, 8), 100_000_000);
});

test("isCloid validates the 0x+32hex client-order-id shape", () => {
  assert.equal(isCloid(CLOID), true);
  assert.equal(isCloid("0x123"), false);
  assert.equal(isCloid("nope"), false);
});
