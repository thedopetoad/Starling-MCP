// src/adapters/evm-rpc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmRpc, EVM_CHAIN_IDS, EVM_CHAIN_NET } from "./evm-rpc.js";

// A canned JSON-RPC responder: maps method -> result (hex strings / objects).
function cannedFetch(byMethod: Record<string, unknown>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    if (!(method in byMethod)) throw new Error(`unexpected method ${method}`);
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: byMethod[method] }),
    };
  }) as unknown as typeof fetch;
}

test("chain id + net maps are correct for the launch chains", () => {
  assert.equal(EVM_CHAIN_IDS.polygon, 137);
  assert.equal(EVM_CHAIN_IDS.arbitrum, 42161);
  assert.equal(EVM_CHAIN_NET.hyperliquid, "arbitrum"); // HL funds live on Arbitrum
  assert.equal(EVM_CHAIN_NET.polygon, "polygon");
});

test("nonce + balance hex are parsed to numbers/bigints", async () => {
  const rpc = new EvmRpc({
    net: "polygon",
    fetchImpl: cannedFetch({
      eth_getTransactionCount: "0x2a", // 42
      eth_getBalance: "0xde0b6b3a7640000", // 1e18 wei
    }),
  });
  assert.equal(await rpc.getPendingNonce("0xabc"), 42);
  assert.equal(await rpc.getBalanceWei("0xabc"), 1_000_000_000_000_000_000n);
});

test("suggestFees applies the Polygon 30-gwei priority floor + 2x base headroom", async () => {
  const rpc = new EvmRpc({
    net: "polygon",
    fetchImpl: cannedFetch({
      eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, // 1 gwei
      eth_maxPriorityFeePerGas: "0x5f5e100", // 0.1 gwei -> floored up to 30 gwei
    }),
  });
  const fees = await rpc.suggestFees();
  assert.equal(fees.maxPriorityFeePerGas, 30_000_000_000n);
  // 2 * 1gwei + 30gwei = 32 gwei
  assert.equal(fees.maxFeePerGas, 32_000_000_000n);
});

test("getReceipt maps status 0x1 -> success, 0x0 -> reverted, missing -> null", async () => {
  const success = new EvmRpc({
    net: "arbitrum",
    fetchImpl: cannedFetch({
      eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x10", gasUsed: "0x5208", transactionHash: "0xabc" },
    }),
  });
  const r = await success.getReceipt("0xabc");
  assert.equal(r?.status, "success");
  assert.equal(r?.gasUsed, 21_000n);

  const reverted = new EvmRpc({
    net: "arbitrum",
    fetchImpl: cannedFetch({
      eth_getTransactionReceipt: { status: "0x0", blockNumber: "0x10", gasUsed: "0x5208", transactionHash: "0xabc" },
    }),
  });
  assert.equal((await reverted.getReceipt("0xabc"))?.status, "reverted");

  const pending = new EvmRpc({ net: "arbitrum", fetchImpl: cannedFetch({ eth_getTransactionReceipt: null }) });
  assert.equal(await pending.getReceipt("0xabc"), null);
});
