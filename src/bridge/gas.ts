// src/bridge/gas.ts
// "GAS rides along with funding." CCTP delivers USDC but CANNOT deliver native
// gas, so after (or alongside) a USDC funding leg the destination EOA still needs
// MATIC / ETH / SOL to pay its own gas (HL deposit/withdraw, Polymarket
// approvals+wrap, Solana ATA rent + tx fees). This module tops that up by placing
// a small deBridge native-OUTPUT order — paid FROM source USDC — that delivers
// native gas to the destination EOA.
//
// PURE BUILDERS. ensureGas/planGas return UnsignedBridgeTx[] (or "already funded")
// and NEVER sign or broadcast. Balance reads are injected (the transport layer
// owns RPC); this file does no network writes and holds no keys.
//
// THE BOOTSTRAP CHICKEN-AND-EGG (read this before tuning anything):
//   The ONLY gas-delivery mechanism is a deBridge native-OUTPUT order, which is
//   placed on a SOURCE chain and requires that SOURCE wallet to already hold
//   native gas (the DLN flat fixFee — 0.001 ETH on Arbitrum/Ethereum, 0.5 POL on
//   Polygon, 0.015 SOL on Solana — PLUS that tx's own gas). So to get gas on
//   chain B you must already have gas on chain A. A truly fresh wallet (USDC
//   bridged in via CCTP, ZERO native on every chain) cannot bootstrap from zero:
//   it can't pay to place the top-up order, and (CCTP side) it can't even pay the
//   destination gas to call receiveMessage to CLAIM the minted USDC (this repo
//   has NO relayer; the local EOA pays dest gas itself).
//   => ensureGas does NOT silently emit an unpayable order. It checks the chosen
//   SOURCE chain can actually afford fixFee + tx-gas and, if not, returns a
//   `funded:false` result with an ACTIONABLE blocker ("needs_starter_gas") naming
//   the chain the user must one-time seed. The "cheapest free source" path the
//   prior design assumed DOES NOT EXIST — there is no zero-fixFee EVM source.
//
// All per-chain minimums cover REAL first-use costs on a fresh wallet, not just
// protocol fixFees. Sources cited inline; fixFees corrected per
//   https://docs.debridge.com/dln-details/overview/fees-supported-chains.

import type { Chain } from "../adapters/types.js";
import type { UnsignedBridgeTx } from "./types.js";
import {
  buildSourceOrderTxs,
  DeBridgeBridge,
  debridgeChainId,
  DLN_SOURCE_FIXFEE_FALLBACK,
  nativeSentinel,
  scaleDecimal,
  usdcOn,
  type CreateTxParams,
  type DlnCreateTxResponse,
  type RealNet,
} from "./debridge.js";

// ---------------------------------------------------------------------------
// Per-chain native-gas minimums. The wallet should hold AT LEAST this much
// native token to operate; below it, ensureGas tops up.
//
// Each entry carries:
//   - symbol/decimals of the native token (for base-unit math + sentinel pricing)
//   - minNative: the floor (decimal string) the EOA must hold
//   - topUpNative: how much native to DELIVER when below the floor (>= the gap to
//     a comfortable working balance; deBridge back-solves the USDC to spend)
//   - usdcSourceCeiling: a sanity ceiling on USDC the order may spend, so a
//     bad price can't drain the wallet on a "small" top-up.
// ---------------------------------------------------------------------------

export interface GasSpec {
  /** Native token symbol delivered at the destination. */
  symbol: "POL" | "ETH" | "SOL";
  /** Native token decimals (EVM native = 18, SOL = 9). */
  decimals: number;
  /** Hold-at-least floor, decimal native units. */
  minNative: string;
  /** Deliver-this-much when topping up, decimal native units. */
  topUpNative: string;
  /** Hard ceiling on USDC (decimal) a single top-up order may spend. */
  usdcSourceCeiling: string;
}

/**
 * GAS_MINIMUMS — exported per-chain table. Two distinct roles a wallet may play:
 *   (A) OPERATE its own venue on that chain, and
 *   (B) be the SOURCE of a cross-chain gas top-up to another chain — which costs
 *       the DLN flat fixFee (Arbitrum/Ethereum 0.001 ETH, Polygon 0.5 POL, Solana
 *       0.015 SOL) + that order tx's gas, ON TOP of (A).
 * The floors below cover (A). Whether a wallet can also act as (B) is checked at
 * order time against the corrected fixFee table (canAffordSource()), NOT assumed.
 *
 * fixFees corrected: https://docs.debridge.com/dln-details/overview/fees-supported-chains
 * Fresh-wallet venue minimums: HL Bridge2 deposit gas + Polymarket approvals/wrap +
 * Solana ATA rent (~0.00203928 SOL/SPL account,
 * https://solana.com/developers/cookbook/accounts/calculate-rent).
 */
export const GAS_MINIMUMS: Record<Chain, GasSpec> = {
  // Polygon native is POL/MATIC (18dp). 7 approvals + wrap + a couple of spare txs.
  // NOTE: acting as a top-up SOURCE from Polygon costs a 0.5 POL fixFee — far
  // above this operating floor; canAffordSource() gates that, so don't bake it in.
  polygon: {
    symbol: "POL",
    decimals: 18,
    minNative: "0.05",
    topUpNative: "0.08",
    usdcSourceCeiling: "5",
  },
  // "hyperliquid" funds live on Arbitrum (18dp ETH). Deposit = one ERC-20 transfer
  // to HL Bridge2; withdraw is gasless. The OPERATE floor is small (~0.0003 ETH),
  // but Arbitrum is also the most common top-up SOURCE and a source order costs a
  // 0.001 ETH fixFee + tx gas. So the floor is raised to 0.0015 ETH and topUp to
  // 0.002 ETH to cover operating AND one outbound gas leg's fixFee without going
  // sub-floor. (Prior 0.0003/0.0006 could not afford the 0.001 ETH fixFee.)
  hyperliquid: {
    symbol: "ETH",
    decimals: 18,
    minNative: "0.0015",
    topUpNative: "0.002",
    usdcSourceCeiling: "5",
  },
  // Solana native SOL (9dp). As the DESTINATION of native-SOL gas delivery there
  // is NO Solana-side fixFee (the 0.015 SOL fixFee is paid on the EVM SOURCE) and
  // NO ATA needed (native SOL is the system account, not an SPL token account —
  // ATA rent ~0.00204 SOL applies only to a USDC SPL account, e.g. a Solana-SOURCE
  // USDC leg). The 0.015 SOL fixFee floor matters only when Solana is itself the
  // SOURCE of a future order. This floor covers operating + a small ATA-rent
  // cushion in case a USDC ATA must be created for a later CCTP redeem.
  solana: {
    symbol: "SOL",
    decimals: 9,
    minNative: "0.015",
    topUpNative: "0.02",
    usdcSourceCeiling: "8",
  },
};

// ---------------------------------------------------------------------------
// Plan + ensure.
// ---------------------------------------------------------------------------

/** A gas-funding plan, independent of current balance (pure description). */
export interface GasPlan {
  /** Destination chain (where native gas is delivered). */
  chain: Chain;
  symbol: GasSpec["symbol"];
  /** Hold-at-least floor (decimal native). */
  minNative: string;
  /** Native amount the top-up order will deliver (decimal native). */
  topUpNative: string;
  /** The chain the order is PLACED on / USDC is spent (the source). */
  sourceChain: Chain;
  /** The DLN flat fixFee the SOURCE wallet must hold as native VALUE to place the
   *  order, decimal native units (fallback table; authoritative value = tx.value
   *  from create-tx). This is ON TOP of the order tx's own gas. */
  sourceFixFee: string;
  /** Native symbol of the source chain (what sourceFixFee is denominated in). */
  sourceFixFeeSymbol: string;
  /** The deBridge native-OUTPUT order params that would deliver topUpNative. */
  params: CreateTxParams;
}

/** A signer-shaped input: we only need the address to read balance + pin authority. */
export interface GasSignerLike {
  address: string;
}

/** Reads the native balance of `address` on `chain`, in DECIMAL native units.
 *  Injected by the transport layer (it owns RPC); gas.ts stays pure. */
export type NativeBalanceReader = (
  chain: Chain,
  address: string,
) => Promise<string>;

export interface EnsureGasResult {
  chain: Chain;
  /** Current native balance read (decimal). */
  balance: string;
  /** Floor we compared against. */
  minNative: string;
  /** True when balance >= minNative (no top-up needed). */
  funded: boolean;
  /** Empty when funded; otherwise the unsigned top-up bridge txs. May be empty
   *  with funded:false when blocked (e.g. needs_starter_gas) — check blockers. */
  txs: UnsignedBridgeTx[];
  /** The plan that produced txs (present even when funded, for surfacing). */
  plan: GasPlan;
  /** deBridge orderId of the placed top-up (when an order was created). The
   *  intents/store layer polls DeBridgeBridge.status(orderId) and drives
   *  DeBridgeBridge.recover(route, orderId) on this id to reclaim a stuck order
   *  (the cancel executes on plan.sourceChain — where the user holds gas). */
  orderId?: string;
  /** Actionable blockers when not funded and no payable order could be produced
   *  (e.g. "needs_starter_gas:hyperliquid", "no_payable_gas_source"). */
  blockers?: string[];
  /** Human note for surfacing. */
  note?: string;
}

/** Map a repo Chain to the real network its DLN fixFee is keyed under. */
function realNetOf(chain: Chain): RealNet {
  if (chain === "polygon") return "polygon";
  if (chain === "hyperliquid") return "arbitrum";
  return "solana";
}

/** The DLN flat fixFee (decimal native) the SOURCE wallet must hold to place an
 *  order on `sourceChain`. Fallback table — authoritative value is tx.value from
 *  create-tx. There is NO zero-fixFee EVM source. */
function sourceFixFeeOf(sourceChain: Chain): { amount: string; symbol: string } {
  const f = DLN_SOURCE_FIXFEE_FALLBACK[realNetOf(sourceChain)];
  return { amount: f.amount, symbol: f.symbol };
}

/**
 * Build the native-OUTPUT deBridge order that delivers `topUpNative` of native
 * gas to `recipient` on `chain`, paid from source USDC. Gas is delivered AT the
 * destination, so the SOURCE is a DIFFERENT chain we spend USDC on (deBridge is
 * cross-chain only).
 *
 * SOURCE SELECTION: there is NO free/zero-fixFee EVM source (the prior "Arbitrum
 * is free" assumption was wrong — Arbitrum's flat fee is 0.001 ETH). The caller
 * SHOULD pass the chain that ALREADY has native headroom above its operating
 * floor (so it can pay its own fixFee + gas); when omitted we default to Arbitrum
 * as the conventional funding hub, but ensureGas() then verifies that source can
 * actually afford the fixFee and refuses with `needs_starter_gas` if it can't.
 * The order's dstChainOrderAuthorityAddress is pinned to the SOURCE address (a
 * chain the user can pay gas on to cancel) — NOT the gasless destination — so a
 * stuck top-up is cancellable.
 */
export function planGas(
  chain: Chain,
  recipient: string,
  opts: { sourceChain?: Chain; sourceAddress: string } ,
): GasPlan {
  const spec = GAS_MINIMUMS[chain];
  const sourceChain: Chain = opts.sourceChain ?? "hyperliquid";
  if (sourceChain === chain) {
    // deBridge is cross-chain; a same-chain "bridge" is invalid. The caller must
    // hold USDC on a DIFFERENT chain to seed gas here.
    throw new Error(
      `gas top-up source chain must differ from destination "${chain}" (deBridge is cross-chain).`,
    );
  }
  const topUpBaseUnits = scaleDecimal(spec.topUpNative, spec.decimals);
  const fix = sourceFixFeeOf(sourceChain);

  // Pin the NATIVE OUTPUT amount; let deBridge back-solve the USDC to spend
  // (srcChainTokenInAmount=auto). Output token = the chain's native sentinel.
  // The usdcSourceCeiling is enforced post-quote in ensureGas (the auto-solved
  // input is only known after the create-tx call returns).
  const params: CreateTxParams = {
    srcChainId: debridgeChainId(sourceChain),
    srcChainTokenIn: usdcOn(sourceChain),
    srcChainTokenInAmount: "auto",
    dstChainId: debridgeChainId(chain),
    dstChainTokenOut: nativeSentinel(chain),
    dstChainTokenOutAmount: topUpBaseUnits,
    dstChainTokenOutRecipient: recipient,
    srcChainOrderAuthorityAddress: opts.sourceAddress,
    // Cancel/refund authority on the chain the user can ACTUALLY pay gas on (the
    // SOURCE), not the gasless destination — otherwise a stuck top-up could only
    // be cancelled from a chain with no native balance. deBridge refunds the input
    // (incl. the flat fee) to this authority on cancel.
    dstChainOrderAuthorityAddress: opts.sourceAddress,
    senderAddress: opts.sourceAddress,
    affiliateFeePercent: 0,
  };

  return {
    chain,
    symbol: spec.symbol,
    minNative: spec.minNative,
    topUpNative: spec.topUpNative,
    sourceChain,
    sourceFixFee: fix.amount,
    sourceFixFeeSymbol: fix.symbol,
    params,
  };
}

/** cmp two non-negative decimals; >0 if a>b, 0 if equal, <0 if a<b. */
function cmpDec(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const aI = ai.replace(/^0+/, "") || "0";
  const bI = bi.replace(/^0+/, "") || "0";
  if (aI.length !== bI.length) return aI.length < bI.length ? -1 : 1;
  if (aI !== bI) return aI < bI ? -1 : 1;
  const len = Math.max(af.length, bf.length);
  const aFrac = af.padEnd(len, "0");
  const bFrac = bf.padEnd(len, "0");
  if (aFrac === bFrac) return 0;
  return aFrac < bFrac ? -1 : 1;
}

export interface EnsureGasOptions {
  /** Reads native balance (decimal) for an address on a chain. Required. */
  readNativeBalance: NativeBalanceReader;
  /** Chain to source the USDC from (defaults to Arbitrum — cheapest fixFee). */
  sourceChain?: Chain;
  /** The source-chain EOA address that pays for / authorities the order. */
  sourceAddress: string;
  /** Optional custom fetch for the create-tx call (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Read native balance on `chain`; if below GAS_MINIMUMS[chain].minNative, build a
 * deBridge native-OUTPUT order delivering the top-up to `signer.address`, paid
 * from USDC on the SOURCE chain. Returns {funded:true} when already above the
 * floor. NEVER signs.
 *
 * BOOTSTRAP GUARD: before placing the order, verify the SOURCE chain can actually
 * pay the DLN flat fixFee + tx gas (canAffordSource). If it can't — e.g. a fresh
 * wallet with USDC but zero native everywhere — return funded:false with an
 * actionable `needs_starter_gas:<sourceChain>` blocker and NO txs, rather than
 * emitting an order the wallet physically cannot broadcast. The user must one-time
 * seed native gas on the source chain (the documented bootstrap step).
 */
export async function ensureGas(
  chain: Chain,
  signer: GasSignerLike,
  opts: EnsureGasOptions,
): Promise<EnsureGasResult> {
  const spec = GAS_MINIMUMS[chain];
  const plan = planGas(chain, signer.address, {
    sourceChain: opts.sourceChain,
    sourceAddress: opts.sourceAddress,
  });

  const balance = await opts.readNativeBalance(chain, signer.address);
  const funded = cmpDec(balance, spec.minNative) >= 0;
  if (funded) {
    return { chain, balance, minNative: spec.minNative, funded: true, txs: [], plan };
  }

  // BOOTSTRAP PRECONDITION: can the SOURCE chain afford to PLACE the order?
  // It must hold >= fixFee + a tx-gas reserve in its native token. Read the
  // source-chain native balance (the same injected reader, keyed on sourceChain).
  let sourceNativeBal: string;
  try {
    sourceNativeBal = await opts.readNativeBalance(plan.sourceChain, opts.sourceAddress);
  } catch {
    sourceNativeBal = "0";
  }
  const need = sourceNeedNative(plan.sourceChain, plan.sourceFixFee);
  if (cmpDec(sourceNativeBal, need) < 0) {
    return {
      chain,
      balance,
      minNative: spec.minNative,
      funded: false,
      txs: [],
      plan,
      blockers: [`needs_starter_gas:${plan.sourceChain}`],
      note:
        `Cannot bootstrap gas for "${chain}": the source chain "${plan.sourceChain}" ` +
        `holds ${sourceNativeBal} ${plan.sourceFixFeeSymbol} but needs >= ${need} ` +
        `(${plan.sourceFixFee} DLN fixFee + tx gas) to PLACE the top-up order. ` +
        `One-time seed native ${plan.sourceFixFeeSymbol} on "${plan.sourceChain}", or pass a ` +
        `sourceChain that already has native headroom. No unpayable tx was emitted.`,
    };
  }

  // Source can pay. Place the native-OUTPUT order through DeBridgeBridge.createOrder,
  // the single verified + re-decoded (assertOrderPins) chokepoint. We need the
  // raw response to enforce the USDC source ceiling BEFORE handing out the tx.
  const bridge = new DeBridgeBridge({
    sourceAddress: opts.sourceAddress,
    fetchImpl: opts.fetchImpl,
  });
  const res = await bridge.createOrder(plan.params);

  // The order executes on the SOURCE chain (where USDC is spent), not `chain`.
  const sourceChain = sourceChainOf(plan.params.srcChainId);
  const txs = buildSourceOrderTxs(sourceChain, res);

  // Enforce the USDC source ceiling on the amount ACTUALLY authorized by the
  // approve in txs (re-decoded), not just the estimation field — fail-closed.
  enforceUsdcCeiling(res, txs, spec.usdcSourceCeiling);

  return {
    chain,
    balance,
    minNative: spec.minNative,
    funded: false,
    txs,
    plan,
    orderId: res.orderId,
    note: `Top-up order placed: deliver ${plan.topUpNative} ${plan.symbol} to "${chain}" from "${sourceChain}" USDC. Source pays ${plan.sourceFixFee} ${plan.sourceFixFeeSymbol} fixFee + gas.`,
  };
}

/** Native the SOURCE wallet must hold to place an order: fixFee + a tx-gas
 *  reserve. The reserve is chain-shaped (EVM L2 gas is tiny; Solana sig/priority
 *  fees are tiny; Polygon POL gas is small relative to its 0.5 POL fixFee). */
function sourceNeedNative(sourceChain: Chain, fixFeeDecimal: string): string {
  // Conservative tx-gas reserve on top of the flat fixFee, per source network.
  const reserve =
    sourceChain === "polygon"
      ? "0.02" // POL: order tx gas
      : sourceChain === "solana"
        ? "0.002" // SOL: signature + priority fees
        : "0.0003"; // Arbitrum ETH: L2 order tx gas
  return addDec(fixFeeDecimal, reserve);
}

/** Recover the repo Chain from a deBridge srcChainId. */
function sourceChainOf(srcChainId: number): Chain {
  if (srcChainId === debridgeChainId("polygon")) return "polygon";
  if (srcChainId === debridgeChainId("hyperliquid")) return "hyperliquid";
  return "solana";
}

/**
 * Enforce the USDC source ceiling, FAIL-CLOSED. For an auto-input gas order the
 * back-solved USDC input is the WHOLE POINT of the guard, so a missing/unparseable
 * estimation amount is a HARD failure (we must not hand out a tx whose USDC spend
 * we can't bound). We bound the amount ACTUALLY AUTHORIZED by the approve in the
 * emitted txs (re-decoded), falling back to the estimation field — both must be
 * present and <= ceiling.
 */
function enforceUsdcCeiling(
  res: DlnCreateTxResponse,
  txs: UnsignedBridgeTx[],
  ceilingDecimal: string,
): void {
  const ceilingBase = BigInt(scaleDecimal(ceilingDecimal, 6));

  // 1) The estimation input (back-solved or fixed). For an auto-input gas order
  //    this MUST be present — its absence means the ceiling can't be checked.
  const estIn = res.estimation?.srcChainTokenIn?.amount;
  if (!estIn || !/^\d+$/.test(estIn)) {
    throw new Error(
      "gas top-up: create-tx response has no parseable srcChainTokenIn.amount — " +
        "cannot bound the auto-solved USDC spend. Refusing to hand out the tx.",
    );
  }
  if (BigInt(estIn) > ceilingBase) {
    throw new Error(
      `gas top-up would spend ${estIn} USDC base units, over ceiling ${ceilingBase}. ` +
        `Refusing — price may be off or the destination native amount too large.`,
    );
  }

  // 2) Re-decode the amount the approve in txs ACTUALLY authorizes the DlnSource to
  //    pull, and assert IT is within the ceiling too (the bound is on the value
  //    authorized on-chain, not only the estimation field).
  const authorized = decodeApproveAmount(txs);
  if (authorized !== undefined && authorized > ceilingBase) {
    throw new Error(
      `gas top-up approve authorizes ${authorized} USDC base units, over ceiling ` +
        `${ceilingBase}. Refusing.`,
    );
  }
}

/** Re-decode the ERC-20 approve amount (uint256, last 32-byte word) from the
 *  emitted source txs. Returns undefined for Solana legs (approve is inside the
 *  VersionedTransaction) or if no approve step is present. */
function decodeApproveAmount(txs: UnsignedBridgeTx[]): bigint | undefined {
  const approve = txs.find(
    (t) => t.kind === "evmTx" && t.label === "approve",
  );
  if (!approve || typeof approve.payload === "string") return undefined;
  const data = approve.payload.data;
  if (typeof data !== "string") return undefined;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  // selector(8) + spender word(64) + amount word(64) = 136 hex chars.
  if (hex.length < 136) return undefined;
  const amountWord = hex.slice(72, 136);
  try {
    return BigInt(`0x${amountWord}`);
  } catch {
    return undefined;
  }
}

/** Add two non-negative decimals (string). */
function addDec(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const len = Math.max(af.length, bf.length);
  const aS = ai + af.padEnd(len, "0");
  const bS = bi + bf.padEnd(len, "0");
  const sum = (BigInt(aS) + BigInt(bS)).toString().padStart(len + 1, "0");
  const whole = sum.slice(0, sum.length - len) || "0";
  const frac = len > 0 ? sum.slice(sum.length - len).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

// re-exported small helper for the transport layer that owns RPC reads/writes.
export { cmpDec as cmpDecimal };
