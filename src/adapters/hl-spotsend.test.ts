// src/adapters/hl-spotsend.test.ts
// Proves signSpotSend + signUsdClassTransfer emit valid EIP-712 user-signed actions
// that recover to the signer over the EXACT structs/domain, and that the
// HyperCore->HyperEVM system address is derived correctly. (HL acceptance is verified
// separately by a live spotSend.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, type Hex } from "viem";
import { makeEvmSigner } from "../signers/evm.js";
import { signSpotSend, signUsdClassTransfer, hyperCoreSystemAddress } from "./hl-signing.js";

const KEY = new Uint8Array(32).fill(7);
const DOMAIN = { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" } as const;
const SPOT_SEND_TYPES = {
  "HyperliquidTransaction:SpotSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
} as const;
const USD_CLASS_TYPES = {
  "HyperliquidTransaction:UsdClassTransfer": [
    { name: "hyperliquidChain", type: "string" },
    { name: "amount", type: "string" },
    { name: "toPerp", type: "bool" },
    { name: "nonce", type: "uint64" },
  ],
} as const;
const sigHex = (s: { r: Hex; s: Hex; v: number }) => `0x${s.r.slice(2)}${s.s.slice(2)}${s.v.toString(16).padStart(2, "0")}` as Hex;

test("hyperCoreSystemAddress: 0x20 + token index big-endian (USDC index 0 = 0x2000...0000)", () => {
  assert.equal(hyperCoreSystemAddress(0), "0x2000000000000000000000000000000000000000");
  assert.equal(hyperCoreSystemAddress(5), "0x2000000000000000000000000000000000000005");
  assert.equal(hyperCoreSystemAddress(1).length, 42); // 20 bytes
  assert.throws(() => hyperCoreSystemAddress(-1));
});

test("signSpotSend: valid EIP-712 action recovering to the signer", async () => {
  const signer = makeEvmSigner(KEY);
  const time = 1781700000000;
  const token = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
  const destination = hyperCoreSystemAddress(0);
  const { action, signature, nonce } = signSpotSend({ signer, destination, token, amount: "2", time, isMainnet: true });

  assert.equal(action.type, "spotSend");
  assert.equal(action.hyperliquidChain, "Mainnet");
  assert.equal(action.signatureChainId, "0xa4b1");
  assert.equal(action.destination, destination); // already lower-case
  assert.equal(action.token, token);
  assert.equal(action.amount, "2");
  assert.equal(nonce, time);

  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN, types: SPOT_SEND_TYPES, primaryType: "HyperliquidTransaction:SpotSend",
    message: { hyperliquidChain: "Mainnet", destination, token, amount: "2", time: BigInt(time) },
    signature: sigHex(signature),
  });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
});

test("signUsdClassTransfer: valid EIP-712 action recovering to the signer", async () => {
  const signer = makeEvmSigner(KEY);
  const nonce = 1781700000001;
  const { action, signature } = signUsdClassTransfer({ signer, amount: "5", toPerp: false, nonce, isMainnet: true });

  assert.equal(action.type, "usdClassTransfer");
  assert.equal(action.toPerp, false);
  assert.equal(action.amount, "5");
  assert.equal(action.signatureChainId, "0xa4b1");

  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN, types: USD_CLASS_TYPES, primaryType: "HyperliquidTransaction:UsdClassTransfer",
    message: { hyperliquidChain: "Mainnet", amount: "5", toPerp: false, nonce: BigInt(nonce) },
    signature: sigHex(signature),
  });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
});
