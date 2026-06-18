// src/adapters/venue-enabler.ts
// The REAL VenueEnabler (replaces the deps.ts placeholder). It turns enable_venue
// into the concrete on-chain setup a fresh EOA needs:
//
//   - polymarket: SCOPED pUSD approvals to the three V2 spenders + (optional)
//     USDC.e->pUSD wrap + CTF operator approvals — the exact preconditions a FAK
//     order needs to SETTLE. Built by polymarket-enable.ts; allowances are scoped
//     to STARLING_PM_COLLATERAL_BUDGET, never MAX.
//   - hyperliquid: nothing to approve — we sign actions directly with the master
//     key. "Enabled" means the L1 account is funded (USDC via CCTP-direct deposit).
//   - jupiter: not wired yet (Solana phase).
//
// It returns UNSIGNED txs only; the local key signs + broadcasts them. We do NOT
// read on-chain allowances here (no RPC client is wired), so alreadyEnabled stays
// false for PM and the txs are emitted unconditionally — re-approving is an
// idempotent no-op on-chain. That trade-off is stated in the note, not hidden.
import type { Venue } from "./types.js";
import type { UnsignedBridgeTx } from "../bridge/types.js";
import type { VenueEnabler } from "../tools/index.js";
import { buildEnableTradingTxs } from "./polymarket-enable.js";
import { loadedAddresses, getEvmSigner } from "../signers/index.js";
import { deriveDepositWalletUUPS } from "./polymarket-deposit-wallet.js";
import { PolymarketRelayer, builderCredsFromEnv, buildApprovalCalls, PUSD } from "./polymarket-relayer.js";
import { CTF_EXCHANGE_V2 } from "./polymarket-constants.js";
import { EvmRpc } from "./evm-rpc.js";

type EnableResult = Awaited<ReturnType<VenueEnabler["enable"]>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is the legacy bare-EOA enable wanted? Default = deposit-wallet (the live path). */
function depositWalletMode(): boolean {
  const f = (process.env.STARLING_PM_DEPOSIT_WALLET ?? "").trim().toLowerCase();
  return !(f === "false" || f === "0" || f === "off");
}

export function makeRealVenueEnabler(): VenueEnabler {
  return {
    async enable(venue: Venue): Promise<EnableResult> {
      switch (venue) {
        case "polymarket":
          return enablePolymarket();
        case "hyperliquid":
          return {
            venue,
            alreadyEnabled: true,
            txs: [],
            blockers: [],
            note:
              "Hyperliquid needs no approval txs — orders are signed directly with the master key. " +
              "Enable = fund the L1 account: deposit USDC to HyperCore (CCTP-direct), then trade.",
          };
        case "jupiter":
          return {
            venue,
            alreadyEnabled: false,
            txs: [],
            blockers: ["jupiter enablement not wired yet"],
            note: "Solana/Jupiter enablement (USDC ATA) lands in a later phase.",
          };
      }
    },
  };
}

async function enablePolymarket(): Promise<EnableResult> {
  const eoa = loadedAddresses().polygon;
  if (!eoa) {
    return {
      venue: "polymarket",
      alreadyEnabled: false,
      txs: [],
      blockers: ["no polygon signer loaded"],
      note: "Unlock a Polygon key (STARLING_PK_POLYGON or the keystore) before enabling Polymarket.",
    };
  }

  // Deposit-wallet mode (DEFAULT): deploy + approve the per-user DW gaslessly via the
  // relayer. The DW is what the V2 CLOB accepts; a bare EOA is rejected.
  if (depositWalletMode()) return enablePolymarketDepositWallet(eoa as `0x${string}`);

  // Legacy bare-EOA mode (STARLING_PM_DEPOSIT_WALLET=false): scoped EOA approvals.
  const budget = process.env.STARLING_PM_COLLATERAL_BUDGET;
  if (!budget) {
    return {
      venue: "polymarket",
      alreadyEnabled: false,
      txs: [],
      blockers: ["STARLING_PM_COLLATERAL_BUDGET unset"],
      note:
        'Set STARLING_PM_COLLATERAL_BUDGET to the pUSD you intend to trade (e.g. "5"). ' +
        "Approvals are SCOPED to it (not MAX). Optionally set STARLING_PM_WRAP_USDCE to also " +
        "wrap USDC.e->pUSD, and STARLING_PM_WRAP_ASSET=native if your USDC arrived via CCTP.",
    };
  }
  const wrapUsdce = process.env.STARLING_PM_WRAP_USDCE || undefined;
  const wrapAsset = process.env.STARLING_PM_WRAP_ASSET === "native" ? "native" : "usdce";
  const includeCtfApprovals = (process.env.STARLING_PM_INCLUDE_CTF_APPROVALS ?? "true").toLowerCase() !== "false";

  const evmTxs = buildEnableTradingTxs({
    eoa: eoa as `0x${string}`,
    collateralBudget: budget,
    wrapUsdce,
    wrapAsset,
    includeCtfApprovals,
  });

  const txs: UnsignedBridgeTx[] = evmTxs.map((t) => ({
    chain: "polygon",
    kind: "evmTx",
    payload: { to: t.to, data: t.data, value: t.value },
    label: t.label,
  }));

  return {
    venue: "polymarket",
    alreadyEnabled: false,
    txs,
    blockers: [],
    note:
      `UNSIGNED Polymarket enable txs (legacy bare-EOA mode) — pUSD allowances scoped to ${budget}` +
      (wrapUsdce ? `, wrapping ${wrapUsdce} USDC.e->pUSD` : "") +
      ". Sign + broadcast each in order with the local Polygon key (pays MATIC gas).",
  };
}

/** Deploy + approve the deposit wallet via the gasless relayer. This EXECUTES (no txs
 *  to broadcast) and is idempotent — it skips a deploy/approval that's already done. */
async function enablePolymarketDepositWallet(eoa: `0x${string}`): Promise<EnableResult> {
  const creds = builderCredsFromEnv();
  if (!creds) {
    return {
      venue: "polymarket",
      alreadyEnabled: false,
      txs: [],
      blockers: ["no builder creds"],
      note: "Deposit-wallet enable needs the gasless relayer: set STARLING_PM_BUILDER_API_KEY / _SECRET / _PASSPHRASE (from polymarket.com/settings?tab=builder). Or set STARLING_PM_DEPOSIT_WALLET=false for the legacy bare-EOA path.",
    };
  }
  const signer = getEvmSigner("polymarket");
  const dw = deriveDepositWalletUUPS(eoa);
  const relayer = new PolymarketRelayer({ creds });
  const rpc = new EvmRpc({ net: "polygon" });
  const steps: string[] = [];

  try {
    // 1. Deploy (gasless). Poll the relayer registry (lag ~5-10s) so the approval
    //    batch that follows doesn't 400 on "wallet not registered".
    let deployed = await relayer.getDeployed(dw).catch(() => false);
    if (!deployed) {
      const sub = await relayer.submitDeploy(eoa);
      await relayer.waitMined(sub.transactionID);
      for (let i = 0; i < 12 && !deployed; i++) { await sleep(2000); deployed = await relayer.getDeployed(dw).catch(() => false); }
      if (!deployed) {
        return { venue: "polymarket", alreadyEnabled: false, txs: [], blockers: ["deploy submitted, registry not caught up"], note: `Deposit wallet ${dw} deploy submitted; the relayer registry hasn't acknowledged it yet — re-run enable_venue in ~10s.` };
      }
      steps.push(`deployed deposit wallet ${dw}`);
    } else {
      steps.push("deposit wallet already deployed");
    }

    // 2. Approve the 3 V2 exchanges to spend the DW's pUSD + outcome tokens.
    //    Idempotent: skip if pUSD->CTF_EXCHANGE_V2 is already a large allowance.
    const allowance = await readDwAllowance(rpc, dw, CTF_EXCHANGE_V2 as `0x${string}`).catch(() => 0n);
    if (allowance < (1n << 200n)) {
      const sub = await relayer.submitBatch(signer, dw, buildApprovalCalls(), Math.floor(Date.now() / 1000) + 1800);
      await relayer.waitMined(sub.transactionID);
      steps.push("approved the V2 exchanges");
    } else {
      steps.push("approvals already set");
    }
  } catch (e) {
    return { venue: "polymarket", alreadyEnabled: false, txs: [], blockers: [`relayer error: ${(e as Error).message}`], note: `Deposit-wallet enable failed mid-flight (${steps.join("; ") || "no steps"}). Safe to re-run — deploy + approvals are idempotent.` };
  }

  return {
    venue: "polymarket",
    alreadyEnabled: true,
    txs: [],
    blockers: [],
    note: `Deposit wallet ${dw} READY (${steps.join("; ")}). Gasless — nothing to broadcast. Fund it with pUSD (wrap USDC.e->pUSD to that address) and open_position settles.`,
  };
}

/** erc20 allowance(owner, spender) on pUSD via eth_call. */
async function readDwAllowance(rpc: EvmRpc, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  const data = "0xdd62ed3e" + owner.slice(2).toLowerCase().padStart(64, "0") + spender.slice(2).toLowerCase().padStart(64, "0");
  return BigInt(await rpc.callReadonly({ from: owner, to: PUSD, data }));
}
