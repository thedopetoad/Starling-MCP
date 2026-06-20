// src/adapters/hl-venue.ts
// The HL-specific tool surface BEYOND the generic open/close adapter: advanced
// orders (resting Gtc/Alo, trigger tp/sl, cloid), cancels, leverage + isolated
// margin, perp<->spot transfers, vault deposit/withdraw, HYPE staking + delegation,
// and TWAP — plus a comprehensive account read. Same shape as makeRealHlExit /
// makeRealPmBridge: an injectable ops object the tool layer drives, EXECUTING each
// flow (sign locally + POST /exchange). Pure action structs come from hl-actions.ts;
// signing from hl-signing.ts; market resolution (perp + spot) from hyperliquid.ts.
//
// Nothing here chooses a withdrawal recipient — these actions keep funds INSIDE the
// HL account (orders, margin, vault, staking, perp<->spot). Getting USDC OUT of HL
// is hl_bridge_out / the native withdraw3, both treasury-pinned in the tool layer.
import type { SubmitResult, Side, AmountKind } from "./types.js";
import type {
  HlVenueOps,
  HlOrderArgs,
  HlCancelArgs,
  HlLeverageArgs,
  HlIsoMarginArgs,
  HlClassTransferArgs,
  HlVaultArgs,
  HlStakeArgs,
  HlDelegateArgs,
  HlTwapOrderArgs,
  HlTwapCancelArgs,
} from "../tools/index.js";
import { getEvmSigner } from "../signers/index.js";
import {
  signL1Action,
  signUsdClassTransfer,
  signTokenDelegate,
  signCDeposit,
  signCWithdraw,
  type RsvSignature,
} from "./hl-signing.js";
import { HL_MAINNET, HL_TESTNET, infoPost, postExchange } from "./hl-transport.js";
import { resolveHlAsset, roundPxGrid, roundSz, type ResolvedHl } from "./hyperliquid.js";
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
  type Tif,
} from "./hl-actions.js";

const rejected = (error: string): SubmitResult => ({ posted: false, status: "rejected", error });

class HlVenue implements HlVenueOps {
  private readonly host: string;
  private readonly isMainnet: boolean;
  private hypeWei?: number; // cached HYPE native wei-decimals (for staking/delegation)

  constructor() {
    this.isMainnet = (process.env.STARLING_NETWORK ?? "").toLowerCase() === "mainnet";
    this.host = this.isMainnet ? HL_MAINNET : HL_TESTNET;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async account(): Promise<unknown> {
    const user = getEvmSigner("hyperliquid").address;
    const [perp, spot, openOrders, staking, delegations] = await Promise.all([
      infoPost<unknown>({ type: "clearinghouseState", user }, { host: this.host }),
      infoPost<unknown>({ type: "spotClearinghouseState", user }, { host: this.host }),
      infoPost<unknown>({ type: "frontendOpenOrders", user }, { host: this.host }),
      infoPost<unknown>({ type: "delegatorSummary", user }, { host: this.host }).catch(() => null),
      infoPost<unknown>({ type: "delegations", user }, { host: this.host }).catch(() => null),
    ]);
    return { address: user, perp, spot, openOrders, staking: { summary: staking, delegations } };
  }

  // ── trading ────────────────────────────────────────────────────────────────

  async order(a: HlOrderArgs): Promise<SubmitResult> {
    const m = await this.resolve(a.marketId);
    if ("error" in m) return rejected(m.error);
    const px = roundPxGrid(Number(a.worstPrice), m.resolved.szDecimals, m.resolved.isSpot);
    if (!(px > 0)) return rejected(`worstPrice "${a.worstPrice}" is not a positive number`);
    const rawSize = a.amountKind === "collateral" ? Number(a.amount) / px : Number(a.amount);
    const sz = roundSz(rawSize, m.resolved.szDecimals);
    if (!(sz > 0)) return rejected(`size rounds to 0 at szDecimals=${m.resolved.szDecimals} (amount ${a.amount})`);
    const trigger = a.trigger
      ? { triggerPx: roundPxGrid(Number(a.trigger.triggerPx), m.resolved.szDecimals, m.resolved.isSpot), isMarket: a.trigger.isMarket, tpsl: a.trigger.tpsl }
      : undefined;
    const wire = buildOrderWire({
      assetIndex: m.resolved.assetIndex,
      isBuy: a.side === "buy",
      px,
      sz,
      reduceOnly: a.reduceOnly ?? false,
      tif: a.tif as Tif | undefined,
      trigger,
      cloid: a.cloid,
    });
    return this.postL1(buildOrderAction([wire]));
  }

  async cancel(a: HlCancelArgs): Promise<SubmitResult> {
    const m = await this.resolve(a.marketId);
    if ("error" in m) return rejected(m.error);
    if (a.cloid) return this.postL1(buildCancelByCloidAction([{ assetIndex: m.resolved.assetIndex, cloid: a.cloid }]));
    if (a.oid != null) return this.postL1(buildCancelAction([{ assetIndex: m.resolved.assetIndex, oid: a.oid }]));
    if (a.all) {
      const oids = await this.openOidsForMarket(m.resolved, m.pairIndex);
      if (oids.length === 0) return { posted: true, status: "accepted", raw: { note: "no open orders on this market" } };
      return this.postL1(buildCancelAction(oids.map((oid) => ({ assetIndex: m.resolved.assetIndex, oid }))));
    }
    return rejected("cancel needs one of: oid, cloid, or all:true");
  }

  // ── risk / margin ────────────────────────────────────────────────────────────

  async updateLeverage(a: HlLeverageArgs): Promise<SubmitResult> {
    const m = await this.resolve(a.marketId);
    if ("error" in m) return rejected(m.error);
    if (m.resolved.isSpot) return rejected("leverage applies to perps only (spot has none)");
    return this.postL1(buildUpdateLeverageAction(m.resolved.assetIndex, a.cross, a.leverage));
  }

  async updateIsolatedMargin(a: HlIsoMarginArgs): Promise<SubmitResult> {
    const m = await this.resolve(a.marketId);
    if ("error" in m) return rejected(m.error);
    if (m.resolved.isSpot) return rejected("isolated margin applies to perps only");
    const ntli = usdToMicro(Number(a.usdDelta)); // positive adds margin, negative removes
    return this.postL1(buildUpdateIsolatedMarginAction(m.resolved.assetIndex, ntli));
  }

  // ── account movement (no external recipient) ─────────────────────────────────

  async usdClassTransfer(a: HlClassTransferArgs): Promise<SubmitResult> {
    const signer = getEvmSigner("hyperliquid");
    const signed = signUsdClassTransfer({ signer, amount: a.amount, toPerp: a.toPerp, nonce: Date.now(), isMainnet: this.isMainnet });
    return this.postUser(signed);
  }

  // ── yield: vaults + staking ──────────────────────────────────────────────────

  async vaultTransfer(a: HlVaultArgs): Promise<SubmitResult> {
    const usd = usdToMicro(Number(a.usd));
    // vaultTransfer is signed with vaultAddress=null in the HASH (SDK passes
    // active_pool=None) even though the vaultAddress rides in the action body.
    return this.postL1(buildVaultTransferAction(a.vaultAddress, a.isDeposit, usd));
  }

  async stake(a: HlStakeArgs): Promise<SubmitResult> {
    const signer = getEvmSigner("hyperliquid");
    const wei = toWei(Number(a.hype), await this.hypeWeiDecimals());
    const signed = a.direction === "deposit"
      ? signCDeposit({ signer, wei, nonce: Date.now(), isMainnet: this.isMainnet })
      : signCWithdraw({ signer, wei, nonce: Date.now(), isMainnet: this.isMainnet });
    return this.postUser(signed);
  }

  async delegate(a: HlDelegateArgs): Promise<SubmitResult> {
    const signer = getEvmSigner("hyperliquid");
    const wei = toWei(Number(a.hype), await this.hypeWeiDecimals());
    const signed = signTokenDelegate({ signer, validator: a.validator, wei, isUndelegate: a.undelegate, nonce: Date.now(), isMainnet: this.isMainnet });
    return this.postUser(signed);
  }

  // ── TWAP ──────────────────────────────────────────────────────────────────────

  async twapOrder(a: HlTwapOrderArgs): Promise<SubmitResult> {
    const m = await this.resolve(a.marketId);
    if ("error" in m) return rejected(m.error);
    const sz = roundSz(Number(a.size), m.resolved.szDecimals);
    if (!(sz > 0)) return rejected(`twap size rounds to 0 at szDecimals=${m.resolved.szDecimals}`);
    return this.postL1(buildTwapOrderAction({ assetIndex: m.resolved.assetIndex, isBuy: a.side === "buy", sz, reduceOnly: a.reduceOnly ?? false, minutes: a.minutes, randomize: a.randomize ?? false }));
  }

  async twapCancel(a: HlTwapCancelArgs): Promise<SubmitResult> {
    const m = await this.resolve(a.marketId);
    if ("error" in m) return rejected(m.error);
    return this.postL1(buildTwapCancelAction(m.resolved.assetIndex, a.twapId));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Resolve a market to its asset index + size precision + spot pair index. */
  private async resolve(marketId: string): Promise<{ resolved: ResolvedHl; pairIndex: number } | { error: string }> {
    const r = await resolveHlAsset(marketId, { host: this.host });
    if (!r.ok || !r.resolved) return { error: String(r.meta.error ?? `could not resolve ${marketId}`) };
    return { resolved: r.resolved, pairIndex: Number(r.meta.pairIndex ?? -1) };
  }

  /** HYPE native wei-decimals (cached) — the unit cDeposit/cWithdraw/tokenDelegate use. */
  private async hypeWeiDecimals(): Promise<number> {
    if (this.hypeWei != null) return this.hypeWei;
    const r = await resolveHlAsset("hlspot:HYPE", { host: this.host });
    const wd = r.resolved?.weiDecimals;
    if (!(typeof wd === "number" && wd > 0)) throw new Error("could not resolve HYPE wei-decimals from spotMeta");
    this.hypeWei = wd;
    return wd;
  }

  /** Open order ids on a single market (perp coin OR spot "@pairIndex"). */
  private async openOidsForMarket(m: ResolvedHl, pairIndex: number): Promise<number[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oo = await infoPost<any[]>({ type: "frontendOpenOrders", user: getEvmSigner("hyperliquid").address }, { host: this.host });
    const id = m.isSpot ? `@${pairIndex}` : m.coin;
    return (Array.isArray(oo) ? oo : [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((o: any) => String(o?.coin).toUpperCase() === id.toUpperCase() && o?.oid != null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((o: any) => Number(o.oid));
  }

  /** Sign an L1 action locally + POST it. (vaultAddress null = plain EOA, no sub-account.) */
  private async postL1(action: Record<string, unknown>): Promise<SubmitResult> {
    const signer = getEvmSigner("hyperliquid");
    const nonce = Date.now();
    const signature = signL1Action({ signer, action, nonce, vaultAddress: null, isMainnet: this.isMainnet });
    return postExchange({ action, nonce, signature, vaultAddress: null }, { host: this.host });
  }

  /** POST an already-signed USER-signed action (cast like hyperliquid.ts's withdraw). */
  private async postUser(signed: { action: unknown; nonce: number; signature: RsvSignature }): Promise<SubmitResult> {
    return postExchange({ action: signed.action as Record<string, unknown>, nonce: signed.nonce, signature: signed.signature, vaultAddress: null }, { host: this.host });
  }
}

/** The HlVenueOps the hl_* tools run on. Wired in server.ts when an HL signer is loaded. */
export function makeRealHlVenue(): HlVenueOps {
  return new HlVenue();
}

// Re-export Side/AmountKind so the tool layer's arg types can reference them without
// importing from two places.
export type { Side, AmountKind };
