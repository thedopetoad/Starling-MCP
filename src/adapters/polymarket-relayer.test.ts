// src/adapters/polymarket-relayer.test.ts
// Locks the hand-rolled relayer to the SDK's wire format. The whole flow is also
// LIVE-PROVEN (a real WALLET batch executed: tx 0x2637648b…), so these guard against
// regressions in the EIP-712 Batch struct + the builder HMAC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, hexToBytes, type Hex } from "viem";
import { makeEvmSigner } from "../signers/evm.js";
import {
  signDepositWalletBatch, buildBuilderHeaders, buildApprovalCalls, buildTransferPusdCall, PUSD,
} from "./polymarket-relayer.js";

const signer = makeEvmSigner(hexToBytes(("0x" + "11".repeat(32)) as Hex));
const DW = "0x648dDfB3b6338Ba33cCD413042764D1B72Fb7951" as Hex;

const BATCH_TYPES = {
  Call: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
  Batch: [{ name: "wallet", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "calls", type: "Call[]" }],
} as const;

test("Batch signature recovers to the owner (valid EIP-712, domain = the DW)", async () => {
  const calls = [buildTransferPusdCall(signer.address as Hex, 100000n)];
  const sig = signDepositWalletBatch(signer, { chainId: 137, walletAddress: DW, nonce: "1", deadline: "1781751300", calls });
  const rec = await recoverTypedDataAddress({
    domain: { name: "DepositWallet", version: "1", chainId: 137, verifyingContract: DW },
    types: BATCH_TYPES,
    primaryType: "Batch",
    message: { wallet: DW, nonce: 1n, deadline: 1781751300n, calls: calls.map((c) => ({ target: c.target, value: 0n, data: c.data })) },
    signature: sig,
  });
  assert.equal(rec.toLowerCase(), signer.address.toLowerCase());
});

test("builder HMAC matches the SDK scheme (ts+method+path+body, url-safe b64)", () => {
  const h = buildBuilderHeaders({ key: "k", secret: Buffer.from("secret123").toString("base64"), passphrase: "p" }, "POST", "/submit", '{"x":1}', 1700000000);
  assert.equal(h.POLY_BUILDER_SIGNATURE, "aVzvXJqN2CkUhca-6SFjx8CSDCUUGnrzYY8MyPAuxpU=");
  assert.equal(h.POLY_BUILDER_API_KEY, "k");
  assert.equal(h.POLY_BUILDER_PASSPHRASE, "p");
  assert.equal(h.POLY_BUILDER_TIMESTAMP, "1700000000");
});

test("approval batch = 3 pUSD approves + 3 CTF setApprovalForAll", () => {
  const calls = buildApprovalCalls();
  assert.equal(calls.length, 6);
  assert.equal(calls.slice(0, 3).every((c) => c.target.toLowerCase() === PUSD.toLowerCase()), true);
  assert.equal(calls.slice(0, 3).every((c) => c.data.startsWith("0x095ea7b3")), true); // approve
  assert.equal(calls.slice(3).every((c) => c.data.startsWith("0xa22cb465")), true); // setApprovalForAll
});

test("transfer-pUSD call encodes erc20.transfer(to, amount)", () => {
  const c = buildTransferPusdCall("0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A", 100000n);
  assert.equal(c.target.toLowerCase(), PUSD.toLowerCase());
  assert.equal(c.value, "0");
  assert.equal(c.data, "0xa9059cbb00000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a00000000000000000000000000000000000000000000000000000000000186a0");
});
