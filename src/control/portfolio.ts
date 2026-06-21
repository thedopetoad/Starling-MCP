// src/control/portfolio.ts
// Read-only portfolio snapshot for the dashboard: per-wallet balances (USDC +
// native gas), Hyperliquid account value + open perp positions + unrealized PnL,
// and aggregate totals. Pure reads against public RPC + the HL info endpoint;
// every read is best-effort (returns 0 / null + a `partial` flag on failure) so a
// flaky RPC never crashes the heartbeat. Polled on a SLOW timer (see server.ts)
// and cached — never on the 1.5s control tick.
//
// Honest scope (v1, Analytics is a stated WIP):
//   - USDC is valued at $1. Hyperliquid accountValue is already USD.
//   - Native SOL/MATIC are reported as AMOUNTS (gas), left unpriced (usd:null).
//   - Positions: Hyperliquid perps (enumerable via clearinghouseState). Polymarket
//     and Jupiter positions need per-market ids to enumerate and are deferred.
import { EvmRpc } from "../adapters/evm-rpc.js";
import { SolanaRpc, associatedTokenAddress } from "../adapters/solana-rpc.js";
import { USDC_MINT } from "../adapters/jupiter.js";
import { usdcOn } from "../bridge/debridge.js";
import { infoPost, HL_MAINNET, HL_TESTNET } from "../adapters/hl-transport.js";
import type { Chain } from "../adapters/types.js";

export interface PortfolioPosition {
  venue: string;
  marketId: string;
  side: "buy" | "sell";
  size: string;
  entryPrice: string;
  valueUsd: number;
  unrealizedPnlUsd: number;
}

export interface WalletState {
  chain: Chain;
  address: string;
  /** Native gas token (SOL / MATIC). Unpriced in v1 — usd is null. */
  native: { symbol: string; amount: number; usd: number | null };
  /** USDC balance (valued 1:1). */
  usdc: number;
  /** USD value attributable to this wallet (USDC + venue account value). */
  valueUsd: number;
  /** True if any read for this wallet failed and the numbers may be incomplete. */
  partial: boolean;
}

export interface Portfolio {
  ts: string;
  wallets: WalletState[];
  positions: PortfolioPosition[];
  totalValueUsd: number;
  unrealizedPnlUsd: number;
  /** v1 pricing caveat surfaced to the UI. */
  pricingNote: string;
  /** True if ANY read failed (the dashboard can show a "stale/partial" hint). */
  partial: boolean;
}

type Addrs = Partial<Record<Chain, string>>;

/** Per-read timeout so one stalled endpoint (the public Solana RPC is notorious)
 *  can't hang the whole refresh. Rejects after `ms` so the caller's catch marks
 *  the wallet partial and moves on. */
const READ_TIMEOUT_MS = 6_000;
const READ_ATTEMPTS = 3; // public RPCs (esp. Solana) rate-limit intermittently
function timed<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${READ_TIMEOUT_MS}ms`)), READ_TIMEOUT_MS).unref(),
    ),
  ]);
}

/** Retry a read a few times — `make` is a thunk so each attempt is a fresh call.
 *  Lets a flaky/rate-limited public RPC succeed within one poll instead of going
 *  `partial`. Throws the last error only after all attempts fail. */
async function timedRetry<T>(make: () => Promise<T>, label: string, attempts = READ_ATTEMPTS): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await timed(make(), label);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(`${label} failed`);
}

/** erc20 balanceOf(owner) via eth_call; returns decimal token units. 0 on error. */
async function erc20Balance(rpc: EvmRpc, token: string, owner: string, decimals: number): Promise<number> {
  const data = "0x70a08231" + owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const hex = await rpc.callReadonly({ from: owner, to: token, data });
  const raw = BigInt(hex && hex !== "0x" ? hex : "0x0");
  return Number(raw) / 10 ** decimals;
}

async function readSolana(address: string): Promise<WalletState> {
  const rpc = new SolanaRpc();
  let sol = 0,
    usdc = 0,
    partial = false;
  try {
    sol = Number(await timedRetry(() => rpc.getBalanceLamports(address), "sol getBalance")) / 1e9;
  } catch {
    partial = true;
  }
  try {
    // Light path: read the specific associated token account, not the heavy
    // getTokenAccountsByOwner (public RPCs rate-limit the latter hard).
    const ata = associatedTokenAddress(address, USDC_MINT);
    const t = await timedRetry(() => rpc.getTokenAccountBalance(ata), "sol USDC");
    usdc = t?.uiAmount ?? 0;
  } catch (e) {
    // A missing ATA just means zero USDC — not a read failure, so don't flag partial.
    if (/find account|could not find|account.*not.*exist/i.test(String((e as Error)?.message))) usdc = 0;
    else partial = true;
  }
  return {
    chain: "solana",
    address,
    native: { symbol: "SOL", amount: sol, usd: null },
    usdc,
    valueUsd: usdc,
    partial,
  };
}

async function readPolygon(address: string): Promise<WalletState> {
  const rpc = new EvmRpc({ net: "polygon" });
  let matic = 0,
    usdc = 0,
    partial = false;
  try {
    matic = Number(await timedRetry(() => rpc.getBalanceWei(address), "polygon native")) / 1e18;
  } catch {
    partial = true;
  }
  try {
    usdc = await timedRetry(() => erc20Balance(rpc, usdcOn("polygon"), address, 6), "polygon USDC");
  } catch {
    partial = true;
  }
  return {
    chain: "polygon",
    address,
    native: { symbol: "MATIC", amount: matic, usd: null },
    usdc,
    valueUsd: usdc,
    partial,
  };
}

/** Hyperliquid: perp account value + USDC + open perp positions, via the info API. */
async function readHyperliquid(
  address: string,
  host: string,
): Promise<{ wallet: WalletState; positions: PortfolioPosition[] }> {
  let accountValue = 0,
    spotUsdc = 0,
    unrealized = 0,
    partial = false;
  const positions: PortfolioPosition[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = await timedRetry(() => infoPost<any>({ type: "clearinghouseState", user: address }, { host }), "hl perp");
    accountValue = Number(cs?.marginSummary?.accountValue ?? 0);
    for (const ap of cs?.assetPositions ?? []) {
      const p = ap?.position;
      const szi = Number(p?.szi ?? 0);
      if (!szi) continue;
      const pnl = Number(p?.unrealizedPnl ?? 0);
      unrealized += pnl;
      positions.push({
        venue: "hyperliquid",
        marketId: `hl:${String(p?.coin)}`,
        side: szi > 0 ? "buy" : "sell",
        size: String(Math.abs(szi)),
        entryPrice: String(p?.entryPx ?? "0"),
        valueUsd: Number(p?.positionValue ?? 0),
        unrealizedPnlUsd: pnl,
      });
    }
  } catch {
    partial = true;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ss = await timedRetry(() => infoPost<any>({ type: "spotClearinghouseState", user: address }, { host }), "hl spot");
    const b = (ss?.balances ?? []).find((x: { coin?: string }) => String(x?.coin).toUpperCase() === "USDC");
    spotUsdc = Number(b?.total ?? 0);
  } catch {
    partial = true;
  }
  return {
    wallet: {
      chain: "hyperliquid",
      address,
      native: { symbol: "USDC", amount: 0, usd: null },
      usdc: spotUsdc,
      valueUsd: accountValue + spotUsdc,
      partial,
    },
    positions,
  };
}

/** Spot USD prices for native gas tokens (CoinGecko, no key). Best-effort: returns
 *  nulls on failure so the portfolio still renders (just without native USD). */
async function nativePrices(): Promise<{ SOL: number | null; MATIC: number | null }> {
  try {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=solana,matic-network&vs_currencies=usd";
    const res = await timed(fetch(url, { headers: { "User-Agent": "starling-dashboard" } }), "native prices");
    if (!res.ok) return { SOL: null, MATIC: null };
    const j = (await res.json()) as Record<string, { usd?: number }>;
    return { SOL: j.solana?.usd ?? null, MATIC: j["matic-network"]?.usd ?? null };
  } catch {
    return { SOL: null, MATIC: null };
  }
}

/**
 * Read the full portfolio for the loaded addresses. `network` selects the HL info
 * host (EVM/Solana RPC use their mainnet defaults). Best-effort: never throws.
 */
export async function readPortfolio(addrs: Addrs, network: string): Promise<Portfolio> {
  const hlHost = network === "mainnet" ? HL_MAINNET : HL_TESTNET;
  const wallets: WalletState[] = [];
  const positions: PortfolioPosition[] = [];

  const jobs: Promise<void>[] = [];
  if (addrs.solana) jobs.push(readSolana(addrs.solana).then((w) => void wallets.push(w)));
  if (addrs.polygon) jobs.push(readPolygon(addrs.polygon).then((w) => void wallets.push(w)));
  if (addrs.hyperliquid)
    jobs.push(
      readHyperliquid(addrs.hyperliquid, hlHost).then((r) => {
        wallets.push(r.wallet);
        positions.push(...r.positions);
      }),
    );
  const [prices] = await Promise.all([nativePrices(), Promise.all(jobs)]);

  // Price the native gas tokens (SOL/MATIC) into each wallet's USD value.
  let priced = true;
  for (const w of wallets) {
    const px = w.native.symbol === "SOL" ? prices.SOL : w.native.symbol === "MATIC" ? prices.MATIC : null;
    if (px != null && w.native.amount > 0) {
      w.native.usd = w.native.amount * px;
      w.valueUsd += w.native.usd;
    } else if (px == null && w.native.amount > 0 && w.native.symbol !== "USDC") {
      priced = false; // had native to value but no price
    }
  }

  // Stable chain order for the UI.
  const order: Chain[] = ["solana", "polygon", "hyperliquid"];
  wallets.sort((a, b) => order.indexOf(a.chain) - order.indexOf(b.chain));

  const totalValueUsd = wallets.reduce((s, w) => s + w.valueUsd, 0);
  const unrealizedPnlUsd = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
  const partial = wallets.some((w) => w.partial);

  return {
    ts: new Date().toISOString(),
    wallets,
    positions,
    totalValueUsd,
    unrealizedPnlUsd,
    pricingNote: priced
      ? "USDC=$1; native SOL/MATIC priced via CoinGecko; HL=accountValue. PM/Jupiter positions WIP"
      : "USDC=$1; HL=accountValue; native price unavailable this tick. PM/Jupiter positions WIP",
    partial,
  };
}
