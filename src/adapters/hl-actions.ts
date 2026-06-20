// src/adapters/hl-actions.ts
// PURE builders for the Hyperliquid L1 actions beyond a plain IOC order. Each
// returns the action object with its keys in the EXACT order the hyperliquid-python-sdk
// emits them — msgpack hashing (actionHash in hl-signing.ts) is order-sensitive, so a
// reordered key silently breaks the signature. These do NOT sign and do NOT post; the
// executing layer (hl-venue.ts) signs via signL1Action and POSTs via postExchange.
//
// Field orders locked to the python SDK (hyperliquid/exchange.py + signing.py):
//   order        : {type, orders:[{a,b,p,s,r,t,c?}], grouping[, builder]}
//   cancel       : {type, cancels:[{a,o}]}
//   cancelByCloid: {type, cancels:[{asset,cloid}]}
//   updateLeverage: {type, asset, isCross, leverage}
//   updateIsolatedMargin: {type, asset, isBuy, ntli}
//   vaultTransfer: {type, vaultAddress, isDeposit, usd}
//   twapOrder    : {type, twap:{a,b,s,r,m,t}}   (HL docs — live-verified)
//   twapCancel   : {type, a, t}                 (HL docs — live-verified)
import { floatToWire } from "./hyperliquid.js";

/** A Limit time-in-force. Ioc = marketable-or-cancel; Gtc = rests; Alo = post-only. */
export type Tif = "Ioc" | "Gtc" | "Alo";
/** A trigger (conditional) order: a stop-loss or take-profit that arms at triggerPx. */
export interface TriggerSpec {
  triggerPx: number;
  isMarket: boolean;
  tpsl: "tp" | "sl";
}

/** A Hyperliquid client order id: "0x" + 32 hex (16 bytes). */
export function isCloid(s: string): boolean {
  return /^0x[0-9a-fA-F]{32}$/.test(s);
}

/**
 * One order's wire form {a,b,p,s,r,t[,c]}. px/sz must ALREADY be on HL's grid
 * (the caller rounds via the resolved szDecimals); this only formats + assembles.
 * A trigger spec produces a `{trigger:{isMarket,triggerPx,tpsl}}` order-type; else a
 * `{limit:{tif}}`. cloid, when present, rides as `c` (SDK appends it last).
 */
export function buildOrderWire(args: {
  assetIndex: number;
  isBuy: boolean;
  px: number;
  sz: number;
  reduceOnly: boolean;
  tif?: Tif;
  trigger?: TriggerSpec;
  cloid?: string;
}): Record<string, unknown> {
  const t = args.trigger
    ? { trigger: { isMarket: args.trigger.isMarket, triggerPx: floatToWire(args.trigger.triggerPx), tpsl: args.trigger.tpsl } }
    : { limit: { tif: args.tif ?? "Gtc" } };
  const wire: Record<string, unknown> = {
    a: args.assetIndex,
    b: args.isBuy,
    p: floatToWire(args.px),
    s: floatToWire(args.sz),
    r: args.reduceOnly,
    t,
  };
  if (args.cloid) {
    if (!isCloid(args.cloid)) throw new Error(`cloid must be 0x+32 hex (got "${args.cloid}")`);
    wire.c = args.cloid.toLowerCase();
  }
  return wire;
}

/** {type:"order", orders, grouping:"na"[, builder:{b,f}]}. builder credits volume. */
export function buildOrderAction(orders: Record<string, unknown>[], builder?: { address: string; feeTenthsBps: number }): Record<string, unknown> {
  const action: Record<string, unknown> = { type: "order", orders, grouping: "na" };
  if (builder) action.builder = { b: builder.address.toLowerCase(), f: builder.feeTenthsBps };
  return action;
}

/** {type:"cancel", cancels:[{a:assetIndex, o:oid}]}. */
export function buildCancelAction(cancels: { assetIndex: number; oid: number }[]): Record<string, unknown> {
  if (cancels.length === 0) throw new Error("cancel needs at least one {assetIndex, oid}");
  return { type: "cancel", cancels: cancels.map((c) => ({ a: c.assetIndex, o: c.oid })) };
}

/** {type:"cancelByCloid", cancels:[{asset:assetIndex, cloid}]}. */
export function buildCancelByCloidAction(cancels: { assetIndex: number; cloid: string }[]): Record<string, unknown> {
  if (cancels.length === 0) throw new Error("cancelByCloid needs at least one {assetIndex, cloid}");
  for (const c of cancels) if (!isCloid(c.cloid)) throw new Error(`cloid must be 0x+32 hex (got "${c.cloid}")`);
  return { type: "cancelByCloid", cancels: cancels.map((c) => ({ asset: c.assetIndex, cloid: c.cloid.toLowerCase() })) };
}

/** {type:"updateLeverage", asset, isCross, leverage}. leverage is an integer (e.g. 5). */
export function buildUpdateLeverageAction(assetIndex: number, isCross: boolean, leverage: number): Record<string, unknown> {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error(`leverage must be a positive integer (got ${leverage})`);
  return { type: "updateLeverage", asset: assetIndex, isCross, leverage };
}

/** {type:"updateIsolatedMargin", asset, isBuy:true, ntli}. ntli = signed micro-USD
 *  (positive adds margin, negative removes). isBuy is vestigial — the SDK pins true. */
export function buildUpdateIsolatedMarginAction(assetIndex: number, ntliMicroUsd: number): Record<string, unknown> {
  if (!Number.isInteger(ntliMicroUsd)) throw new Error(`ntli must be an integer micro-USD (got ${ntliMicroUsd})`);
  return { type: "updateIsolatedMargin", asset: assetIndex, isBuy: true, ntli: ntliMicroUsd };
}

/** {type:"vaultTransfer", vaultAddress, isDeposit, usd}. usd = micro-USD integer.
 *  NOTE hl-venue signs this with vaultAddress=null in the hash (SDK passes active_pool=None). */
export function buildVaultTransferAction(vaultAddress: string, isDeposit: boolean, usdMicro: number): Record<string, unknown> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) throw new Error(`vaultAddress must be a 20-byte hex address`);
  if (!Number.isInteger(usdMicro) || usdMicro <= 0) throw new Error(`usd must be a positive integer micro-USD (got ${usdMicro})`);
  return { type: "vaultTransfer", vaultAddress: vaultAddress.toLowerCase(), isDeposit, usd: usdMicro };
}

/** {type:"twapOrder", twap:{a,b,s,r,m,t}}. m = minutes to run over, t = randomize. */
export function buildTwapOrderAction(args: { assetIndex: number; isBuy: boolean; sz: number; reduceOnly: boolean; minutes: number; randomize: boolean }): Record<string, unknown> {
  if (!Number.isInteger(args.minutes) || args.minutes < 1) throw new Error(`twap minutes must be a positive integer (got ${args.minutes})`);
  return { type: "twapOrder", twap: { a: args.assetIndex, b: args.isBuy, s: floatToWire(args.sz), r: args.reduceOnly, m: args.minutes, t: args.randomize } };
}

/** {type:"twapCancel", a:assetIndex, t:twapId}. */
export function buildTwapCancelAction(assetIndex: number, twapId: number): Record<string, unknown> {
  if (!Number.isInteger(twapId) || twapId < 0) throw new Error(`twapId must be a non-negative integer (got ${twapId})`);
  return { type: "twapCancel", a: assetIndex, t: twapId };
}

// ── scaled-unit helpers ──────────────────────────────────────────────────────

/** USD (decimal) -> micro-USD integer (HL's usd/ntli unit). Rejects sub-micro dust loss. */
export function usdToMicro(usd: number): number {
  const v = usd * 1e6;
  if (Math.abs(Math.round(v) - v) >= 1e-3) throw new Error(`usd ${usd} has sub-micro precision`);
  return Math.round(v);
}

/** A token amount (decimal) -> integer wei at `weiDecimals` (HYPE staking = 1e8). */
export function toWei(amount: number, weiDecimals: number): number {
  const v = amount * 10 ** weiDecimals;
  if (Math.abs(Math.round(v) - v) >= 1e-3) throw new Error(`amount ${amount} exceeds ${weiDecimals}-dp wei precision`);
  return Math.round(v);
}
