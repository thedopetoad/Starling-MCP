// scout: pure ranking + HL book math. The scout's promise is "least fees,
// tightest spread, most liquidity wins" — these tests pin that ordering and
// the thin-liquidity demotion so a cheap-but-empty book can never be `best`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  hlCandidateFromBook,
  rankCandidates,
  parseContractRef,
  symbolMatches,
  vetSolanaHits,
  HL_TAKER_FEE_BPS,
  type ScoutCandidate,
  type SolanaTokenHit,
  type CgLookup,
} from "./scout.js";

const cand = (over: Partial<ScoutCandidate>): ScoutCandidate => ({
  venue: "jupiter",
  kind: "spot",
  instrument: "jup:usdc:mint",
  symbol: "X",
  mid: 1,
  spreadBps: null,
  feeBps: 0,
  impactBps: 10,
  totalCostBps: 10,
  liquidityUsd: 1_000_000,
  ...over,
});

test("hlCandidateFromBook: mid, spread, cost = half-spread + taker fee, depth within ±0.5%", () => {
  const c = hlCandidateFromBook("BTC", {
    levels: [
      [{ px: "99900", sz: "1" }, { px: "99000", sz: "5" }], // 2nd bid is 0.95% off mid — outside window
      [{ px: "100100", sz: "1" }, { px: "100400", sz: "2" }], // 2nd ask 0.35% off mid — inside
    ],
  });
  assert.ok(c);
  assert.equal(c.mid, 100_000);
  assert.ok(Math.abs((c.spreadBps ?? NaN) - 20) < 1e-9); // 200/100000
  assert.ok(Math.abs(c.totalCostBps - (10 + HL_TAKER_FEE_BPS)) < 1e-9);
  // depth: 99900*1 + 100100*1 + 100400*2 (99000*5 excluded)
  assert.ok(Math.abs(c.liquidityUsd - (99_900 + 100_100 + 200_800)) < 1e-6);
});

test("hlCandidateFromBook: empty book is not a candidate", () => {
  assert.equal(hlCandidateFromBook("XYZ", { levels: [[], []] }), null);
});

test("rankCandidates: lowest all-in cost wins among liquid candidates", () => {
  const cheapHl = cand({ venue: "hyperliquid", kind: "perp", instrument: "hl:BTC", totalCostBps: 5.5, liquidityUsd: 5_000_000 });
  const dearJup = cand({ instrument: "jup:usdc:wbtc", totalCostBps: 22, liquidityUsd: 29_000_000 });
  const { best, ranked, reason } = rankCandidates([dearJup, cheapHl], 100);
  assert.equal(best?.instrument, "hl:BTC");
  assert.equal(ranked[0].instrument, "hl:BTC");
  assert.match(reason, /hl:BTC wins/);
});

test("rankCandidates: thin liquidity is demoted below every liquid candidate, never best", () => {
  const thinButFree = cand({ instrument: "jup:usdc:scam", totalCostBps: 0.1, liquidityUsd: 500 });
  const liquid = cand({ instrument: "jup:usdc:wbtc", totalCostBps: 30, liquidityUsd: 2_000_000 });
  const { best, ranked } = rankCandidates([thinButFree, liquid], 100);
  assert.equal(best?.instrument, "jup:usdc:wbtc");
  assert.equal(ranked[ranked.length - 1].instrument, "jup:usdc:scam");
  assert.match(ranked[ranked.length - 1].note ?? "", /thin liquidity/);
});

test("rankCandidates: liquidity floor scales with size (20x)", () => {
  const c = cand({ liquidityUsd: 50_000 }); // fine at $100, thin at $5,000 (needs 100k)
  assert.ok(rankCandidates([c], 100).best);
  assert.equal(rankCandidates([c], 5_000).best, null);
});

test("rankCandidates: no candidates -> honest reason", () => {
  const r = rankCandidates([], 100);
  assert.equal(r.best, null);
  assert.match(r.reason, /no venue/);
});

// ── wrong-coin guards (the blknoiz06 fake-LIT incident) ─────────────────────
// The scenario these pin: a Jupiter-"verified" Solana mirror of a major
// Ethereum token (arb-pegged price, active mint authority, not on CoinGecko)
// must never survive vetting; official wraps and pure-Solana memecoins must.

const hit = (over: Partial<SolanaTokenHit> = {}): SolanaTokenHit => ({
  symbol: "LIT",
  name: "Lighter",
  mint: "EicWvteVi2fWepEzS3FYWsnuPoP6caZfjnKqNvydLjCH",
  decimals: 8,
  liquidityUsd: 15_000,
  mcapUsd: 1_000_000,
  usdPrice: 2.69,
  mintAuthority: null,
  ...over,
});

/** Stub CoinGecko: a map of "platform:address(lowercased)" -> CgLookup. */
const cg = (table: Record<string, CgLookup>) => (platform: string, address: string) =>
  Promise.resolve(table[`${platform}:${address.toLowerCase()}`] ?? ({ status: "unregistered" } as CgLookup));

test("parseContractRef: chain:address in, junk out", () => {
  assert.deepEqual(parseContractRef("ethereum:0xAbC1"), { chain: "ethereum", address: "0xAbC1" });
  assert.deepEqual(parseContractRef(" Solana:EicW "), { chain: "solana", address: "EicW" });
  assert.equal(parseContractRef("just a ticker"), null);
  assert.equal(parseContractRef(null), null);
});

test("symbolMatches: exact + wrapper prefixes only, no fuzz", () => {
  assert.ok(symbolMatches("LIT", "lit"));
  assert.ok(symbolMatches("WETH", "ETH"));
  assert.ok(symbolMatches("soETH", "ETH"));
  assert.ok(symbolMatches("cbBTC", "BTC"));
  assert.equal(symbolMatches("STETH", "ETH"), false); // staked = different asset
  assert.equal(symbolMatches("CLANKER", "CL"), false); // the old .includes() bug
});

test("guard 1 (solana ref): only the pinned mint survives", async () => {
  const pinned = hit({ mint: "RealMint1111111111111111111111111111111111" });
  const imposter = hit({ mint: "FakeMint1111111111111111111111111111111111" });
  const r = await vetSolanaHits("LIT", [pinned, imposter], {
    contractRef: "solana:RealMint1111111111111111111111111111111111",
    hlListed: true,
    lookup: cg({}),
  });
  assert.deepEqual(r.kept.map((h) => h.mint), [pinned.mint]);
  assert.equal(r.vetoed.length, 1);
  assert.match(r.vetoed[0], /different mint/);
});

test("guard 1 (EVM ref): unregistered Solana mirror vetoed, registered same-coin deployment kept", async () => {
  const ethLit = "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2";
  const official = hit({ mint: "OfficialBridgedMint111111111111111111111111" });
  const fake = hit(); // EicW… — not on CoinGecko
  const r = await vetSolanaHits("LIT", [official, fake], {
    contractRef: `ethereum:${ethLit}`,
    hlListed: true,
    lookup: cg({
      [`ethereum:${ethLit}`]: { status: "registered", id: "lighter", symbol: "LIT" },
      [`solana:${official.mint.toLowerCase()}`]: { status: "registered", id: "lighter", symbol: "LIT" },
    }),
  });
  assert.deepEqual(r.kept.map((h) => h.mint), [official.mint]);
  assert.match(r.vetoed[0] ?? "", /not a registered deployment of lighter/);
});

test("guard 1 (EVM ref): unresolvable home contract fails closed — all Solana hits vetoed", async () => {
  const r = await vetSolanaHits("LIT", [hit()], {
    contractRef: "ethereum:0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2",
    hlListed: true,
    lookup: () => Promise.resolve({ status: "unavailable" } as CgLookup),
  });
  assert.equal(r.kept.length, 0);
  assert.match(r.vetoed[0], /can't resolve/);
});

test("guard 2 (HL-listed ticker, no ref): mint must be CG-registered under the symbol", async () => {
  const fake = hit(); // fake LIT, unregistered
  const r = await vetSolanaHits("LIT", [fake], { hlListed: true, lookup: cg({}) });
  assert.equal(r.kept.length, 0);
  assert.match(r.vetoed[0], /HL perp/);
  // wrapper prefix accepted: WETH mint qualifies for asset "ETH"
  const weth = hit({ symbol: "WETH", mint: "WethMint1111111111111111111111111111111111", mintAuthority: "BridgePda11111111111111111111111111111111" });
  const r2 = await vetSolanaHits("ETH", [weth], {
    hlListed: true,
    lookup: cg({ [`solana:${weth.mint.toLowerCase()}`]: { status: "registered", id: "weth", symbol: "WETH" } }),
  });
  assert.deepEqual(r2.kept.map((h) => h.mint), [weth.mint]);
});

test("guard 2: pure-Solana memecoin (no HL book) skips the registry requirement", async () => {
  const meme = hit({ symbol: "ANSEM", name: "ansem", mint: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump" });
  const r = await vetSolanaHits("ANSEM", [meme], { hlListed: false, lookup: cg({}) });
  assert.deepEqual(r.kept.map((h) => h.mint), [meme.mint]);
  assert.equal(r.vetoed.length, 0);
});

test("guard 3: active mint authority rejected unless CG-registered (USDC/bridge exception)", async () => {
  const printable = hit({ symbol: "MEME", mint: "PrintableMint11111111111111111111111111111", mintAuthority: "Dev111111111111111111111111111111111111111" });
  const r = await vetSolanaHits("MEME", [printable], { hlListed: false, lookup: cg({}) });
  assert.equal(r.kept.length, 0);
  assert.match(r.vetoed[0], /ACTIVE mint authority/);
  // registered issuer keeps authority legitimately (e.g. USDC)
  const usdc = hit({ symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", mintAuthority: "Circle1111111111111111111111111111111111111" });
  const r2 = await vetSolanaHits("USDC", [usdc], {
    hlListed: false,
    lookup: cg({ [`solana:${usdc.mint.toLowerCase()}`]: { status: "registered", id: "usd-coin", symbol: "USDC" } }),
  });
  assert.deepEqual(r2.kept.map((h) => h.mint), [usdc.mint]);
});

test("KNOWN_CANONICAL: wSOL survives guards 2+3 offline even when CoinGecko is down", async () => {
  const wsol = hit({ symbol: "SOL", name: "Wrapped SOL", mint: "So11111111111111111111111111111111111111112", mintAuthority: null });
  const r = await vetSolanaHits("SOL", [wsol], {
    hlListed: true,
    lookup: () => Promise.resolve({ status: "unavailable" } as CgLookup),
  });
  assert.deepEqual(r.kept.map((h) => h.mint), [wsol.mint]);
  // wrapper-prefix ticker through the allowlist: Wormhole WETH for asset "ETH"
  const weth = hit({ symbol: "WETH", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", mintAuthority: "Bridge1111111111111111111111111111111111111" });
  const r2 = await vetSolanaHits("ETH", [weth], {
    hlListed: true,
    lookup: () => Promise.resolve({ status: "unavailable" } as CgLookup),
  });
  assert.deepEqual(r2.kept.map((h) => h.mint), [weth.mint]);
});

test("guards compose: the real fake-LIT scenario end-to-end (HL listed + active authority + unregistered)", async () => {
  const fakeLit = hit({ mintAuthority: "8Ea2yErngbGWTABRVbiuuAXDFtQXmR7JqZxS7zm3TEL4" });
  const r = await vetSolanaHits("LIT", [fakeLit], {
    contractRef: "ethereum:0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2",
    hlListed: true,
    lookup: cg({
      "ethereum:0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2": { status: "registered", id: "lighter", symbol: "LIT" },
    }),
  });
  assert.equal(r.kept.length, 0);
  assert.equal(r.vetoed.length, 1);
});
