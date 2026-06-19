// src/adapters/polymarket-enable.ts
// Build the (UNSIGNED) on-chain transactions a fresh local EOA needs before it
// can trade Polymarket V2:
//
//   1. (optional) wrap USDC.e -> pUSD via CollateralOnramp.wrap(), if the EOA
//      holds USDC.e that must be converted to the V2 collateral.
//   2. SCOPED ERC-20 approvals on pUSD -> the three V2 spenders so they can pull
//      collateral at fill time.
//   3. ERC-1155 setApprovalForAll on the CTF -> the same three spenders so they
//      can move the EOA's outcome shares on a SELL.
//   4. the ERC-20 approval on USDC.e -> CollateralOnramp that wrap() consumes
//      (only emitted when a wrap is requested).
//
// DIFFERENCE FROM THE V1 APP (deliberate):
//   - v1 batched these through a Safe/relayer and used MAX_UINT256 allowances.
//     We are on a PLAIN EOA, so each tx is a normal tx the LOCAL key signs and
//     pays MATIC gas for — and we set SCOPED allowances (exactly the amount this
//     enable round needs), NOT MAX. A blanket MAX allowance on pUSD lets the
//     exchange pull the EOA's entire collateral balance forever; scoping the
//     allowance to the trading budget caps the blast radius of a compromised or
//     buggy exchange contract.
//   - setApprovalForAll on ERC-1155 is inherently all-or-nothing (no per-amount
//     scoping exists in the standard). It is required for SELLs. We surface it
//     as a distinct, clearly-labeled step so the caller can choose to defer it
//     until the first SELL rather than granting it up front.
//
// This module is PURE: it returns UnsignedBridgeTx[]-shaped {to,data,value}
// payloads. It does not read balances, sign, or broadcast. The caller decides
// which steps to include (e.g. skip wrap if the EOA already holds pUSD) and how
// to size the allowances from its risk budget.

import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import {
  COLLATERAL_ONRAMP,
  PUSD,
  USDC_E,
  USDC_NATIVE,
  CONDITIONAL_TOKENS_CTF,
  CTF_EXCHANGE_V2,
  NEG_RISK_CTF_EXCHANGE_V2,
  NEG_RISK_ADAPTER,
  COLLATERAL_DECIMALS,
  UNISWAP_V3_SWAPROUTER02,
  USDC_SWAP_FEE,
} from "./polymarket-constants.js";

/** A single unsigned EVM tx the local Polygon EOA signs + broadcasts. */
export interface UnsignedEvmTx {
  to: `0x${string}`;
  data: `0x${string}`;
  /** wei as a decimal string; "0" for all of these (none send native value). */
  value: "0";
  /** Human label for the lifecycle log. */
  label:
    | "approve-usdce-onramp"
    | "wrap-usdce-to-pusd"
    | "approve-native-router"
    | "swap-native-to-usdce"
    | "approve-pusd-ctfExchange"
    | "approve-pusd-negRiskExchange"
    | "approve-pusd-negRiskAdapter"
    | "ctf-setApprovalForAll-ctfExchange"
    | "ctf-setApprovalForAll-negRiskExchange"
    | "ctf-setApprovalForAll-negRiskAdapter";
}

/** The three V2 spenders that need pUSD allowance + CTF operator rights. */
const SPENDERS = [
  { addr: CTF_EXCHANGE_V2, pusdLabel: "approve-pusd-ctfExchange", ctfLabel: "ctf-setApprovalForAll-ctfExchange" },
  { addr: NEG_RISK_CTF_EXCHANGE_V2, pusdLabel: "approve-pusd-negRiskExchange", ctfLabel: "ctf-setApprovalForAll-negRiskExchange" },
  { addr: NEG_RISK_ADAPTER, pusdLabel: "approve-pusd-negRiskAdapter", ctfLabel: "ctf-setApprovalForAll-negRiskAdapter" },
] as const;

/** ERC-1155 setApprovalForAll ABI (only what we encode). */
const ERC1155_SET_APPROVAL_ABI = [
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/** CollateralOnramp.wrap(asset, to, amount). */
const ONRAMP_WRAP_ABI = [
  {
    name: "wrap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_asset", type: "address" },
      { name: "_to", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Uniswap V3 SwapRouter02.exactInputSingle(params) — single-pool exact-in swap.
 *  Used to convert native Circle USDC -> USDC.e before the wrap (the Onramp
 *  rejects native USDC). Verbatim shape from the live-proven scripts/trade-dw.mjs. */
const EXACT_INPUT_SINGLE_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface EnableTradingArgs {
  /** The local trading EOA — receives pUSD from wrap() and is the approver. */
  eoa: `0x${string}`;
  /**
   * Collateral budget (decimal pUSD, e.g. "250.5"). Each pUSD allowance is
   * scoped to EXACTLY this amount (in 6-dp base units), NOT MAX. Size it to the
   * trading budget you intend to deploy this session.
   */
  collateralBudget: string;
  /**
   * Optional USDC.e wrap: amount of USDC.e (decimal, e.g. "100") to convert to
   * pUSD. When present, emits an approve(USDC.e -> Onramp, thisAmount) + a
   * wrap() call. The approve is also SCOPED to the wrap amount, not MAX.
   * Omit if the EOA already holds pUSD directly (CCTP/bridge-routed pUSD).
   */
  wrapUsdce?: string;
  /**
   * Wrap source asset. The Onramp accepts USDC.e (default) or native USDC. Use
   * "native" only when the EOA's collateral arrived as native Circle USDC (e.g.
   * straight from CCTP) rather than bridged USDC.e.
   */
  wrapAsset?: "usdce" | "native";
  /**
   * Whether to include the three ERC-1155 setApprovalForAll txs. These are
   * needed for SELLs but are all-or-nothing (no amount scoping). Default true;
   * set false to defer until the first SELL.
   */
  includeCtfApprovals?: boolean;
}

/**
 * Build the ordered list of unsigned enable txs. Order matters: the USDC.e
 * approve must precede the wrap (wrap pulls via that allowance), and you want
 * pUSD allowances in place before the first BUY. The caller signs + broadcasts
 * each in order (or batches via its own multicall if it has one — these are
 * plain txs, no relayer).
 */
export function buildEnableTradingTxs(args: EnableTradingArgs): UnsignedEvmTx[] {
  const txs: UnsignedEvmTx[] = [];
  const budgetUnits = parseUnits(assertDecimal(args.collateralBudget, "collateralBudget"), COLLATERAL_DECIMALS);
  if (budgetUnits <= 0n) throw new Error("collateralBudget must be > 0");

  // 1+4. Optional wrap: approve(USDC.e/native -> Onramp, wrapAmount) then wrap().
  if (args.wrapUsdce !== undefined) {
    const wrapUnits = parseUnits(assertDecimal(args.wrapUsdce, "wrapUsdce"), COLLATERAL_DECIMALS);
    if (wrapUnits <= 0n) throw new Error("wrapUsdce must be > 0 when provided");
    const asset = args.wrapAsset === "native" ? USDC_NATIVE : USDC_E;

    txs.push({
      to: asset as `0x${string}`,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [COLLATERAL_ONRAMP as `0x${string}`, wrapUnits], // SCOPED to wrap amount
      }),
      value: "0",
      label: "approve-usdce-onramp",
    });

    txs.push({
      to: COLLATERAL_ONRAMP as `0x${string}`,
      data: encodeFunctionData({
        abi: ONRAMP_WRAP_ABI,
        functionName: "wrap",
        args: [asset as `0x${string}`, args.eoa, wrapUnits],
      }),
      value: "0",
      label: "wrap-usdce-to-pusd",
    });
  }

  // 2. SCOPED pUSD allowances to the three V2 spenders (budget, not MAX).
  for (const s of SPENDERS) {
    txs.push({
      to: PUSD as `0x${string}`,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [s.addr as `0x${string}`, budgetUnits],
      }),
      value: "0",
      label: s.pusdLabel,
    });
  }

  // 3. ERC-1155 operator rights for SELLs (all-or-nothing; opt-out via flag).
  if (args.includeCtfApprovals !== false) {
    for (const s of SPENDERS) {
      txs.push({
        to: CONDITIONAL_TOKENS_CTF as `0x${string}`,
        data: encodeFunctionData({
          abi: ERC1155_SET_APPROVAL_ABI,
          functionName: "setApprovalForAll",
          args: [s.addr as `0x${string}`, true],
        }),
        value: "0",
        label: s.ctfLabel,
      });
    }
  }

  return txs;
}

/**
 * Build only the wrap pair (approve + wrap), e.g. to top up collateral mid-session
 * or to fund a deposit wallet. `recipient` is where the minted pUSD lands: default
 * the EOA itself, OR the deposit wallet — the Onramp's wrap `to` is arbitrary, so
 * an EOA that holds the USDC.e can mint pUSD STRAIGHT INTO its deposit wallet in
 * one tx (no separate transfer). The approve is scoped to the wrap amount, not MAX.
 */
export function buildWrapTxs(args: {
  eoa: `0x${string}`;
  amount: string;
  asset?: "usdce" | "native";
  recipient?: `0x${string}`;
}): UnsignedEvmTx[] {
  const wrapUnits = parseUnits(assertDecimal(args.amount, "amount"), COLLATERAL_DECIMALS);
  if (wrapUnits <= 0n) throw new Error("wrap amount must be > 0");
  const asset = args.asset === "native" ? USDC_NATIVE : USDC_E;
  const to = args.recipient ?? args.eoa;
  return [
    {
      to: asset as `0x${string}`,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [COLLATERAL_ONRAMP as `0x${string}`, wrapUnits],
      }),
      value: "0",
      label: "approve-usdce-onramp",
    },
    {
      to: COLLATERAL_ONRAMP as `0x${string}`,
      data: encodeFunctionData({
        abi: ONRAMP_WRAP_ABI,
        functionName: "wrap",
        args: [asset as `0x${string}`, to, wrapUnits],
      }),
      value: "0",
      label: "wrap-usdce-to-pusd",
    },
  ];
}

/**
 * Build the (approve + swap) pair that converts native Circle USDC -> USDC.e via
 * the Uniswap V3 fee-100 pool, so a CCTP/bridge-funded EOA can feed the
 * CollateralOnramp (which wraps USDC.e, NOT native USDC). The swapped USDC.e lands
 * on the EOA, which then wraps it (see buildWrapTxs with recipient=depositWallet).
 * `amountIn` is the native USDC to swap; `minOutBps` floors the output (default
 * 9950 = 0.5% slippage; the pool is deep + ~1:1, so this is conservative). This is
 * the forward inverse of the wind-down's USDC.e -> native swap.
 */
export function buildNativeToUsdceSwapTxs(args: {
  eoa: `0x${string}`;
  amountIn: string;
  minOutBps?: number;
}): UnsignedEvmTx[] {
  const amountIn = parseUnits(assertDecimal(args.amountIn, "amountIn"), COLLATERAL_DECIMALS);
  if (amountIn <= 0n) throw new Error("swap amountIn must be > 0");
  const bps = BigInt(args.minOutBps ?? 9950);
  if (bps <= 0n || bps > 10000n) throw new Error("minOutBps must be in (0, 10000]");
  const minOut = (amountIn * bps) / 10000n;
  return [
    {
      to: USDC_NATIVE as `0x${string}`,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [UNISWAP_V3_SWAPROUTER02 as `0x${string}`, amountIn], // SCOPED to swap amount
      }),
      value: "0",
      label: "approve-native-router",
    },
    {
      to: UNISWAP_V3_SWAPROUTER02 as `0x${string}`,
      data: encodeFunctionData({
        abi: EXACT_INPUT_SINGLE_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: USDC_NATIVE as `0x${string}`,
            tokenOut: USDC_E as `0x${string}`,
            fee: USDC_SWAP_FEE,
            recipient: args.eoa,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
      value: "0",
      label: "swap-native-to-usdce",
    },
  ];
}

/** Reject empty / non-numeric decimal strings before parseUnits (clearer error). */
function assertDecimal(v: string, name: string): string {
  if (!/^\d+(\.\d+)?$/.test(v.trim())) {
    throw new Error(`${name} must be a non-negative decimal string, got "${v}"`);
  }
  return v.trim();
}
