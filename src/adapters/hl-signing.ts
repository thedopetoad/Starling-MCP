// src/adapters/hl-signing.ts
// Hyperliquid L1-action signing, hand-rolled to stay inside the tiny audited dep
// tree (viem for keccak/EIP-712 + our @noble EvmSigner) and locked to the OFFICIAL
// hyperliquid-python-sdk signature vector in hl-signing.test.ts.
//
// The scheme (NOT a generic EVM tx — HyperCore is its own L1):
//   1. connectionId = keccak256( msgpack(action) ++ nonce[8B big-endian]
//                                ++ (vault ? 0x01||addr20 : 0x00)
//                                ++ (expiresAfter ? 0x00||u64BE : ø) )
//   2. phantomAgent = { source: isMainnet ? "a" : "b", connectionId }
//   3. sign the EIP-712 digest of phantomAgent under the FIXED "Exchange" domain
//      (chainId 1337, verifyingContract 0x0…0, version "1") with the local key.
//
// The chainId here is 1337 — the phantom L1-action domain — NOT HyperEVM's 999.
// `source` "a"/"b" (mainnet/testnet) is part of the signed message, so a testnet
// signature can never be replayed on mainnet.
import { hashTypedData, keccak256 } from "viem";
import type { EvmSigner } from "../signers/evm.js";
import { packb } from "./hl-msgpack.js";

export interface RsvSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
}

/** The phantom L1-action signing domain. FIXED — do not derive from the network. */
const EXCHANGE_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

/**
 * The L1 action hash (HL "connectionId"): keccak256 over the msgpack of the
 * action plus the nonce, vault flag, and optional expiresAfter tail. Exported so
 * a test/caller can re-derive it.
 */
export function actionHash(
  action: unknown,
  nonce: number,
  vaultAddress: string | null,
  expiresAfter: number | null = null,
): `0x${string}` {
  const packed = packb(action);
  const tail: number[] = [];
  pushUint64BE(tail, nonce);
  if (vaultAddress === null) {
    tail.push(0x00);
  } else {
    tail.push(0x01);
    pushAddress(tail, vaultAddress);
  }
  if (expiresAfter !== null) {
    tail.push(0x00);
    pushUint64BE(tail, expiresAfter);
  }
  const data = new Uint8Array(packed.length + tail.length);
  data.set(packed, 0);
  data.set(Uint8Array.from(tail), packed.length);
  return keccak256(data);
}

/** Sign an L1 action with the local key; returns the {r,s,v} /exchange expects. */
export function signL1Action(args: {
  signer: EvmSigner;
  action: unknown;
  nonce: number;
  isMainnet: boolean;
  vaultAddress?: string | null;
  expiresAfter?: number | null;
}): RsvSignature {
  const vaultAddress = args.vaultAddress ?? null;
  const expiresAfter = args.expiresAfter ?? null;
  const connectionId = actionHash(args.action, args.nonce, vaultAddress, expiresAfter);
  const digest = hashTypedData({
    domain: EXCHANGE_DOMAIN,
    types: AGENT_TYPES,
    primaryType: "Agent",
    message: { source: args.isMainnet ? "a" : "b", connectionId },
  });
  const rsv = args.signer.signDigest(hexToBytes(digest));
  return {
    r: `0x${toHex(rsv.subarray(0, 32))}`,
    s: `0x${toHex(rsv.subarray(32, 64))}`,
    v: rsv[64],
  };
}

// ── USER-SIGNED actions (withdraw, usdSend, …) ──────────────────────────────
// A DIFFERENT scheme from L1 actions: instead of the phantom-agent "Exchange"
// domain (chainId 1337) over a msgpack hash, user-signed actions sign the action
// fields DIRECTLY as EIP-712 typed data under the "HyperliquidSignTransaction"
// domain on the REAL signatureChainId (Arbitrum 42161 mainnet / 421614 testnet).
// The signed struct excludes `type`/`signatureChainId` (those ride in the action
// JSON but not the typed-data). nonce == the action's `time` (ms). Confirmed
// against the @nktkas/hyperliquid SDK + HL docs.
const WITHDRAW_TYPES = {
  "HyperliquidTransaction:Withdraw": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
} as const;

export interface HlWithdrawAction {
  type: "withdraw3";
  hyperliquidChain: "Mainnet" | "Testnet";
  signatureChainId: `0x${string}`;
  destination: string;
  amount: string;
  time: number;
}

/** Build + sign a USDC withdrawal from HyperCore to the same address on Arbitrum.
 *  Returns the action (POST verbatim) + its signature + nonce (== time). The
 *  destination is lower-cased (HL hashes the lower-case string). A $1 fee is
 *  deducted by HL; amount is the gross withdrawal in USDC (decimal string). */
export function signWithdraw(args: {
  signer: EvmSigner;
  destination: string;
  amount: string;
  time: number;
  isMainnet: boolean;
}): { action: HlWithdrawAction; signature: RsvSignature; nonce: number } {
  const destination = args.destination.toLowerCase();
  const signatureChainId: `0x${string}` = args.isMainnet ? "0xa4b1" : "0x66eee"; // 42161 / 421614
  const chainId = args.isMainnet ? 42161 : 421614;
  const hyperliquidChain = args.isMainnet ? "Mainnet" : "Testnet";
  const digest = hashTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: WITHDRAW_TYPES,
    primaryType: "HyperliquidTransaction:Withdraw",
    message: { hyperliquidChain, destination, amount: args.amount, time: BigInt(args.time) },
  });
  const rsv = args.signer.signDigest(hexToBytes(digest));
  return {
    action: { type: "withdraw3", hyperliquidChain, signatureChainId, destination, amount: args.amount, time: args.time },
    signature: { r: `0x${toHex(rsv.subarray(0, 32))}`, s: `0x${toHex(rsv.subarray(32, 64))}`, v: rsv[64] },
    nonce: args.time,
  };
}

// ── usdClassTransfer (perp <-> spot) ────────────────────────────────────────
// Move USDC between the perp and spot sub-accounts on HyperCore. Same user-signed
// scheme as withdraw3. toPerp=false => perp -> spot (needed before a spotSend to
// HyperEVM); toPerp=true => spot -> perp. Free + instant. Types verbatim from the
// hyperliquid-python-sdk (HyperliquidTransaction:UsdClassTransfer).
const USD_CLASS_TRANSFER_TYPES = {
  "HyperliquidTransaction:UsdClassTransfer": [
    { name: "hyperliquidChain", type: "string" },
    { name: "amount", type: "string" },
    { name: "toPerp", type: "bool" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export interface HlUsdClassTransferAction {
  type: "usdClassTransfer";
  hyperliquidChain: "Mainnet" | "Testnet";
  signatureChainId: `0x${string}`;
  amount: string;
  toPerp: boolean;
  nonce: number;
}

export function signUsdClassTransfer(args: {
  signer: EvmSigner;
  amount: string;
  toPerp: boolean;
  nonce: number;
  isMainnet: boolean;
}): { action: HlUsdClassTransferAction; signature: RsvSignature; nonce: number } {
  const signatureChainId: `0x${string}` = args.isMainnet ? "0xa4b1" : "0x66eee";
  const chainId = args.isMainnet ? 42161 : 421614;
  const hyperliquidChain = args.isMainnet ? "Mainnet" : "Testnet";
  const digest = hashTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: USD_CLASS_TRANSFER_TYPES,
    primaryType: "HyperliquidTransaction:UsdClassTransfer",
    message: { hyperliquidChain, amount: args.amount, toPerp: args.toPerp, nonce: BigInt(args.nonce) },
  });
  const rsv = args.signer.signDigest(hexToBytes(digest));
  return {
    action: { type: "usdClassTransfer", hyperliquidChain, signatureChainId, amount: args.amount, toPerp: args.toPerp, nonce: args.nonce },
    signature: { r: `0x${toHex(rsv.subarray(0, 32))}`, s: `0x${toHex(rsv.subarray(32, 64))}`, v: rsv[64] },
    nonce: args.nonce,
  };
}

// ── spotSend (send a spot token to any address, incl. the HyperEVM bridge) ───
// Send a HyperCore SPOT token to `destination`. To bridge USDC HyperCore->HyperEVM,
// destination = the token's SYSTEM ADDRESS (hyperCoreSystemAddress(tokenIndex)) and
// the credited HyperEVM ERC-20 is the token's linked `evmContract` (spotMeta). The
// `token` field is "NAME:tokenId" (tokenId from spotMeta). Types verbatim from the
// python SDK (HyperliquidTransaction:SpotSend).
const SPOT_SEND_TYPES = {
  "HyperliquidTransaction:SpotSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
} as const;

export interface HlSpotSendAction {
  type: "spotSend";
  hyperliquidChain: "Mainnet" | "Testnet";
  signatureChainId: `0x${string}`;
  destination: string;
  token: string;
  amount: string;
  time: number;
}

export function signSpotSend(args: {
  signer: EvmSigner;
  destination: string;
  /** "NAME:tokenId" from spotMeta, e.g. "USDC:0x6d1e7cde53ba9467b783cb7c530ce054". */
  token: string;
  amount: string;
  time: number;
  isMainnet: boolean;
}): { action: HlSpotSendAction; signature: RsvSignature; nonce: number } {
  const destination = args.destination.toLowerCase();
  const signatureChainId: `0x${string}` = args.isMainnet ? "0xa4b1" : "0x66eee";
  const chainId = args.isMainnet ? 42161 : 421614;
  const hyperliquidChain = args.isMainnet ? "Mainnet" : "Testnet";
  const digest = hashTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: SPOT_SEND_TYPES,
    primaryType: "HyperliquidTransaction:SpotSend",
    message: { hyperliquidChain, destination, token: args.token, amount: args.amount, time: BigInt(args.time) },
  });
  const rsv = args.signer.signDigest(hexToBytes(digest));
  return {
    action: { type: "spotSend", hyperliquidChain, signatureChainId, destination, token: args.token, amount: args.amount, time: args.time },
    signature: { r: `0x${toHex(rsv.subarray(0, 32))}`, s: `0x${toHex(rsv.subarray(32, 64))}`, v: rsv[64] },
    nonce: args.time,
  };
}

/**
 * The HyperCore->HyperEVM SYSTEM ADDRESS for a spot token: first byte 0x20, the
 * remaining 19 bytes are the token index big-endian (zeros for the low ones). USDC
 * is token index 0 => 0x2000000000000000000000000000000000000000. spotSend-ing a
 * token to THIS address credits its linked ERC-20 on HyperEVM.
 * Source: HL docs (HyperCore<>HyperEVM transfers).
 */
export function hyperCoreSystemAddress(tokenIndex: number): `0x${string}` {
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 0xffffffff) {
    throw new Error(`tokenIndex must be a uint32 (got ${tokenIndex})`);
  }
  // 19 bytes = 38 hex chars after the leading 0x20 byte.
  return `0x20${tokenIndex.toString(16).padStart(38, "0")}` as `0x${string}`;
}

// ── byte helpers ─────────────────────────────────────────────────────────────

/** nonce is a ms timestamp — well within the 53-bit safe-integer range. */
function pushUint64BE(out: number[], n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`nonce must be a non-negative integer (got ${n})`);
  const hi = Math.floor(n / 2 ** 32);
  const lo = n >>> 0;
  out.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  out.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
}

function pushAddress(out: number[], addr: string): void {
  const h = addr.startsWith("0x") ? addr.slice(2) : addr;
  if (h.length !== 40 || !/^[0-9a-fA-F]+$/.test(h)) throw new Error(`vault address must be 20 hex bytes`);
  for (let i = 0; i < 40; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
