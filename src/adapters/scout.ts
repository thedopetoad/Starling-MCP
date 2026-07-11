// src/adapters/scout.ts
// Cross-venue EXECUTION SCOUT. Given one asset (e.g. "BTC"), discover every way
// the stack can express it — Hyperliquid perp book, Jupiter spot on verified
// Solana mints — and rank the candidates by ALL-IN execution quality: venue
// fees + bid/ask spread (or AMM impact, which embeds pool fees) at the caller's
// size, with liquidity as the safety gate. Read-only and keyless: HL /info +
// Jupiter lite-api, no signer anywhere.
//
// Polymarket is deliberately absent: it trades event contracts, not assets —
// there is no "BTC" to buy there, so it can never be an execution candidate
// for a token/perp expression.
import { infoPost, HL_MAINNET, HL_TESTNET } from "./hl-transport.js";

const JUP_TOKEN_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** HL base-tier taker fee (bps). Perp orders cross the spread + pay this. */
export const HL_TAKER_FEE_BPS = 4.5;
/** Book depth window for the liquidity measure: ±0.5% around mid. */
const DEPTH_WINDOW = 0.005;

export interface SolanaTokenHit {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  liquidityUsd: number;
  mcapUsd: number;
  usdPrice: number | null;
  /** SPL mint authority — null/undefined when revoked. Active = dev can print. */
  mintAuthority: string | null;
  /** Jupiter-curated tags (verified, xstocks, rwa, …). */
  tags: string[];
}

export interface ScoutCandidate {
  venue: "hyperliquid" | "jupiter";
  kind: "perp" | "spot";
  /** Venue-prefixed id ready for get_quote / open_position / hl_order. */
  instrument: string;
  symbol: string;
  mid: number | null;
  /** Book bid/ask spread (HL). AMM venues have no book — null. */
  spreadBps: number | null;
  /** Explicit venue taker fee. Jupiter's pool fees are embedded in impactBps. */
  feeBps: number;
  /** Quote-derived price impact at the requested size (embeds AMM fees). */
  impactBps: number | null;
  /** All-in one-way cost estimate at sizeUsd: fees + half-spread or impact. */
  totalCostBps: number;
  /** HL: book depth within ±0.5% of mid. Jupiter: pool liquidity. */
  liquidityUsd: number;
  /** Round-trip execution quality (entry + exit + depth penalty), lower wins. */
  qualityScore?: number;
  note?: string;
}

export interface ScoutResult {
  asset: string;
  sizeUsd: number;
  /** All candidates, best execution first (ineligible thin-liquidity last). */
  ranked: ScoutCandidate[];
  /** The winner, or null if nothing has safe liquidity for the size. */
  best: ScoutCandidate | null;
  reason: string;
  /** Wrong-coin guard rejections (why each Solana mint was refused), if any. */
  vetoed?: string[];
}

interface FetchOpts {
  fetchImpl?: typeof fetch;
  hlHost?: string;
}

export function defaultHlHost(): string {
  return process.env.STARLING_NETWORK === "testnet" ? HL_TESTNET : HL_MAINNET;
}

/** Verified Solana mints matching `query`, most liquid first. */
export async function searchVerifiedTokens(query: string, opts: FetchOpts = {}, limit = 5): Promise<SolanaTokenHit[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${JUP_TOKEN_SEARCH}?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Jupiter token search HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr = (await res.json()) as any[];
  return (Array.isArray(arr) ? arr : [])
    .filter((t) => t?.isVerified === true && Number.isInteger(t?.decimals))
    .map((t) => ({
      symbol: String(t.symbol ?? ""),
      name: String(t.name ?? ""),
      mint: String(t.id),
      decimals: Number(t.decimals),
      liquidityUsd: Number(t.liquidity ?? 0),
      mcapUsd: Number(t.mcap ?? 0),
      usdPrice: t.usdPrice != null ? Number(t.usdPrice) : null,
      mintAuthority: t.mintAuthority != null ? String(t.mintAuthority) : null,
      tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
    }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .slice(0, limit);
}

// ── WRONG-COIN GUARDS (2026-07-10, blknoiz06 fake-LIT incident) ──────────────
// A ticker search is NOT an identity check: an unofficial Solana "LIT" mirror
// (Jupiter-verified, price arb-pegged 1:1 to the real Ethereum LIT, $15k pool,
// ACTIVE mint authority) won the spot ranking for a tweet that literally tagged
// `ethereum:0x232c…`. Three layered guards, all here so every scout consumer
// (MCP venue_scout tool + the desk engines) gets them:
//   1. CONTRACT REF — a signal that names `<chain>:<address>` pins the asset's
//      identity; only that mint (solana ref) or CoinGecko-registered
//      deployments of that exact coin (EVM ref) survive.
//   2. CROSS-CHAIN AMBIGUITY — a ticker that also trades as an HL perp is a
//      major asset whose canonical home is probably not Solana; a Solana mint
//      must be CoinGecko-registered under that symbol (modulo wrapper
//      prefixes: WETH/soETH/cbBTC…) to qualify. Pure-Solana memecoins (no HL
//      book) skip this — they have no cross-chain canonical to collide with.
//   3. ACTIVE MINT AUTHORITY — the dev can print supply at will; reject unless
//      the mint is CoinGecko-registered (official issuers/bridges — USDC,
//      wormhole wraps — legitimately keep authority).
// CoinGecko lookups are keyless, cached per-process, and FAIL CLOSED: if CG is
// unreachable, an ambiguous mint is vetoed rather than trusted (the HL perp
// path is unaffected, so majors stay tradeable).

const CG_CONTRACT = "https://api.coingecko.com/api/v3/coins";

/** CoinGecko asset-platform ids for the chains tweets actually tag. */
const CG_PLATFORM: Record<string, string> = {
  ethereum: "ethereum", eth: "ethereum",
  solana: "solana", sol: "solana",
  base: "base",
  arbitrum: "arbitrum-one",
  polygon: "polygon-pos", matic: "polygon-pos",
  bsc: "binance-smart-chain", bnb: "binance-smart-chain",
  optimism: "optimistic-ethereum",
  avalanche: "avalanche", avax: "avalanche",
};

export interface ContractRef { chain: string; address: string; }

/** Parse "<chain>:<address>" (e.g. "ethereum:0x232c…", "solana:EicW…"). */
export function parseContractRef(raw: string | null | undefined): ContractRef | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^([a-zA-Z0-9-]+)\s*:\s*(\S+)$/);
  if (!m) return null;
  return { chain: m[1].toLowerCase(), address: m[2] };
}

export type CgLookup =
  | { status: "registered"; id: string; symbol: string }
  | { status: "unregistered" }
  | { status: "unavailable" };

const cgCache = new Map<string, CgLookup>();

/** Which registered CoinGecko coin owns this contract? "unregistered" (404) is
 *  cached; "unavailable" (rate-limit/outage) is not, so a later call retries. */
export async function cgCoinForContract(platform: string, address: string, opts: FetchOpts = {}): Promise<CgLookup> {
  const key = `${platform}:${address.toLowerCase()}`;
  const hit = cgCache.get(key);
  if (hit) return hit;
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${CG_CONTRACT}/${platform}/contract/${address}`);
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = (await res.json()) as any;
      const out: CgLookup = j?.id
        ? { status: "registered", id: String(j.id), symbol: String(j.symbol ?? "").toUpperCase() }
        : { status: "unregistered" };
      cgCache.set(key, out);
      return out;
    }
    if (res.status === 404) {
      const out: CgLookup = { status: "unregistered" };
      cgCache.set(key, out);
      return out;
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Does a CoinGecko symbol denote `asset`, allowing official wrapper prefixes
 *  (WETH/soETH/cbBTC/whBTC → ETH/BTC)? Exact after normalization — no fuzz. */
export function symbolMatches(cgSymbol: string, asset: string): boolean {
  const s = cgSymbol.toUpperCase();
  const a = asset.toUpperCase();
  if (s === a) return true;
  for (const pre of ["W", "SO", "CB", "WH"]) {
    if (s.startsWith(pre) && s.slice(pre.length) === a) return true;
  }
  return false;
}

/** Canonical Solana mints that never need a registry lookup — guards 2 and 3
 *  accept these offline so a CoinGecko outage can't veto wSOL or major wraps.
 *  Value = the asset ticker the mint legitimately denotes. */
export const KNOWN_CANONICAL: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL", // native wrapped SOL
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH", // Wormhole WETH
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "BTC", // Wormhole WBTC
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: "BTC", // Coinbase cbBTC
};

/** xStocks issuer — every tokenized equity (TSLAx, AAPLx, …) keeps its mint
 *  authority at this address (backed asset; issuer mints against custody).
 *  Guard 3 accepts an active authority ONLY when it is this address AND
 *  Jupiter's curated tag list says "xstocks" — authority alone is spoofable
 *  (anyone can setAuthority to a pubkey they don't control), the tag alone is
 *  Jupiter curation; together they're as strong as isVerified itself. */
export const XSTOCKS_ISSUER = "7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj";
export function isXStock(h: SolanaTokenHit): boolean {
  return h.mintAuthority === XSTOCKS_ISSUER && (h.tags ?? []).includes("xstocks");
}

export interface VetContext extends FetchOpts {
  /** Explicit `<chain>:<address>` the signal/tweet names, if any. */
  contractRef?: string | null;
  /** True when the ticker also trades as an HL perp (cross-chain ambiguity). */
  hlListed: boolean;
  /** Injectable CoinGecko lookup (tests). Defaults to cgCoinForContract. */
  lookup?: (platform: string, address: string) => Promise<CgLookup>;
}

export interface VetResult { kept: SolanaTokenHit[]; vetoed: string[]; }

/** Apply the three wrong-coin guards to Jupiter token-search hits. */
export async function vetSolanaHits(asset: string, hits: SolanaTokenHit[], ctx: VetContext): Promise<VetResult> {
  const lookup = ctx.lookup ?? ((p: string, a: string) => cgCoinForContract(p, a, ctx));
  const vetoed: string[] = [];
  const tag = (h: SolanaTokenHit) => `${h.symbol} (${h.mint.slice(0, 6)}…)`;
  let pool = hits;

  // Guard 1 — explicit contract ref pins identity.
  const ref = parseContractRef(ctx.contractRef);
  if (ref) {
    if (CG_PLATFORM[ref.chain] === "solana") {
      pool = [];
      for (const h of hits) {
        if (h.mint === ref.address) pool.push(h);
        else vetoed.push(`${tag(h)}: signal pins solana:${ref.address.slice(0, 6)}… — different mint`);
      }
    } else {
      const platform = CG_PLATFORM[ref.chain];
      const home = platform ? await lookup(platform, ref.address) : ({ status: "unregistered" } as CgLookup);
      const out: SolanaTokenHit[] = [];
      for (const h of hits) {
        if (home.status !== "registered") {
          vetoed.push(`${tag(h)}: signal pins ${ref.chain}:${ref.address.slice(0, 10)}… but CoinGecko can't resolve it (${home.status}) — no Solana deployment is verifiable`);
          continue;
        }
        const cg = await lookup("solana", h.mint);
        if (cg.status === "registered" && cg.id === home.id) out.push(h);
        else vetoed.push(`${tag(h)}: not a registered deployment of ${home.id} (CoinGecko: ${cg.status === "registered" ? `coin ${cg.id}` : cg.status})`);
      }
      pool = out;
    }
  }

  // Guard 2 — HL lists the ticker → any Solana mint must be a registered
  // deployment of that symbol. Skipped when a ref already pinned identity.
  if (!ref && ctx.hlListed) {
    const out: SolanaTokenHit[] = [];
    for (const h of pool) {
      if (symbolMatches(KNOWN_CANONICAL[h.mint] ?? "", asset)) { out.push(h); continue; }
      const cg = await lookup("solana", h.mint);
      if (cg.status === "registered" && symbolMatches(cg.symbol, asset)) out.push(h);
      else vetoed.push(`${tag(h)}: ${asset.toUpperCase()} also trades as an HL perp — Solana mint must be a CoinGecko-registered ${asset.toUpperCase()} deployment (got ${cg.status === "registered" ? cg.symbol : cg.status})`);
    }
    pool = out;
  }

  // Guard 3 — active mint authority: reject unless CoinGecko-registered.
  {
    const out: SolanaTokenHit[] = [];
    for (const h of pool) {
      if (!h.mintAuthority || KNOWN_CANONICAL[h.mint] || isXStock(h)) { out.push(h); continue; }
      const cg = await lookup("solana", h.mint);
      if (cg.status === "registered") out.push(h);
      else vetoed.push(`${tag(h)}: ACTIVE mint authority (${h.mintAuthority.slice(0, 6)}…) and not CoinGecko-registered (${cg.status}) — dev can print supply`);
    }
    pool = out;
  }

  return { kept: pool, vetoed };
}

// ── Polymarket market search (Gamma public-search, read-only, keyless) ───────
const GAMMA = "https://gamma-api.polymarket.com";

export interface PmMarketHit {
  question: string;
  eventTitle: string;
  conditionId: string;
  /** [YES tokenId, NO tokenId] — the CLOB tokens an order trades. */
  yesTokenId: string | null;
  noTokenId: string | null;
  outcomes: string[];
  /** Marketable prices per outcome (0..1). */
  prices: number[];
  volumeUsd: number;
  liquidityUsd: number;
  endDate: string | null;
}

/** Search Polymarket for ACTIVE, tradeable markets matching free text (a team,
 *  person, event, ticker…). Skips resolved/degenerate books (price pinned to
 *  0 or 1) and dust volume. Most-liquid first. This is how an event/sports/
 *  political tweet becomes a concrete tradeable market. */
export async function searchPolymarketMarkets(query: string, opts: FetchOpts = {}, limit = 8): Promise<PmMarketHit[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${GAMMA}/public-search?q=${encodeURIComponent(query)}&limit_per_type=12&events_status=active`);
  if (!res.ok) throw new Error(`Gamma public-search HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await res.json()) as any;
  const out: PmMarketHit[] = [];
  for (const ev of j?.events ?? []) {
    if (ev?.closed === true) continue;
    for (const m of ev?.markets ?? []) {
      if (m?.active !== true || m?.closed === true) continue;
      const parse = (v: unknown) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return []; } };
      const tokens = parse(m.clobTokenIds) as string[];
      const outcomes = (parse(m.outcomes) as string[]) ?? [];
      const prices = ((parse(m.outcomePrices) as string[]) ?? []).map(Number);
      // Skip already-resolved / untradeable books (a side pinned to 0 or 1).
      if (prices.length && prices.every((p) => p <= 0.02 || p >= 0.98)) continue;
      const vol = Number(m.volumeNum ?? m.volume ?? 0);
      out.push({
        question: String(m.question ?? ev.title ?? ""),
        eventTitle: String(ev.title ?? ""),
        conditionId: String(m.conditionId ?? ""),
        yesTokenId: tokens?.[0] ?? null,
        noTokenId: tokens?.[1] ?? null,
        outcomes,
        prices,
        volumeUsd: vol,
        liquidityUsd: Number(m.liquidity ?? m.liquidityNum ?? 0),
        endDate: m.endDate ?? ev.endDate ?? null,
      });
    }
  }
  return out.sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, limit);
}

/** HL l2Book levels: [bids, asks], px/sz as strings. */
interface HlBook {
  levels: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>];
}

/** Pure: candidate from an HL book snapshot (exported for tests). */
export function hlCandidateFromBook(coin: string, book: HlBook): ScoutCandidate | null {
  const bids = book?.levels?.[0] ?? [];
  const asks = book?.levels?.[1] ?? [];
  const bestBid = Number(bids[0]?.px ?? 0);
  const bestAsk = Number(asks[0]?.px ?? 0);
  if (!(bestBid > 0) || !(bestAsk > 0)) return null;
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  let depthUsd = 0;
  for (const l of bids) {
    const px = Number(l.px);
    if (px >= mid * (1 - DEPTH_WINDOW)) depthUsd += px * Number(l.sz);
  }
  for (const l of asks) {
    const px = Number(l.px);
    if (px <= mid * (1 + DEPTH_WINDOW)) depthUsd += px * Number(l.sz);
  }
  return {
    venue: "hyperliquid",
    kind: "perp",
    instrument: `hl:${coin}`,
    symbol: coin,
    mid,
    spreadBps,
    feeBps: HL_TAKER_FEE_BPS,
    impactBps: null,
    // A marketable order pays the half-spread to cross + the taker fee.
    totalCostBps: spreadBps / 2 + HL_TAKER_FEE_BPS,
    liquidityUsd: depthUsd,
  };
}

export async function hlPerpCandidate(coin: string, opts: FetchOpts = {}): Promise<ScoutCandidate | null> {
  try {
    const book = await infoPost<HlBook>({ type: "l2Book", coin: coin.toUpperCase() }, {
      host: opts.hlHost ?? defaultHlHost(),
      fetchImpl: opts.fetchImpl,
    });
    return hlCandidateFromBook(coin.toUpperCase(), book);
  } catch {
    return null; // unknown coin on HL — simply not a candidate
  }
}

// ── HIP-3 builder-deployed perp dexs (oil, stock/commodity perps, …) ─────────
// Builder dexs list markets the main dex doesn't (xyz:BRENTOIL, xyz:GOLD, …).
// Catalogs come from {type:"meta", dex:"<name>"}; coins are "<dex>:<COIN>" and
// l2Book takes the prefixed coin directly. Only USDC-collateral dexs
// (collateralToken === 0) are candidates — trading a non-USDC dex would need a
// spot buy of its collateral token first. Liquidity varies WILDLY (some books
// are literally empty), so every candidate still goes through rankCandidates'
// 20×-size floor — an empty book sinks as "thin liquidity", never wins.
// NOTE: builder dexs may add a deployer fee on top of HL's base taker fee; we
// rank with the base fee (spread/depth dominate the comparison anyway).
const BUILDER_CACHE_TTL_MS = 10 * 60_000;

export interface BuilderDex { name: string; markets: string[]; }

let builderCache: { at: number; host: string; dexs: BuilderDex[] } = { at: 0, host: "", dexs: [] };

/** USDC-collateral builder dexs with their market names, cached 10 min. */
export async function usdcBuilderDexs(opts: FetchOpts = {}): Promise<BuilderDex[]> {
  const host = opts.hlHost ?? defaultHlHost();
  if (builderCache.host === host && Date.now() - builderCache.at < BUILDER_CACHE_TTL_MS) return builderCache.dexs;
  const f = { host, fetchImpl: opts.fetchImpl };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await infoPost<any[]>({ type: "perpDexs" }, f);
  const names = (Array.isArray(raw) ? raw : []).filter((d) => d && d.name).map((d) => String(d.name));
  const dexs: BuilderDex[] = [];
  await Promise.all(names.map(async (name) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = await infoPost<any>({ type: "meta", dex: name }, f);
      if (Number(meta?.collateralToken ?? 0) !== 0) return; // non-USDC collateral — unsupported
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dexs.push({ name, markets: (meta?.universe ?? []).map((u: any) => String(u.name)) });
    } catch {
      /* skip a flaky dex this cycle; cache refresh retries in 10 min */
    }
  }));
  builderCache = { at: Date.now(), host, dexs };
  return dexs;
}

/** Ticker aliases for markets whose listed name differs from how a tweet says
 *  it (CL is the WTI crude contract; BRENTOIL is brent). Deliberately tiny. */
const TICKER_ALIASES: Record<string, string[]> = {
  OIL: ["CL", "WTI", "USOIL", "BRENTOIL", "CRUDE"],
  WTI: ["CL", "USOIL", "OIL"],
  CRUDE: ["CL", "WTI", "USOIL", "BRENTOIL", "OIL"],
  CRUDEOIL: ["CL", "WTI", "USOIL", "BRENTOIL", "OIL"],
  BRENT: ["BRENTOIL"],
  NATGAS: ["TTF"],
  GAS: ["NATGAS", "TTF"],
};

/** Builder-dex perp candidates for `asset`: symbol/alias match across every
 *  USDC-collateral dex, then price each match's book. Instrument is
 *  "hl:<dex>:<COIN>" — resolveHlAsset handles the prefixed form end-to-end. */
export async function builderPerpCandidates(asset: string, opts: FetchOpts = {}, maxBooks = 6): Promise<ScoutCandidate[]> {
  const q = asset.toUpperCase().trim();
  if (!q) return [];
  const wanted = new Set([q, ...(TICKER_ALIASES[q] ?? [])]);
  const dexs = await usdcBuilderDexs(opts).catch(() => [] as BuilderDex[]);
  const matches: string[] = [];
  for (const d of dexs) {
    for (const name of d.markets) {
      // EXACT match (or alias) only — substring matching put a LIT signal on
      // xyz:LITE (2026-07-10, same bug class as CLANKER-for-CL). Markets whose
      // listed name legitimately differs from the tweet's ticker belong in
      // TICKER_ALIASES, not in a fuzzy match.
      const bare = name.slice(name.indexOf(":") + 1).toUpperCase();
      if (wanted.has(bare)) matches.push(name);
    }
  }
  const host = opts.hlHost ?? defaultHlHost();
  const cands = await Promise.all(matches.slice(0, maxBooks).map(async (name) => {
    try {
      const book = await infoPost<HlBook>({ type: "l2Book", coin: name }, { host, fetchImpl: opts.fetchImpl });
      return hlCandidateFromBook(name, book); // instrument hl:<dex>:<COIN>
    } catch {
      return null;
    }
  }));
  return cands.filter((c): c is ScoutCandidate => c !== null);
}

/** Jupiter spot candidate: quote USDC -> mint at sizeUsd; the shortfall of the
 *  received value vs the marked usdPrice IS the all-in cost (pool fees +
 *  impact; lite-api platform fee is zero). */
export async function jupCandidate(hit: SolanaTokenHit, sizeUsd: number, opts: FetchOpts = {}): Promise<ScoutCandidate | null> {
  if (!(hit.usdPrice && hit.usdPrice > 0)) return null;
  const f = opts.fetchImpl ?? fetch;
  const amount = Math.max(1, Math.round(sizeUsd * 1e6));
  try {
    const res = await f(
      `${JUP_QUOTE}?inputMint=${USDC_MINT}&outputMint=${hit.mint}&amount=${amount}&slippageBps=100&swapMode=ExactIn`,
    );
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (await res.json()) as any;
    const outAmount = Number(q?.outAmount ?? 0);
    if (!(outAmount > 0)) return null;
    const outUsd = (outAmount / 10 ** hit.decimals) * hit.usdPrice;
    const impactBps = Math.max(0, (1 - outUsd / sizeUsd) * 10_000);
    return {
      venue: "jupiter",
      kind: "spot",
      instrument: `jup:${USDC_MINT}:${hit.mint}`,
      symbol: hit.symbol,
      mid: hit.usdPrice,
      spreadBps: null,
      feeBps: 0,
      impactBps,
      totalCostBps: impactBps,
      liquidityUsd: hit.liquidityUsd,
      note: `${hit.name} (${hit.mint.slice(0, 6)}…), verified`,
    };
  } catch {
    return null;
  }
}

/** Pure ranking (exported for tests): best round-trip QUALITY wins among
 *  candidates whose liquidity can safely absorb the size; thin books sink to
 *  the bottom with a note rather than silently disappearing. */
export function rankCandidates(cands: ScoutCandidate[], sizeUsd: number): Omit<ScoutResult, "asset" | "sizeUsd"> {
  const MIN_LIQ = Math.max(20 * sizeUsd, 1_000);
  const eligible = cands.filter((c) => c.liquidityUsd >= MIN_LIQ);
  const thin = cands
    .filter((c) => c.liquidityUsd < MIN_LIQ)
    .map((c) => ({ ...c, note: `${c.note ? c.note + "; " : ""}thin liquidity ($${Math.round(c.liquidityUsd).toLocaleString()} < $${Math.round(MIN_LIQ).toLocaleString()} floor)` }));
  // QUALITY SCORE (owner call 2026-07-10): never rank on entry cost alone —
  // a thin book can quote a deceptively tight small-size entry while being
  // horrible to exit. Score = round-trip cost + a log-scaled depth penalty:
  //   - totalCostBps already covers fees + ENTRY half-spread/impact
  //   - add the EXIT leg: another half-spread (or impact again for AMMs)
  //   - depth penalty: 20 bps per 10x below $1M liquidity (a $29k pool owes
  //     ~+31 bps, a $1M+ pool owes 0) — deep books win unless the thin one
  //     is drastically cheaper, which at that depth it never honestly is.
  const LIQ_REF = 1_000_000;
  const qualityScore = (c: ScoutCandidate) => {
    const exitLeg = c.spreadBps != null ? c.spreadBps / 2 : (c.impactBps ?? 0);
    const depthPenalty = 20 * Math.max(0, Math.log10(LIQ_REF / Math.max(c.liquidityUsd, 1)));
    return c.totalCostBps + exitLeg + depthPenalty;
  };
  for (const c of cands) c.qualityScore = Math.round(qualityScore(c) * 10) / 10; // observability: shows up in scout output
  const byQuality = (a: ScoutCandidate, b: ScoutCandidate) =>
    qualityScore(a) - qualityScore(b) || b.liquidityUsd - a.liquidityUsd;
  eligible.sort(byQuality);
  thin.sort(byQuality);
  const best = eligible[0] ?? null;
  const reason = best
    ? `${best.instrument} wins: quality ${best.qualityScore} (entry ~${best.totalCostBps.toFixed(1)} bps (fees ${best.feeBps} bps + ${
        best.spreadBps != null ? `half-spread ${(best.spreadBps / 2).toFixed(1)} bps` : `impact ${best.impactBps?.toFixed(1)} bps`
      }) with $${Math.round(best.liquidityUsd).toLocaleString()} liquidity at $${sizeUsd} size${
        eligible[1] ? ` — next best ${eligible[1].instrument} at ~${eligible[1].totalCostBps.toFixed(1)} bps` : ""
      }`
    : cands.length
      ? "no candidate has safe liquidity for this size"
      : "no venue can express this asset";
  return { ranked: [...eligible, ...thin], best, reason };
}

export interface ScoutOpts extends FetchOpts {
  /** Explicit `<chain>:<address>` from the signal/tweet — pins asset identity. */
  contractRef?: string | null;
}

/** The full scout: search every venue (HL main dex + HIP-3 builder dexs +
 *  Jupiter verified mints), guard identity, price every candidate, rank. */
export async function scoutAsset(asset: string, sizeUsd: number, opts: ScoutOpts = {}): Promise<ScoutResult> {
  const [hl, builders, solHitsAll] = await Promise.all([
    hlPerpCandidate(asset, opts),
    builderPerpCandidates(asset, opts).catch(() => [] as ScoutCandidate[]),
    searchVerifiedTokens(asset, opts, 4).catch(() => [] as SolanaTokenHit[]),
  ]);
  // EXACT-TICKER GUARD (2026-07-10: desk bought "Hobbes" for a $ANSEM tweet).
  // Jupiter's fuzzy search matches name/metadata too, and rankCandidates picks
  // by EXECUTION QUALITY — so any richer-pool token that merely mentions the
  // ticker could beat the ticker itself. Rules:
  //   1. exact symbol match exists -> ONLY exact matches are candidates
  //      (top-3 by liquidity; verified impostor dupes lose on liquidity, and
  //      can never win on a cheaper pool).
  //   2. no exact match -> symbol-SUBSTRING matches only (BTC -> cbBTC/WBTC/
  //      xBTC wrapper proxies keep working). Metadata-only matches (query in
  //      the name/description, e.g. "Ansem's cat") are NEVER eligible.
  // Exact tier includes the xStocks convention (owner call 2026-07-10): an X
  // cashtag like $TSLA maps to the tokenized equity "TSLAx" on Jupiter — and
  // a verified meme literally named "TSLA" must NOT own the exact tier just
  // by string equality. Both forms are exact candidates; the quality score
  // (round-trip cost + depth) then picks the healthier market between them.
  const q = String(asset).toUpperCase();
  const isExact = (h: SolanaTokenHit) => {
    const sym = h.symbol.toUpperCase();
    return sym === q || sym === q + "X";
  };
  const exact = solHitsAll.filter(isExact);
  const tickerHits = exact.length ? exact.slice(0, 3) : solHitsAll.filter((h) => h.symbol.toUpperCase().includes(q));
  // IDENTITY GUARDS (2026-07-10: fake-LIT) — a ticker match still isn't an
  // identity check; vet contract refs, cross-chain mirrors, mint authority.
  const { kept, vetoed } = await vetSolanaHits(asset, tickerHits, {
    ...opts,
    contractRef: opts.contractRef ?? null,
    hlListed: hl !== null,
  });
  const jups = (await Promise.all(kept.map((h) => jupCandidate(h, sizeUsd, opts)))).filter(
    (c): c is ScoutCandidate => c !== null,
  );
  const cands = [...(hl ? [hl] : []), ...builders, ...jups];
  const res: ScoutResult = { asset, sizeUsd, ...rankCandidates(cands, sizeUsd) };
  if (vetoed.length) {
    res.vetoed = vetoed;
    res.reason += ` — wrong-coin guard vetoed ${vetoed.length} Solana candidate(s)`;
  }
  return res;
}
