// src/adapters/hyperliquid.test.ts
// Adapter behavior with a fake /info + /exchange transport (no live venue): the
// wire-shape helpers, build→submit assembling a correctly-keyed IOC order, the
// posted body carrying the local signature, and response classification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnlock } from "../signers/index.js";
import {
  HyperliquidAdapter,
  floatToWire,
  roundPx,
  roundSz,
  stripHlPrefix,
} from "./hyperliquid.js";
import { classifyHlResponse } from "./hl-transport.js";

process.env.STARLING_KEY_SOURCE = "env";
process.env.STARLING_PK_HYPERLIQUID = "0x0000000000000000000000000000000000000000000000000000000000000001";
await bootUnlock();

test("floatToWire matches the SDK normalization", () => {
  assert.equal(floatToWire(100), "100");
  assert.equal(floatToWire(0.5), "0.5");
  assert.equal(floatToWire(12.0), "12");
  assert.equal(floatToWire(0), "0");
  assert.equal(floatToWire(1.23456789), "1.23456789");
});

test("roundPx respects the 5-sig-fig + decimal-cap grid; integers pass through", () => {
  assert.equal(roundPx(60500, 5), 60500); // integer stays
  assert.equal(roundPx(1.23456, 3), 1.235); // 5 sig figs then 3 decimals
});

test("roundSz floors to szDecimals (never over-deploy)", () => {
  assert.equal(roundSz(1.23999, 2), 1.23);
  assert.equal(roundSz(0.0009917, 5), 0.00099);
});

test("stripHlPrefix removes the venue prefix", () => {
  assert.equal(stripHlPrefix("hl:BTC"), "BTC");
  assert.equal(stripHlPrefix("hyperliquid:ETH"), "ETH");
  assert.equal(stripHlPrefix("BTC"), "BTC");
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function router(state: any): typeof fetch {
  return (async (url: unknown, init: { body: string }) => {
    const u = String(url);
    if (u.endsWith("/info")) {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => state.info[body.type] } as unknown as Response;
    }
    if (u.endsWith("/exchange")) {
      state.lastExchange = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => state.exchangeReply } as unknown as Response;
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

test("buildOpen assembles a keyed IOC order; submit POSTs it + classifies a fill", async () => {
  const state = {
    info: {
      meta: { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4 }] },
      allMids: { BTC: "60000", ETH: "3000" },
    },
    exchangeReply: {
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.00099", avgPx: "60000", oid: 123 } }] } },
    },
    lastExchange: undefined as unknown,
  };
  const a = new HyperliquidAdapter({ fetchImpl: router(state), mainnet: true });

  const build = await a.buildOpen({
    venue: "hyperliquid",
    marketId: "hl:BTC",
    side: "buy",
    amount: "60",
    amountKind: "collateral",
    worstPrice: "60500",
    idempotencyKey: "k1",
  });
  assert.equal(build.kind, "hlAction");
  assert.equal(build.assetIndex, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wire = (build.action.orders as any[])[0];
  assert.equal(wire.a, 0);
  assert.equal(wire.b, true);
  assert.equal(wire.r, false);
  assert.deepEqual(wire.t, { limit: { tif: "Ioc" } });
  assert.equal(wire.p, "60500");
  assert.equal(wire.s, "0.00099"); // 60/60500 floored to 5 dp
  assert.match(build.signature.r, /^0x[0-9a-f]{64}$/);

  const submit = await a.submit(build);
  assert.equal(submit.posted, true);
  assert.equal(submit.orderId, "123");
  assert.equal(submit.status, "filled");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((state.lastExchange as any).signature.r, build.signature.r);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((state.lastExchange as any).vaultAddress, null);
});

test("buildOpen resolves a SPOT market to assetIndex 10000+pairIndex via spotMeta", async () => {
  const state = {
    info: {
      spotMeta: {
        tokens: [
          { name: "USDC", index: 0, szDecimals: 8, weiDecimals: 8 },
          { name: "HYPE", index: 150, szDecimals: 2, weiDecimals: 8 },
        ],
        universe: [{ tokens: [150, 0], name: "@107", index: 107 }],
      },
      allMids: { "@107": "40" },
    },
    exchangeReply: {
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.97", avgPx: "40", oid: 5 } }] } },
    },
    lastExchange: undefined as unknown,
  };
  const a = new HyperliquidAdapter({ fetchImpl: router(state), mainnet: true });
  const build = await a.buildOpen({
    venue: "hyperliquid",
    marketId: "hlspot:HYPE",
    side: "buy",
    amount: "40",
    amountKind: "collateral",
    worstPrice: "41",
    idempotencyKey: "s1",
  });
  assert.equal(build.assetIndex, 10107); // 10000 + spot pair index 107
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wire = (build.action.orders as any[])[0];
  assert.equal(wire.a, 10107);
  assert.equal(wire.p, "41"); // integer price passes the grid
  assert.equal(wire.s, "0.97"); // 40/41 floored to szDecimals 2 (the TOKEN's)
});

test("classifyHlResponse treats a non-ok status + per-order error as a rejection", () => {
  assert.equal(classifyHlResponse(true, { status: "err", response: "Insufficient margin" }).posted, false);
  const perOrder = classifyHlResponse(true, {
    status: "ok",
    response: { type: "order", data: { statuses: [{ error: "Order price invalid" }] } },
  });
  assert.equal(perOrder.posted, false);
  assert.match(perOrder.error ?? "", /price invalid/);
});
