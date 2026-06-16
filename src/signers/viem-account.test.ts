// src/signers/viem-account.test.ts — proves the @noble-backed signer, wrapped as
// a viem account, produces EIP-712 / personal-message signatures that recover to
// the signer's own address (so it interops with the venue SDKs, key never exported).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { makeEvmSigner } from "./evm.js";
import { toViemAccount } from "./viem-account.js";

const secret = randomBytes(32);
const signer = makeEvmSigner(secret);
const account = toViemAccount(signer);

const TYPED = {
  domain: { name: "Starling Test", version: "1", chainId: 137 },
  types: { Order: [{ name: "maker", type: "address" }, { name: "amount", type: "uint256" }] },
  primaryType: "Order" as const,
  message: { maker: signer.address, amount: 1000000n },
};

test("signTypedData recovers to the signer's own address", async () => {
  const signature = await account.signTypedData!(TYPED as never);
  const recovered = await recoverTypedDataAddress({ ...TYPED, signature });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
});

test("signMessage recovers to the signer's own address", async () => {
  const message = "starling auth challenge";
  const signature = await account.signMessage!({ message });
  const recovered = await recoverMessageAddress({ message, signature });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase());
});

test("signTransaction is refused (orders are typed-data only)", async () => {
  await assert.rejects(() => account.signTransaction!({} as never), /not supported/);
});
