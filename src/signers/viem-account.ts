// src/signers/viem-account.ts
// Adopt-pattern from the ecosystem scan (#1): wrap our @noble-backed EvmSigner as
// a viem LocalAccount. Both the official Polymarket clob-client-v2 and the de-facto
// @nktkas/hyperliquid SDK consume a viem-account-shaped signer, so this lets our
// EIP-712 signing interop with their reference flows WITHOUT exporting the key —
// the private key stays sealed inside the EvmSigner closure; only 32-byte digests
// cross the boundary. This makes "keys never leave the box" a code contract.
import { toAccount } from "viem/accounts";
import { hashMessage, hashTypedData, hexToBytes, type Account, type Hex } from "viem";
import type { EvmSigner } from "./evm.js";

function sigToHex(rsv: Uint8Array): Hex {
  return `0x${Buffer.from(rsv).toString("hex")}` as Hex;
}

/**
 * Build a viem LocalAccount from an EvmSigner. Only message/typed-data signing is
 * supported (CLOB orders + HL actions are EIP-712 typed data); signTransaction
 * throws because this stack never broadcasts raw EVM transactions through viem —
 * the local signer signs digests, the caller broadcasts.
 */
export function toViemAccount(signer: EvmSigner): Account {
  return toAccount({
    address: signer.address,
    async signMessage({ message }) {
      return sigToHex(signer.signDigest(hexToBytes(hashMessage(message))));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signTypedData(typedData: any) {
      return sigToHex(signer.signDigest(hexToBytes(hashTypedData(typedData))));
    },
    async signTransaction() {
      throw new Error(
        "signTransaction is not supported by the Starling local signer — orders are EIP-712 typed data; broadcasting is the caller's job",
      );
    },
  });
}
