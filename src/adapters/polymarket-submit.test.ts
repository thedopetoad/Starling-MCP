// src/adapters/polymarket-submit.test.ts
// Proves the PM submit() path: refuses without L2 creds, POSTs with L2 auth
// headers and classifies a success, and rejects a non-order build. Uses an env
// key (so getEvmSigner resolves an address) + a fake fetch — no live venue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootUnlock } from "../signers/index.js";
import { PolymarketAdapter } from "./polymarket.js";
import type { BuildResult } from "./types.js";

process.env.STARLING_KEY_SOURCE = "env";
process.env.STARLING_PK_POLYGON = "0x0000000000000000000000000000000000000000000000000000000000000001";
await bootUnlock(); // load a polygon signer so submit() can read the address

const ORDER_BUILD: BuildResult = {
  kind: "eip712Order",
  chain: "polygon",
  verifyingContract: "0x0000000000000000000000000000000000000000",
  negRisk: false,
  tickSize: "0.01",
  typedData: {},
  orderStruct: { salt: 1, side: "BUY", signature: "0xsig" },
  postUrl: "https://clob.polymarket.com/order",
};

test("submit refuses without L2 creds", async () => {
  delete process.env.STARLING_PM_CLOB_API_KEY;
  delete process.env.STARLING_PM_CLOB_SECRET;
  delete process.env.STARLING_PM_CLOB_PASSPHRASE;
  const r = await new PolymarketAdapter().submit(ORDER_BUILD);
  assert.equal(r.posted, false);
  assert.match(r.error ?? "", /L2 creds/);
});

test("submit POSTs with L2 auth and classifies a successful order", async () => {
  process.env.STARLING_PM_CLOB_API_KEY = "apikey";
  process.env.STARLING_PM_CLOB_SECRET = "c2VjcmV0"; // valid base64 ("secret")
  process.env.STARLING_PM_CLOB_PASSPHRASE = "pass";
  let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
  const fakeFetch = (async (url: unknown, init: { headers: Record<string, string>; body: string }) => {
    captured = { url: String(url), headers: init.headers, body: init.body };
    return {
      ok: true,
      status: 200,
      json: async () => ({ orderID: "0xabc", status: "matched", transactionsHashes: ["0xdead"] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const r = await new PolymarketAdapter({ fetchImpl: fakeFetch }).submit(ORDER_BUILD);
  assert.equal(r.posted, true);
  assert.equal(r.orderId, "0xabc");
  assert.deepEqual(r.txHashes, ["0xdead"]);
  assert.match(captured!.url, /\/order$/);
  assert.ok(captured!.headers.POLY_SIGNATURE, "L2 signature header present");
  assert.equal(captured!.headers.POLY_API_KEY, "apikey");
  // the inner signed order rides in the payload envelope
  assert.match(captured!.body, /"owner":"apikey"/);
  assert.match(captured!.body, /"orderType":"FAK"/);
});

test("submit rejects a non-order build", async () => {
  const r = await new PolymarketAdapter().submit({
    kind: "solanaTx",
    chain: "solana",
    unsignedTxB64: "",
    lastValidBlockHeight: 0,
  });
  assert.equal(r.posted, false);
});
