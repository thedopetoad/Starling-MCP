// src/adapters/hl-exit.test.ts
// The cheap-exit CCTP calldata builders (HyperEVM burn + dest receive). These MOVE
// money, so decode them back and assert domain/recipient/token/lane byte-for-byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, pad } from "viem";
import { buildHyperevmBurnTxs, buildCctpReceiveTx, HYPEREVM_USDC } from "./hl-exit.js";
import { CCTP_CONSTANTS } from "../bridge/cctp.js";

const RECIP = "0x92c0d39f947d371bc9a8323ce3f110ab4663effd";
const lower = (a: unknown) => String(a).toLowerCase();
const APPROVE_ABI = [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const DFB_ABI = [{ name: "depositForBurn", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" }, { name: "minFinalityThreshold", type: "uint32" }], outputs: [] }] as const;
const RECV_ABI = [{ name: "receiveMessage", type: "function", stateMutability: "nonpayable", inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }], outputs: [{ type: "bool" }] }] as const;

test("buildHyperevmBurnTxs: approve + depositForBurn to Arbitrum (domain 3), standard lane", () => {
  const { approve, burn } = buildHyperevmBurnTxs({ amountBase: 2_000_000n, dest: "arbitrum", recipient: RECIP });

  assert.equal(lower(approve.to), lower(HYPEREVM_USDC));
  const ap = decodeFunctionData({ abi: APPROVE_ABI, data: approve.data });
  assert.equal(lower(ap.args[0]), lower(CCTP_CONSTANTS.TOKEN_MESSENGER_V2));
  assert.equal(ap.args[1], 2_000_000n);

  assert.equal(lower(burn.to), lower(CCTP_CONSTANTS.TOKEN_MESSENGER_V2));
  const d = decodeFunctionData({ abi: DFB_ABI, data: burn.data });
  assert.equal(d.args[0], 2_000_000n);
  assert.equal(d.args[1], CCTP_CONSTANTS.DOMAIN.arbitrum); // 3
  assert.equal(lower(d.args[2]), lower(pad(RECIP as `0x${string}`, { size: 32 })));
  assert.equal(lower(d.args[3]), lower(HYPEREVM_USDC)); // burnToken = HyperEVM native USDC
  assert.equal(d.args[5], 0n); // standard lane: maxFee 0 (free)
  assert.equal(d.args[6], 2000); // standard finality
});

test("buildHyperevmBurnTxs: polygon dest uses domain 7", () => {
  const { burn } = buildHyperevmBurnTxs({ amountBase: 1_000_000n, dest: "polygon", recipient: RECIP });
  const d = decodeFunctionData({ abi: DFB_ABI, data: burn.data });
  assert.equal(d.args[1], CCTP_CONSTANTS.DOMAIN.polygon); // 7
});

test("buildHyperevmBurnTxs rejects a bad recipient / zero amount", () => {
  assert.throws(() => buildHyperevmBurnTxs({ amountBase: 1n, dest: "arbitrum", recipient: "not-an-addr" }));
  assert.throws(() => buildHyperevmBurnTxs({ amountBase: 0n, dest: "arbitrum", recipient: RECIP }));
});

test("buildCctpReceiveTx: receiveMessage to the destination MessageTransmitterV2", () => {
  const r = buildCctpReceiveTx("0xdeadbeef", "0xcafe");
  assert.equal(lower(r.to), lower(CCTP_CONSTANTS.MESSAGE_TRANSMITTER_V2));
  const d = decodeFunctionData({ abi: RECV_ABI, data: r.data });
  assert.equal(d.args[0], "0xdeadbeef");
  assert.equal(d.args[1], "0xcafe");
});
