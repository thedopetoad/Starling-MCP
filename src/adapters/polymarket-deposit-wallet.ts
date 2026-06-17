// src/adapters/polymarket-deposit-wallet.ts
// Polymarket V2 DEPOSIT-WALLET address derivation. A deposit wallet is a per-user
// ERC-1967 (UUPS) proxy the DepositWalletFactory deploys at a deterministic CREATE2
// address from the EOA owner. Funds (pUSD + conditional tokens) live ON it; orders
// sign under its ERC-1271 validator (signatureType 3 / POLY_1271). This is the V2
// path for NEW API keys — a bare EOA (signatureType 0) is what the CLOB rejects.
//
// PORTED VERBATIM from the official @polymarket/builder-relayer-client SDK
// (dist/builder/derive.js) using the SAME viem primitives — NOT hand-rolled crypto.
// polymarket-deposit-wallet.test.ts LOCKS the output to the SDK's exact vectors, so
// it is a byte-for-byte replica or the test fails. (The MCP keeps a tiny prod dep
// tree; the SDK is used at DEV time only, to generate the locked vectors.)
//
// UUPS vs BeaconProxy — the #1 money-loss footgun the research flagged:
//   The SDK 0.0.10 RelayClient probes factory.beacon() at runtime: revert/zero =>
//   UUPS (initCodeHashERC1967(implementation)); a real beacon => BeaconProxy. On the
//   LIVE factory (0x0000…Cc07) beacon() REVERTS (verified on-chain 2026-06-17) and
//   the SDK config carries no beacon, so new wallets are UUPS — the path below.
//   assertUUPSFactory() re-runs that probe defensively so a future Polymarket
//   migration to BeaconProxy can never silently derive (and fund) a WRONG address.

import {
  concat,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  pad,
  toHex,
  type Hex,
} from "viem";

/** DepositWalletFactory on Polygon. Source: SDK getContractConfig(137) +
 *  docs.polymarket.com/trading/deposit-wallets. */
export const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07" as const;

/** UUPS implementation behind every deposit-wallet proxy. Source: SDK config
 *  (getContractConfig(137).DepositWalletContracts.DepositWalletImplementation). */
export const DEPOSIT_WALLET_IMPLEMENTATION = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB" as const;

// Solady v0.1.26 LibClone.initCodeHashERC1967 byte constants — verbatim from the SDK
// (these encode the minimal ERC-1967 proxy runtime bytecode).
const ERC1967_CONST1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3" as Hex;
const ERC1967_CONST2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076" as Hex;
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

/**
 * Solady LibClone.initCodeHashERC1967(implementation, args) — verbatim port.
 * keccak256 of: prefix(10) | implementation(20) | 0x6009(2) | const2(32) |
 * const1(32) | args(n). The proxy's runtime length is injected into the prefix.
 */
export function initCodeHashERC1967(implementation: Hex, args: Hex): Hex {
  const n = BigInt((args.length - 2) / 2);
  const combined = ERC1967_PREFIX + (n << 56n);
  return keccak256(
    concat([toHex(combined, { size: 10 }), implementation, "0x6009", ERC1967_CONST2, ERC1967_CONST1, args]),
  );
}

/**
 * Derive the UUPS deposit-wallet address for an EOA owner. Deterministic in
 * (owner, factory, implementation): the same EOA always derives the same wallet,
 * and it can be derived BEFORE deploy. walletId = bytes32(owner), left-padded.
 */
export function deriveDepositWalletUUPS(
  owner: Hex,
  factory: Hex = DEPOSIT_WALLET_FACTORY,
  implementation: Hex = DEPOSIT_WALLET_IMPLEMENTATION,
): Hex {
  const walletId = pad(owner, { dir: "left", size: 32 });
  const args = encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [factory, walletId]);
  const salt = keccak256(args);
  const bytecodeHash = initCodeHashERC1967(implementation, args);
  return getCreate2Address({ from: factory, salt, bytecodeHash });
}

/** factory.beacon() selector — the SDK 0.0.10 probe for UUPS-vs-BeaconProxy. */
export const BEACON_SELECTOR = "0x49493a4d" as const;

/** Is an eth_call beacon() result a REAL (non-zero) beacon address? Pure; "0x" /
 *  zero-word => not a beacon (=> UUPS). Exported for unit testing the guard. */
export function isBeaconResult(beaconCallResult: string): boolean {
  if (!beaconCallResult || beaconCallResult === "0x") return false;
  const addr = beaconCallResult.slice(-40);
  return !/^0+$/.test(addr);
}

/**
 * Defensive guard against the UUPS-vs-Beacon footgun. Probe factory.beacon() via
 * the caller's eth_call: revert / zero => UUPS (safe to derive). A NON-ZERO beacon
 * => the factory migrated to BeaconProxy and the UUPS derivation would compute the
 * WRONG address — THROW rather than risk funding a wrong wallet (re-port
 * initCodeHashERC1967BeaconProxy from the SDK first). Call once before first use.
 */
export async function assertUUPSFactory(
  ethCall: (to: string, data: string) => Promise<string>,
  factory: string = DEPOSIT_WALLET_FACTORY,
): Promise<void> {
  let res: string;
  try {
    res = await ethCall(factory, BEACON_SELECTOR);
  } catch {
    return; // reverted => no beacon() => UUPS, the confirmed path
  }
  if (isBeaconResult(res)) {
    const addr = `0x${res.slice(-40)}`;
    throw new Error(
      `DepositWalletFactory.beacon() returned ${addr} — the factory uses BeaconProxy now, not ` +
        "UUPS. The UUPS derivation would compute the WRONG deposit-wallet address. Re-port " +
        "initCodeHashERC1967BeaconProxy from the SDK and add a Beacon path before deriving.",
    );
  }
}
