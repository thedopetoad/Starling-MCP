// src/adapters/polymarket-bridge.test.ts
// The bridge.polymarket.com HTTP client — request shapes + response parsing + the
// optional builder-code header, all against an injected fake fetch (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PolymarketBridge, PM_SOLANA_CHAIN_ID, SOLANA_USDC_MINT, type SupportedAsset } from "./polymarket-bridge.js";

interface Call { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }
function fakeFetch(handler: () => { ok: boolean; status: number; json: () => Promise<unknown> }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: Call["init"]) => {
    calls.push({ url, init: init ?? {} });
    return handler();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (obj: unknown, ok = true, status = 200) => ({ ok, status, json: async () => obj });

test("getDepositAddresses POSTs /deposit and returns the address bundle", async () => {
  const { fn, calls } = fakeFetch(() => json({ address: { evm: "0xEVM", svm: "SOLADDR", tron: "T", btc: "b" } }));
  const b = new PolymarketBridge({ fetchImpl: fn });
  const a = await b.getDepositAddresses("0xDW");
  assert.equal(a.svm, "SOLADDR");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/deposit$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body!), { address: "0xDW" });
});

test("getWithdrawAddress POSTs /withdraw with chain + token + recipient", async () => {
  const { fn, calls } = fakeFetch(() => json({ address: { evm: "0xBRIDGE", svm: "s", tron: "t", btc: "b" } }));
  const b = new PolymarketBridge({ fetchImpl: fn });
  const a = await b.getWithdrawAddress({ dwAddress: "0xDW", toChainId: PM_SOLANA_CHAIN_ID, toTokenAddress: SOLANA_USDC_MINT, recipientAddr: "SOLrecip" });
  assert.equal(a.evm, "0xBRIDGE"); // the relay transfer happens on Polygon -> use the EVM address
  const body = JSON.parse(calls[0].init.body!);
  assert.equal(body.address, "0xDW");
  assert.equal(body.toChainId, PM_SOLANA_CHAIN_ID);
  assert.equal(body.toTokenAddress, SOLANA_USDC_MINT);
  assert.equal(body.recipientAddr, "SOLrecip");
});

test("findAsset filters supported-assets by chain + symbol (case-insensitive)", async () => {
  const assets: SupportedAsset[] = [
    { chainId: PM_SOLANA_CHAIN_ID, chainName: "Solana", token: { name: "USD Coin", symbol: "USDC", address: SOLANA_USDC_MINT, decimals: 6 }, minCheckoutUsd: 2 },
    { chainId: "137", chainName: "Polygon", token: { name: "pUSD", symbol: "pUSD", address: "0xpusd", decimals: 6 }, minCheckoutUsd: 0 },
  ];
  const { fn } = fakeFetch(() => json({ supportedAssets: assets }));
  const b = new PolymarketBridge({ fetchImpl: fn });
  const got = await b.findAsset(PM_SOLANA_CHAIN_ID, "usdc");
  assert.equal(got?.minCheckoutUsd, 2);
  assert.equal(got?.token.address, SOLANA_USDC_MINT);
});

test("X-Builder-Code header attached only when STARLING_PM_BUILDER_CODE is set", async () => {
  const { fn, calls } = fakeFetch(() => json({ address: { evm: "0x", svm: "", tron: "", btc: "" } }));
  delete process.env.STARLING_PM_BUILDER_CODE;
  const b = new PolymarketBridge({ fetchImpl: fn });
  await b.getDepositAddresses("0xDW");
  assert.equal(calls[0].init.headers?.["X-Builder-Code"], undefined);

  process.env.STARLING_PM_BUILDER_CODE = "0xBUILDER";
  await b.getDepositAddresses("0xDW");
  assert.equal(calls[1].init.headers?.["X-Builder-Code"], "0xBUILDER");
  delete process.env.STARLING_PM_BUILDER_CODE;
});

test("a non-ok response throws with the HTTP status", async () => {
  const { fn } = fakeFetch(() => json({ error: "bad" }, false, 400));
  const b = new PolymarketBridge({ fetchImpl: fn });
  await assert.rejects(() => b.getDepositAddresses("0xDW"), /HTTP 400/);
});
