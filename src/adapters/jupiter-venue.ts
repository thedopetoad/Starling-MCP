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
} from "../tools/index.js";
import { getSolanaSigner } from "../signers/index.js";
import { JupiterAdapter, toBaseUnits } from "./jupiter.js";
import { jupGet, jupPost, signAndExecute } from "./jupiter-rest.js";

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
}

/** The JupVenueOps the jup_* tools run on. Wired in server.ts when a Solana signer is loaded. */
export function makeRealJupVenue(): JupVenueOps {
  return new JupVenue();
}
