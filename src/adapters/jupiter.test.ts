// src/adapters/jupiter.test.ts
// Jupiter adapter against a fake quote/swap transport (no live API): base-unit
// math, the quote URL params, the /swap body, and buildOpen mapping side->mints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnlock } from "../signers/index.js";
import {
  JupiterAdapter,
  SOL_MINT,
  USDC_MINT,
  toBaseUnits,
  decimalsOf,
  stripJupPrefix,
} from "./jupiter.js";

process.env.STARLING_KEY_SOURCE = "env";
process.env.STARLING_PK_SOLANA = "0101010101010101010101010101010101010101010101010101010101010101"; // 32-byte seed (hex)
await bootUnlock();

test("toBaseUnits converts decimals without float drift", () => {
  assert.equal(toBaseUnits("0.01", 9), "10000000");
  assert.equal(toBaseUnits("1", 6), "1000000");
  assert.equal(toBaseUnits("3.278695", 6), "3278695");
  assert.equal(toBaseUnits("0", 9), "0");
  assert.throws(() => toBaseUnits("0.0000000001", 6)); // more precision than decimals
});

test("decimalsOf + stripJupPrefix", () => {
  assert.equal(decimalsOf(SOL_MINT), 9);
  assert.equal(decimalsOf(USDC_MINT), 6);
  assert.equal(stripJupPrefix(`jup:${USDC_MINT}`), USDC_MINT);
  assert.equal(stripJupPrefix(USDC_MINT), USDC_MINT);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function router(state: any): typeof fetch {
  return (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes("/quote")) {
      state.lastQuoteUrl = u;
      const parsed = new URL(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          inputMint: parsed.searchParams.get("inputMint"),
          outputMint: parsed.searchParams.get("outputMint"),
          inAmount: parsed.searchParams.get("amount"),
          outAmount: "123456",
          otherAmountThreshold: "123000",
          slippageBps: Number(parsed.searchParams.get("slippageBps")),
          routePlan: [],
        }),
      } as unknown as Response;
    }
    if (u.endsWith("/swap")) {
      state.lastSwapBody = JSON.parse(init!.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ swapTransaction: "AQAB-base64-placeholder", lastValidBlockHeight: 4242 }),
      } as unknown as Response;
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

test("buildOpen BUY maps SOL->target, sizes in SOL base units, returns a solanaTx", async () => {
  const state: Record<string, unknown> = {};
  const a = new JupiterAdapter({ fetchImpl: router(state) });
  const build = await a.buildOpen({
    venue: "jupiter",
    marketId: `jup:${USDC_MINT}`,
    side: "buy",
    amount: "0.01",
    amountKind: "collateral",
    worstPrice: "0",
    slippageFrac: 0.005,
    idempotencyKey: "k1",
  });
  assert.equal(build.kind, "solanaTx");
  assert.equal(build.lastValidBlockHeight, 4242);
  assert.equal(build.unsignedTxB64, "AQAB-base64-placeholder");

  const q = new URL(state.lastQuoteUrl as string);
  assert.equal(q.searchParams.get("inputMint"), SOL_MINT);
  assert.equal(q.searchParams.get("outputMint"), USDC_MINT);
  assert.equal(q.searchParams.get("amount"), "10000000"); // 0.01 SOL @ 9dp
  assert.equal(q.searchParams.get("slippageBps"), "50"); // 0.5%

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = state.lastSwapBody as any;
  assert.equal(body.wrapAndUnwrapSol, true);
  assert.equal(body.dynamicComputeUnitLimit, true);
  assert.ok(body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports > 0);
  assert.match(body.userPublicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // the loaded signer
});

test("buildOpen enforces the absolute worstPrice floor against guaranteed minOut", async () => {
  const a = new JupiterAdapter({ fetchImpl: router({}) });
  // fake quote: otherAmountThreshold 123000 (0.123 USDC) for 0.01 SOL => rate 12.3 out/in.
  await assert.rejects(
    a.buildOpen({
      venue: "jupiter",
      marketId: `jup:${USDC_MINT}`,
      side: "buy",
      amount: "0.01",
      amountKind: "collateral",
      worstPrice: "50", // demand >=50 USDC/SOL — quote can't meet it
      idempotencyKey: "kf",
    }),
    /below worstPrice floor/,
  );
  // a floor the quote DOES clear builds fine.
  const ok = await a.buildOpen({
    venue: "jupiter",
    marketId: `jup:${USDC_MINT}`,
    side: "buy",
    amount: "0.01",
    amountKind: "collateral",
    worstPrice: "10",
    idempotencyKey: "kf2",
  });
  assert.equal(ok.kind, "solanaTx");
});

test("buildOpen SELL maps target->SOL, sizes in the token's base units", async () => {
  const state: Record<string, unknown> = {};
  const a = new JupiterAdapter({ fetchImpl: router(state) });
  await a.buildOpen({
    venue: "jupiter",
    marketId: `jup:${USDC_MINT}`,
    side: "sell",
    amount: "1.5",
    amountKind: "shares",
    worstPrice: "0",
    idempotencyKey: "k2",
  });
  const q = new URL(state.lastQuoteUrl as string);
  assert.equal(q.searchParams.get("inputMint"), USDC_MINT);
  assert.equal(q.searchParams.get("outputMint"), SOL_MINT);
  assert.equal(q.searchParams.get("amount"), "1500000"); // 1.5 USDC @ 6dp
});
