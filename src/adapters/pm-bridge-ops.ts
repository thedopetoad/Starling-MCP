// src/adapters/pm-bridge-ops.ts
// The concrete PmBridgeOps the enable/withdraw tools run on: fund-address lookup +
// the GASLESS native withdraw (relayer pUSD transfer from the deposit wallet to a
// bridge.polymarket.com routing address, which delivers to the destination chain).
//
// makePmBridgeOps() is INJECTABLE (fake the bridge/relayer/balance reader in tests);
// makeRealPmBridge() wires the live concretes (PolymarketBridge + the hand-rolled
// relayer + an EvmRpc pUSD read), exactly like venue-enabler wires the enable path.
// The tool layer pins the withdraw recipient to the sealed treasury — this module
// never chooses a recipient, it only executes the transfer it's handed.

import { parseUnits, formatUnits, type Hex } from "viem";
import type { Chain } from "./types.js";
import type { PmBridgeOps, PmDepositInfo, PmWithdrawResult } from "../tools/index.js";
import { PolymarketBridge, PM_SOLANA_CHAIN_ID, SOLANA_USDC_MINT, type BridgeAddresses } from "./polymarket-bridge.js";
import { loadedAddresses, getEvmSigner } from "../signers/index.js";
import { resolveDepositWallet } from "./polymarket-deposit-wallet.js";
import { PolymarketRelayer, builderCredsFromEnv, buildTransferPusdCall, PUSD } from "./polymarket-relayer.js";
import { EvmRpc } from "./evm-rpc.js";

const COLLATERAL_DECIMALS = 6;

/** Arbitrum USDC — the dest token when withdrawing to the hyperliquid (Arbitrum) treasury address. */
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

/** Cross-chain withdraw destinations the PM bridge serves. polygon is same-chain
 *  (a direct relayer transfer to the recipient), so it is NOT in this map. */
const PM_WITHDRAW_DEST: Partial<Record<Chain, { chainId: string; token: string; min: number }>> = {
  solana: { chainId: PM_SOLANA_CHAIN_ID, token: SOLANA_USDC_MINT, min: 2 },
  hyperliquid: { chainId: "42161", token: ARBITRUM_USDC, min: 2 },
};

/** The seam makeRealPmBridge wires to live concretes; tests inject fakes. */
export interface PmBridgeBackend {
  /** Resolved deposit-wallet address for the loaded EOA, or null if no signer.
   *  Async because the live impl resolves the wallet's era (UUPS vs beacon) on-chain. */
  depositWallet(): Promise<string | null>;
  bridge: Pick<PolymarketBridge, "getDepositAddresses" | "getWithdrawAddress">;
  /** DW pUSD balance (6-dp base units). */
  readDwPusd(dw: string): Promise<bigint>;
  /** Gasless relayer pUSD transfer FROM the DW to `to`; resolves the tx hash. */
  relayTransferPusd(dw: string, to: string, amountRaw: bigint): Promise<string>;
}

export function makePmBridgeOps(b: PmBridgeBackend): PmBridgeOps {
  return {
    async depositAddresses(): Promise<PmDepositInfo> {
      const dw = await b.depositWallet();
      if (!dw) throw new Error("no polygon signer loaded — unlock a Polygon key first");
      const addresses = await b.bridge.getDepositAddresses(dw);
      return {
        depositWallet: dw,
        addresses,
        note:
          "Send any supported stable on any supported chain to the matching address (Solana USDC -> .svm, " +
          "Polygon/EVM USDC -> .evm) — Polymarket settles pUSD INTO the deposit wallet, GASLESS and 1:1 " +
          "(no swap/wrap/deBridge). Min ~$2 cross-chain; full list at bridge.polymarket.com/supported-assets.",
      };
    },

    async withdraw({ amount, toChain, recipient }): Promise<PmWithdrawResult> {
      const base = { deliveredToChain: toChain, recipient };
      const dw = await b.depositWallet();
      if (!dw) return { ...base, ok: false, blockers: ["no polygon signer loaded"], note: "Unlock a Polygon key before withdrawing." };

      let amountRaw: bigint;
      try {
        amountRaw = parseUnits(amount, COLLATERAL_DECIMALS);
      } catch {
        return { ...base, ok: false, blockers: [`invalid amount "${amount}"`], note: "amount must be a decimal pUSD string." };
      }
      if (amountRaw <= 0n) return { ...base, ok: false, blockers: ["amount must be > 0"], note: "Nothing to withdraw." };

      const dwPusd = await b.readDwPusd(dw).catch(() => 0n);
      if (dwPusd < amountRaw) {
        return { ...base, ok: false, blockers: [`deposit wallet holds ${formatUnits(dwPusd, 6)} pUSD < requested ${amount}`], note: "Fund the DW (pm_deposit_address) or lower the amount." };
      }

      // Same-chain Polygon = a direct relayer transfer to the recipient. Cross-chain
      // routes through bridge.polymarket.com: transfer pUSD to its routing address,
      // and the bridge unwraps pUSD->USDC + delivers to the destination chain.
      let target = recipient;
      let via = "same-chain Polygon transfer";
      if (toChain !== "polygon") {
        const dest = PM_WITHDRAW_DEST[toChain];
        if (!dest) return { ...base, ok: false, blockers: [`pm_withdraw to "${toChain}" is not supported (use polygon, solana, or hyperliquid)`], note: "Unsupported destination chain." };
        if (Number(amount) < dest.min) return { ...base, ok: false, blockers: [`amount ${amount} is below the $${dest.min} ${toChain} bridge minimum — it would strand at the bridge`], note: `Withdraw at least $${dest.min} to ${toChain}, or withdraw to Polygon first.` };
        let addrs: BridgeAddresses;
        try {
          addrs = await b.bridge.getWithdrawAddress({ dwAddress: dw, toChainId: dest.chainId, toTokenAddress: dest.token, recipientAddr: recipient });
        } catch (e) {
          return { ...base, ok: false, blockers: [`bridge /withdraw lookup failed: ${(e as Error).message}`], note: "The Polymarket bridge did not return a routing address." };
        }
        target = addrs.evm; // the relay transfer happens on Polygon
        via = `bridge.polymarket.com -> ${toChain}`;
      }

      let txHash: string;
      try {
        txHash = await b.relayTransferPusd(dw, target, amountRaw);
      } catch (e) {
        return { ...base, ok: false, blockers: [`relayer transfer failed: ${(e as Error).message}`], note: "The gasless relayer transfer did not land. Safe to retry with a NEW idempotencyKey." };
      }

      return {
        ...base,
        ok: true,
        txHash,
        blockers: [],
        note: `Gasless pUSD withdraw via ${via} to ${recipient} (relayer tx ${txHash}). ` + (toChain === "polygon" ? "Delivered on Polygon." : "The bridge unwraps pUSD->USDC and delivers shortly."),
      };
    },
  };
}

/** Wire the live concretes: the bridge HTTP client + the hand-rolled gasless relayer
 *  + an EvmRpc pUSD balance read. The DW is derived from the loaded Polygon EOA. */
export function makeRealPmBridge(): PmBridgeOps {
  const rpc = new EvmRpc({ net: "polygon" });
  return makePmBridgeOps({
    async depositWallet() {
      const eoa = loadedAddresses().polygon;
      return eoa ? resolveDepositWallet(eoa as Hex, rpc) : null;
    },
    bridge: new PolymarketBridge(),
    async readDwPusd(dw: string) {
      const data = "0x70a08231" + dw.slice(2).toLowerCase().padStart(64, "0");
      const hex = await rpc.callReadonly({ from: dw, to: PUSD, data });
      return BigInt(hex && hex !== "0x" ? hex : "0x0");
    },
    async relayTransferPusd(dw: string, to: string, amountRaw: bigint) {
      const creds = builderCredsFromEnv();
      if (!creds) throw new Error("no builder relayer creds (set STARLING_PM_BUILDER_API_KEY / _SECRET / _PASSPHRASE)");
      const signer = getEvmSigner("polymarket");
      const relayer = new PolymarketRelayer({ creds });
      const deadline = Math.floor(Date.now() / 1000) + 1800;
      const sub = await relayer.submitBatch(signer, dw as Hex, [buildTransferPusdCall(to as Hex, amountRaw)], deadline);
      return relayer.waitMined(sub.transactionID);
    },
  });
}
