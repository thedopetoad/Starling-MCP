// src/adapters/hl-withdraw.test.ts
// Proves signWithdraw emits a valid EIP-712 user-signed action that recovers to
// the signer over the EXACT HyperliquidTransaction:Withdraw struct + domain.
// (HL acceptance is verified separately by a live withdraw.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, type Hex } from "viem";
import { makeEvmSigner } from "../signers/evm.js";
import { signWithdraw } from "./hl-signing.js";

const KEY = new Uint8Array(32).fill(7);
const WITHDRAW_TYPES = {
  "HyperliquidTransaction:Withdraw": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
} as const;

test("signWithdraw: valid EIP-712 user-signed action recovering to the signer", async () => {
  const signer = makeEvmSigner(KEY);
  const time = 1781700000000;
  const { action, signature, nonce } = signWithdraw({
    signer, destination: signer.address, amount: "4", time, isMainnet: true,
  });

  // action shape (POSTed verbatim to /exchange)
  assert.equal(action.type, "withdraw3");
  assert.equal(action.hyperliquidChain, "Mainnet");
  assert.equal(action.signatureChainId, "0xa4b1");
  assert.equal(action.destination, signer.address.toLowerCase());
  assert.equal(action.amount, "4");
  assert.equal(nonce, time);

  // the signature must recover to us over the exact withdraw typed-data
  const sig = `0x${signature.r.slice(2)}${signature.s.slice(2)}${signature.v.toString(16).padStart(2, "0")}` as Hex;
  const recovered = await recoverTypedDataAddress({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: WITHDRAW_TYPES,
    primaryType: "HyperliquidTransaction:Withdraw",
    message: { hyperliquidChain: "Mainnet", destination: signer.address.toLowerCase(), amount: "4", time: BigInt(time) },
    signature: sig,
  });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
});
