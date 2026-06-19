// src/adapters/polymarket-bridge.ts
// Polymarket's NATIVE deposit/withdraw bridge (bridge.polymarket.com) — the gasless,
// fee-free rail the polymarket.com / starling.bet web app uses to fund + drain a
// deposit wallet. Public HTTP, no auth; an OPTIONAL X-Builder-Code header attributes
// volume at 0 fee (set STARLING_PM_BUILDER_CODE to the public code from
// polymarket.com/settings?tab=builder). Verified live 2026-06-18.
//
//  DEPOSIT  — POST /deposit {address: DW} -> per-chain deposit addresses
//    {evm, svm, tron, btc}. Send any supported stable on any supported chain (incl.
//    Solana USDC) to the matching address; Polymarket sweeps it and settles pUSD
//    INTO the deposit wallet. No gas / swap / wrap on our side; it also registers
//    the wallet for trading. Replaces the deBridge+swap+wrap funding leg for PM.
//
//  WITHDRAW — POST /withdraw {address: DW, toChainId, toTokenAddress, recipientAddr}
//    -> a bridge address (use the EVM one — the relay transfer is on Polygon).
//    Transfer pUSD from the DW to it via the GASLESS relayer (buildTransferPusdCall +
//    submitBatch); Polymarket unwraps pUSD->USDC and delivers to the dest chain.
//    Replaces the extract+unwrap+swap+deBridge wind-down for PM.
//
//  SUPPORTED — GET /supported-assets -> [{chainId, chainName, token{...},
//    minCheckoutUsd}]. minCheckoutUsd is a HARD floor: below it the bridge will not
//    forward (funds strand at the deposit address). Solana USDC min is $2.
//
// PM-SPECIFIC: this only moves PM's pUSD in/out of a deposit wallet. deBridge/CCTP
// remain the rails for Hyperliquid + cross-venue Solana/EVM moves.

export const BRIDGE_API = "https://bridge.polymarket.com";

/** Polymarket's non-standard chain id for Solana in the bridge API. */
export const PM_SOLANA_CHAIN_ID = "1151111081099710";
/** Polygon (same-chain bridge address is also Polygon — the relay transfer's chain). */
export const PM_POLYGON_CHAIN_ID = "137";
/** Solana USDC mint — the dest token for a Solana withdraw / asset for a Solana deposit. */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** The four address families /deposit and /withdraw return. */
export interface BridgeAddresses {
  evm: string;
  svm: string;
  tron: string;
  btc: string;
}

export interface SupportedAsset {
  chainId: string;
  chainName: string;
  token: { name: string; symbol: string; address: string; decimals: number };
  minCheckoutUsd: number;
}

/** Optional public builder-code attribution header (0 fee). Omitted if unset. */
export function builderCodeHeader(): Record<string, string> {
  const code = process.env.STARLING_PM_BUILDER_CODE?.trim();
  return code ? { "X-Builder-Code": code } : {};
}

export class PolymarketBridge {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { url?: string; fetchImpl?: typeof fetch } = {}) {
    this.url = (opts.url ?? BRIDGE_API).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Deterministic per-chain deposit addresses for `dwAddress`. Send funds to the
   *  family that matches the source chain (svm for Solana, evm for Polygon/EVM). */
  async getDepositAddresses(dwAddress: string): Promise<BridgeAddresses> {
    const data = await this.post("/deposit", { address: dwAddress });
    const addr = (data as { address?: BridgeAddresses }).address;
    if (!addr?.evm) throw new Error(`bridge /deposit returned no address: ${JSON.stringify(data)}`);
    return addr;
  }

  /** Routing address for a DW -> destination withdraw. Transfer pUSD from the DW to
   *  the returned EVM address via the relayer; the bridge delivers to (chain, token). */
  async getWithdrawAddress(args: {
    dwAddress: string;
    toChainId: string;
    toTokenAddress: string;
    recipientAddr: string;
  }): Promise<BridgeAddresses> {
    const data = await this.post("/withdraw", {
      address: args.dwAddress,
      toChainId: args.toChainId,
      toTokenAddress: args.toTokenAddress,
      recipientAddr: args.recipientAddr,
    });
    const addr = (data as { address?: BridgeAddresses }).address;
    if (!addr?.evm) throw new Error(`bridge /withdraw returned no address: ${JSON.stringify(data)}`);
    return addr;
  }

  /** All supported (chain, token) deposit options + their minCheckoutUsd floors. */
  async getSupportedAssets(): Promise<SupportedAsset[]> {
    const res = await this.fetchImpl(`${this.url}/supported-assets`, { headers: builderCodeHeader() });
    const data = (await res.json().catch(() => ({}))) as { supportedAssets?: SupportedAsset[] };
    if (!res.ok) throw new Error(`bridge /supported-assets -> HTTP ${res.status}`);
    return data.supportedAssets ?? [];
  }

  /** Look up one asset (for its minCheckoutUsd + token address) by chain id + symbol. */
  async findAsset(chainId: string, symbol: string): Promise<SupportedAsset | undefined> {
    const assets = await this.getSupportedAssets();
    return assets.find((a) => a.chainId === chainId && a.token.symbol.toUpperCase() === symbol.toUpperCase());
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...builderCodeHeader() },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`bridge ${path} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }
}
