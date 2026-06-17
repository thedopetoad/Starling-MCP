// src/bridge/cctp.ts
// CCTP V2 (Circle Cross-Chain Transfer Protocol) bridge — the PRIMARY rail for
// moving plain USDC across EVM chains (Polygon PoS <-> Arbitrum, + Ethereum).
// Burn-and-mint: there is NO pooled liquidity and NO wrapped token — native
// Circle USDC is burned on the source chain and minted 1:1 on the destination.
//
// THE FLOW (all-domains, V2):
//   1. buildBridgeIn  -> [approve(USDC -> TokenMessengerV2)?, depositForBurn(...)]
//      The local EOA signs + broadcasts both on the SOURCE chain; USDC is burned.
//   2. status()       -> poll Iris for the attestation by the BURN tx hash, THEN
//      confirm the destination USDC balance actually moved ON-CHAIN before "ready".
//   3. recover()      -> once Iris == 'complete', rebuild receiveMessage(message,
//      attestation) on the DESTINATION chain (destinationCaller == bytes32(0) =>
//      permissionless, the same local EOA self-recovers). Never strands funds.
//
// RECIPIENT INVARIANT (see bridge/types.ts):
//   mintRecipient is taken VERBATIM from route.recipient — which the CALLER sets
//   to the sealed treasury (withdraws) or an allowlisted thin-wallet (rebalances).
//   It is NEVER derived from an agent argument here, and validate_intent
//   re-decodes the returned calldata to assert it. destinationCaller is forced to
//   bytes32(0) so redemption is permissionless and self-recoverable.
//
// FINALITY:
//   minFinalityThreshold at BURN time picks the lane. Fast (<=1000) attests at
//   confirmed/soft level in seconds but REQUIRES maxFee >= the LIVE per-corridor
//   minimum (Circle sets it, NOT a bps of the sender's choosing) and is reorg-
//   exposed. Standard (2000) waits for hard finality (free, no maxFee).
//   STANDARD IS THE DEFAULT for BOTH directions — a fund-moving burn must not
//   silently pick a reorg-exposed lane with a guessed fee. Fast is opt-in only
//   (route.lane === "fast"), and even then maxFee is pinned to the live Iris fee
//   (GET /v2/burn/USDC/fees/{src}/{dst}); buildBridgeOut additionally HARD-FORCES
//   Standard regardless of route.lane (withdrawals/large sweeps).
//
// GAS:
//   CCTP delivers ONLY USDC, never native gas. The destination EOA must already
//   hold gas to submit receiveMessage — seeded by the separate deBridge native-
//   output leg (bridge/debridge.ts). Not this module's concern.
//
// LEAN DEPS: viem for encodeFunctionData + bytes32 padding + ABI decode only.
// We do NOT pull @polymarket/clob-client-v2 (drags ethers+axios). RPC reads are
// hand-rolled JSON-RPC over fetch so we don't import viem's client/ws transport.
//
// ---------------------------------------------------------------------------
// SOURCES (every address / domain / endpoint below is from an official doc):
//   TokenMessengerV2 / MessageTransmitterV2 / TokenMinterV2 (identical across
//     all 3 EVM chains, deterministic CREATE2):
//     https://developers.circle.com/cctp/evm-smart-contracts
//   CCTP domain ids (Eth=0, Arb=3, Polygon=7):
//     https://developers.circle.com/cctp/cctp-supported-blockchains
//   Native USDC token addresses (per chain):
//     https://developers.circle.com/stablecoins/usdc-contract-addresses
//   Finality thresholds (Fast<=1000 / Standard 2000) + maxFee rule:
//     https://developers.circle.com/cctp/technical-guide
//   depositForBurn / receiveMessage Solidity signatures:
//     https://github.com/circlefin/evm-cctp-contracts (TokenMessengerV2.sol /
//     MessageTransmitterV2.sol)
//   Iris attestation API (GET /v2/messages/{sourceDomain}?transactionHash=):
//     https://developers.circle.com/api-reference/cctp/all/get-messages-v2
//     NOTE: while pending, attestation == the literal string "PENDING" (NOT null)
//     and message == "0x". We treat both as not-ready.
//   Iris base URLs (prod / sandbox):
//     https://iris-api.circle.com  /  https://iris-api-sandbox.circle.com
//   Fast Transfer fee (per-corridor, set by Circle — query EVERY burn):
//     GET /v2/burn/USDC/fees/{srcDomain}/{dstDomain} -> { minimumFee: <bps> }
//     https://developers.circle.com/cctp/cctp-finality-and-fees
//   On-chain mint proof: MessageTransmitterV2.usedNonces(bytes32 nonce) -> uint256
//     (0 = unused, non-zero = the message was received/minted). The burn's
//     eventNonce comes back from Iris. This is the AUTHORITATIVE mint proof —
//     a recipient-balance heuristic is NOT (a persistent recipient accumulates
//     USDC across bridges, so balance>=amount false-positives).
//     https://github.com/circlefin/evm-cctp-contracts (MessageTransmitterV2.sol)
// ---------------------------------------------------------------------------

import {
  decodeFunctionResult,
  encodeFunctionData,
  pad,
  parseUnits,
} from "viem";
import type { Chain } from "../adapters/types.js";
import type {
  Bridge,
  BridgeQuote,
  BridgeRoute,
  BridgeStatus,
  CctpLane,
  UnsignedBridgeTx,
} from "./types.js";

// ─── VERIFIED CONSTANTS ─────────────────────────────────────────────────────
// SAFETY: the three contract addresses are IDENTICAL on Ethereum / Arbitrum /
// Polygon. This is intentional (deterministic CREATE2), NOT a copy-paste error —
// do not "fix" them to differ per chain.
// https://developers.circle.com/cctp/evm-smart-contracts

/** depositForBurn entrypoint (SOURCE side). approve() targets THIS, never the transmitter. */
const TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const;
/** receiveMessage entrypoint (DESTINATION side). */
const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as const;

/** CCTP domain id per chain — https://developers.circle.com/cctp/cctp-supported-blockchains */
const DOMAIN = {
  ethereum: 0,
  arbitrum: 3,
  polygon: 7,
  solana: 5,
} as const;

/** Native Circle USDC token (the asset CCTP burns/mints). 6 decimals.
 *  NOTE: Polygon native USDC (0x3c49…) is NOT USDC.e (0x2791…) and NOT
 *  Polymarket pUSD — a separate wrap step feeds Polymarket. Not our concern. */
const USDC = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
} as const;

const USDC_DECIMALS = 6;

/** Iris attestation service base URLs. Keyed off network, never hard-coded. */
const IRIS_BASE = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
} as const;

/** minFinalityThreshold values. Fast: confirmed level (seconds), needs maxFee>0,
 *  reorg-exposed. Standard: finalized level (free). */
const FINALITY = { fast: 1000, standard: 2000 } as const;

/** bytes32(0). destinationCaller => permissionless redeem; metadata default. */
const BYTES32_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

// ─── INTERNAL CCTP CHAIN MODEL ──────────────────────────────────────────────
// The repo's Chain union ("polygon" | "hyperliquid" | "solana") is a VENUE-chain
// label, not a settlement network. CCTP settles on real EVM networks, so we map
// the venue-chain onto the CCTP network it actually funds:
//   - "polygon"     -> Polygon PoS   (Polymarket collateral lands here)
//   - "hyperliquid" -> Arbitrum One  (HL funds live on Arbitrum; deposit there)
//   - "solana"      -> Solana        (Stage-2 — not on the EVM critical path)
// Ethereum is a valid CCTP network but no venue maps to it; it is reachable only
// when a future caller passes an explicit "ethereum" CctpNetwork (kept internal).

type CctpNetwork = "ethereum" | "arbitrum" | "polygon" | "solana";

function toCctpNetwork(chain: Chain): CctpNetwork {
  switch (chain) {
    case "polygon":
      return "polygon";
    case "hyperliquid":
      return "arbitrum";
    case "solana":
      return "solana";
    default: {
      // Exhaustiveness guard — a new Chain member must be mapped explicitly.
      const never: never = chain;
      throw new Error(`CCTP: unmapped chain "${never as string}".`);
    }
  }
}

/** True once we know this is an EVM CCTP network we can encode with viem. */
function isEvm(n: CctpNetwork): n is "ethereum" | "arbitrum" | "polygon" {
  return n === "ethereum" || n === "arbitrum" || n === "polygon";
}

function network(): "mainnet" | "testnet" {
  return process.env.STARLING_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

function irisBase(): string {
  return IRIS_BASE[network()];
}

/** Per-chain RPC URL (override via env). Required for the on-chain mint confirm
 *  in status(); without it status() degrades to attestation-only (never green-
 *  lights "ready"). */
function rpcUrl(n: "ethereum" | "arbitrum" | "polygon"): string | undefined {
  const env = {
    ethereum: process.env.STARLING_RPC_ETHEREUM,
    arbitrum: process.env.STARLING_RPC_ARBITRUM,
    polygon: process.env.STARLING_RPC_POLYGON,
  } as const;
  return env[n];
}

// ─── MINIMAL ABIs (only the fns we encode/decode) ───────────────────────────

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient,
//   address burnToken, bytes32 destinationCaller, uint256 maxFee,
//   uint32 minFinalityThreshold) — V2 entrypoint.
// https://github.com/circlefin/evm-cctp-contracts (TokenMessengerV2.sol)
const TOKEN_MESSENGER_V2_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

// receiveMessage(bytes message, bytes attestation) -> bool — DESTINATION entrypoint.
// usedNonces(bytes32 nonce) -> uint256 — the AUTHORITATIVE on-chain mint proof.
// https://github.com/circlefin/evm-cctp-contracts (MessageTransmitterV2.sol)
const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ─── FLIGHT ID ──────────────────────────────────────────────────────────────
// status()/recover() receive a flightId, not the route. We encode the route +
// the recipient's PRE-BURN USDC balance + burn tx hash into the id at build time
// so the poller can reconstruct the Iris query (needs sourceDomain + burn hash),
// the AUTHORITATIVE on-chain mint proof (usedNonces by eventNonce), and a
// balance-DELTA fallback (bal - preBurnBalance >= amount, never absolute bal),
// all without a side store. Shape:
//   cctp:<srcNet>:<dstNet>:<recipient>:<amount6dp>:<preBurnBal6dp>:<burnTxHash|pending>
//
// preBurnBal6dp is the recipient's native-USDC balance on the DESTINATION chain
// at build time (the caller snapshots it; "0" if unknown — then status() relies
// on usedNonces only and will NOT fall back to a balance heuristic). buildBridgeIn
// returns the id-without-hash; the caller appends the real burn hash once it
// broadcasts (recover/status accept either form).

const FLIGHT_PREFIX = "cctp";

interface FlightParts {
  srcNet: CctpNetwork;
  dstNet: CctpNetwork;
  recipient: string;
  amount6dp: string;
  /** Recipient's destination native-USDC balance at burn-build time (6dp base
   *  units, as a string). Used ONLY for the delta fallback; "0" = unknown. */
  preBurnBal6dp: string;
  burnTxHash?: string;
}

function encodeFlightId(p: FlightParts): string {
  return [
    FLIGHT_PREFIX,
    p.srcNet,
    p.dstNet,
    p.recipient.toLowerCase(),
    p.amount6dp,
    p.preBurnBal6dp ?? "0",
    p.burnTxHash ?? "pending",
  ].join(":");
}

function decodeFlightId(id: string): FlightParts {
  const parts = id.split(":");
  if (parts.length !== 7 || parts[0] !== FLIGHT_PREFIX) {
    throw new Error(`CCTP: malformed flightId "${id}".`);
  }
  const [, srcNet, dstNet, recipient, amount6dp, preBurnBal6dp, burnTxHash] = parts;
  return {
    srcNet: srcNet as CctpNetwork,
    dstNet: dstNet as CctpNetwork,
    recipient,
    amount6dp,
    preBurnBal6dp: preBurnBal6dp ?? "0",
    burnTxHash: burnTxHash === "pending" ? undefined : burnTxHash,
  };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

/** USDC decimal string -> 6-decimal base units (bigint). Throws on bad input. */
function toBaseUnits(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

/**
 * Left-pad a 20-byte EVM address into bytes32 (address in the LOW 20 bytes).
 * This is the #1 fund-loss footgun if done wrong — viem's pad() does the
 * canonical left-pad. We accept only a 0x-prefixed 20-byte hex address.
 */
function addressToBytes32(addr: string): `0x${string}` {
  const a = addr.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    throw new Error(`CCTP: mintRecipient "${addr}" is not a 20-byte EVM address.`);
  }
  return pad(a as `0x${string}`, { size: 32 });
}

/**
 * The maxFee for a Fast transfer, in USDC base units. Fast REQUIRES maxFee >= the
 * per-corridor minimum CIRCLE sets (NOT a sender-chosen bps) or Iris parks the
 * burn forever with delayReason=insufficient_fee — and there is NO way to raise
 * maxFee on an already-burned message. So we fetch the LIVE minimum bps from Iris
 * (GET /v2/burn/USDC/fees/{srcDomain}/{dstDomain}) and pin maxFee to that minimum
 * applied to the amount, with a small headroom multiplier. If the fee lookup
 * fails we REFUSE the Fast lane (caller must use Standard) rather than guessing a
 * fee that strands the burn. Standard transfers pass maxFee 0.
 *   https://developers.circle.com/cctp/cctp-finality-and-fees
 *
 * Headroom (default 1.0 = exact minimum, no padding) overridable via
 * STARLING_CCTP_FAST_FEE_HEADROOM (e.g. "1.2" for +20% buffer against a fee bump
 * between quote and burn).
 */
async function fetchFastFeeBps(
  srcNet: CctpNetwork,
  dstNet: CctpNetwork,
): Promise<number> {
  const url = `${irisBase()}/v2/burn/USDC/fees/${DOMAIN[srcNet]}/${DOMAIN[dstNet]}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `CCTP: Fast-fee lookup failed (HTTP ${res.status}) for ${srcNet}->${dstNet}. ` +
        "Use the Standard lane (free) or retry.",
    );
  }
  // Iris now returns an ARRAY (one entry per finalityThreshold: 1000=Fast,
  // 2000=Standard); the older shape was a bare { minimumFee } object. Handle both
  // — pick the Fast (1000) entry. minimumFee may legitimately be 0 (free corridor);
  // fastMaxFee floors the resulting maxFee to 1 base unit (Circle wants it > 0).
  const json = (await res.json()) as
    | { minimumFee?: number }
    | Array<{ finalityThreshold?: number; minimumFee?: number }>;
  const bps = Array.isArray(json)
    ? (json.find((e) => e.finalityThreshold === FINALITY.fast) ?? json[0])?.minimumFee
    : json.minimumFee;
  if (typeof bps !== "number" || !Number.isFinite(bps) || bps < 0) {
    throw new Error(
      `CCTP: Iris returned an invalid Fast-fee (${JSON.stringify(json)}) for ` +
        `${srcNet}->${dstNet}. Use the Standard lane.`,
    );
  }
  return bps;
}

/** Compute the Fast maxFee (USDC base units) from the LIVE per-corridor bps. */
async function fastMaxFee(
  amountBase: bigint,
  srcNet: CctpNetwork,
  dstNet: CctpNetwork,
): Promise<bigint> {
  const bps = await fetchFastFeeBps(srcNet, dstNet);
  const headroomRaw = Number(process.env.STARLING_CCTP_FAST_FEE_HEADROOM ?? "1");
  const headroom =
    Number.isFinite(headroomRaw) && headroomRaw >= 1 ? headroomRaw : 1;
  // maxFee = ceil(amount * bps / 10_000 * headroom). Scale headroom into integer
  // math: multiply by round(headroom*1000), divide by 1000.
  const hMilli = BigInt(Math.round(headroom * 1000));
  const fee = (amountBase * BigInt(Math.ceil(bps)) * hMilli) / (10_000n * 1000n);
  // Circle requires a strictly positive maxFee for Fast; never return 0.
  return fee > 0n ? fee : 1n;
}

/** Resolve the finality lane actually executed for a route. STANDARD is the
 *  default for BOTH directions (a fund-moving burn must not silently take a
 *  reorg-exposed Fast lane with a fee that could strand it). Fast is opt-in only
 *  via route.lane === "fast"; buildBridgeOut force-overrides any Fast to Standard. */
function resolveLane(route: BridgeRoute, forceStandard: boolean): CctpLane {
  if (forceStandard) return "standard";
  return route.lane === "fast" ? "fast" : "standard";
}

/** Minimal JSON-RPC POST. Returns the `result` field or throws on RPC error. */
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message ?? "error"}`);
  return json.result;
}

/** Read native-USDC balanceOf(recipient) on an EVM network. undefined if no RPC. */
async function usdcBalanceOf(
  net: "ethereum" | "arbitrum" | "polygon",
  recipient: string,
): Promise<bigint | undefined> {
  const url = rpcUrl(net);
  if (!url) return undefined;
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [recipient as `0x${string}`],
  });
  const result = (await rpc(url, "eth_call", [
    { to: USDC[net], data },
    "latest",
  ])) as `0x${string}`;
  return decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: result,
  }) as bigint;
}

/**
 * Read MessageTransmitterV2.usedNonces(nonce) on the destination chain — the
 * AUTHORITATIVE proof a specific burn was minted. Returns:
 *   - true   => the message nonce is consumed (mint landed),
 *   - false  => not yet consumed,
 *   - undefined => no RPC configured / read failed (can't prove either way).
 * The eventNonce comes from Iris (decodedMessage.nonce / eventNonce). We treat
 * any NON-ZERO usedNonces value as "used" per the contract (0 = unused).
 */
async function nonceUsed(
  net: "ethereum" | "arbitrum" | "polygon",
  eventNonce: string,
): Promise<boolean | undefined> {
  const url = rpcUrl(net);
  if (!url) return undefined;
  // eventNonce must be a 0x-prefixed bytes32. Iris returns it as a hex string;
  // pad defensively (a short/odd value would mis-encode and read the wrong slot).
  let nonce32: `0x${string}`;
  try {
    const hex = eventNonce.startsWith("0x") ? eventNonce.slice(2) : eventNonce;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 64) return undefined;
    nonce32 = `0x${hex.padStart(64, "0")}`;
  } catch {
    return undefined;
  }
  const data = encodeFunctionData({
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "usedNonces",
    args: [nonce32],
  });
  const result = (await rpc(url, "eth_call", [
    { to: MESSAGE_TRANSMITTER_V2, data },
    "latest",
  ])) as `0x${string}`;
  const used = decodeFunctionResult({
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "usedNonces",
    data: result,
  }) as bigint;
  return used !== 0n;
}

// ─── IRIS ATTESTATION ───────────────────────────────────────────────────────

interface IrisMessage {
  status: "pending_confirmations" | "complete";
  /** While pending this is the LITERAL string "PENDING" (NOT null). Only a
   *  0x-hex value with status==='complete' is usable. */
  attestation: string | null;
  /** While pending this is "0x" (prefix only, no body). */
  message: string | null;
  /** The burn's message nonce (bytes32 hex) — usedNonces() key for mint proof. */
  eventNonce?: string;
  cctpVersion?: number;
  /** Some Iris responses nest the nonce under decodedMessage instead of the top. */
  decodedMessage?: { nonce?: string };
  delayReason?: "insufficient_fee" | "amount_above_max" | "insufficient_allowance_available" | null;
}

/** A fully-attested Iris message that is SAFE to feed to receiveMessage. Guards
 *  against the "PENDING"/"0x" footgun: status must be complete AND attestation /
 *  message must be real 0x-hex (not the literal "PENDING" / bare "0x"). */
function attestationReady(iris: IrisMessage | null): iris is IrisMessage & {
  attestation: `0x${string}`;
  message: `0x${string}`;
} {
  if (!iris || iris.status !== "complete") return false;
  const a = iris.attestation;
  const m = iris.message;
  if (!a || a === "PENDING" || !/^0x[0-9a-fA-F]+$/.test(a)) return false;
  // message must be real hex with a body (not the bare "0x" placeholder).
  if (!m || m === "0x" || !/^0x[0-9a-fA-F]{2,}$/.test(m)) return false;
  return true;
}

/** Pull the burn's bytes32 message nonce from an Iris message (top-level or nested). */
function irisEventNonce(iris: IrisMessage): string | undefined {
  return iris.eventNonce ?? iris.decodedMessage?.nonce;
}

/**
 * Fetch the attestation for a burn. The Iris path uses the SOURCE domain id and
 * the BURN tx hash (a common bug is putting the destination domain in the path).
 * Returns null while still pending or if the message isn't indexed yet.
 */
async function fetchAttestation(
  srcNet: CctpNetwork,
  burnTxHash: string,
): Promise<IrisMessage | null> {
  const srcDomain = DOMAIN[srcNet];
  const url = `${irisBase()}/v2/messages/${srcDomain}?transactionHash=${burnTxHash}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  // 404 simply means Iris hasn't indexed the burn yet — treat as pending.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Iris HTTP ${res.status} for ${burnTxHash}`);
  const json = (await res.json()) as { messages?: IrisMessage[] };
  return json.messages?.[0] ?? null;
}

// ─── THE BRIDGE ─────────────────────────────────────────────────────────────

class CctpBridge implements Bridge {
  readonly provider = "cctp" as const;

  // ── quote ──────────────────────────────────────────────────────────────
  async quote(route: BridgeRoute): Promise<BridgeQuote> {
    const srcNet = toCctpNetwork(route.fromChain);
    const dstNet = toCctpNetwork(route.toChain);
    this.assertUsdc(route);
    this.assertEvmOnly(srcNet, dstNet);

    const lane = resolveLane(route, /* forceStandard */ false);
    const amountBase = toBaseUnits(route.amount);

    // feeUsd: Circle charges a fee ONLY on Fast transfers (the maxFee we pin to
    // the LIVE per-corridor minimum); Standard is free. We surface the Fast fee
    // CEILING (what the EOA agrees to pay) as a decimal-USD string. Native gas
    // for the two on-chain txs is NOT included here (paid in MATIC/ETH, seeded by
    // the deBridge leg). If the Fast-fee lookup fails, fastMaxFee throws and the
    // quote surfaces that the Fast lane is unavailable (caller falls to Standard).
    const feeBase =
      lane === "fast" ? await fastMaxFee(amountBase, srcNet, dstNet) : 0n;
    const feeUsd = formatUsdc(feeBase);

    // ETA: Fast attests at confirmed level in seconds; Standard waits for hard
    // finality. Polygon PoS finalizes fast; ETH/Arb finalized ~13-19min.
    const etaSec = lane === "fast" ? 30 : srcNet === "polygon" ? 120 : 1140;

    const finalityThresholdExecuted = FINALITY[lane];

    return {
      provider: "cctp",
      feeUsd,
      etaSec,
      starlingFeeUsd: "0",
      lane,
      finalityThresholdExecuted,
      reorgExposed: lane === "fast",
    };
  }

  // ── buildBridgeIn: [approve?, depositForBurn] ────────────────────────────
  async buildBridgeIn(route: BridgeRoute): Promise<UnsignedBridgeTx[]> {
    return this.buildBurn(route, /* forceStandard */ false);
  }

  // ── buildBridgeOut: outbound/return bridge — STANDARD finality FORCED ─────
  async buildBridgeOut(route: BridgeRoute): Promise<UnsignedBridgeTx[]> {
    // Withdrawals + large treasury sweeps must wait for hard finality; never let
    // a route.lane=fast slip a reorg-exposed mint into the return path.
    return this.buildBurn(route, /* forceStandard */ true);
  }

  /** Shared burn builder. Standard finality is forced for the outbound path. */
  private async buildBurn(
    route: BridgeRoute,
    forceStandard: boolean,
  ): Promise<UnsignedBridgeTx[]> {
    const srcNet = toCctpNetwork(route.fromChain);
    const dstNet = toCctpNetwork(route.toChain);
    this.assertUsdc(route);
    this.assertEvmOnly(srcNet, dstNet);
    if (srcNet === dstNet) {
      throw new Error(`CCTP: source and destination are the same network (${srcNet}).`);
    }

    // FUND-LOSS GUARD: a Solana destination requires the recipient's USDC
    // ASSOCIATED TOKEN ACCOUNT as mintRecipient (NOT the wallet pubkey), and the
    // ATA must exist before redeem. assertEvmOnly already rejected it above; this
    // is the second, build-path-local guard so the directional-ATA requirement is
    // enforced where the calldata is synthesized, not only in prose.
    if (dstNet === "solana" || srcNet === "solana") {
      throw new Error(
        "CCTP: Solana leg is Stage-2. EVM->Solana needs the recipient's USDC " +
          "ATA as mintRecipient (NOT the wallet pubkey) and a pre-created ATA — " +
          "do not encode a 20-byte EVM-style mintRecipient for Solana. See the stub.",
      );
    }

    const amountBase = toBaseUnits(route.amount);
    if (amountBase <= 0n) throw new Error("CCTP: amount must be > 0.");

    const lane = resolveLane(route, forceStandard);
    const minFinalityThreshold = FINALITY[lane];
    // Fast pins maxFee to the LIVE per-corridor minimum (throws if unavailable —
    // we never guess a fee on a fund-moving burn). Standard is free (maxFee 0).
    const maxFee = lane === "fast" ? await fastMaxFee(amountBase, srcNet, dstNet) : 0n;

    // mintRecipient is route.recipient — the sealed treasury / allowlisted wallet
    // the CALLER pinned. NEVER an agent argument. Padded to bytes32.
    const mintRecipient = addressToBytes32(route.recipient);

    const srcUsdc = USDC[srcNet as "ethereum" | "arbitrum" | "polygon"];
    const spender = TOKEN_MESSENGER_V2;

    const txs: UnsignedBridgeTx[] = [];

    // 1) approve(TokenMessengerV2, amount) on the source native-USDC token.
    //    Targets the BURN entrypoint, never the transmitter. We approve the EXACT
    //    amount (not max-uint) so a stale allowance can't be reused by a later
    //    rogue build — every burn re-approves precisely what it spends.
    txs.push({
      chain: route.fromChain,
      kind: "evmTx",
      label: "approve",
      payload: {
        to: srcUsdc,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [spender, amountBase],
        }),
        value: "0",
      },
    });

    // 2) depositForBurn — burns USDC, emits the message Iris will attest.
    txs.push({
      chain: route.fromChain,
      kind: "evmTx",
      label: "depositForBurn",
      payload: {
        to: TOKEN_MESSENGER_V2,
        data: encodeFunctionData({
          abi: TOKEN_MESSENGER_V2_ABI,
          functionName: "depositForBurn",
          args: [
            amountBase,
            DOMAIN[dstNet], // destinationDomain
            mintRecipient, // bytes32, low-20 = recipient
            srcUsdc as `0x${string}`, // burnToken
            BYTES32_ZERO, // destinationCaller => permissionless redeem
            maxFee, // > 0 for Fast, 0 for Standard
            minFinalityThreshold,
          ],
        }),
        value: "0",
      },
    });

    return txs;
  }

  // ── recover: rebuild receiveMessage once Iris has attested ───────────────
  async recover(route: BridgeRoute, flightId: string): Promise<UnsignedBridgeTx[]> {
    const parts = decodeFlightId(flightId);
    const dstNet = parts.dstNet;
    if (!isEvm(dstNet)) {
      throw new Error(
        `CCTP: Solana receiveMessage recovery is Stage-2 (dest ${dstNet}). ` +
          "See the Solana stub.",
      );
    }
    if (!parts.burnTxHash) {
      throw new Error(
        "CCTP: cannot recover without the burn tx hash. Append it to the " +
          "flightId (cctp:…:<burnTxHash>) once the source burn has broadcast.",
      );
    }

    const iris = await fetchAttestation(parts.srcNet, parts.burnTxHash);
    // attestationReady rejects the "PENDING" literal and the bare "0x" message
    // placeholder — encoding receiveMessage('0x','PENDING') would broadcast a
    // guaranteed-revert tx and burn destination gas.
    if (!attestationReady(iris)) {
      const reason = iris?.delayReason ? ` (delayReason=${iris.delayReason})` : "";
      const st = iris ? ` (status=${iris.status}, attestation=${iris.attestation ?? "null"})` : "";
      throw new Error(
        `CCTP: attestation not ready for ${parts.burnTxHash}${reason}${st}. ` +
          "Poll status() until state=mint_pending, then recover().",
      );
    }

    // receiveMessage(message, attestation) on the DESTINATION transmitter. The
    // local EOA pays destination gas; destinationCaller was bytes32(0) so anyone
    // (incl. us) may submit it. `route.toChain` is the chain the signer broadcasts on.
    return [
      {
        chain: route.toChain,
        kind: "evmTx",
        label: "receiveMessage",
        payload: {
          to: MESSAGE_TRANSMITTER_V2,
          data: encodeFunctionData({
            abi: MESSAGE_TRANSMITTER_V2_ABI,
            functionName: "receiveMessage",
            args: [iris.message, iris.attestation],
          }),
          value: "0",
        },
      },
    ];
  }

  // ── status: poll Iris THEN confirm the destination mint on-chain ─────────
  async status(flightId: string): Promise<BridgeStatus> {
    const parts = decodeFlightId(flightId);

    if (!isEvm(parts.dstNet) || !isEvm(parts.srcNet)) {
      // Solana legs are Stage-2; we don't claim status for them.
      return {
        provider: "cctp",
        state: "failed",
        readyToTrade: false,
        blockers: ["solana_cctp_stage2"],
        note: "CCTP Solana leg is Stage-2; status tracking not implemented.",
      };
    }

    if (!parts.burnTxHash) {
      return {
        provider: "cctp",
        state: "burn_pending",
        readyToTrade: false,
        blockers: ["burn_not_broadcast"],
        note: "Source burn tx hash not yet bound to the flightId.",
      };
    }

    // 1) Attestation phase.
    let iris: IrisMessage | null;
    try {
      iris = await fetchAttestation(parts.srcNet, parts.burnTxHash);
    } catch (e) {
      return {
        provider: "cctp",
        state: "attestation_pending",
        readyToTrade: false,
        blockers: ["iris_unreachable"],
        note: `Iris poll failed: ${(e as Error).message}`,
      };
    }

    // attestationReady gates on status==='complete' AND real 0x-hex (rejects the
    // literal "PENDING" attestation / bare "0x" message Iris returns while pending).
    if (!attestationReady(iris)) {
      // A surfaced delayReason is actionable (don't blind-retry): insufficient_fee
      // (Fast maxFee below the per-corridor minimum — UNRECOVERABLE on this burn,
      // wait out Standard finality), amount_above_max (Fast cap — fall back to
      // Standard), insufficient_allowance_available (re-approve / re-burn).
      const delay = iris?.delayReason;
      if (delay) {
        return {
          provider: "cctp",
          state: "attestation_sla_exceeded",
          readyToTrade: false,
          blockers: [`iris_delay_${delay}`],
          note:
            delay === "amount_above_max"
              ? "Fast per-transfer cap exceeded — rebuild with Standard finality (lane=standard)."
              : delay === "insufficient_fee"
                ? "Fast maxFee below the per-corridor minimum. This burn cannot be re-priced — wait for Standard finality. Future burns pin the live Iris fee (default lane is now Standard)."
                : "Insufficient burn allowance — re-approve and re-burn.",
        };
      }
      return {
        provider: "cctp",
        state: "attestation_pending",
        readyToTrade: false,
        blockers: ["attestation_pending"],
        note: "Burn seen; waiting on Iris attestation (status not yet 'complete' with a real attestation).",
      };
    }

    // status === 'complete' with a real attestation from here. receiveMessage may
    // or may not have landed. Confirm the mint ON-CHAIN — never trust attestation
    // alone, and NEVER use an ABSOLUTE recipient balance (a persistent treasury /
    // thin-wallet accumulates USDC across bridges, so balance>=amount false-
    // positives on every later bridge). PRIMARY proof: usedNonces(eventNonce) on
    // the destination MessageTransmitterV2. FALLBACK (only if nonce/RPC missing):
    // a balance DELTA vs the pre-burn snapshot baked into the flightId.
    const dstNet = parts.dstNet as "ethereum" | "arbitrum" | "polygon";
    const eventNonce = irisEventNonce(iris);

    // 2a) AUTHORITATIVE: was this exact message's nonce consumed on the dest chain?
    if (eventNonce) {
      let used: boolean | undefined;
      try {
        used = await nonceUsed(dstNet, eventNonce);
      } catch {
        used = undefined;
      }
      if (used === true) {
        // Mint proven by the message's own nonce — immune to resting-balance
        // false-positives. readyToTrade stays FALSE: a bare mint is ~3 steps short
        // of a tradable venue (wrap -> pUSD -> approvals -> registry); the caller's
        // check_venue_status owns the final green-light.
        return {
          provider: "cctp",
          state: "ready",
          readyToTrade: false,
          blockers: ["venue_preconditions_unverified"],
          note: "Destination mint PROVEN via usedNonces(eventNonce). Venue preconditions (wrap/approvals/registry) checked separately.",
        };
      }
      if (used === false) {
        return {
          provider: "cctp",
          state: "mint_pending",
          readyToTrade: false,
          blockers: ["receive_message_pending"],
          note: "Attested; message nonce not yet consumed on destination (usedNonces==0). Call recover() to submit receiveMessage.",
        };
      }
      // used === undefined: no RPC / read failed; fall through to the delta path.
    }

    // 2b) FALLBACK: balance DELTA against the pre-burn snapshot. Only used when the
    // nonce path is unavailable. A delta is racy against concurrent inbound
    // transfers, so it is the WEAKER proof — we only green-light with a real
    // pre-burn baseline. Absolute balance is NEVER trusted.
    // NB: parts.amount6dp is ALREADY in 6-dp base units (set by flightIdForRoute
    // via toBaseUnits()), so parse it directly — do NOT re-scale with toBaseUnits.
    const expected = (() => {
      try {
        return BigInt(parts.amount6dp || "0");
      } catch {
        return 0n;
      }
    })();
    let bal: bigint | undefined;
    try {
      bal = await usdcBalanceOf(dstNet, parts.recipient);
    } catch {
      bal = undefined;
    }

    if (bal === undefined) {
      return {
        provider: "cctp",
        state: "mint_pending",
        readyToTrade: false,
        blockers: ["dest_mint_unconfirmed", "no_dest_rpc"],
        note:
          "Attestation complete but destination mint unconfirmed on-chain " +
          `(set STARLING_RPC_${parts.dstNet.toUpperCase()} to confirm via usedNonces). ` +
          "Call recover() to (re)drive receiveMessage.",
      };
    }

    const preBurn = (() => {
      try {
        return BigInt(parts.preBurnBal6dp || "0");
      } catch {
        return 0n;
      }
    })();
    const haveBaseline = parts.preBurnBal6dp !== "" && parts.preBurnBal6dp !== "0";

    if (haveBaseline && bal - preBurn >= expected) {
      return {
        provider: "cctp",
        state: "ready",
        readyToTrade: false,
        blockers: ["venue_preconditions_unverified", "proof_balance_delta_not_nonce"],
        note: "Destination mint confirmed via balance DELTA (no eventNonce/usedNonces available). Weaker than nonce proof. Venue preconditions checked separately.",
      };
    }

    return {
      provider: "cctp",
      state: "mint_pending",
      readyToTrade: false,
      blockers: haveBaseline
        ? ["receive_message_pending"]
        : ["dest_mint_unconfirmed", "no_preburn_baseline_no_nonce"],
      note: haveBaseline
        ? "Attested; balance delta below expected — receiveMessage not yet landed. Call recover()."
        : "Attested but cannot prove the mint: no eventNonce/usedNonces and no pre-burn balance baseline in the flightId. Refusing to green-light off an absolute balance. Provide STARLING_RPC_<NET> (nonce proof) or a pre-burn snapshot.",
    };
  }

  // ── guards ───────────────────────────────────────────────────────────────

  private assertUsdc(route: BridgeRoute): void {
    if (route.token.toUpperCase() !== "USDC") {
      throw new Error(
        `CCTP only bridges USDC (got "${route.token}"). Route non-USDC via deBridge.`,
      );
    }
  }

  private assertEvmOnly(src: CctpNetwork, dst: CctpNetwork): void {
    if (!isEvm(src) || !isEvm(dst)) {
      throw new Error(
        "CCTP Solana leg is Stage-2 (EVM<->EVM only for now). " +
          `Got ${src} -> ${dst}. See the Solana stub below.`,
      );
    }
  }
}

/** Format USDC base units (6 dp) to a trimmed decimal string. */
function formatUsdc(base: bigint): string {
  const s = base.toString().padStart(USDC_DECIMALS + 1, "0");
  const whole = s.slice(0, -USDC_DECIMALS);
  const frac = s.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ─── FLIGHT-ID WIRING CONTRACT (for the Phase-3 caller) ─────────────────────
// buildBridgeIn/Out return ONLY the unsigned txs (the Bridge interface gives
// status()/recover() a flightId, not a route). The caller wires the flight as:
//   1. BEFORE building the burn, snapshot the recipient's destination native-USDC
//      balance via cctpPreBurnBalance(route) (returns "0" if no RPC — then status
//      relies on usedNonces only and refuses the balance fallback).
//   2. Build the flightId with flightIdForRoute(route, preBurnBal6dp). Store it
//      against the intent.
//   3. Once the depositForBurn tx broadcasts, append the real burn tx hash with
//      bindBurnHash(flightId, burnTxHash) and persist the bound id.
//   4. status(boundId) / recover(route, boundId) thereafter.
// This keeps the source-of-truth (burn hash + pre-burn baseline) in the id with
// no side store, and is the contract the intents/store layer must honor.

/** Build the (hash-less) flightId for a route + pre-burn balance snapshot. */
export function flightIdForRoute(
  route: BridgeRoute,
  preBurnBal6dp: string = "0",
): string {
  const srcNet = toCctpNetwork(route.fromChain);
  const dstNet = toCctpNetwork(route.toChain);
  return encodeFlightId({
    srcNet,
    dstNet,
    recipient: route.recipient,
    amount6dp: toBaseUnits(route.amount).toString(),
    preBurnBal6dp: preBurnBal6dp || "0",
  });
}

/** Append the broadcast burn tx hash onto a hash-less flightId. */
export function bindBurnHash(flightId: string, burnTxHash: string): string {
  const parts = decodeFlightId(flightId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
    throw new Error(`CCTP: burnTxHash "${burnTxHash}" is not a 32-byte tx hash.`);
  }
  return encodeFlightId({ ...parts, burnTxHash });
}

/** Snapshot the recipient's destination native-USDC balance (6dp base units, as
 *  a string) BEFORE the burn, for the status() delta fallback. Returns "0" when
 *  no destination RPC is configured (status() then relies on usedNonces only and
 *  will NOT fall back to a balance heuristic — the honest, safe default). */
export async function cctpPreBurnBalance(route: BridgeRoute): Promise<string> {
  const dstNet = toCctpNetwork(route.toChain);
  if (!isEvm(dstNet)) return "0";
  try {
    const bal = await usdcBalanceOf(dstNet, route.recipient);
    return bal === undefined ? "0" : bal.toString();
  } catch {
    return "0";
  }
}

// ─── SOLANA CCTP LEG — STAGE-2 STUB ─────────────────────────────────────────
// Deliberately NOT implemented here. The Solana CCTP leg is materially more
// complex than EVM<->EVM and is a self-contained add-on, NOT on the
// Polymarket/Hyperliquid critical path:
//
//   - depositForBurn / receiveMessage are Anchor instructions on
//     TokenMessengerMinterV2 (CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe) and
//     MessageTransmitterV2 (CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC), which
//     require hand-rolled Borsh args + an 8-byte discriminator + an EXACT ordered
//     account-meta list + PDA derivation — there is no viem-like helper.
//   - mintRecipient encoding is DIRECTIONAL: EVM->Solana sets it to the
//     recipient's USDC ASSOCIATED TOKEN ACCOUNT (not the wallet pubkey), and the
//     ATA MUST already exist or receiveMessage reverts.
//   - A fresh message_sent_event_data keypair must be co-signed per burn, and its
//     rent is LOCKED for 5 days before reclaim_event_account.
//   - Pulls @solana/web3.js (approved) but needs manual Anchor encoding.
//
// Ship EVM<->EVM first; wire Solana as Stage-2.
// Source: https://developers.circle.com/cctp/solana-programs
export function buildSolanaCctpLeg(): never {
  throw new Error(
    "CCTP Solana leg is Stage-2 and not yet implemented. EVM<->EVM " +
      "(Polygon/Arbitrum/Ethereum) is the launch scope. Solana requires a " +
      "hand-rolled Anchor encoder (Borsh + discriminator + account metas + PDAs), " +
      "directional ATA mintRecipient handling, and the 5-day event-account rent " +
      "lock — tracked separately. See https://developers.circle.com/cctp/solana-programs",
  );
}

// ─── EXPORT ─────────────────────────────────────────────────────────────────

/** The CCTP V2 USDC bridge (EVM<->EVM). Singleton — stateless, env-driven. */
export const cctpBridge: Bridge = new CctpBridge();

// Re-export the constants for validate_intent's calldata re-decode + tests.
export const CCTP_CONSTANTS = {
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
  DOMAIN,
  USDC,
  USDC_DECIMALS,
  FINALITY,
  BYTES32_ZERO,
  IRIS_BASE,
} as const;

// Internal helpers exported for unit tests / validate_intent re-decode.
export {
  addressToBytes32,
  decodeFlightId,
  encodeFlightId,
  toCctpNetwork,
  toBaseUnits,
  formatUsdc,
};
export type { CctpNetwork, FlightParts };
