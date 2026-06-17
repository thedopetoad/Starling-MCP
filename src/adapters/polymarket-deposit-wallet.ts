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
  hashTypedData,
  hexToBytes,
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

// ── POLY_1271 (ERC-7739) order signing ──────────────────────────────────────
// V2 deposit-wallet orders sign with signatureType=3 via an ERC-7739 "defensive
// nested" signature: the EOA signs a TypedDataSign that wraps the Order as
// `contents` under the deposit-wallet's own domain, and the on-wire signature packs
// innerSig ++ appDomainSep ++ contentsHash ++ ORDER_TYPE_STRING ++ uint16(len).
// Ported VERBATIM from clob-client-v2 ExchangeOrderBuilderV2.buildOrderSignature and
// LOCKED to an SDK-generated vector in the test. maker == signer == deposit wallet.

/** The V2 Order EIP-712 type string (hashed for ORDER_TYPE_HASH). */
export const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const ORDER_TYPE_HASH = keccak256(toHex(ORDER_TYPE_STRING));
const DOMAIN_TYPE_HASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const BYTES32_ZERO = `0x${"00".repeat(32)}` as Hex;

/** Order struct field list — order matters; matches ORDER_TYPE_STRING. */
const ORDER_STRUCT = [
  { name: "salt", type: "uint256" }, { name: "maker", type: "address" }, { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" }, { name: "makerAmount", type: "uint256" }, { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" }, { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" }, { name: "builder", type: "bytes32" },
] as const;

/** The ERC-7739 TypedDataSign wrapper struct. */
const TYPED_DATA_SIGN_STRUCT = [
  { name: "contents", type: "Order" }, { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" },
] as const;

/** The unsigned V2 Order as the deposit wallet (POLY_1271) signs it. side: 0=BUY/1=SELL. */
export interface Poly1271Order {
  salt: string;
  maker: Hex; // the deposit wallet
  signer: Hex; // == maker for POLY_1271
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: 0 | 1;
  signatureType: 3;
  timestamp: string;
  metadata: Hex;
  builder: Hex;
}

/** The exchange's EIP-712 domain (CTF Exchange V2 or Neg Risk). */
export interface ExchangeDomain {
  exchange: Hex;
  chainId: number;
  name: string; // "Polymarket CTF Exchange" / "Polymarket Neg Risk CTF Exchange"
  version: string; // "2"
}

/** keccak256(abi.encode(ORDER_TYPE_HASH, ...11 order fields)) — the Order hashStruct. */
export function poly1271ContentsHash(o: Poly1271Order): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "uint8" }, { type: "uint256" },
        { type: "bytes32" }, { type: "bytes32" },
      ],
      [
        ORDER_TYPE_HASH, BigInt(o.salt), o.maker, o.signer, BigInt(o.tokenId), BigInt(o.makerAmount),
        BigInt(o.takerAmount), o.side, o.signatureType, BigInt(o.timestamp), o.metadata, o.builder,
      ],
    ),
  );
}

/** The exchange's EIP-712 domain separator (appended to the packed signature). */
export function poly1271AppDomainSep(d: ExchangeDomain): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPE_HASH, keccak256(toHex(d.name)), keccak256(toHex(d.version)), BigInt(d.chainId), d.exchange],
    ),
  );
}

/** The EIP-712 digest the EOA signs: the nested TypedDataSign over the order. */
export function poly1271Digest(o: Poly1271Order, d: ExchangeDomain): Hex {
  return hashTypedData({
    domain: { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.exchange },
    types: { TypedDataSign: TYPED_DATA_SIGN_STRUCT, Order: ORDER_STRUCT },
    primaryType: "TypedDataSign",
    message: {
      contents: {
        salt: BigInt(o.salt), maker: o.maker, signer: o.signer, tokenId: BigInt(o.tokenId),
        makerAmount: BigInt(o.makerAmount), takerAmount: BigInt(o.takerAmount), side: o.side,
        signatureType: o.signatureType, timestamp: BigInt(o.timestamp), metadata: o.metadata, builder: o.builder,
      },
      name: "DepositWallet",
      version: "1",
      chainId: BigInt(d.chainId),
      verifyingContract: o.signer, // the deposit wallet
      salt: BYTES32_ZERO,
    },
  });
}

/**
 * Build the ERC-7739-packed POLY_1271 signature for a deposit-wallet order. The EOA
 * signs poly1271Digest() LOCALLY; the result packs innerSig(65) ++ appDomainSep(32)
 * ++ contentsHash(32) ++ ORDER_TYPE_STRING ++ uint16(len). Byte-locked to the SDK.
 */
export function signPoly1271Order(args: {
  signer: { signDigest(digest: Uint8Array): Uint8Array };
  order: Poly1271Order;
  domain: ExchangeDomain;
}): Hex {
  const { signer, order, domain } = args;
  const innerSig = toHex(signer.signDigest(hexToBytes(poly1271Digest(order, domain)))); // 65-byte r||s||v
  const sep = poly1271AppDomainSep(domain);
  const contentsHash = poly1271ContentsHash(order);
  const lenHex = ORDER_TYPE_STRING.length.toString(16).padStart(4, "0");
  return `0x${innerSig.slice(2)}${sep.slice(2)}${contentsHash.slice(2)}${toHex(ORDER_TYPE_STRING).slice(2)}${lenHex}` as Hex;
}
