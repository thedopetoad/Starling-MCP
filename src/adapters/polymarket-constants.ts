// src/adapters/polymarket-constants.ts
// Polymarket CLOB V2 + collateral constants for the polymarket VenueAdapter.
//
// SAFETY: every address / chain id / endpoint here is sourced from an OFFICIAL
// reference and the source is cited inline. A wrong exchange address or domain
// version makes the EIP-712 signature recover to the wrong signer ("Invalid
// signature") at best, or — for the on-chain enable txs — sends an approval to a
// contract that can move funds. Do not edit without re-checking the cited source.

/** Polygon PoS. Polymarket trades only here. */
export const POLYGON_CHAIN_ID = 137;

/**
 * V2 Exchange contracts. Binary markets verify against CTF_EXCHANGE_V2; neg-risk
 * (multi-outcome) markets verify against NEG_RISK_CTF_EXCHANGE_V2. Picking the
 * wrong one => the order's EIP-712 domain.verifyingContract is wrong => CLOB
 * rejects with "Invalid signature".
 * Source: https://docs.polymarket.com/v2-migration
 */
export const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B" as const;
export const NEG_RISK_CTF_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59" as const;

/**
 * NegRisk adapter — the third spender that needs a pUSD allowance + CTF
 * setApprovalForAll so neg-risk fills can settle.
 * Source: https://docs.polymarket.com/resources/contracts
 */
export const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as const;

/**
 * Conditional Tokens Framework (ERC-1155). Unchanged V1->V2. Holds the outcome
 * shares; the exchanges need setApprovalForAll on it to move shares on a SELL.
 * Source: https://docs.polymarket.com/resources/contracts
 */
export const CONDITIONAL_TOKENS_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;

/**
 * Permissionless Collateral Onramp — exposes wrap(asset,to,amount) that pulls
 * USDC.e (or native USDC) and mints pUSD.
 * Source: https://polygonscan.com/address/0x93070a847efEf7F70739046A929D47a521F5B8ee
 */
export const COLLATERAL_ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee" as const;

/**
 * pUSD — V2 trading collateral (6 decimals). The order makerAmount is spent in
 * this token. USDC.e is ONLY the wrap() source.
 * Source: https://docs.polymarket.com/resources/contracts
 */
export const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;

/**
 * USDC.e — bridged USDC, the wrap() source asset. NOT the V2 trading collateral.
 * Source: C:/Users/will/Desktop/Polymarket/src/lib/polymarket-approvals.ts
 */
export const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;

/**
 * Native Circle USDC on Polygon — what CCTP mints. Also accepted by the Onramp
 * wrap() per the chain explorer. Distinct from USDC.e and pUSD.
 * Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
export const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;

/**
 * EIP-712 Exchange order domain. version bumped V1->V2 to "2" (the L1
 * ClobAuthDomain used to derive API keys stays "1" — different domain, not ours).
 * Source: https://docs.polymarket.com/v2-migration
 */
export const EIP712_DOMAIN_VERSION = "2" as const;
export const EIP712_DOMAIN_NAME = "Polymarket CTF Exchange" as const;
export const EIP712_DOMAIN_NAME_NEGRISK = "Polymarket Neg Risk CTF Exchange" as const;

/** CLOB HTTP base. POST /order, GET /tick-size, GET /neg-risk.
 *  Source: C:/Users/will/Desktop/Polymarket/src/app/api/polymarket/order/route.ts */
export const CLOB_HOST = "https://clob.polymarket.com" as const;

/** Polymarket data API — source-of-truth positions (mirrors v1 app).
 *  Source: C:/Users/will/Desktop/Polymarket/src/app/api/polymarket/positions/route.ts */
export const DATA_API_HOST = "https://data-api.polymarket.com" as const;

/** Both collateral (pUSD) and conditional tokens are 6-decimal on Polymarket. */
export const COLLATERAL_DECIMALS = 6;

/** bytes32 zero — default metadata + default builder (no attribution). */
export const BYTES32_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";

/**
 * Per-tick rounding precision, verbatim from the V2 SDK
 * (order-builder/helpers/roundingConfig.ts). `price` = dp for the price,
 * `size` = dp for share size, `amount` = dp for the derived collateral amount.
 * Replicated so our hand-rolled amount math byte-matches the SDK's.
 */
export const ROUNDING_CONFIG: Record<TickSize, { price: number; size: number; amount: number }> = {
  "0.1": { price: 1, size: 2, amount: 3 },
  "0.01": { price: 2, size: 2, amount: 4 },
  "0.001": { price: 3, size: 2, amount: 5 },
  "0.0001": { price: 4, size: 2, amount: 6 },
};

/** Order side as the signed uint8 (matches the V2 Order struct `side` field). */
export const SIDE_BUY = 0;
export const SIDE_SELL = 1;

/** signatureType=0 EOA. We trade on plain EOAs; signer == maker == local EOA. */
export const SIGNATURE_TYPE_EOA = 0;
