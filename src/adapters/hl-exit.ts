// src/adapters/hl-exit.ts
// The CHEAP Hyperliquid exit: HyperCore -> HyperEVM -> CCTP -> destination chain.
// ~$0.003 + ~30s vs the $1 + ~5min withdraw3 (~300x cheaper, and reaches any CCTP
// chain, not just Arbitrum). EXECUTES the whole flow locally and SELF-FUNDS its HYPE
// gas. PROVEN LIVE 2026-06-19 (HyperCore->HyperEVM->Arbitrum, +2.000000 USDC).
//
// Why HyperEVM lives HERE and not in the repo Chain union: "hyperevm" is an INTERNAL
// hop of this one flow, not a general route endpoint — adding it to Chain would touch
// 240+ call sites. So this module owns the HyperEVM-specific CCTP facts and reuses
// cctp.ts's SHARED, chain-agnostic constants (the V2 contracts are identical across
// chains by deterministic CREATE2 — verified deployed on HyperEVM).
//
// The flow:
//   1. usdClassTransfer USDC perp->spot (deposits land in perp; spotSend needs spot).
//   2. spotSend USDC -> HyperEVM (HyperCore USDC system address 0x2000...0000) — it
//      credits the CIRCLE-NATIVE USDC 0xb88339CB DIRECTLY (no conversion; proven).
//   3. ensureHypeGas: if HyperEVM HYPE < floor, spot-buy HYPE + spotSend it to the
//      special HYPE system address 0x2222...2222 (native gas). HL spot $10 min order.
//   4. CCTP burn on HyperEVM (approve + depositForBurn, standard lane / free) -> Iris
//      attestation (HyperEVM fast finality => ~seconds) -> receiveMessage on the dest.
// Recipient is pinned by the caller (sealed treasury), never chosen here.

import { encodeFunctionData, pad, type Hex } from "viem";
import type { EvmSigner } from "../signers/evm.js";
import { getEvmSigner } from "../signers/index.js";
import { EvmRpc } from "./evm-rpc.js";
import { signAndSendEvm } from "./evm-broadcast.js";
import { signSpotSend, signUsdClassTransfer, signL1Action, type RsvSignature } from "./hl-signing.js";
import { postExchange, infoPost, HL_MAINNET } from "./hl-transport.js";
import { floatToWire, roundPx } from "./hyperliquid.js";
import { CCTP_CONSTANTS } from "../bridge/cctp.js";
import type { HlExitOps, HlBridgeOutResult } from "../tools/index.js";

// ── HyperEVM + HL constants (verified on-chain / spotMeta 2026-06-19) ─────────
/** CCTP source domain for HyperEVM. (cctp.ts owns the dest domains/USDC.) */
export const HYPEREVM_CCTP_DOMAIN = 19;
/** Circle-native, CCTP-burnable USDC on HyperEVM (6dp). NOT the spotMeta-linked proxy. */
export const HYPEREVM_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as const;
/** HL spot USDC "name:tokenId" + its HyperCore->HyperEVM system address (token index 0). */
const HL_USDC_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
const HL_USDC_SYSTEM = "0x2000000000000000000000000000000000000000";
/** HYPE (HyperEVM native gas): token, SPECIAL system addr (not 0x20+index), spot pair @107. */
const HYPE_TOKEN = "HYPE:0x0d01dc56dcaaca66ad901c959b4011ec";
const HYPE_SYSTEM = "0x2222222222222222222222222222222222222222";
const HYPE_SPOT_ASSET = 10107;
const HYPE_SZ_DECIMALS = 2;

/** Destinations the cheap exit can mint to via CCTP. (solana CCTP leg is stage-2.) */
export type HlExitDest = "arbitrum" | "polygon";

const DEPOSIT_FOR_BURN_ABI = [
  {
    name: "depositForBurn", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ], outputs: [],
  },
] as const;
const RECEIVE_MESSAGE_ABI = [
  { name: "receiveMessage", type: "function", stateMutability: "nonpayable", inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }], outputs: [{ type: "bool" }] },
] as const;
const ERC20_APPROVE_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export interface EvmCall { to: Hex; data: Hex; }

// ── PURE builders (exported for unit tests — these MOVE money, decode them) ───

/** The two HyperEVM burn legs: approve(USDC->TokenMessengerV2) + depositForBurn to
 *  `dest`. Standard lane (maxFee 0, finality 2000) = free + HyperEVM finalizes fast.
 *  mintRecipient is the caller-pinned dest address (low-20 of the bytes32). */
export function buildHyperevmBurnTxs(args: { amountBase: bigint; dest: HlExitDest; recipient: string }): { approve: EvmCall; burn: EvmCall } {
  if (args.amountBase <= 0n) throw new Error("burn amount must be > 0");
  const a = args.recipient.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`recipient "${args.recipient}" is not a 20-byte EVM address`);
  const destDomain = CCTP_CONSTANTS.DOMAIN[args.dest];
  const tokenMessenger = CCTP_CONSTANTS.TOKEN_MESSENGER_V2 as Hex;
  return {
    approve: {
      to: HYPEREVM_USDC,
      data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [tokenMessenger, args.amountBase] }),
    },
    burn: {
      to: tokenMessenger,
      data: encodeFunctionData({
        abi: DEPOSIT_FOR_BURN_ABI, functionName: "depositForBurn",
        args: [args.amountBase, destDomain, pad(a as Hex, { size: 32 }), HYPEREVM_USDC, CCTP_CONSTANTS.BYTES32_ZERO as Hex, 0n, 2000],
      }),
    },
  };
}

/** receiveMessage(message, attestation) on the destination MessageTransmitterV2. */
export function buildCctpReceiveTx(message: Hex, attestation: Hex): EvmCall {
  return {
    to: CCTP_CONSTANTS.MESSAGE_TRANSMITTER_V2 as Hex,
    data: encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: "receiveMessage", args: [message, attestation] }),
  };
}

// ── orchestrator (EXECUTES) ──────────────────────────────────────────────────
// HlBridgeOutResult is shared with the tool layer (imported from tools/index.js).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt6 = (n: bigint) => (Number(n) / 1e6).toFixed(6);

async function erc20Balance(rpc: EvmRpc, token: string, owner: string): Promise<bigint> {
  const data = "0x70a08231" + owner.slice(2).toLowerCase().padStart(64, "0");
  const hex = await rpc.callReadonly({ from: owner, to: token, data });
  return BigInt(hex && hex !== "0x" ? hex : "0x0");
}

/** POST a locally-signed HL action to /exchange — casts the typed action to the
 *  transport's Record<string,unknown> (as hyperliquid.ts does). */
function postHlAction(signed: { action: unknown; nonce: number; signature: RsvSignature }) {
  return postExchange({ action: signed.action as Record<string, unknown>, nonce: signed.nonce, signature: signed.signature, vaultAddress: null }, { host: HL_MAINNET });
}

/** Ensure the HyperEVM address holds at least `floorHype` native HYPE for burn gas;
 *  if short, spot-buy HYPE (>= the $10 HL min) and spotSend it to HyperEVM. */
export async function ensureHypeGas(signer: EvmSigner, opts: { floorHype?: number; log?: (m: string) => void } = {}): Promise<{ topUp: boolean; note: string }> {
  const log = opts.log ?? (() => {});
  const floor = opts.floorHype ?? 0.02;
  const heRpc = new EvmRpc({ net: "hyperevm" });
  const have = Number(await heRpc.getBalanceWei(signer.address)) / 1e18;
  if (have >= floor) return { topUp: false, note: `HyperEVM HYPE ${have.toFixed(4)} >= floor ${floor}` };

  const mids = await infoPost<Record<string, string>>({ type: "allMids" }, { host: HL_MAINNET });
  const mid = Number(mids["@107"]);
  if (!(mid > 0)) throw new Error("could not read HYPE mid");
  // HL spot min order is $10 — buy at least that, rounded up to szDecimals.
  const sizeNeeded = Math.max(11 / mid, floor * 3); // ~$11 chunk (above the $10 min)
  const size = Math.ceil(sizeNeeded * 100) / 100; // szDecimals 2

  // Make sure spot has USD for the buy (move from perp).
  log(`HYPE gas low (${have.toFixed(4)} < ${floor}); buying ${size} HYPE (~$${(size * mid).toFixed(2)}) on HL spot`);
  const usdNeeded = (size * mid * 1.04).toFixed(2);
  const ut = signUsdClassTransfer({ signer, amount: usdNeeded, toPerp: false, nonce: Date.now(), isMainnet: true });
  await postHlAction(ut);
  await sleep(1500);

  const limit = roundPx(mid * 1.03, HYPE_SZ_DECIMALS);
  const order = { a: HYPE_SPOT_ASSET, b: true, p: floatToWire(limit), s: floatToWire(size), r: false, t: { limit: { tif: "Ioc" } } };
  const action = { type: "order", orders: [order], grouping: "na" };
  const nonce = Date.now();
  const sig = signL1Action({ signer, action, nonce, vaultAddress: null, isMainnet: true });
  const buy = await postHlAction({ action, nonce, signature: sig });
  if (!buy.posted) throw new Error(`HYPE spot buy rejected: ${buy.error}`);
  await sleep(1500);

  // Send (size - a hair) to HyperEVM as native gas.
  const sendHype = (size - 0.01).toFixed(2);
  const ss = signSpotSend({ signer, destination: HYPE_SYSTEM, token: HYPE_TOKEN, amount: sendHype, time: Date.now(), isMainnet: true });
  const sent = await postHlAction(ss);
  if (!sent.posted) throw new Error(`HYPE spotSend to HyperEVM rejected: ${sent.error}`);
  log(`sent ${sendHype} HYPE to HyperEVM for gas`);
  return { topUp: true, note: `topped up ${sendHype} HYPE on HyperEVM` };
}

/**
 * The cheap exit, executed end-to-end. Moves `amount` USDC from HyperCore to
 * `recipient` on `dest` via HyperEVM + CCTP. Self-funds HYPE gas. Returns the tx
 * hashes + a blockers[] (non-empty => did not fully complete; safe to inspect/retry).
 */
export async function hlBridgeOut(args: { amount: string; dest: HlExitDest; recipient: string; log?: (m: string) => void }): Promise<HlBridgeOutResult> {
  const log = args.log ?? (() => {});
  const txHashes: string[] = [];
  const amountBase = BigInt(Math.round(Number(args.amount) * 1e6));
  if (amountBase <= 0n) return { ok: false, txHashes, blockers: ["amount must be > 0"], note: "Nothing to bridge." };

  const signer = getEvmSigner("hyperliquid");
  const heRpc = new EvmRpc({ net: "hyperevm" });
  const destRpc = new EvmRpc({ net: args.dest });

  try {
    // 0. HYPE gas float (self-fund if needed).
    await ensureHypeGas(signer, { log });

    // 1. perp -> spot so spotSend has the USDC. Move amount + a small buffer.
    const toSpot = (Number(args.amount) + 0.1).toFixed(2);
    const u = signUsdClassTransfer({ signer, amount: toSpot, toPerp: false, nonce: Date.now(), isMainnet: true });
    const ur = await postHlAction(u);
    if (!ur.posted) return { ok: false, txHashes, blockers: [`usdClassTransfer perp->spot rejected: ${ur.error}`], note: "Could not move USDC to spot." };
    await sleep(1500);

    // 2. spotSend USDC -> HyperEVM (credits native USDC 0xb88339CB).
    const beforeHe = await erc20Balance(heRpc, HYPEREVM_USDC, signer.address);
    const ss = signSpotSend({ signer, destination: HL_USDC_SYSTEM, token: HL_USDC_TOKEN, amount: args.amount, time: Date.now(), isMainnet: true });
    const sr = await postHlAction(ss);
    if (!sr.posted) return { ok: false, txHashes, blockers: [`spotSend USDC->HyperEVM rejected: ${sr.error}`], note: "Could not bridge USDC to HyperEVM." };
    log(`spotSent ${args.amount} USDC -> HyperEVM; waiting for the credit…`);
    // wait for the HyperEVM credit (next block, ~seconds).
    let credited = false;
    for (let i = 0; i < 30 && !credited; i++) {
      await sleep(3000);
      const now = await erc20Balance(heRpc, HYPEREVM_USDC, signer.address);
      if (now - beforeHe >= amountBase) credited = true;
    }
    if (!credited) return { ok: false, txHashes, blockers: ["HyperEVM USDC not credited within ~90s"], note: "spotSend posted but the HyperEVM credit didn't land yet; re-check / retry." };

    // 3. CCTP burn on HyperEVM (approve + depositForBurn).
    const { approve, burn } = buildHyperevmBurnTxs({ amountBase, dest: args.dest, recipient: args.recipient });
    let r = await signAndSendEvm({ to: approve.to, data: approve.data, value: 0n }, signer, heRpc);
    if (!r.ok) return { ok: false, txHashes, blockers: [`HyperEVM approve failed (${r.status})`], note: "Could not approve USDC for the CCTP burn (HYPE gas?)." };
    txHashes.push(r.txHash);
    r = await signAndSendEvm({ to: burn.to, data: burn.data, value: 0n }, signer, heRpc);
    if (!r.ok) return { ok: false, txHashes, blockers: [`HyperEVM depositForBurn failed (${r.status})`], note: "CCTP burn did not land." };
    txHashes.push(r.txHash);
    const burnTxHash = r.txHash;
    log(`CCTP burn on HyperEVM: ${burnTxHash}`);

    // 4. Iris attestation (source domain 19).
    let message: Hex | undefined;
    let attestation: Hex | undefined;
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      await sleep(8000);
      const j = await fetch(`${CCTP_CONSTANTS.IRIS_BASE.mainnet}/v2/messages/${HYPEREVM_CCTP_DOMAIN}?transactionHash=${burnTxHash}`)
        .then((x) => x.json()).catch(() => ({} as Record<string, unknown>));
      const m = (j as { messages?: Array<{ status?: string; message?: string; attestation?: string }> }).messages?.[0];
      if (m?.status === "complete" && m.attestation && m.attestation !== "PENDING" && m.message && m.message !== "0x") {
        message = m.message as Hex;
        attestation = m.attestation as Hex;
        break;
      }
    }
    if (!message || !attestation) {
      return { ok: false, txHashes, burnTxHash, blockers: ["iris_attestation_timeout"], note: `Burn landed (${burnTxHash}) but Iris hasn't attested yet — re-drive receiveMessage on ${args.dest} once attested.` };
    }

    // 5. receiveMessage (mint) on the destination — local EOA pays dest gas.
    const recv = buildCctpReceiveTx(message, attestation);
    r = await signAndSendEvm({ to: recv.to, data: recv.data, value: 0n }, signer, destRpc);
    txHashes.push(r.txHash);
    if (!r.ok) return { ok: false, txHashes, burnTxHash, blockers: [`receiveMessage on ${args.dest} failed (${r.status})`], note: `Attested; mint did not land (dest gas?). Re-drive receiveMessage. burn ${burnTxHash}.` };

    return { ok: true, txHashes, burnTxHash, blockers: [], note: `Cheap exit complete — ${args.amount} USDC HyperCore -> HyperEVM -> CCTP -> ${args.dest} to ${args.recipient}. Gas paid in HYPE; ~$0.003 vs the $1 withdraw3.` };
  } catch (e) {
    return { ok: false, txHashes, blockers: [`hl_bridge_out error: ${(e as Error).message}`], note: "The cheap exit did not complete. Funds are recoverable on whichever leg they reached; safe to retry." };
  }
}

/** The HlExitOps the hl_bridge_out tool runs on. Wired in server.ts when an HL
 *  signer is loaded. Thin — bridgeOut IS the executing orchestrator above. */
export function makeRealHlExit(): HlExitOps {
  return { bridgeOut: (a) => hlBridgeOut(a) };
}
