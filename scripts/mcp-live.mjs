// scripts/mcp-live.mjs — drive the MCP TOOL SURFACE live (the counterpart of
// live.mjs, which drives the adapters). This calls the EXACT tool dispatcher a
// cold MCP client hits — buildToolDeps() + handleMoneyTool(name, args) — so it
// proves a context-free agent's TOOL CALLS actually move money, end to end.
//
//   node --env-file=../starling-test/agent.env scripts/mcp-live.mjs <stage> [args] [--live]
// stages:
//   tools                                list the money tools
//   quote <venue> <marketId>            get_quote (read-only)
//   jupiter <solAmount>                 open_position(jupiter): buy SOL->USDC, EXECUTED
//   transfer <from> <to> <amt>          transfer (auto-rail) -> source broadcast + flightId
//   advance <provider> <flightId>       advance_bridge: drive to delivery (CCTP mints)
//   hl-withdraw <amt>                   build_withdraw(hyperliquid): native withdraw3
// DRY by default; only --live signs+broadcasts.
if (!process.env.STARLING_KEY_SOURCE) process.env.STARLING_KEY_SOURCE = "env";
process.env.STARLING_NETWORK = process.env.STARLING_NETWORK || "mainnet";
process.env.STARLING_RPC_POLYGON = process.env.STARLING_RPC_POLYGON || "https://polygon-bor-rpc.publicnode.com";
process.env.STARLING_RPC_ARBITRUM = process.env.STARLING_RPC_ARBITRUM || "https://arb1.arbitrum.io/rpc";

// DYNAMIC import (after the env block above) — static `import` is hoisted ABOVE the
// env assignments, so module singletons that read env at construction (the
// Hyperliquid adapter reads STARLING_NETWORK then) would capture the wrong network.
const { bootUnlock, loadedAddresses } = await import("../dist/signers/index.js");
const { buildToolDeps } = await import("../dist/server.js");
const { handleMoneyTool, MONEY_TOOLS } = await import("../dist/tools/index.js");

const stage = process.argv[2];
const a = process.argv.slice(3).filter((x) => !x.startsWith("--"));
const LIVE = process.argv.includes("--live");
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

await bootUnlock();
const deps = buildToolDeps();
const A = loadedAddresses();

/** Call a tool exactly as the MCP server's CallTool handler does. */
async function call(name, args) {
  const r = await handleMoneyTool(name, args, deps);
  const text = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const key = (p) => `${p}-${Date.now()}`;
const show = (o) => console.log(JSON.stringify(o, null, 2));

const stages = {
  async tools() {
    console.log("money tools:", MONEY_TOOLS.map((t) => t.name).join(", "));
    console.log("addresses:", A);
  },
  async quote() {
    show(await call("get_quote", { venue: a[0], marketId: a[1], side: a[2] }));
  },
  async jupiter() {
    const amt = a[0] || "0.01";
    console.log(`open_position(jupiter) buy ${amt} SOL -> USDC, EXECUTED through the tool`);
    if (!LIVE) return console.log("DRY — re-run with --live to sign + broadcast.");
    show(
      await call("open_position", {
        venue: "jupiter",
        marketId: "jup:" + USDC_SOL_MINT,
        side: "buy",
        amount: amt,
        amountKind: "collateral",
        worstPrice: "0",
        slippageFrac: 0.01,
        idempotencyKey: key("jup-open"),
      }),
    );
  },
  async transfer() {
    const [from, to, amt] = a;
    if (!from || !to || !amt) throw new Error("usage: transfer <from> <to> <amountUSDC> [--live]");
    console.log(`transfer ${amt} USDC ${from} -> ${to} (auto-rail) through the tool`);
    if (!LIVE) return console.log("DRY — re-run with --live to broadcast the source leg(s).");
    show(await call("transfer", { fromChain: from, toChain: to, amount: amt, idempotencyKey: key("xfer") }));
  },
  async advance() {
    const [provider, flightId] = a;
    if (!provider || !flightId) throw new Error("usage: advance <cctp|debridge> <flightId>");
    show(await call("advance_bridge", { provider, flightId }));
  },
  async "hl-withdraw"() {
    const amt = a[0] || "1";
    console.log(`build_withdraw(hyperliquid) ${amt} USDC -> own Arbitrum address`);
    if (!LIVE) return console.log("DRY — re-run with --live. (Needs STARLING_WITHDRAW_MAX set.)");
    show(await call("build_withdraw", { chain: "hyperliquid", amount: amt, idempotencyKey: key("hlw") }));
  },
  async "hl-trade"() {
    const coin = (a[0] || "SOL").toUpperCase();
    const usd = a[1] || "11";
    const q = await call("get_quote", { venue: "hyperliquid", marketId: "hl:" + coin });
    const mid = Number(q?.meta?.mid);
    if (!mid) return console.log("no HL mid:", JSON.stringify(q, null, 2));
    const worstBuy = Number((mid * 1.01).toPrecision(5));
    console.log(`HL ${coin}: mid=${mid} | open $${usd} IOC-buy worst=${worstBuy}`);
    if (!LIVE) return console.log("DRY — --live to trade.");
    console.log("\n>>> OPEN (hyperliquid) <<<");
    show(await call("open_position", { venue: "hyperliquid", marketId: "hl:" + coin, side: "buy", amount: usd, amountKind: "collateral", worstPrice: String(worstBuy), idempotencyKey: key("hl-open") }));
    await new Promise((r) => setTimeout(r, 4000)); // let HL reflect the fill before closing
    console.log("\n>>> CLOSE (hyperliquid) <<<");
    const worstSell = Number((mid * 0.99).toPrecision(5));
    show(await call("close_position", { venue: "hyperliquid", marketId: "hl:" + coin, fraction: "1", worstPrice: String(worstSell), idempotencyKey: key("hl-close") }));
  },
};

if (!stages[stage]) {
  console.log("stages:", Object.keys(stages).join(", "));
  process.exit(1);
}
await stages[stage]();
