// src/control/portfolio.ts
// Read-only portfolio snapshot for the dashboard: per-wallet balances (USDC +
// native gas), Hyperliquid account value + open perp positions + unrealized PnL,
// and aggregate totals. Pure reads against public RPC + the HL info endpoint;
// every read is best-effort (returns 0 / null + a `partial` flag on failure) so a
// flaky RPC never crashes the heartbeat. Polled on a SLOW timer (see server.ts)
// and cached — never on the 1.5s control tick.
//
// Scope:
//   - USDC = $1; Hyperliquid accountValue is already USD; native SOL/MATIC priced via CoinGecko.
//   - Solana SPL tokens (incl. tokens locked in open Jupiter orders) are enumerated
//     and priced via the keyless Jupiter token API, so the dashboard shows ALL holdings.
//   - Positions: Hyperliquid perps (via clearinghouseState). Polymarket positions
//     need per-market ids to enumerate and are deferred.
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

/** A non-USDC fungible token holding — an SPL token in the wallet, or one escrowed
 *  in an open Jupiter order. `usd` is null when no price was available this refresh. */
export interface TokenHolding {
  symbol: string;
  mint: string;
  amount: number;
  usd: number | null;
  location: "wallet" | "order";
}

export interface WalletState {
  chain: Chain;
  address: string;
  /** Native gas token (SOL / MATIC), priced via CoinGecko (usd null if unavailable). */
  native: { symbol: string; amount: number; usd: number | null };
  /** USDC balance (valued 1:1). */
  usdc: number;
  /** Non-USDC token holdings incl. tokens locked in open orders (Solana only in v1). */
  tokens?: TokenHolding[];
  /** USD value attributable to this wallet (USDC + tokens + native + venue value). */
  valueUsd: number;
  /** True if any read for this wallet failed and the numbers may be incomplete. */
  partial: boolean;
}

/** An open on-chain order (e.g. a Jupiter limit/trigger order). Display-only: its
 *  escrowed token value is already counted in the wallet's `tokens`, so it is NOT
 *  added to totals — this list just makes the resting order visible. */
export interface PortfolioOrder {
  venue: string;
  kind: string;
  orderId: string;
  description: string;
  inputSymbol: string;
  inputMint: string;
  makingAmount: number;
  outputSymbol: string;
  outputMint: string;
  takingAmount: number;
  limitPrice: number | null;
}

export interface Portfolio {
  ts: string;
  wallets: WalletState[];
  positions: PortfolioPosition[];
  /** Open on-chain orders (e.g. Jupiter limit orders). Informational, not in totals. */
  orders?: PortfolioOrder[];
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

// ── Jupiter helpers for full token visibility (keyless lite-api; best-effort) ──
const JUP_TOKEN_API = "https://lite-api.jup.ag/tokens/v2";
const JUP_TRIGGER_API = "https://lite-api.jup.ag/trigger/v1";

/** Symbol + live USD price for any SPL mint (Jupiter token search). Null on any
 *  failure so the portfolio still renders (the token just shows unpriced). */
async function jupTokenInfo(mint: string): Promise<{ symbol: string; usdPrice: number | null } | null> {
  try {
    const res = await timed(fetch(`${JUP_TOKEN_API}/search?query=${mint}`), `jup token ${mint.slice(0, 4)}`);
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ id: string; symbol?: string; usdPrice?: number }>;
    const hit = Array.isArray(arr) ? arr.find((t) => t.id === mint) : undefined;
    if (!hit) return null;
    return { symbol: hit.symbol || mint.slice(0, 4), usdPrice: typeof hit.usdPrice === "number" ? hit.usdPrice : null };
  } catch {
    return null;
  }
}

/** An open Jupiter trigger (limit) order in raw form (UI/decimal amounts). */
interface RawOrder {
  orderId: string;
  inputMint: string;
  makingAmount: number;
  outputMint: string;
  takingAmount: number;
}

/** The user's open Jupiter limit (trigger) orders. The tokens in these have left the
 *  wallet's token accounts (escrowed), so callers add makingAmount/inputMint back to
 *  show true holdings AND surface the orders themselves on the dashboard.
 *  Best-effort -> [] on failure. */
async function jupOpenOrders(owner: string): Promise<RawOrder[]> {
  try {
    const res = await timed(
      fetch(`${JUP_TRIGGER_API}/getTriggerOrders?user=${owner}&orderStatus=active`),
      "jup open orders",
    );
    if (!res.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = (await res.json()) as any;
    const orders = Array.isArray(j?.orders) ? j.orders : Array.isArray(j) ? j : [];
    const out: RawOrder[] = [];
    for (const o of orders) {
      const inputMint = o?.inputMint;
      const makingAmount = Number(o?.makingAmount); // lite-api returns UI (decimal) amounts
      if (!inputMint || !(makingAmount > 0)) continue;
      out.push({
        orderId: String(o?.orderKey ?? o?.publicKey ?? o?.account ?? o?.order ?? ""),
        inputMint,
        makingAmount,
        outputMint: String(o?.outputMint ?? ""),
        takingAmount: Number(o?.takingAmount ?? 0),
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function readSolana(address: string, openOrders: RawOrder[]): Promise<WalletState> {
  const rpc = new SolanaRpc();
  let sol = 0,
    partial = false;
  try {
    sol = Number(await timedRetry(() => rpc.getBalanceLamports(address), "sol getBalance")) / 1e9;
  } catch {
    partial = true;
  }

  // Enumerate EVERY SPL token in the wallet. Falls back to the light USDC-only read
  // if the heavy getTokenAccountsByOwner fails (e.g. a throttling RPC), so it never regresses.
  let walletTokens: { mint: string; uiAmount: number }[] | null = null;
  try {
    const accts = await timedRetry(() => rpc.getAllTokenAccounts(address), "sol all tokens");
    walletTokens = accts.filter((a) => a.uiAmount > 0).map((a) => ({ mint: a.mint, uiAmount: a.uiAmount }));
  } catch {
    walletTokens = null;
  }
  if (walletTokens === null) {
    try {
      const ata = associatedTokenAddress(address, USDC_MINT);
      const t = await timedRetry(() => rpc.getTokenAccountBalance(ata), "sol USDC");
      walletTokens = [{ mint: USDC_MINT, uiAmount: t?.uiAmount ?? 0 }];
    } catch (e) {
      if (/find account|could not find|account.*not.*exist/i.test(String((e as Error)?.message))) walletTokens = [];
      else {
        walletTokens = [];
        partial = true;
      }
    }
  }

  // Tokens escrowed in open Jupiter orders (left the wallet but still ours).
  const orderHoldings = openOrders.map((o) => ({ mint: o.inputMint, amount: o.makingAmount }));

  const usdc = walletTokens.filter((t) => t.mint === USDC_MINT).reduce((s, t) => s + t.uiAmount, 0);

  // Build the non-USDC token list (wallet + escrowed) and price each via Jupiter.
  const holdings: { mint: string; amount: number; location: "wallet" | "order" }[] = [
    ...walletTokens.filter((t) => t.mint !== USDC_MINT).map((t) => ({ mint: t.mint, amount: t.uiAmount, location: "wallet" as const })),
    ...orderHoldings.filter((o) => o.mint !== USDC_MINT).map((o) => ({ mint: o.mint, amount: o.amount, location: "order" as const })),
  ];
  const tokens: TokenHolding[] = [];
  let tokensUsd = 0;
  for (const h of holdings) {
    const info = await jupTokenInfo(h.mint);
    const usd = info?.usdPrice != null ? h.amount * info.usdPrice : null;
    if (usd != null) tokensUsd += usd;
    else partial = true; // a token we couldn't price -> totals are incomplete
    tokens.push({ symbol: info?.symbol || h.mint.slice(0, 4), mint: h.mint, amount: h.amount, usd, location: h.location });
  }
  // USDC parked in an open order (uncommon here, but be complete).
  const orderUsdc = orderHoldings.filter((o) => o.mint === USDC_MINT).reduce((s, o) => s + o.amount, 0);
  if (orderUsdc > 0) {
    tokens.push({ symbol: "USDC", mint: USDC_MINT, amount: orderUsdc, usd: orderUsdc, location: "order" });
    tokensUsd += orderUsdc;
  }

  return {
    chain: "solana",
    address,
    native: { symbol: "SOL", amount: sol, usd: null },
    usdc,
    tokens,
    valueUsd: usdc + tokensUsd, // native USD added by the caller
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

  // Open Jupiter limit orders (Solana), fetched once: feeds the escrowed-token
  // valuation in readSolana AND the standalone orders list below.
  const solOrders = addrs.solana ? await jupOpenOrders(addrs.solana) : [];

  const jobs: Promise<void>[] = [];
  if (addrs.solana) jobs.push(readSolana(addrs.solana, solOrders).then((w) => void wallets.push(w)));
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

  // Enrich open orders for display (symbols + limit price). Their escrowed value is
  // already counted in the wallets' tokens, so this list is informational only.
  const orders: PortfolioOrder[] = [];
  for (const o of solOrders) {
    const inSym = o.inputMint === USDC_MINT ? "USDC" : (await jupTokenInfo(o.inputMint))?.symbol || o.inputMint.slice(0, 4);
    const outSym = o.outputMint === USDC_MINT ? "USDC" : (await jupTokenInfo(o.outputMint))?.symbol || (o.outputMint ? o.outputMint.slice(0, 4) : "?");
    const limitPrice = o.makingAmount > 0 ? o.takingAmount / o.makingAmount : null;
    orders.push({
      venue: "jupiter",
      kind: "limit",
      orderId: o.orderId,
      description: `SELL ${o.makingAmount} ${inSym} -> ${o.takingAmount} ${outSym}`,
      inputSymbol: inSym,
      inputMint: o.inputMint,
      makingAmount: o.makingAmount,
      outputSymbol: outSym,
      outputMint: o.outputMint,
      takingAmount: o.takingAmount,
      limitPrice,
    });
  }

  return {
    ts: new Date().toISOString(),
    wallets,
    positions,
    orders,
    totalValueUsd,
    unrealizedPnlUsd,
    pricingNote: priced
      ? "USDC=$1; SOL/MATIC via CoinGecko; SPL tokens + open Jupiter orders via Jupiter; HL=accountValue"
      : "USDC=$1; SPL tokens via Jupiter; HL=accountValue; native price unavailable this tick",
    partial,
  };
}
