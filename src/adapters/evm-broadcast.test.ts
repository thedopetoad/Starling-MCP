// src/adapters/evm-broadcast.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { makeEvmSigner } from "../signers/evm.js";
import { signAndSendEvm } from "./evm-broadcast.js";
import type { EvmRpcLike, EvmReceipt, EvmFees } from "./evm-rpc.js";

// A throwaway test key (NEVER a real one): 32 bytes of 0x01 — a valid scalar.
const TEST_KEY = new Uint8Array(32).fill(1);
const TO = ("0x" + "ab".repeat(20)) as Hex;

interface FakeOpts {
  chainId?: number;
  liveChainId?: number;
  pendingNonce?: number;
  latestNonce?: number | (() => number);
  estimateGas?: bigint;
  fees?: EvmFees;
  callReadonly?: () => Promise<string>;
  send?: (raw: string) => Promise<string>;
  receipt?: EvmReceipt | null | (() => EvmReceipt | null);
  onSend?: (raw: string) => void;
}

function fakeRpc(o: FakeOpts = {}): EvmRpcLike {
  const chainId = o.chainId ?? 137;
  return {
    net: "polygon",
    chainId,
    async getChainId() {
      return o.liveChainId ?? chainId;
    },
    async getPendingNonce() {
      return o.pendingNonce ?? 7;
    },
    async getLatestNonce() {
      return typeof o.latestNonce === "function" ? o.latestNonce() : (o.latestNonce ?? (o.pendingNonce ?? 7));
    },
    async estimateGas() {
      return o.estimateGas ?? 50_000n;
    },
    async suggestFees() {
      return o.fees ?? { maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 30_000_000_000n };
    },
    async callReadonly() {
      return o.callReadonly ? o.callReadonly() : "0x";
    },
    async sendRawTransaction(raw: string) {
      o.onSend?.(raw);
      if (o.send) return o.send(raw);
      return "0xhash";
    },
    async getReceipt() {
      const r = typeof o.receipt === "function" ? o.receipt() : o.receipt;
      return r ?? null;
    },
  };
}

const okReceipt: EvmReceipt = {
  status: "success",
  blockNumber: 100n,
  gasUsed: 46_000n,
  transactionHash: "0xhash",
};

test("happy path: signs a byte-valid EIP-1559 tx that recovers to the signer", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  let sentRaw = "";
  const rpc = fakeRpc({ pendingNonce: 7, receipt: okReceipt, onSend: (raw) => (sentRaw = raw) });

  const res = await signAndSendEvm({ to: TO, data: "0x", value: 0n }, signer, rpc, { pollMs: 1 });

  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.equal(res.nonce, 7);
  assert.equal(res.gasUsed, 46_000n);

  // PROOF the encoding + signature are correct: the raw tx must recover to us.
  const recovered = await recoverTransactionAddress({ serializedTransaction: sentRaw as `0x02${string}` });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());

  // …and the structural fields round-trip.
  const parsed = parseTransaction(sentRaw as `0x02${string}`);
  assert.equal(parsed.type, "eip1559");
  assert.equal(parsed.chainId, 137);
  assert.equal(parsed.nonce, 7);
  assert.equal((parsed.to ?? "").toLowerCase(), TO.toLowerCase());
  assert.equal(parsed.gas, (50_000n * 125n) / 100n); // estimate + 25%
});

test("chainId guard: refuses to sign when the live RPC is a different chain", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  const rpc = fakeRpc({ chainId: 137, liveChainId: 42161 });
  await assert.rejects(() => signAndSendEvm({ to: TO }, signer, rpc), /chainId 42161 != expected 137/);
});

test("revert pre-check: aborts before sending, nothing broadcast", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  let sends = 0;
  const rpc = fakeRpc({
    callReadonly: async () => {
      throw new Error("execution reverted: ERC20: insufficient allowance");
    },
    onSend: () => sends++,
  });
  const res = await signAndSendEvm({ to: TO, data: "0x1234" }, signer, rpc);
  assert.equal(res.status, "precheck_failed");
  assert.equal(res.ok, false);
  assert.equal(sends, 0);
});

test("send error is swallowed; a real receipt still confirms success", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  const rpc = fakeRpc({
    send: async () => {
      throw new Error("known transaction"); // node says "already known" — NOT a failure
    },
    receipt: okReceipt,
  });
  const res = await signAndSendEvm({ to: TO }, signer, rpc, { pollMs: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.equal(res.sendError, "known transaction");
});

test("replaced: a different tx consumed our nonce -> reconcile, never re-sign", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  const rpc = fakeRpc({ pendingNonce: 5, latestNonce: 6, receipt: null });
  const res = await signAndSendEvm({ to: TO }, signer, rpc, { pollMs: 1, maxWallClockMs: 50 });
  assert.equal(res.status, "replaced");
  assert.equal(res.ok, false);
  assert.equal(res.nonce, 5);
});

test("reverted receipt -> ok:false, status reverted", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  const reverted: EvmReceipt = { ...okReceipt, status: "reverted" };
  const res = await signAndSendEvm({ to: TO }, signer, fakeRpc({ receipt: reverted }), { pollMs: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.status, "reverted");
});

test("gas-limit cap: a runaway estimate is refused before signing", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  const rpc = fakeRpc({ estimateGas: 3_000_000n }); // > default 2,000,000 cap
  await assert.rejects(() => signAndSendEvm({ to: TO }, signer, rpc), /exceeds cap/);
});

test("timeout with no receipt and no nonce movement -> unknown (not failed)", async () => {
  const signer = makeEvmSigner(TEST_KEY);
  const rpc = fakeRpc({ pendingNonce: 9, latestNonce: 9, receipt: null });
  const res = await signAndSendEvm({ to: TO }, signer, rpc, { pollMs: 1, maxWallClockMs: 5 });
  assert.equal(res.status, "unknown");
  assert.equal(res.ok, false);
});
