// scout: pure ranking + HL book math. The scout's promise is "least fees,
// tightest spread, most liquidity wins" — these tests pin that ordering and
// the thin-liquidity demotion so a cheap-but-empty book can never be `best`.
import test from "node:test";
import assert from "node:assert/strict";
import { hlCandidateFromBook, rankCandidates, HL_TAKER_FEE_BPS, type ScoutCandidate } from "./scout.js";

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
