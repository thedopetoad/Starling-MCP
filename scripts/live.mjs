// scripts/live.mjs — the REFERENCE HARNESS (committed; touches a REAL wallet).
//
// The worked, end-to-end example of the whole Starling lifecycle in the
// "caller/agent" role: it drives the MCP's pure builders (the SAME adapters/
// bridges the tools use), signs + broadcasts via the local broadcast helpers, and
// confirms on-chain. READ it to see the exact call sequence for any flow; RUN it
// to live-integration-check a venue/rail end to end.
//
// SAFETY: every money stage is DRY BY DEFAULT — it builds + simulates/prechecks and
// sends NOTHING. Only the explicit `--live` flag ever broadcasts. Keys never leave
// this box; this script signs locally exactly like the in-MCP path does.
//
// Run with your keys in the env (any STARLING_KEY_SOURCE works; the `env` source +
// a --env-file is quickest). From the Starling-MCP dir, after `npm run build`:
//   node --env-file=../starling-test/agent.env scripts/live.mjs balances
//   node --env-file=../starling-test/agent.env scripts/live.mjs swap 0.15 [--live]
//   node --env-file=../starling-test/agent.env scripts/live.mjs bridge arb-usdc 7 [--live]
//       legs: arb-usdc | poly-usdc (amount = USDC in) ; arb-gas | poly-gas (amount = native out)
//   node ... scripts/live.mjs hl-withdraw 4 [--live]              # HyperCore -> Arbitrum ($1 HL fee)
//   node ... scripts/live.mjs transfer solana polygon 3 [--live]  # auto-picks CCTP vs deBridge
//
// Stages: balances, swap, bridge, hl-deposit, hl-trade, hl-close, hl-withdraw,
// pm-creds, pm-enable, poly-swap, pm-trade, route, cctp, transfer. Run with no
// stage to print the list.
if (!process.env.STARLING_KEY_SOURCE) process.env.STARLING_KEY_SOURCE = "env";
// CCTP needs mainnet Iris + dest RPC for the usedNonces mint-proof (cctp.ts reads these).
process.env.STARLING_NETWORK = process.env.STARLING_NETWORK || "mainnet";
process.env.STARLING_RPC_POLYGON = process.env.STARLING_RPC_POLYGON || "https://polygon-bor-rpc.publicnode.com";
process.env.STARLING_RPC_ARBITRUM = process.env.STARLING_RPC_ARBITRUM || "https://arb1.arbitrum.io/rpc";

import { bootUnlock, getSolanaSigner, getEvmSigner, loadedAddresses } from "../dist/signers/index.js";
import { jupiterAdapter, USDC_MINT, SOL_MINT } from "../dist/adapters/jupiter.js";
import { HyperliquidAdapter } from "../dist/adapters/hyperliquid.js";
import { signWithdraw } from "../dist/adapters/hl-signing.js";
import { signAndSend } from "../dist/adapters/solana-broadcast.js";
import { signAndSendEvm } from "../dist/adapters/evm-broadcast.js";
import { signTransaction, readShortVec } from "../dist/adapters/solana-tx.js";
import { SolanaRpc } from "../dist/adapters/solana-rpc.js";
import { EvmRpc } from "../dist/adapters/evm-rpc.js";
import { base58 } from "@scure/base";
import { hashTypedData, hexToBytes, encodeFunctionData } from "viem";
import { CLOB_HOST } from "../dist/adapters/polymarket-constants.js";
import { buildEnableTradingTxs } from "../dist/adapters/polymarket-enable.js";
import { polymarketAdapter } from "../dist/adapters/polymarket.js";
import { postOrder } from "../dist/adapters/polymarket-transport.js";
import { cctpBridge, flightIdForRoute, bindBurnHash, cctpPreBurnBalance } from "../dist/bridge/cctp.js";
import {
  DeBridgeBridge, debridgeChainId, usdcOn, nativeSentinel, scaleDecimal, buildSourceOrderTxs,
} from "../dist/bridge/debridge.js";

const stage = process.argv[2];
const LIVE = process.argv.includes("--live");
const arg = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
const arg2 = process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : undefined;
const arg3 = process.argv[5] && !process.argv[5].startsWith("--") ? process.argv[5] : undefined;

const solRpc = new SolanaRpc();
const fmt = (n, d) => (Number(n) / 10 ** d).toFixed(d > 9 ? 6 : 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USDC_EVM = { polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" };

await bootUnlock();
const A = loadedAddresses();

// Overwrite the 32-byte recent blockhash in a v0 tx message with a fresh one.
// Layout after the sig array: [version 0x80][header 3B][shortvec keys][keys*32]
// [recentBlockhash 32B][instructions...]. Replacing it is safe — the blockhash is
// tx-liveness only, not part of deBridge's order semantics (the order is in the ix).
function refreshBlockhash(b64, newBhBase58) {
  const buf = Uint8Array.from(Buffer.from(b64, "base64"));
  const [sigCount, sigStart] = readShortVec(buf, 0);
  let off = sigStart + 64 * sigCount; // message start
  if (buf[off] & 0x80) off += 1; // version byte
  off += 3; // header
  const [numKeys, kLen] = readShortVec(buf, off);
  off += kLen + numKeys * 32; // skip static account keys -> blockhash starts here
  const bh = base58.decode(newBhBase58);
  if (bh.length !== 32) throw new Error("bad blockhash length " + bh.length);
  const out = Uint8Array.from(buf);
  out.set(bh, off);
  return Buffer.from(out).toString("base64");
}

// erc20 balanceOf via eth_call (selector 0x70a08231)
async function erc20Bal(net, token, owner) {
  const data = "0x70a08231" + owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const hex = await new EvmRpc({ net }).callReadonly({ from: owner, to: token, data });
  return BigInt(hex === "0x" ? "0x0" : hex);
}

async function balances() {
  console.log("loaded signers:", A);
  const sol = await solRpc.getBalanceLamports(A.solana).catch((e) => `ERR ${e.message}`);
  const usdc = await solRpc.getTokenBalance(A.solana, USDC_MINT).catch((e) => `ERR ${e.message}`);
  console.log("Solana   SOL :", typeof sol === "number" ? fmt(sol, 9) : sol);
  console.log("Solana   USDC:", usdc?.uiAmount ?? usdc);
  for (const net of ["polygon", "arbitrum"]) {
    const addr = net === "polygon" ? A.polygon : A.hyperliquid;
    const wei = await new EvmRpc({ net }).getBalanceWei(addr).catch((e) => `ERR ${e.message}`);
    const usdce = await erc20Bal(net, USDC_EVM[net], addr).catch((e) => `ERR ${e.message}`);
    console.log(`${net.padEnd(8)} native:`, typeof wei === "bigint" ? fmt(wei, 18) : wei, "| USDC:", typeof usdce === "bigint" ? fmt(usdce, 6) : usdce, `(${addr})`);
  }
}

async function swap() {
  if (!arg) throw new Error("usage: swap <solAmount> [--live]");
  const intent = {
    venue: "jupiter", marketId: "jup:" + USDC_MINT, side: "buy", amount: arg,
    amountKind: "collateral", worstPrice: "0", slippageFrac: 0.01, idempotencyKey: `swap-${arg}`,
  };
  const q = await jupiterAdapter.quote({
    inputMint: SOL_MINT, outputMint: USDC_MINT,
    amountBaseUnits: BigInt(Math.round(Number(arg) * 1e9)).toString(), slippageBps: 100,
  });
  console.log(`quote: ${arg} SOL -> ${(Number(q.outAmount) / 1e6).toFixed(4)} USDC (min ${(Number(q.otherAmountThreshold) / 1e6).toFixed(4)}); ~$${(Number(q.outAmount) / 1e6 / Number(arg)).toFixed(2)}/SOL`);
  const build = await jupiterAdapter.buildOpen(intent);
  const sim = await solRpc.simulate(build.unsignedTxB64).catch((e) => ({ err: `sim fetch: ${e.message}` }));
  console.log("simulate:", sim.err ? `ERR ${JSON.stringify(sim.err)}` : "OK");
  if (!LIVE) return void console.log("\nDRY RUN — re-run with --live to send.");
  if (sim.err) return void console.log("refusing to broadcast: sim failed.");
  console.log("\n>>> BROADCASTING LIVE <<<");
  const res = await signAndSend(build, getSolanaSigner(), solRpc, { simulateFirst: true });
  console.log("result:", { ok: res.ok, status: res.status, txid: res.txid });
  if (res.txid) console.log("https://solscan.io/tx/" + res.txid);
}

// ── Generic Jupiter swap: ANY pair, ANY side (proves arbitrary-token trading) ──
// usage: jup <marketId> <buy|sell> <amount> [--live]
//   marketId "jup:<assetMint>" (SOL quote) or "jup:<quoteMint>:<assetMint>". The
//   symbol shortcuts SOL/USDC/BONK expand to mints for convenience, e.g.
//   `jup jup:USDC:BONK buy 0.5` spends 0.5 USDC for BONK.
const JUP_SYMS = { SOL: SOL_MINT, USDC: USDC_MINT, BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" };
function expandMarketId(m) {
  return m.split(/([:/])/).map((p) => JUP_SYMS[p.toUpperCase()] ?? p).join("");
}
async function jup() {
  if (!arg) throw new Error("usage: jup <marketId> <buy|sell> <amount> [--live]  e.g. jup jup:USDC:BONK buy 0.5");
  const marketId = expandMarketId(arg);
  const side = (arg2 || "buy").toLowerCase();
  const amount = arg3 || "0.5";
  const rm = await jupiterAdapter.resolveMarket(marketId);
  console.log(`jup ${side} ${amount} on ${arg} -> ${marketId}`);
  console.log("  resolve:", JSON.stringify(rm.meta));
  const intent = { venue: "jupiter", marketId, side, amount, amountKind: side === "buy" ? "collateral" : "shares", worstPrice: "0", slippageFrac: 0.02, idempotencyKey: `jup-${Date.now()}` };
  const build = await jupiterAdapter.buildOpen(intent);
  const sim = await solRpc.simulate(build.unsignedTxB64).catch((e) => ({ err: `sim fetch: ${e.message}` }));
  console.log("  simulate:", sim.err ? `ERR ${JSON.stringify(sim.err)}` : "OK (executable)");
  if (!LIVE) return void console.log("DRY — --live to send.");
  if (sim.err) return void console.log("refusing to broadcast: sim failed.");
  console.log("\n>>> BROADCASTING JUP SWAP LIVE <<<");
  const res = await signAndSend(build, getSolanaSigner(), solRpc, { simulateFirst: true });
  console.log("  result:", { ok: res.ok, status: res.status, txid: res.txid });
  if (res.txid) console.log("  https://solscan.io/tx/" + res.txid);
}

// ── deBridge param builders (Solana source; authorities pinned to our wallets) ──
function fundingParams(toChain, recipient, usdcDecimal) {
  return {
    srcChainId: debridgeChainId("solana"), srcChainTokenIn: usdcOn("solana"),
    srcChainTokenInAmount: scaleDecimal(usdcDecimal, 6),
    dstChainId: debridgeChainId(toChain), dstChainTokenOut: usdcOn(toChain), dstChainTokenOutAmount: "auto",
    dstChainTokenOutRecipient: recipient, srcChainOrderAuthorityAddress: A.solana,
    dstChainOrderAuthorityAddress: recipient, senderAddress: A.solana, affiliateFeePercent: 0,
  };
}
function gasParams(toChain, recipient, nativeDecimal) {
  return {
    srcChainId: debridgeChainId("solana"), srcChainTokenIn: usdcOn("solana"), srcChainTokenInAmount: "auto",
    dstChainId: debridgeChainId(toChain), dstChainTokenOut: nativeSentinel(toChain),
    dstChainTokenOutAmount: scaleDecimal(nativeDecimal, 18),
    dstChainTokenOutRecipient: recipient, srcChainOrderAuthorityAddress: A.solana,
    dstChainOrderAuthorityAddress: recipient, senderAddress: A.solana, affiliateFeePercent: 0,
  };
}
const LEGS = {
  "arb-usdc": { params: (a) => fundingParams("hyperliquid", A.hyperliquid, a), dest: () => erc20Bal("arbitrum", USDC_EVM.arbitrum, A.hyperliquid), unit: "USDC", dp: 6 },
  "poly-usdc": { params: (a) => fundingParams("polygon", A.polygon, a), dest: () => erc20Bal("polygon", USDC_EVM.polygon, A.polygon), unit: "USDC", dp: 6 },
  "arb-gas": { params: (a) => gasParams("hyperliquid", A.hyperliquid, a), dest: () => new EvmRpc({ net: "arbitrum" }).getBalanceWei(A.hyperliquid), unit: "ETH", dp: 18 },
  "poly-gas": { params: (a) => gasParams("polygon", A.polygon, a), dest: () => new EvmRpc({ net: "polygon" }).getBalanceWei(A.polygon), unit: "POL", dp: 18 },
};

async function bridge() {
  if (!arg || !arg2) throw new Error("usage: bridge <arb-usdc|poly-usdc|arb-gas|poly-gas> <amount> [--live]");
  const leg = LEGS[arg];
  if (!leg) throw new Error("unknown leg " + arg);
  const bridge = new DeBridgeBridge({ sourceAddressFor: (c) => (c === "solana" ? A.solana : c === "hyperliquid" ? A.hyperliquid : A.polygon) });

  const res = await bridge.createOrder(leg.params(arg2));
  const inTok = res.estimation?.srcChainTokenIn, outTok = res.estimation?.dstChainTokenOut;
  console.log(`order ${res.orderId}`);
  console.log(`  in ${(Number(inTok?.amount) / 1e6).toFixed(4)} USDC ($${inTok?.approximateUsdValue}) -> out ${outTok?.amount} ${leg.unit} ($${outTok?.approximateUsdValue}) | fixFee ${res.tx?.value} lamports`);

  const [tx] = buildSourceOrderTxs("solana", res); // single solanaTx (base64)

  // DRY proof 1: will our signer ACCEPT this tx? (single-signer + our fee payer)
  let signed;
  try {
    signed = signTransaction(tx.payload, getSolanaSigner());
    console.log("  sign: OK (single-signer, our fee payer) txid would be", signed.txid.slice(0, 16) + "…");
  } catch (e) {
    return void console.log("  sign: REJECTED —", e.message);
  }
  // DRY proof 2: does it simulate clean?
  const sim = await solRpc.simulate(signed.signedTxB64).catch((e) => ({ err: `sim fetch: ${e.message}` }));
  console.log("  simulate:", sim.err ? `ERR ${JSON.stringify(sim.err)}` : "OK (executable)");

  if (!LIVE) return void console.log("\nDRY RUN — re-run with --live to place the order.");
  if (sim.err) return void console.log("refusing to broadcast: sim failed.");

  const before = await leg.dest().catch(() => 0n);
  // deBridge's baked-in blockhash goes stale across the build round-trips; refresh
  // it to a current one right before signing so the source tx actually lands.
  const bh = await solRpc.getLatestBlockhash();
  const refreshed = refreshBlockhash(tx.payload, bh.blockhash);
  const sol = { kind: "solanaTx", chain: "solana", unsignedTxB64: refreshed, lastValidBlockHeight: bh.lastValidBlockHeight };
  console.log("\n>>> BROADCASTING SOURCE TX LIVE (fresh blockhash) <<<");
  const r = await signAndSend(sol, getSolanaSigner(), solRpc, { simulateFirst: true });
  console.log("  source:", { ok: r.ok, status: r.status, txid: r.txid });
  if (!r.ok) return void console.log("  source tx did not confirm; not polling fill.");
  console.log("  https://solscan.io/tx/" + r.txid);

  console.log("  polling deBridge fill + destination credit (up to 5 min)…");
  const deadline = Date.now() + 300_000;
  for (;;) {
    await sleep(10_000);
    const st = await bridge.status(res.orderId).catch((e) => ({ state: "err", note: e.message }));
    const now = await leg.dest().catch(() => before);
    const delta = now - before;
    console.log(`  [${new Date().toISOString().slice(11, 19)}] state=${st.state} destΔ=${fmt(delta, leg.dp)} ${leg.unit}`);
    if (delta > 0n) return void console.log(`\n  ✓ DELIVERED ${fmt(delta, leg.dp)} ${leg.unit} on destination.`);
    if (Date.now() > deadline) return void console.log("\n  timed out waiting for fill. Order is recoverable via DeBridgeBridge.recover(orderId) if stuck.");
  }
}

// ── Hyperliquid deposit: plain native-USDC transfer to Bridge2 on Arbitrum ──────
// Address verified against HL docs + Arbiscan. HL credits the SENDER's account in
// <1 min. HARD MINIMUM 5 USDC — below that HL keeps it (lost forever), so we refuse.
const HL_BRIDGE2 = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";
const HL_MIN_DEPOSIT = 5_000_000n; // 5 USDC base units

async function hlDeposit() {
  if (!arg) throw new Error("usage: hl-deposit <usdcAmount> [--live]");
  const amount = BigInt(Math.round(Number(arg) * 1e6));
  if (amount < HL_MIN_DEPOSIT) throw new Error(`HL minimum is 5 USDC; ${arg} would be LOST. Refusing.`);
  const usdc = USDC_EVM.arbitrum;
  const data = "0xa9059cbb" + HL_BRIDGE2.toLowerCase().replace(/^0x/, "").padStart(64, "0") + amount.toString(16).padStart(64, "0");
  const rpc = new EvmRpc({ net: "arbitrum" });
  const signer = getEvmSigner("hyperliquid");
  const bal = await erc20Bal("arbitrum", usdc, signer.address);
  console.log(`HL deposit: transfer ${arg} USDC from ${signer.address}`);
  console.log(`  USDC token : ${usdc}`);
  console.log(`  -> Bridge2 : ${HL_BRIDGE2}  (verified: HL docs + Arbiscan)`);
  console.log(`  Arbitrum USDC balance: ${fmt(bal, 6)}`);
  if (bal < amount) return void console.log("  insufficient USDC on Arbitrum. abort.");
  const pre = await rpc.callReadonly({ from: signer.address, to: usdc, data }).catch((e) => ({ err: e.message }));
  console.log("  eth_call precheck:", pre?.err ? `REVERT ${pre.err}` : "OK (transfer would succeed)");
  if (!LIVE) return void console.log("\nDRY RUN — re-run with --live to deposit.");
  if (pre?.err) return void console.log("refusing: precheck reverted.");
  console.log("\n>>> BROADCASTING HL DEPOSIT (first live EVM tx via the new broadcaster) <<<");
  const res = await signAndSendEvm({ to: usdc, data, value: 0n }, signer, rpc);
  console.log("  result:", { ok: res.ok, status: res.status, txHash: res.txHash, nonce: res.nonce, gasUsed: res.gasUsed?.toString() });
  if (res.txHash) console.log("  https://arbiscan.io/tx/" + res.txHash);
  if (res.ok) console.log("  HL should credit", signer.address, "within ~1 min. Check with: hl-status");
}

// ── Hyperliquid trade: small IOC perp via the adapter (signs locally, POST /exchange) ──
async function hlTrade() {
  const coin = (arg || "SOL").toUpperCase();
  const usd = arg2 || "12"; // notional USD (HL min order is $10)
  const hl = new HyperliquidAdapter({ mainnet: true }); // funds are on mainnet HL
  const r = await hl.resolveMarket("hl:" + coin);
  if (!r.ok) throw new Error("resolve: " + JSON.stringify(r.meta));
  const mid = Number(r.meta.mid);
  const worst = mid * 1.005; // IOC buy: pay up to 0.5% above mid so it fills
  console.log(`HL ${coin}: mid=$${mid} szDecimals=${r.meta.szDecimals} notional=$${usd} IOC-buy worst=$${worst.toFixed(4)} (mainnet=${r.meta.isMainnet})`);
  const intent = {
    venue: "hyperliquid", marketId: "hl:" + coin, side: "buy", amount: String(usd),
    amountKind: "collateral", worstPrice: String(worst), idempotencyKey: `hl-${coin}-open`,
  };
  const build = await hl.buildOpen(intent);
  console.log("  signed action:", JSON.stringify(build.action), "| nonce", build.nonce);
  if (!LIVE) return void console.log("\nDRY RUN — built + signed, NOT submitted. Re-run with --live.");
  console.log("\n>>> SUBMITTING HL ORDER LIVE <<<");
  const res = await hl.submit(build);
  console.log("  result:", JSON.stringify(res, null, 2));
}

// ── Hyperliquid close: reduceOnly IOC sell of the open position ─────────────
async function hlClose() {
  const coin = (arg || "SOL").toUpperCase();
  const frac = arg2 || "1";
  const hl = new HyperliquidAdapter({ mainnet: true });
  const pos = await hl.state("hl:" + coin);
  if (!pos) return void console.log(`no open HL position for ${coin}.`);
  const r = await hl.resolveMarket("hl:" + coin);
  const mid = Number(r.meta.mid);
  const worst = pos.side === "buy" ? mid * 0.99 : mid * 1.01; // long->sell floor / short->buy ceil
  console.log(`HL close ${coin}: ${pos.side} ${pos.size} @ entry ${pos.avgPrice}, mid $${mid}, pnl ${pos.unrealizedPnlUsd}; closing frac ${frac} worst $${worst.toFixed(4)}`);
  const build = await hl.buildClose({ venue: "hyperliquid", marketId: "hl:" + coin, fraction: frac, worstPrice: String(worst), idempotencyKey: `hl-${coin}-close` });
  console.log("  action:", JSON.stringify(build.action));
  if (!LIVE) return void console.log("DRY — built+signed, not submitted. --live to send.");
  console.log("\n>>> SUBMITTING HL CLOSE LIVE <<<");
  const res = await hl.submit(build);
  console.log("  result:", JSON.stringify(res, null, 2));
}

// ── Hyperliquid withdraw: user-signed withdraw3 -> same address on Arbitrum ──
async function hlWithdraw() {
  const amt = arg || "4";
  const hl = new HyperliquidAdapter({ mainnet: true });
  const dest = getEvmSigner("hyperliquid").address;
  const before = await erc20Bal("arbitrum", USDC_EVM.arbitrum, dest).catch(() => 0n);
  console.log(`HL withdraw ${amt} USDC -> ${dest} on Arbitrum ($1 HL fee, ~5min). Arbitrum USDC before: ${fmt(before, 6)}`);
  if (!LIVE) {
    const { action, signature } = signWithdraw({ signer: getEvmSigner("hyperliquid"), destination: dest, amount: amt, time: Date.now(), isMainnet: true });
    console.log("  signed action:", JSON.stringify(action), "| sig.v", signature.v);
    return void console.log("DRY — built+signed, not submitted. --live to withdraw.");
  }
  console.log("\n>>> SUBMITTING HL WITHDRAW LIVE <<<");
  const res = await hl.withdraw(amt, dest);
  console.log("  result:", JSON.stringify(res));
  if (!res.posted) return void console.log("  withdraw REJECTED by HL.");
  console.log("  accepted by HL. Polling Arbitrum for arrival (up to 6 min)…");
  const deadline = Date.now() + 360_000;
  for (;;) {
    await sleep(20_000);
    const now = await erc20Bal("arbitrum", USDC_EVM.arbitrum, dest).catch(() => before);
    const d = now - before;
    console.log(`  [${new Date().toISOString().slice(11, 19)}] Arbitrum USDC Δ=${fmt(d, 6)}`);
    if (d > 0n) return void console.log(`\n  ✓ ${fmt(d, 6)} USDC arrived on Arbitrum — HL withdraw works.`);
    if (Date.now() > deadline) return void console.log("\n  not arrived yet (HL withdraws ~5min); re-check later.");
  }
}

// ── HyperCore -> HyperEVM bridge test (the cheap-exit first hop) ─────────────
// Moves USDC perp->spot (usdClassTransfer), then spotSend to USDC's system address
// (0x2000...0000) to credit HyperEVM. Settles the 2-USDC question: check afterward
// which HyperEVM token got credited (HyperCore-linked 0x6b9e7731 vs Circle-native
// 0xb88339CB). usage: hl-to-evm <amt> [--live]. (Read HyperEVM balances via curl;
// node can't reach rpc.hyperliquid.xyz in this sandbox.)
async function hlToEvm() {
  const amt = arg || "2";
  const { signUsdClassTransfer, signSpotSend, hyperCoreSystemAddress } = await import("../dist/adapters/hl-signing.js");
  const { postExchange, HL_MAINNET } = await import("../dist/adapters/hl-transport.js");
  const signer = getEvmSigner("hyperliquid");
  const USDC_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"; // name:tokenId from spotMeta
  const SYS = hyperCoreSystemAddress(0); // USDC = token index 0
  console.log(`HyperCore->HyperEVM | HL ${signer.address} | spotSend ${amt} USDC -> system ${SYS}`);
  if (!LIVE) {
    const u = signUsdClassTransfer({ signer, amount: amt, toPerp: false, nonce: Date.now(), isMainnet: true });
    const s = signSpotSend({ signer, destination: SYS, token: USDC_TOKEN, amount: amt, time: Date.now(), isMainnet: true });
    console.log("  usdClassTransfer:", JSON.stringify(u.action));
    console.log("  spotSend       :", JSON.stringify(s.action));
    return void console.log("DRY — --live to execute.");
  }
  const post = (signed) => postExchange({ action: signed.action, nonce: signed.nonce, signature: signed.signature, vaultAddress: null }, { host: HL_MAINNET });
  const toSpot = (Number(amt) + 0.2).toFixed(2);
  console.log(`\n>>> usdClassTransfer perp->spot ${toSpot} <<<`);
  let r = await post(signUsdClassTransfer({ signer, amount: toSpot, toPerp: false, nonce: Date.now(), isMainnet: true }));
  console.log("   ", JSON.stringify({ posted: r.posted, status: r.status, error: r.error, raw: r.raw }));
  if (!r.posted) return void console.log("  STOP: perp->spot rejected.");
  await sleep(3000);
  console.log(`\n>>> spotSend ${amt} USDC -> HyperEVM (system ${SYS}) <<<`);
  r = await post(signSpotSend({ signer, destination: SYS, token: USDC_TOKEN, amount: amt, time: Date.now(), isMainnet: true }));
  console.log("   ", JSON.stringify({ posted: r.posted, status: r.status, error: r.error, raw: r.raw }));
  console.log("\nNow check which HyperEVM token got credited (curl rpc.hyperliquid.xyz/evm balanceOf for the HL address):");
  console.log("  linked 0x6b9e7731… (spotMeta) vs Circle-native 0xb88339CB… (CCTP-burnable)");
}

// ── HYPE-gas bootstrap: buy HYPE on HL spot + spotSend it to HyperEVM as native
// gas, so the HyperEVM address can pay for a CCTP burn (the cheap-exit second hop).
// usdClassTransfer perp<->spot. usage: hl-usd-class <amt> [toperp]
async function hlUsdClass() {
  const amt = arg || "4";
  const toPerp = (arg2 || "").toLowerCase() === "toperp";
  const { signUsdClassTransfer } = await import("../dist/adapters/hl-signing.js");
  const { postExchange, HL_MAINNET } = await import("../dist/adapters/hl-transport.js");
  const signer = getEvmSigner("hyperliquid");
  console.log(`usdClassTransfer ${amt} USDC ${toPerp ? "spot->perp" : "perp->spot"}`);
  if (!LIVE) return void console.log("DRY — --live.");
  const u = signUsdClassTransfer({ signer, amount: amt, toPerp, nonce: Date.now(), isMainnet: true });
  const r = await postExchange({ action: u.action, nonce: u.nonce, signature: u.signature, vaultAddress: null }, { host: HL_MAINNET });
  console.log("  result:", JSON.stringify({ posted: r.posted, status: r.status, error: r.error, raw: r.raw }));
}

// Spot IOC buy of HYPE (asset 10107 = HYPE/USDC pair @107). usage: hl-buy-hype <hypeSize>
async function hlBuyHype() {
  const size = arg || "0.05";
  const { signL1Action } = await import("../dist/adapters/hl-signing.js");
  const { postExchange, HL_MAINNET, infoPost } = await import("../dist/adapters/hl-transport.js");
  const { floatToWire, roundPx } = await import("../dist/adapters/hyperliquid.js");
  const signer = getEvmSigner("hyperliquid");
  const mids = await infoPost({ type: "allMids" }, { host: HL_MAINNET });
  const mid = Number(mids["@107"]);
  const limit = roundPx(mid * 1.03, 2); // generous IOC buy limit (HYPE szDecimals 2)
  const order = { a: 10107, b: true, p: floatToWire(limit), s: floatToWire(Number(size)), r: false, t: { limit: { tif: "Ioc" } } };
  const action = { type: "order", orders: [order], grouping: "na" };
  const nonce = Date.now();
  const signature = signL1Action({ signer, action, nonce, vaultAddress: null, isMainnet: true });
  console.log(`spot BUY ${size} HYPE @ limit ${limit} (mid ${mid}) — spend ~$${(Number(size) * mid).toFixed(2)}`);
  if (!LIVE) return void console.log("DRY — --live.");
  const r = await postExchange({ action, nonce, signature, vaultAddress: null }, { host: HL_MAINNET });
  console.log("  result:", JSON.stringify({ posted: r.posted, status: r.status, error: r.error, raw: r.raw }));
}

// spotSend HYPE -> HyperEVM as NATIVE gas (HYPE's special system addr 0x2222...2222,
// NOT the 0x20+index formula — HYPE is the gas token). usage: hl-hype-to-evm <amt>
async function hlHypeToEvm() {
  const amt = arg || "0.04";
  const { signSpotSend } = await import("../dist/adapters/hl-signing.js");
  const { postExchange, HL_MAINNET } = await import("../dist/adapters/hl-transport.js");
  const signer = getEvmSigner("hyperliquid");
  const HYPE_TOKEN = "HYPE:0x0d01dc56dcaaca66ad901c959b4011ec"; // name:tokenId from spotMeta (index 150)
  const HYPE_SYS = "0x2222222222222222222222222222222222222222";
  console.log(`spotSend ${amt} HYPE -> HyperEVM native gas via ${HYPE_SYS}`);
  if (!LIVE) return void console.log("DRY — --live.");
  const s = signSpotSend({ signer, destination: HYPE_SYS, token: HYPE_TOKEN, amount: amt, time: Date.now(), isMainnet: true });
  const r = await postExchange({ action: s.action, nonce: s.nonce, signature: s.signature, vaultAddress: null }, { host: HL_MAINNET });
  console.log("  result:", JSON.stringify({ posted: r.posted, status: r.status, error: r.error, raw: r.raw }));
}

// ── HyperEVM -> Arbitrum CCTP burn (the cheap-exit SECOND hop; pays HYPE gas) ──
// approve + depositForBurn on HyperEVM (CCTP domain 19) -> Iris attestation ->
// receiveMessage on Arbitrum (domain 3). Inline like the `cctp` stage (HyperEVM
// isn't in cctp.ts's repo-Chain machinery yet). usage: hl-evm-cctp-out <amt> [--live]
async function hlEvmCctpOut() {
  const amt = arg || "2";
  const amountBase = BigInt(Math.round(Number(amt) * 1e6));
  const signer = getEvmSigner("hyperliquid"); // same key on HyperEVM + Arbitrum
  const heRpc = new EvmRpc({ net: "hyperevm" });
  const arbRpc = new EvmRpc({ net: "arbitrum" });
  const TMv2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
  const MTv2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
  const USDC_HE = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
  const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const Z32 = "0x" + "00".repeat(32);
  const recipient32 = "0x000000000000000000000000" + signer.address.slice(2).toLowerCase();
  const DFB_ABI = [{ name: "depositForBurn", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" }, { name: "minFinalityThreshold", type: "uint32" }], outputs: [] }];
  const RECV_ABI = [{ name: "receiveMessage", type: "function", stateMutability: "nonpayable", inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }], outputs: [{ type: "bool" }] }];
  const appr = (spender, a) => "0x095ea7b3" + spender.slice(2).toLowerCase().padStart(64, "0") + a.toString(16).padStart(64, "0");
  const bal = async (rpc, tok, who) => BigInt(await rpc.callReadonly({ from: who, to: tok, data: "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0") }));

  const heUsdc = await bal(heRpc, USDC_HE, signer.address);
  const heHype = await heRpc.getBalanceWei(signer.address);
  console.log(`HyperEVM USDC ${fmt(heUsdc, 6)} | HYPE ${(Number(heHype) / 1e18).toFixed(4)} | burn ${amt} -> Arbitrum ${signer.address}`);
  if (heUsdc < amountBase) return void console.log("  insufficient HyperEVM USDC.");
  if (!LIVE) return void console.log("DRY — --live to burn.");

  console.log("\n>>> approve USDC->TokenMessenger (HyperEVM) <<<");
  let r = await signAndSendEvm({ to: USDC_HE, data: appr(TMv2, amountBase), value: 0n }, signer, heRpc);
  console.log("   ", { ok: r.ok, status: r.status, txHash: r.txHash }); if (!r.ok) return void console.log("  STOP: approve failed.");
  console.log("\n>>> depositForBurn (HyperEVM 19 -> Arbitrum 3, standard lane) <<<");
  const dfb = encodeFunctionData({ abi: DFB_ABI, functionName: "depositForBurn", args: [amountBase, 3, recipient32, USDC_HE, Z32, 0n, 2000] });
  r = await signAndSendEvm({ to: TMv2, data: dfb, value: 0n }, signer, heRpc);
  console.log("   ", { ok: r.ok, status: r.status, txHash: r.txHash }); if (!r.ok) return void console.log("  STOP: depositForBurn failed.");
  const burnHash = r.txHash;
  console.log("    burn:", burnHash);

  console.log("\n  polling Iris attestation (source domain 19)…");
  let msg, att;
  const deadline = Date.now() + 900_000;
  for (;;) {
    await sleep(12000);
    const j = await fetch(`https://iris-api.circle.com/v2/messages/19?transactionHash=${burnHash}`).then((x) => x.json()).catch((e) => ({ err: e.message }));
    const m = j?.messages?.[0];
    console.log(`  [${new Date().toISOString().slice(11, 19)}] iris=${m?.status ?? (j.err ? "err:" + j.err : "indexing")}`);
    if (m?.status === "complete" && m.attestation && m.attestation !== "PENDING" && m.message && m.message !== "0x") { msg = m.message; att = m.attestation; break; }
    if (Date.now() > deadline) return void console.log("  Iris timeout; re-poll later (burn hash above).");
  }

  const arbBefore = await bal(arbRpc, USDC_ARB, signer.address);
  console.log("\n>>> receiveMessage (Arbitrum) — mint (pays Arbitrum ETH) <<<");
  r = await signAndSendEvm({ to: MTv2, data: encodeFunctionData({ abi: RECV_ABI, functionName: "receiveMessage", args: [msg, att] }), value: 0n }, signer, arbRpc);
  console.log("   ", { ok: r.ok, status: r.status, txHash: r.txHash });
  if (r.txHash) console.log("    https://arbiscan.io/tx/" + r.txHash);
  const arbAfter = await bal(arbRpc, USDC_ARB, signer.address);
  console.log(`\n  ✓ Arbitrum USDC ${fmt(arbBefore, 6)} -> ${fmt(arbAfter, 6)} (+${fmt(arbAfter - arbBefore, 6)}) — HyperEVM->Arbitrum CCTP, gas paid in HYPE.`);
}

// ── Polymarket L2 CLOB cred derivation (createOrDeriveApiKey) ────────────────
// L1 ClobAuth EIP-712 (domain ClobAuthDomain v1 chainId 137, no verifyingContract)
// signed by the EOA -> L1 headers -> POST /auth/api-key (create) else GET
// /auth/derive-api-key. Returns {key,secret,passphrase}. NO funds move. These
// creds can read/cancel orders but NOT move funds (only the secp256k1 key signs
// spendable orders), so they're safe to hold/derive inline.
async function deriveClobCreds() {
  const signer = getEvmSigner("polymarket");
  const ts = Math.floor(Date.now() / 1000).toString();
  const digest = hashTypedData({
    domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
    types: {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "ClobAuth",
    message: { address: signer.address, timestamp: ts, nonce: 0n, message: "This message attests that I control the given wallet" },
  });
  const sig = "0x" + Buffer.from(signer.signDigest(hexToBytes(digest))).toString("hex");
  const headers = { POLY_ADDRESS: signer.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: ts, POLY_NONCE: "0" };
  const hit = async (method, path) => {
    const r = await fetch(`${CLOB_HOST}${path}`, { method, headers });
    return r.json().catch(() => ({}));
  };
  let j = await hit("POST", "/auth/api-key");
  if (!j?.apiKey) j = await hit("GET", "/auth/derive-api-key");
  if (!j?.apiKey) throw new Error("PM cred derivation failed: " + JSON.stringify(j));
  return { key: j.apiKey, secret: j.secret, passphrase: j.passphrase, address: signer.address };
}

async function pmCreds() {
  const c = await deriveClobCreds();
  console.log("PM L2 creds OK for", c.address);
  console.log("  apiKey    :", c.key);
  console.log("  secret    :", c.secret ? `received (${c.secret.length} chars, kept off-transcript)` : "MISSING");
  console.log("  passphrase:", c.passphrase ? "received" : "MISSING");
}

// ── Polymarket enable: wrap native USDC -> pUSD + scoped pUSD approvals ──────
// BUY-only by default (skips the SELL-side CTF setApprovalForAll; pass --ctf to
// include). Broadcast IN ORDER via the EVM broadcaster, which eth_call-prechecks
// each tx — so the native-USDC wrap (the one unverified bit) is caught AFTER the
// approve lands, without wasting gas, if CollateralOnramp rejects native USDC.
async function pmEnable() {
  const budget = arg || "3.9"; // pUSD budget == native USDC to wrap
  const eoa = getEvmSigner("polymarket").address;
  const wrapAsset = process.argv.includes("--native") ? "native" : "usdce"; // CollateralOnramp wraps USDC.e
  const txs = buildEnableTradingTxs({
    eoa, collateralBudget: budget, wrapUsdce: budget, wrapAsset,
    includeCtfApprovals: process.argv.includes("--ctf"),
  });
  console.log(`PM enable for ${eoa}: ${txs.length} txs (wrap ${budget} ${wrapAsset} -> pUSD; pUSD approvals scoped to ${budget})`);
  txs.forEach((t, i) => console.log(`  ${i + 1}. ${t.label} -> ${t.to}`));
  if (!LIVE) return void console.log("\nDRY — sequence above. The wrap is validated live (after its approve). Re-run with --live.");
  const rpc = new EvmRpc({ net: "polygon" });
  const signer = getEvmSigner("polymarket");
  for (const t of txs) {
    console.log(`\n>>> ${t.label} <<<`);
    const res = await signAndSendEvm({ to: t.to, data: t.data, value: 0n }, signer, rpc);
    console.log("   ", { ok: res.ok, status: res.status, txHash: res.txHash, nonce: res.nonce, gasUsed: res.gasUsed?.toString() });
    if (res.txHash) console.log("    https://polygonscan.com/tx/" + res.txHash);
    if (!res.ok) return void console.log(`\n  STOP: ${t.label} failed (${res.status}); not continuing.`);
  }
  console.log("\n✓ Polymarket enable complete — pUSD wrapped + approvals set. open_position can now settle.");
}

// ── Polymarket DEPOSIT-WALLET enable (the DEFAULT path) — drives the REAL enabler ─
// the enable_venue tool uses: gasless deploy + approve via the relayer, then (when
// STARLING_PM_FUND_USDC is set) auto-wrap the EOA's bridged USDC -> pUSD STRAIGHT
// into the DW. EXECUTES (no dry mode inside the enabler: deploy/approve are gasless;
// the fund swap+wrap are small EOA txs that pay POL). Needs the builder relayer creds
// (STARLING_PM_BUILDER_*) + a little POL on the EOA for the fund leg.
async function enableDw() {
  const { makeRealVenueEnabler } = await import("../dist/adapters/venue-enabler.js");
  const eoa = getEvmSigner("polymarket").address;
  const { deriveDepositWalletUUPS } = await import("../dist/adapters/polymarket-deposit-wallet.js");
  console.log(`enable_venue(polymarket) | EOA ${eoa} -> DW ${deriveDepositWalletUUPS(eoa)}`);
  console.log(`  STARLING_PM_FUND_USDC=${process.env.STARLING_PM_FUND_USDC ?? "(unset → deploy+approve only)"}`);
  if (!LIVE) return void console.log("\nDRY — this stage EXECUTES (gasless deploy/approve + EOA-signed fund). Re-run with --live.");
  console.log("\n>>> RUNNING REAL enable_venue(polymarket) LIVE <<<");
  const r = await makeRealVenueEnabler().enable("polymarket");
  console.log(JSON.stringify(r, null, 2));
}

// ── Polygon native-USDC -> USDC.e via Uniswap V3 (CollateralOnramp needs USDC.e) ──
const USDCE_POLY = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const UNI_ROUTER02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // Uniswap V3 SwapRouter02
const EXACT_INPUT_SINGLE_ABI = [{
  name: "exactInputSingle", type: "function", stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
    { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" },
    { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }],
  outputs: [{ name: "amountOut", type: "uint256" }],
}];

async function polySwap() {
  const amt = arg || "3.9";
  const amountIn = BigInt(Math.round(Number(amt) * 1e6));
  const minOut = (amountIn * 995n) / 1000n; // 0.5% floor; deep ~1:1 stable pool
  const NATIVE = USDC_EVM.polygon;
  const eoa = getEvmSigner("polymarket").address;
  const rpc = new EvmRpc({ net: "polygon" });
  const signer = getEvmSigner("polymarket");
  const approveData = "0x095ea7b3" + UNI_ROUTER02.slice(2).padStart(64, "0") + amountIn.toString(16).padStart(64, "0");
  const swapData = encodeFunctionData({
    abi: EXACT_INPUT_SINGLE_ABI, functionName: "exactInputSingle",
    args: [{ tokenIn: NATIVE, tokenOut: USDCE_POLY, fee: 100, recipient: eoa, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  });
  const steps = [
    { label: "approve-native->router", to: NATIVE, data: approveData },
    { label: "swap-native->usdce", to: UNI_ROUTER02, data: swapData },
  ];
  console.log(`poly-swap ${amt} native USDC -> USDC.e (Uni V3 0.01% pool), minOut ${(Number(minOut) / 1e6).toFixed(4)}`);
  if (!LIVE) { steps.forEach((s) => console.log("  " + s.label + " -> " + s.to)); return void console.log("DRY — --live to execute."); }
  const before = await erc20Bal("polygon", USDCE_POLY, eoa).catch(() => 0n);
  for (const s of steps) {
    console.log(`\n>>> ${s.label} <<<`);
    const res = await signAndSendEvm({ to: s.to, data: s.data, value: 0n }, signer, rpc);
    console.log("   ", { ok: res.ok, status: res.status, txHash: res.txHash, nonce: res.nonce });
    if (res.txHash) console.log("    https://polygonscan.com/tx/" + res.txHash);
    if (!res.ok) return void console.log("  STOP: " + s.label + " failed.");
  }
  const after = await erc20Bal("polygon", USDCE_POLY, eoa).catch(() => 0n);
  console.log(`\n✓ USDC.e: ${fmt(before, 6)} -> ${fmt(after, 6)} (+${fmt(after - before, 6)})`);
}

// ── Polymarket trade: FAK BUY via the adapter, posted with L2 creds ──────────
async function pmTrade() {
  const tokenId = arg;
  const usd = arg2 || "2";
  if (!tokenId) throw new Error("usage: pm-trade <tokenId> <usd> [--live]");
  const creds = await deriveClobCreds();
  const r = await polymarketAdapter.resolveMarket("pm:" + tokenId);
  if (!r.ok) throw new Error("resolve: " + JSON.stringify(r.meta));
  if (r.meta.negRisk) throw new Error("market is negRisk — needs negRiskExchange approval (not set). Pick a standard market.");
  const book = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`).then((x) => x.json());
  const asks = (book.asks || []).map((a) => Number(a.price)).filter((p) => p > 0);
  if (!asks.length) throw new Error("no asks in book");
  const bestAsk = Math.min(...asks);
  const tick = Number(r.meta.tickSize);
  const worst = Math.min(Number((bestAsk + 2 * tick).toFixed(4)), 1 - tick);
  console.log(`PM ${tokenId.slice(0, 12)}… negRisk=${r.meta.negRisk} tick=${tick} bestAsk=${bestAsk} -> worstPrice=${worst} | FAK buy $${usd}`);
  const intent = {
    venue: "polymarket", marketId: "pm:" + tokenId, side: "buy", amount: String(usd),
    amountKind: "collateral", worstPrice: String(worst), idempotencyKey: `pm-${tokenId.slice(0, 10)}`,
  };
  const build = await polymarketAdapter.buildOpen(intent);
  console.log("  order:", { maker: build.orderStruct.maker, makerAmount: build.orderStruct.makerAmount, takerAmount: build.orderStruct.takerAmount, side: build.orderStruct.side, exchange: build.verifyingContract });
  if (!LIVE) return void console.log("\nDRY — built + signed, NOT posted. Re-run with --live.");
  console.log("\n>>> POSTING PM ORDER LIVE <<<");
  const res = await postOrder(creds, creds.address, { order: build.orderStruct, owner: creds.key, orderType: "FAK" }, { host: CLOB_HOST });
  console.log("  result:", JSON.stringify({ ok: res.ok, orderID: res.orderID, status: res.status, error: res.error, txHashes: res.transactionHashes }, null, 2));
}

// ── Generic mesh bridge: USDC between ANY of solana/polygon/arbitrum ─────────
// Full round-trip enabler: a wallet on one chain can push funds out to a venue
// chain and pull them back home. Solana-source signs+sends via solana-broadcast
// (blockhash refreshed); EVM-source ([approve, create]) via the EVM broadcaster
// (the create carries deBridge's native fixFee as value: 0.5 POL / 0.001 ETH).
const CHAINS = { solana: { repo: "solana" }, polygon: { repo: "polygon", net: "polygon" }, arbitrum: { repo: "hyperliquid", net: "arbitrum" } };
const chainAddr = (n) => (n === "solana" ? A.solana : n === "polygon" ? A.polygon : A.hyperliquid);
const destUsdcBal = async (n) => {
  if (n === "solana") { const t = await solRpc.getTokenBalance(A.solana, USDC_MINT); return BigInt(t?.amount ?? 0); }
  const net = n === "polygon" ? "polygon" : "arbitrum";
  return erc20Bal(net, USDC_EVM[net], chainAddr(n));
};

async function route() {
  const from = arg, to = arg2, amt = arg3 || "3";
  if (!CHAINS[from] || !CHAINS[to] || from === to) throw new Error("usage: route <solana|polygon|arbitrum> <to> <amountUSDC> [--live]");
  const F = CHAINS[from];
  const bridge = new DeBridgeBridge({ sourceAddressFor: (c) => (c === "solana" ? A.solana : c === "hyperliquid" ? A.hyperliquid : A.polygon) });
  const params = {
    srcChainId: debridgeChainId(F.repo), srcChainTokenIn: usdcOn(F.repo), srcChainTokenInAmount: scaleDecimal(amt, 6),
    dstChainId: debridgeChainId(CHAINS[to].repo), dstChainTokenOut: usdcOn(CHAINS[to].repo), dstChainTokenOutAmount: "auto",
    dstChainTokenOutRecipient: chainAddr(to), srcChainOrderAuthorityAddress: chainAddr(from),
    dstChainOrderAuthorityAddress: chainAddr(to), senderAddress: chainAddr(from), affiliateFeePercent: 0,
  };
  const res = await bridge.createOrder(params);
  const o = res.estimation?.dstChainTokenOut;
  console.log(`route ${from}->${to} ${amt} USDC -> out ${(Number(o?.amount) / 1e6).toFixed(4)} ${o?.symbol} | order ${res.orderId} | fixFee ${res.tx?.value ?? "(in solana tx)"}`);
  const txs = buildSourceOrderTxs(F.repo, res);
  console.log("  srcTxs:", txs.map((t) => `${t.label}/${t.kind}`).join(", "));
  if (!LIVE) return void console.log("DRY — --live to execute.");
  const before = await destUsdcBal(to).catch(() => 0n);
  if (from === "solana") {
    const bh = await solRpc.getLatestBlockhash();
    const refreshed = refreshBlockhash(txs[0].payload, bh.blockhash);
    console.log("\n>>> SOURCE (solana) <<<");
    const r = await signAndSend({ kind: "solanaTx", chain: "solana", unsignedTxB64: refreshed, lastValidBlockHeight: bh.lastValidBlockHeight }, getSolanaSigner(), solRpc, { simulateFirst: true });
    console.log("   ", { ok: r.ok, status: r.status, txid: r.txid });
    if (!r.ok) return void console.log("  source failed; abort.");
  } else {
    const signer = from === "polygon" ? getEvmSigner("polymarket") : getEvmSigner("hyperliquid");
    const rpc = new EvmRpc({ net: F.net });
    for (const t of txs) {
      const p = t.payload;
      const value = p.value ? BigInt(p.value) : 0n;
      console.log(`\n>>> ${t.label} (value ${value} wei) <<<`);
      const r = await signAndSendEvm({ to: p.to, data: p.data, value }, signer, rpc);
      console.log("   ", { ok: r.ok, status: r.status, txHash: r.txHash, nonce: r.nonce });
      if (r.txHash) console.log("    " + (F.net === "polygon" ? "https://polygonscan.com/tx/" : "https://arbiscan.io/tx/") + r.txHash);
      if (!r.ok) return void console.log("  STOP: " + t.label + " " + r.status);
    }
  }
  console.log("\n  polling fill + destination credit (up to 5 min)…");
  const deadline = Date.now() + 300_000;
  for (;;) {
    await sleep(10_000);
    const st = await bridge.status(res.orderId).catch(() => ({ state: "err" }));
    const delta = (await destUsdcBal(to).catch(() => before)) - before;
    console.log(`  [${new Date().toISOString().slice(11, 19)}] state=${st.state} destΔ=${(Number(delta) / 1e6).toFixed(4)} USDC`);
    if (delta > 0n) return void console.log(`\n  ✓ DELIVERED ${(Number(delta) / 1e6).toFixed(4)} USDC on ${to}.`);
    if (Date.now() > deadline) return void console.log("\n  timed out (order recoverable via DeBridgeBridge.recover).");
  }
}

// ── CCTP: burn-and-mint USDC across EVM chains (the cheap EVM<->EVM rail) ────
// ~1:1 (no solver haircut), cost = gas on BOTH ends + (Fast lane only) a tiny
// Circle fee. Flow: [approve, depositForBurn] on source -> poll Iris attestation
// -> receiveMessage (mint) on dest. Standard lane = free + hard finality (slower);
// --fast = seconds + a per-corridor fee + reorg-exposed.
async function cctp() {
  const from = arg, to = arg2, amt = arg3 || "0.1";
  const EVM = ["polygon", "arbitrum"];
  if (!EVM.includes(from) || !EVM.includes(to) || from === to) throw new Error("usage: cctp <polygon|arbitrum> <polygon|arbitrum> <amountUSDC> [--live] [--fast]");
  const lane = process.argv.includes("--fast") ? "fast" : "standard";
  const repo = (n) => (n === "polygon" ? "polygon" : "hyperliquid");
  const route = { fromChain: repo(from), toChain: repo(to), token: "USDC", amount: amt, recipient: chainAddr(to), lane };
  const preBurn = await cctpPreBurnBalance(route);
  let flightId = flightIdForRoute(route, preBurn);
  const burnTxs = await cctpBridge.buildBridgeIn(route);
  console.log(`CCTP ${from}->${to} ${amt} USDC | lane ${lane} | recipient ${chainAddr(to)} | preBurnBal ${(Number(preBurn) / 1e6).toFixed(4)}`);
  console.log("  burn:", burnTxs.map((t) => t.label).join(" + "));
  if (!LIVE) return void console.log("DRY — burn+attest+mint, gas on both ends. --live to execute.");
  const srcSigner = from === "polygon" ? getEvmSigner("polymarket") : getEvmSigner("hyperliquid");
  const srcRpc = new EvmRpc({ net: from });
  const exp = (n) => (n === "polygon" ? "https://polygonscan.com/tx/" : "https://arbiscan.io/tx/");
  let burnHash;
  for (const t of burnTxs) {
    console.log(`\n>>> ${t.label} (on ${from}) <<<`);
    const r = await signAndSendEvm({ to: t.payload.to, data: t.payload.data, value: 0n }, srcSigner, srcRpc);
    console.log("   ", { ok: r.ok, status: r.status, txHash: r.txHash, nonce: r.nonce });
    if (r.txHash) console.log("    " + exp(from) + r.txHash);
    if (!r.ok) return void console.log("  STOP: " + t.label + " " + r.status);
    if (t.label === "depositForBurn") burnHash = r.txHash;
  }
  flightId = bindBurnHash(flightId, burnHash);
  console.log("\n  burn done. Polling Iris attestation, then minting on " + to + "…");
  const dstSigner = to === "polygon" ? getEvmSigner("polymarket") : getEvmSigner("hyperliquid");
  const dstRpc = new EvmRpc({ net: to });
  const deadline = Date.now() + 900_000;
  let submitted = false;
  for (;;) {
    await sleep(15_000);
    const st = await cctpBridge.status(flightId).catch((e) => ({ state: "err", note: e.message }));
    console.log(`  [${new Date().toISOString().slice(11, 19)}] state=${st.state}`);
    if (st.state === "ready") return void console.log("\n  ✓ MINTED on " + to + " (proven via usedNonces). CCTP round complete.");
    if (st.state === "mint_pending" && !submitted) {
      try {
        const [recv] = await cctpBridge.recover(route, flightId);
        console.log("  attested → submitting receiveMessage (mint) on " + to);
        const r = await signAndSendEvm({ to: recv.payload.to, data: recv.payload.data, value: 0n }, dstSigner, dstRpc);
        console.log("   receiveMessage:", { ok: r.ok, status: r.status, txHash: r.txHash });
        if (r.txHash) console.log("    " + exp(to) + r.txHash);
        if (r.ok) submitted = true;
      } catch (e) { console.log("  recover not ready:", String(e.message).slice(0, 90)); }
    }
    if (Date.now() > deadline) return void console.log("\n  timed out; flightId for later: " + flightId);
  }
}

// ── Auto-router: CCTP when both legs are EVM + dest has mint-gas, else deBridge ──
// So the bot never picks the rail. CCTP = ~1:1 (gas both ends); deBridge = solver
// delivers (no dest gas needed) but takes a haircut + a source fixFee. Delegates
// to cctp()/route() which read the same arg/arg2/arg3 globals.
const destNativeGas = async (n) => {
  if (n === "solana") return Number(await solRpc.getBalanceLamports(A.solana)) / 1e9;
  const net = n === "polygon" ? "polygon" : "arbitrum";
  return Number(await new EvmRpc({ net }).getBalanceWei(chainAddr(n))) / 1e18;
};

async function transfer() {
  const from = arg, to = arg2;
  if (!CHAINS[from] || !CHAINS[to] || from === to) throw new Error("usage: transfer <from> <to> <amountUSDC> [--live] [--fast]");
  const EVM = ["polygon", "arbitrum"];
  if (EVM.includes(from) && EVM.includes(to)) {
    const gas = await destNativeGas(to);
    const need = to === "polygon" ? 0.1 : 0.0003; // enough for the CCTP receiveMessage
    const useCctp = gas >= need;
    console.log(`transfer ${from}->${to}: both-EVM; dest ${to} gas=${gas.toFixed(5)} (need ${need}) -> ${useCctp ? "CCTP (~1:1, gas both ends)" : "deBridge (dest lacks mint-gas; solver delivers)"}`);
    return useCctp ? cctp() : route();
  }
  console.log(`transfer ${from}->${to}: Solana leg -> deBridge (CCTP Solana is Stage-2)`);
  return route();
}

// ── Polymarket NATIVE withdraw via bridge.polymarket.com — GASLESS, no deBridge ──
// Transfer pUSD from the DW to the bridge's routing address via the relayer; the
// bridge unwraps pUSD->USDC and delivers to Solana. The whole thing is EVM-side +
// gasless (no POL, no unwrap/swap, no deBridge haircut). usage: pm-bridge-withdraw
// <pUSDamount> [solanaRecipient] [--live]. Solana min is $2.
async function pmBridgeWithdraw() {
  const amt = arg || "2";
  const toAddr = arg2 || A.solana; // default: our own Solana wallet
  const { PolymarketBridge, PM_SOLANA_CHAIN_ID, SOLANA_USDC_MINT } = await import("../dist/adapters/polymarket-bridge.js");
  const { deriveDepositWalletUUPS } = await import("../dist/adapters/polymarket-deposit-wallet.js");
  const { PolymarketRelayer, builderCredsFromEnv, buildTransferPusdCall, PUSD } = await import("../dist/adapters/polymarket-relayer.js");
  const signer = getEvmSigner("polymarket");
  const dw = deriveDepositWalletUUPS(signer.address);
  const dwPusd = await erc20Bal("polygon", PUSD, dw);
  console.log(`PM native withdraw: ${amt} pUSD from DW ${dw} -> ${toAddr} (Solana) | DW pUSD: ${fmt(dwPusd, 6)}`);
  const bridge = new PolymarketBridge();
  const addrs = await bridge.getWithdrawAddress({ dwAddress: dw, toChainId: PM_SOLANA_CHAIN_ID, toTokenAddress: SOLANA_USDC_MINT, recipientAddr: toAddr });
  console.log(`  bridge routing address (Polygon): ${addrs.evm}`);
  if (!LIVE) return void console.log("\nDRY — would relayer-transfer pUSD to the bridge addr (gasless). --live to execute.");
  const creds = builderCredsFromEnv();
  if (!creds) throw new Error("no builder creds (STARLING_PM_BUILDER_*)");
  const relayer = new PolymarketRelayer({ creds });
  const amountRaw = BigInt(Math.round(Number(amt) * 1e6));
  const solBefore = BigInt((await solRpc.getTokenBalance(toAddr, USDC_MINT).catch(() => null))?.amount ?? 0);
  console.log(`  Solana USDC before: ${fmt(solBefore, 6)}`);
  console.log("\n>>> RELAYER TRANSFER pUSD DW->bridge (gasless) <<<");
  const sub = await relayer.submitBatch(signer, dw, [buildTransferPusdCall(addrs.evm, amountRaw)], Math.floor(Date.now() / 1000) + 1800);
  const hash = await relayer.waitMined(sub.transactionID);
  console.log("  https://polygonscan.com/tx/" + hash);
  console.log("  polling Solana for bridge delivery (up to 5 min)…");
  const deadline = Date.now() + 300_000;
  for (;;) {
    await sleep(10_000);
    const now = BigInt((await solRpc.getTokenBalance(toAddr, USDC_MINT).catch(() => null))?.amount ?? 0);
    const d = now - solBefore;
    console.log(`  [${new Date().toISOString().slice(11, 19)}] Solana USDC Δ=${fmt(d, 6)}`);
    if (d > 0n) return void console.log(`\n  ✓ DELIVERED ${fmt(d, 6)} USDC to Solana — gasless, no deBridge.`);
    if (Date.now() > deadline) return void console.log("\n  not delivered yet; the bridge can take a few minutes. Re-check Solana USDC.");
  }
}

const stages = { balances, swap, jup, bridge, "hl-deposit": hlDeposit, "hl-trade": hlTrade, "hl-close": hlClose, "hl-withdraw": hlWithdraw, "hl-to-evm": hlToEvm, "hl-usd-class": hlUsdClass, "hl-buy-hype": hlBuyHype, "hl-hype-to-evm": hlHypeToEvm, "hl-evm-cctp-out": hlEvmCctpOut, "pm-creds": pmCreds, "pm-enable": pmEnable, "enable-dw": enableDw, "poly-swap": polySwap, "pm-trade": pmTrade, "pm-bridge-withdraw": pmBridgeWithdraw, route, cctp, transfer };
if (!stages[stage]) { console.log("stages:", Object.keys(stages).join(", ")); process.exit(1); }
await stages[stage]();
