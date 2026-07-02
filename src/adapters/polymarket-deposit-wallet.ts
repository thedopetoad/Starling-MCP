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
//   UUPS (initCodeHashERC1967(implementation)); a real beacon => BeaconProxy.
//   HISTORY: on 2026-06-17 the live factory's beacon() REVERTED, so wallets deployed
//   then (e.g. the jiang desk DW) are UUPS. By 2026-07-01 Polymarket MIGRATED the
//   factory to BeaconProxy (beacon() = 0x7A18…fc3a) — new wallets deploy at the
//   BEACON derivation, and the old assertUUPSFactory() guard fired for real ($3 of
//   pUSD stranded at a UUPS-derived address that can no longer exist). Both
//   derivations below are pure; resolveDepositWallet() picks the RIGHT one per owner
//   by checking which address actually has code on-chain (legacy UUPS wallets keep
//   working; fresh owners get the current factory mode via a live beacon() probe).

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
import { EvmRpc } from "./evm-rpc.js";

/** DepositWalletFactory on Polygon. Source: SDK getContractConfig(137) +
 *  docs.polymarket.com/trading/deposit-wallets. */
export const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07" as const;

/** UUPS implementation behind every deposit-wallet proxy. Source: SDK config
 *  (getContractConfig(137).DepositWalletContracts.DepositWalletImplementation). */
export const DEPOSIT_WALLET_IMPLEMENTATION = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB" as const;

/** The upgrade beacon the migrated factory points every NEW proxy at. Read live from
 *  factory.beacon() on Polygon 2026-07-01; resolveDepositWallet() re-probes at
 *  runtime, so this constant is a test vector / documentation, not a hard pin. */
export const DEPOSIT_WALLET_BEACON = "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a" as const;

// Solady v0.1.26 LibClone.initCodeHashERC1967 byte constants — verbatim from the SDK
// (these encode the minimal ERC-1967 proxy runtime bytecode).
const ERC1967_CONST1 = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3" as Hex;
const ERC1967_CONST2 = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076" as Hex;
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

// Solady LibClone.initCodeHashERC1967BeaconProxy byte constants — verbatim from the
// SDK 0.0.10 (dist/builder/derive.js). These encode the beacon-proxy runtime that
// loads the implementation from beacon.implementation() on every call.
const ERC1967_BEACON_CONST1 = "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3" as Hex;
const ERC1967_BEACON_CONST2 = "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c" as Hex;
const ERC1967_BEACON_CONST3 = "0x60195155f3363d3d373d3d363d602036600436635c60da" as Hex;
const ERC1967_BEACON_PREFIX = 0x6100523d8160233d3973n;

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
 * LEGACY: only wallets deployed before the factory's beacon migration (2026-06/07)
 * live here. Use resolveDepositWallet() unless you know the wallet's era.
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

/**
 * Solady LibClone.initCodeHashERC1967BeaconProxy(beacon, args) — verbatim port of
 * the SDK 0.0.10 initCodeHashERC1967Beacon. keccak256 of: prefix(10) | beacon(20) |
 * const3(23) | const2(32) | const1(32) | args(n), runtime length in the prefix.
 */
export function initCodeHashERC1967Beacon(beacon: Hex, args: Hex): Hex {
  const n = BigInt((args.length - 2) / 2);
  const combined = ERC1967_BEACON_PREFIX + (n << 56n);
  return keccak256(
    concat([toHex(combined, { size: 10 }), beacon, ERC1967_BEACON_CONST3, ERC1967_BEACON_CONST2, ERC1967_BEACON_CONST1, args]),
  );
}

/**
 * Derive the BeaconProxy deposit-wallet address for an EOA owner — the derivation
 * the MIGRATED factory uses for every new wallet. Deterministic in (owner, factory,
 * beacon). Ported verbatim from SDK 0.0.10 deriveBeaconDepositWallet; live-verified
 * against the deployed loading DW 0xdE3539…46A4 (owner 0x5931…7842) 2026-07-01.
 */
export function deriveDepositWalletBeacon(
  owner: Hex,
  factory: Hex = DEPOSIT_WALLET_FACTORY,
  beacon: Hex = DEPOSIT_WALLET_BEACON,
): Hex {
  const walletId = pad(owner, { dir: "left", size: 32 });
  const args = encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [factory, walletId]);
  const salt = keccak256(args);
  const bytecodeHash = initCodeHashERC1967Beacon(beacon, args);
  return getCreate2Address({ from: factory, salt, bytecodeHash });
}

// ── Runtime resolution (the anti-footgun) ───────────────────────────────────
// A wallet deployed pre-migration lives at the UUPS address FOREVER; a wallet
// deployed post-migration lives at the beacon address. Deriving with the wrong era
// funds an address that can never have code (that's how the $3 stranded). The only
// safe resolution is on-chain: prefer whichever candidate actually has code, and
// for never-deployed owners derive per the factory's CURRENT mode (live beacon()
// probe, so a future re-migration changes behavior without a code change).

/** The minimal chain-read surface the resolver needs (EvmRpc satisfies it). */
export interface DwResolveRpc {
  getCode(address: string): Promise<string>;
  callReadonly(tx: { from: string; to: string; data?: string }): Promise<string>;
}

const hasCode = (code: string | null | undefined): boolean => !!code && code !== "0x" && code.length > 2;

/** Deployed wallets only — a fresh owner's address depends on the factory's mode at
 *  deploy time, so undeployed resolutions are never cached. */
const dwCache = new Map<string, Hex>();

/** TEST-ONLY: reset the resolver cache between cases. */
export function _clearDwCache(): void {
  dwCache.clear();
}

/**
 * Resolve the deposit wallet for `owner`: the UUPS candidate if it has code (legacy,
 * pre-migration), else the beacon candidate if it has code (post-migration), else —
 * never deployed — derive per the factory's live mode: beacon() non-zero => beacon
 * derivation WITH THAT beacon, revert/zero => UUPS. Deployed results are cached.
 */
export async function resolveDepositWallet(owner: Hex, rpc?: DwResolveRpc): Promise<Hex> {
  const key = owner.toLowerCase();
  const cached = dwCache.get(key);
  if (cached) return cached;
  const io: DwResolveRpc = rpc ?? new EvmRpc({ net: "polygon" });

  const uups = deriveDepositWalletUUPS(owner);
  if (hasCode(await io.getCode(uups))) {
    dwCache.set(key, uups);
    return uups;
  }
  const beaconDw = deriveDepositWalletBeacon(owner);
  if (hasCode(await io.getCode(beaconDw))) {
    dwCache.set(key, beaconDw);
    return beaconDw;
  }

  // Never deployed: the factory's CURRENT mode decides where a deploy would land.
  let beaconRes = "";
  try {
    beaconRes = await io.callReadonly({ from: owner, to: DEPOSIT_WALLET_FACTORY, data: BEACON_SELECTOR });
  } catch {
    return uups; // beacon() reverted => factory is in UUPS mode
  }
  if (!isBeaconResult(beaconRes)) return uups;
  const liveBeacon = `0x${beaconRes.slice(-40)}` as Hex;
  return deriveDepositWalletBeacon(owner, DEPOSIT_WALLET_FACTORY, liveBeacon);
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
 * @deprecated The migration this guarded against HAPPENED (2026-06/07): the live
 * factory now returns a real beacon, so this throws on mainnet. Use
 * resolveDepositWallet(), which handles both eras. Kept for tests/history.
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
