// src/adapters/jupiter-venue.ts
// The Jupiter surface BEYOND spot swap: limit (Trigger) orders + recurring (DCA), and
// (added incrementally) lend + prediction markets. Same shape as makeRealHlVenue /
// makeRealPmBridge: an injectable ops object the tool layer drives, EXECUTING each flow
// (call the keyless REST endpoint -> sign the returned base64 tx with the local Solana
// key -> land it). Pure REST + the shared signing helpers in jupiter-rest.ts; decimals
// resolve via the existing JupiterAdapter (any SPL mint).
//
// These keep funds in the user's own wallet (orders escrow to a program-owned order
// account the user can cancel), so none take a recipient.
import type { SubmitResult } from "./types.js";
import type {
  JupVenueOps,
  JupLimitArgs,
  JupLimitCancelArgs,
  JupRecurringArgs,
  JupRecurringCancelArgs,
  JupLendEarnArgs,
  JupLendBorrowArgs,
  JupPredEventsArgs,
  JupPredOrderArgs,
  JupPredExitArgs,
} from "../tools/index.js";
import { getSolanaSigner } from "../signers/index.js";
import { JupiterAdapter, toBaseUnits, USDC_MINT } from "./jupiter.js";
import { jupGet, jupPost, jupDelete, signAndExecute, signAndBroadcast } from "./jupiter-rest.js";

const rejected = (error: string): SubmitResult => ({ posted: false, status: "rejected", error });

class JupVenue implements JupVenueOps {
  private readonly jup = new JupiterAdapter(); // decimals resolution for any mint
  private user(): string {
    return getSolanaSigner().address;
  }

  // ── Trigger / limit orders ───────────────────────────────────────────────────
  // The limit PRICE is implied by makingAmount (sell) / takingAmount (buy): you get
  // filled when the market offers >= takingAmount of outputMint for your makingAmount.

  async limitCreate(a: JupLimitArgs): Promise<SubmitResult> {
    const [inMeta, outMeta] = await Promise.all([
      this.jup.resolveTokenMeta(a.inputMint),
      this.jup.resolveTokenMeta(a.outputMint),
    ]);
    const user = this.user();
    const body = {
      inputMint: a.inputMint,
      outputMint: a.outputMint,
      maker: user,
      payer: user,
      params: {
        makingAmount: toBaseUnits(a.makingAmount, inMeta.decimals),
        takingAmount: toBaseUnits(a.takingAmount, outMeta.decimals),
        ...(a.slippageBps != null ? { slippageBps: String(a.slippageBps) } : {}),
        ...(a.expiredAt != null ? { expiredAt: String(a.expiredAt) } : {}),
      },
      computeUnitPrice: "auto",
    };
    const r = await jupPost<{ transaction?: string; requestId?: string; order?: string; error?: string }>("/trigger/v1/createOrder", body);
    if (!r.transaction || !r.requestId) return { posted: false, status: "rejected", error: r.error ?? "createOrder returned no transaction", raw: r };
    const exec = await signAndExecute({ unsignedTxB64: r.transaction, requestId: r.requestId, executePath: "/trigger/v1/execute" });
    // Prefer the order account from createOrder (the handle to cancel by).
    if (r.order && !exec.orderId) exec.orderId = r.order;
    return exec;
  }

  async limitCancel(a: JupLimitCancelArgs): Promise<SubmitResult> {
    const body = { maker: this.user(), order: a.order, computeUnitPrice: "auto" };
    const r = await jupPost<{ transaction?: string; requestId?: string; error?: string }>("/trigger/v1/cancelOrder", body);
    if (!r.transaction || !r.requestId) return { posted: false, status: "rejected", error: r.error ?? "cancelOrder returned no transaction", raw: r };
    return signAndExecute({ unsignedTxB64: r.transaction, requestId: r.requestId, executePath: "/trigger/v1/execute" });
  }

  async limitList(status: "active" | "history"): Promise<unknown> {
    return jupGet("/trigger/v1/getTriggerOrders", { user: this.user(), orderStatus: status });
  }

  // ── Recurring / DCA (time-based; price-based is deprecated via API) ───────────

  async recurringCreate(a: JupRecurringArgs): Promise<SubmitResult> {
    const inMeta = await this.jup.resolveTokenMeta(a.inputMint);
    const body = {
      user: this.user(),
      inputMint: a.inputMint,
      outputMint: a.outputMint,
      params: {
        time: {
          inAmount: Number(toBaseUnits(a.inAmount, inMeta.decimals)), // total input across all cycles
          numberOfOrders: a.numberOfOrders,
          interval: a.interval, // seconds between cycles
          minPrice: a.minPrice ?? null,
          maxPrice: a.maxPrice ?? null,
          startAt: a.startAt ?? null,
        },
      },
    };
    const r = await jupPost<{ transaction?: string; requestId?: string; error?: string }>("/recurring/v1/createOrder", body);
    if (!r.transaction || !r.requestId) return { posted: false, status: "rejected", error: r.error ?? "createOrder returned no transaction", raw: r };
    // /execute returns the order account in `order`; signAndExecute surfaces it as orderId.
    return signAndExecute({ unsignedTxB64: r.transaction, requestId: r.requestId, executePath: "/recurring/v1/execute" });
  }

  async recurringCancel(a: JupRecurringCancelArgs): Promise<SubmitResult> {
    const body = { order: a.order, user: this.user(), recurringType: "time" };
    const r = await jupPost<{ transaction?: string; requestId?: string; error?: string }>("/recurring/v1/cancelOrder", body);
    if (!r.transaction || !r.requestId) return { posted: false, status: "rejected", error: r.error ?? "cancelOrder returned no transaction", raw: r };
    return signAndExecute({ unsignedTxB64: r.transaction, requestId: r.requestId, executePath: "/recurring/v1/execute" });
  }

  async recurringList(status: "active" | "history"): Promise<unknown> {
    return jupGet("/recurring/v1/getRecurringOrders", { user: this.user(), orderStatus: status, recurringType: "time" });
  }

  // ── Lend: Earn (deposit/withdraw yield) ──────────────────────────────────────
  // amount is a decimal UI amount of `asset`; converted to raw units via the mint's
  // decimals. Returns an unsigned tx we broadcast ourselves (Lend has no /execute).

  async lendDeposit(a: JupLendEarnArgs): Promise<SubmitResult> {
    const meta = await this.jup.resolveTokenMeta(a.asset);
    const r = await jupPost<{ transaction?: string; error?: string }>("/lend/v1/earn/deposit", { asset: a.asset, amount: toBaseUnits(a.amount, meta.decimals), signer: this.user() });
    if (!r.transaction) return rejected(r.error ?? "lend deposit returned no transaction");
    return signAndBroadcast({ unsignedTxB64: r.transaction });
  }

  async lendWithdraw(a: JupLendEarnArgs): Promise<SubmitResult> {
    const meta = await this.jup.resolveTokenMeta(a.asset);
    const r = await jupPost<{ transaction?: string; error?: string }>("/lend/v1/earn/withdraw", { asset: a.asset, amount: toBaseUnits(a.amount, meta.decimals), signer: this.user() });
    if (!r.transaction) return rejected(r.error ?? "lend withdraw returned no transaction");
    return signAndBroadcast({ unsignedTxB64: r.transaction });
  }

  async lendTokens(): Promise<unknown> {
    return jupGet("/lend/v1/earn/tokens", {});
  }

  async lendPositions(): Promise<unknown> {
    return jupGet("/lend/v1/earn/positions", { users: this.user() });
  }

  // ── Lend: Borrow (collateralized; advanced) ──────────────────────────────────
  // ONE unified `operate` endpoint: colAmount/debtAmount are SIGNED RAW-unit strings —
  // +col supplies collateral / -col withdraws it; +debt borrows / -debt repays.
  // positionId 0 opens a new position (an NFT). Raw units (no UI conversion) because
  // the two tokens differ per vault; read decimals from lendVaults() first.

  async lendBorrow(a: JupLendBorrowArgs): Promise<SubmitResult> {
    const r = await jupPost<{ transaction?: string; nftId?: number; error?: string }>("/lend/v1/borrow/operate", {
      vaultId: a.vaultId,
      positionId: a.positionId,
      signer: this.user(),
      colAmount: a.colAmount,
      debtAmount: a.debtAmount,
    });
    if (!r.transaction) return rejected(r.error ?? "lend borrow/operate returned no transaction");
    const res = await signAndBroadcast({ unsignedTxB64: r.transaction });
    if (res.posted && r.nftId != null) res.orderId = String(r.nftId); // the borrow position NFT id
    return res;
  }

  async lendVaults(): Promise<unknown> {
    return jupGet("/lend/v1/borrow/vaults", {});
  }

  async lendBorrowPositions(): Promise<unknown> {
    return jupGet("/lend/v1/borrow/positions", { users: this.user() });
  }

  // ── Prediction markets (binary YES/NO) ───────────────────────────────────────
  // NOTE: Predict is served from api.jup.ag and (per the docs) needs an API key —
  // set STARLING_JUP_API_KEY so jupHost() targets api.jup.ag. Geo-blocked (US/KR).
  // Amounts are USD; depositAmount is micro-USD ($5 min). Returns an unsigned tx we
  // broadcast (txMeta carries lastValidBlockHeight). Sell = DELETE the position.

  async predEvents(a: JupPredEventsArgs): Promise<unknown> {
    if (a.search) return jupGet("/prediction/v1/events/search", { query: a.search });
    return jupGet("/prediction/v1/events", { filter: a.filter, category: a.category, includeMarkets: "true" });
  }

  async predOrder(a: JupPredOrderArgs): Promise<SubmitResult> {
    const depositMint = a.depositMint ?? USDC_MINT;
    const depositAmount = String(Math.round(Number(a.usd) * 1e6)); // micro-USD ($5 min)
    const r = await jupPost<{ transaction?: string; txMeta?: { lastValidBlockHeight?: number }; order?: { orderPubkey?: string; positionPubkey?: string }; error?: string }>(
      "/prediction/v1/orders",
      { ownerPubkey: this.user(), marketId: a.marketId, isYes: a.isYes, isBuy: true, depositAmount, depositMint },
    );
    if (!r.transaction) return rejected(r.error ?? "prediction order returned no transaction");
    const res = await signAndBroadcast({ unsignedTxB64: r.transaction, lastValidBlockHeight: r.txMeta?.lastValidBlockHeight });
    if (res.posted) res.orderId = r.order?.positionPubkey ?? r.order?.orderPubkey; // the position handle (for exit/claim)
    return res;
  }

  async predPositions(): Promise<unknown> {
    return jupGet("/prediction/v1/positions", { ownerPubkey: this.user() });
  }

  async predExit(a: JupPredExitArgs): Promise<SubmitResult> {
    const r = await jupDelete<{ transaction?: string; txMeta?: { lastValidBlockHeight?: number }; error?: string }>(`/prediction/v1/positions/${a.positionPubkey}`, { ownerPubkey: this.user() });
    if (!r.transaction) return rejected(r.error ?? "prediction exit returned no transaction");
    // Multi-sig pre-signed (Jupiter co-signs) -> pass the baked-blockhash height so we
    // DON'T refresh it (refreshing would invalidate Jupiter's pre-signature).
    return signAndBroadcast({ unsignedTxB64: r.transaction, lastValidBlockHeight: r.txMeta?.lastValidBlockHeight });
  }

  async predClaim(a: JupPredExitArgs): Promise<SubmitResult> {
    const r = await jupPost<{ transaction?: string; txMeta?: { lastValidBlockHeight?: number }; error?: string }>(`/prediction/v1/positions/${a.positionPubkey}/claim`, { ownerPubkey: this.user() });
    if (!r.transaction) return rejected(r.error ?? "prediction claim returned no transaction");
    return signAndBroadcast({ unsignedTxB64: r.transaction, lastValidBlockHeight: r.txMeta?.lastValidBlockHeight });
  }
}

/** The JupVenueOps the jup_* tools run on. Wired in server.ts when a Solana signer is loaded. */
export function makeRealJupVenue(): JupVenueOps {
  return new JupVenue();
}
