// src/bridge/debridge.test.ts
// Pure-helper correctness for the deBridge leg (no network): decimal scaling
// fails closed on excess precision, approve encoding is a known vector, chain/
// token/sentinel mapping is right, and assertOrderPins rejects skims/errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scaleDecimal,
  toBaseUnits,
  encodeErc20Approve,
  assertOrderPins,
  debridgeChainId,
  usdcOn,
  nativeSentinel,
  NATIVE_SENTINEL_EVM,
  NATIVE_SENTINEL_SOLANA,
  type CreateTxParams,
} from "./debridge.js";

test("scaleDecimal scales and FAILS CLOSED on excess precision", () => {
  assert.equal(scaleDecimal("3", 6), "3000000");
  assert.equal(scaleDecimal("1.5", 6), "1500000");
  assert.equal(scaleDecimal("1.500000", 6), "1500000"); // trailing zeros ok
  assert.throws(() => scaleDecimal("1.5000001", 6)); // 7th significant decimal -> refuse
});

test("toBaseUnits only accepts USDC (6dp)", () => {
  assert.equal(toBaseUnits("3", "USDC"), "3000000");
  assert.throws(() => toBaseUnits("3", "WETH"));
});

test("encodeErc20Approve is a correct selector + padded args", () => {
  const spender = "0x1111111111111111111111111111111111111111";
  const data = encodeErc20Approve(spender, "1000000");
  assert.ok(data.startsWith("0x095ea7b3")); // approve(address,uint256)
  // spender left-padded to 32 bytes
  assert.ok(data.includes("0000000000000000000000001111111111111111111111111111111111111111"));
  // amount 1000000 = 0xf4240, right-most word
  assert.ok(data.endsWith("00000000000000000000000000000000000000000000000000000000000f4240"));
  assert.equal(data.length, 2 + 8 + 64 + 64); // 0x + selector + 2 words
});

test("chain/token/sentinel mapping (hyperliquid -> arbitrum)", () => {
  assert.equal(debridgeChainId("solana"), 7565164);
  assert.equal(debridgeChainId("polygon"), 137);
  assert.equal(debridgeChainId("hyperliquid"), 42161); // HL funds live on Arbitrum
  assert.equal(usdcOn("solana"), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(nativeSentinel("polygon"), NATIVE_SENTINEL_EVM);
  assert.equal(nativeSentinel("solana"), NATIVE_SENTINEL_SOLANA);
});

const pins = (over: Partial<CreateTxParams> = {}): CreateTxParams => ({
  srcChainId: 7565164,
  srcChainTokenIn: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  srcChainTokenInAmount: "3000000",
  dstChainId: 137,
  dstChainTokenOut: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  dstChainTokenOutAmount: "auto",
  dstChainTokenOutRecipient: "0xA6350f11AF9Bd54603EDaB09871737539c35D0e0",
  srcChainOrderAuthorityAddress: "23MGLpSTbgejYmCRHApWkpwJh64sGFjjj4XgxDke8ePA",
  dstChainOrderAuthorityAddress: "0xA6350f11AF9Bd54603EDaB09871737539c35D0e0",
  senderAddress: "23MGLpSTbgejYmCRHApWkpwJh64sGFjjj4XgxDke8ePA",
  affiliateFeePercent: 0,
  ...over,
});

test("assertOrderPins accepts a clean response, rejects skim/error/token-drift", () => {
  const good = { tx: { to: "0xDln", data: "0xabcd" }, estimation: { dstChainTokenOut: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" } } };
  assert.doesNotThrow(() => assertOrderPins(pins(), good));
  // a non-zero affiliate fee must never be requested
  assert.throws(() => assertOrderPins(pins({ affiliateFeePercent: 1 as unknown as 0 }), good));
  // API error surfaces
  assert.throws(() => assertOrderPins(pins(), { errorId: "X", errorMessage: "bad" }));
  // priced output token drifting from what we asked for
  assert.throws(() =>
    assertOrderPins(pins(), { tx: { to: "0xDln", data: "0xabcd" }, estimation: { dstChainTokenOut: { address: "0xDEAD000000000000000000000000000000000000" } } }),
  );
});
