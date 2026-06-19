// src/adapters/polymarket-enable.test.ts
// The deposit-wallet FUNDING builders: the native-USDC -> USDC.e swap and the
// wrap-to-deposit-wallet. These txs MOVE the EOA's bridged USDC, so we decode the
// emitted calldata back and assert the recipient + amounts byte-for-byte (a wrong
// `to` would mint pUSD to the wrong address; a wrong swap recipient would strand it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseUnits } from "viem";
import { buildWrapTxs, buildNativeToUsdceSwapTxs } from "./polymarket-enable.js";
import {
  USDC_E,
  USDC_NATIVE,
  COLLATERAL_ONRAMP,
  UNISWAP_V3_SWAPROUTER02,
  USDC_SWAP_FEE,
} from "./polymarket-constants.js";

const EOA = "0x1111111111111111111111111111111111111111" as const;
const DW = "0x2222222222222222222222222222222222222222" as const;
const lower = (a: unknown) => String(a).toLowerCase();

// Single-function ABIs so the decode is unambiguous (no erc20 union narrowing).
const APPROVE_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const WRAP_ABI = [
  { name: "wrap", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_asset", type: "address" }, { name: "_to", type: "address" }, { name: "_amount", type: "uint256" }], outputs: [] },
] as const;
const EXACT_IN_ABI = [
  { name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
    { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }], outputs: [{ name: "amountOut", type: "uint256" }] },
] as const;

test("buildWrapTxs(recipient=DW) wraps USDC.e and mints pUSD straight to the deposit wallet", () => {
  const txs = buildWrapTxs({ eoa: EOA, amount: "3", asset: "usdce", recipient: DW });
  assert.equal(txs.length, 2);

  // 1. approve USDC.e -> Onramp, SCOPED to 3 (not MAX).
  assert.equal(txs[0].label, "approve-usdce-onramp");
  assert.equal(lower(txs[0].to), lower(USDC_E));
  const ap = decodeFunctionData({ abi: APPROVE_ABI, data: txs[0].data });
  assert.equal(lower(ap.args[0]), lower(COLLATERAL_ONRAMP));
  assert.equal(ap.args[1], parseUnits("3", 6));

  // 2. wrap(USDC.e, DW, 3) — the `to` is the DEPOSIT WALLET, not the EOA.
  assert.equal(txs[1].label, "wrap-usdce-to-pusd");
  assert.equal(lower(txs[1].to), lower(COLLATERAL_ONRAMP));
  const w = decodeFunctionData({ abi: WRAP_ABI, data: txs[1].data });
  assert.equal(lower(w.args[0]), lower(USDC_E));
  assert.equal(lower(w.args[1]), lower(DW));
  assert.equal(w.args[2], parseUnits("3", 6));
});

test("buildWrapTxs defaults the wrap recipient to the EOA (back-compat with the top-up path)", () => {
  const txs = buildWrapTxs({ eoa: EOA, amount: "1.5" });
  const w = decodeFunctionData({ abi: WRAP_ABI, data: txs[1].data });
  assert.equal(lower(w.args[1]), lower(EOA));
  assert.equal(w.args[2], parseUnits("1.5", 6));
});

test("buildNativeToUsdceSwapTxs swaps native->USDC.e on the fee-100 pool, output to the EOA", () => {
  const txs = buildNativeToUsdceSwapTxs({ eoa: EOA, amountIn: "3.05" });
  assert.equal(txs.length, 2);

  assert.equal(txs[0].label, "approve-native-router");
  assert.equal(lower(txs[0].to), lower(USDC_NATIVE));
  const ap = decodeFunctionData({ abi: APPROVE_ABI, data: txs[0].data });
  assert.equal(lower(ap.args[0]), lower(UNISWAP_V3_SWAPROUTER02));
  assert.equal(ap.args[1], parseUnits("3.05", 6));

  assert.equal(txs[1].label, "swap-native-to-usdce");
  assert.equal(lower(txs[1].to), lower(UNISWAP_V3_SWAPROUTER02));
  const s = decodeFunctionData({ abi: EXACT_IN_ABI, data: txs[1].data });
  const p = s.args[0];
  assert.equal(lower(p.tokenIn), lower(USDC_NATIVE));
  assert.equal(lower(p.tokenOut), lower(USDC_E));
  assert.equal(p.fee, USDC_SWAP_FEE);
  assert.equal(lower(p.recipient), lower(EOA)); // swapped USDC.e lands on the EOA, which then wraps it
  assert.equal(p.amountIn, parseUnits("3.05", 6));
  assert.equal(p.amountOutMinimum, (parseUnits("3.05", 6) * 9950n) / 10000n); // default 0.5% floor
  assert.equal(p.sqrtPriceLimitX96, 0n);
});

test("buildNativeToUsdceSwapTxs honors a custom minOutBps and rejects bad bounds", () => {
  const txs = buildNativeToUsdceSwapTxs({ eoa: EOA, amountIn: "2", minOutBps: 9900 });
  const s = decodeFunctionData({ abi: EXACT_IN_ABI, data: txs[1].data });
  assert.equal(s.args[0].amountOutMinimum, (parseUnits("2", 6) * 9900n) / 10000n);

  assert.throws(() => buildNativeToUsdceSwapTxs({ eoa: EOA, amountIn: "1", minOutBps: 0 }));
  assert.throws(() => buildNativeToUsdceSwapTxs({ eoa: EOA, amountIn: "1", minOutBps: 10001 }));
  assert.throws(() => buildNativeToUsdceSwapTxs({ eoa: EOA, amountIn: "0" }));
});
