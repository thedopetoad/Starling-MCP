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
import { loadedAddresses } from "../signers/index.js";

type EnableResult = Awaited<ReturnType<VenueEnabler["enable"]>>;

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

function enablePolymarket(): EnableResult {
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
      `UNSIGNED Polymarket enable txs — pUSD allowances scoped to ${budget}` +
      (wrapUsdce ? `, wrapping ${wrapUsdce} USDC.e->pUSD` : "") +
      ". Sign + broadcast each in order with the local Polygon key (pays MATIC gas). " +
      "Re-running is idempotent on-chain. Once they confirm, open_position can settle.",
  };
}
