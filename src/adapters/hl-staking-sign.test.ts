// src/adapters/hl-staking-sign.test.ts
// The NEW user-signed HL actions (tokenDelegate / cDeposit / cWithdraw). These can't
// be vector-locked to the python SDK: the SDK pins signatureChainId="0x66eee" while
// we use the PROVEN-LIVE "0xa4b1" on mainnet (HL only requires domain.chainId ==
// int(signatureChainId,16); our spotSend/withdraw use 0xa4b1 live). So we assert:
//   1. the exact action JSON shape HL receives (type, hyperliquidChain, fields),
//   2. determinism (same inputs => same r,s,v), and
//   3. signature VALIDITY — recover the typed-data signer == our key.
// HL field-ORDER correctness (the type lists) is confirmed by the live test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, type Hex } from "viem";
import { makeEvmSigner } from "../signers/evm.js";
import { signTokenDelegate, signCDeposit, signCWithdraw } from "./hl-signing.js";

function testKeyBytes(): Uint8Array {
  const hex = "0123456789012345678901234567890123456789012345678901234567890123";
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const signer = makeEvmSigner(testKeyBytes());
const VALIDATOR = "0x" + "c".repeat(40);
const ser = (s: { r: string; s: string; v: number }): Hex => (s.r + s.s.slice(2) + s.v.toString(16).padStart(2, "0")) as Hex;
const DOMAIN = { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" } as const;

test("signTokenDelegate: action shape + signatureChainId + recoverable", async () => {
  const out = signTokenDelegate({ signer, validator: VALIDATOR, wei: 10_000_000, isUndelegate: false, nonce: 1700000000000, isMainnet: true });
  assert.deepEqual(out.action, {
    type: "tokenDelegate",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0xa4b1",
    validator: VALIDATOR,
    wei: 10_000_000,
    isUndelegate: false,
    nonce: 1700000000000,
  });
  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN,
    types: {
      "HyperliquidTransaction:TokenDelegate": [
        { name: "hyperliquidChain", type: "string" },
        { name: "validator", type: "address" },
        { name: "wei", type: "uint64" },
        { name: "isUndelegate", type: "bool" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:TokenDelegate",
    message: { hyperliquidChain: "Mainnet", validator: VALIDATOR as Hex, wei: 10_000_000n, isUndelegate: false, nonce: 1700000000000n },
    signature: ser(out.signature),
  });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
});

test("signCDeposit / signCWithdraw: shape + type + testnet chain id", () => {
  const dep = signCDeposit({ signer, wei: 5_000_000, nonce: 1700000000001, isMainnet: true });
  assert.deepEqual(dep.action, { type: "cDeposit", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", wei: 5_000_000, nonce: 1700000000001 });
  const wd = signCWithdraw({ signer, wei: 5_000_000, nonce: 1700000000002, isMainnet: false });
  assert.deepEqual(wd.action, { type: "cWithdraw", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", wei: 5_000_000, nonce: 1700000000002 });
});

test("cDeposit signature is recoverable to our key", async () => {
  const dep = signCDeposit({ signer, wei: 5_000_000, nonce: 1700000000003, isMainnet: true });
  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN,
    types: {
      "HyperliquidTransaction:CDeposit": [
        { name: "hyperliquidChain", type: "string" },
        { name: "wei", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:CDeposit",
    message: { hyperliquidChain: "Mainnet", wei: 5_000_000n, nonce: 1700000000003n },
    signature: ser(dep.signature),
  });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
});

test("signing is deterministic (same inputs => same r,s,v)", () => {
  const a = signTokenDelegate({ signer, validator: VALIDATOR, wei: 1, isUndelegate: true, nonce: 42, isMainnet: true });
  const b = signTokenDelegate({ signer, validator: VALIDATOR, wei: 1, isUndelegate: true, nonce: 42, isMainnet: true });
  assert.deepEqual(a.signature, b.signature);
});
