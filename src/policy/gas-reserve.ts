// src/policy/gas-reserve.ts
// The GAS-OUT RESERVE — the minimum NATIVE balance a wallet must keep so it can
// ALWAYS pay for an outbound bridge ("bring it home"). The execution layer's
// transient-custody model breaks if a wallet trades/bridges itself below this and
// gets STRANDED holding USDC it can't move — USDC cannot pay a bridge's native fee,
// so a near-empty native balance is a one-way trap. (Observed live: a Solana wallet
// at 0.006 SOL and an Arbitrum wallet at 0.0005 ETH, both below the deBridge fee,
// could not bridge their USDC out at all.)
//
// Floors are the cheapest bridge-out rail's cost + a buffer, per chain:
//   - solana:      deBridge ONLY (CCTP-Solana is stage-2): ~0.015 SOL fixFee + tx.
//   - polygon:     CCTP-out (USDC) burn gas; cheaper than deBridge's 0.5 POL fixFee,
//                  but Polygon gas SPIKES, so the floor carries headroom.
//   - hyperliquid: Arbitrum CCTP/deBridge out — ~0.001 ETH either way.
// Each is env-overridable: STARLING_GAS_RESERVE_<CHAIN> (decimal native units).

import type { Chain } from "../adapters/types.js";

export interface GasReserve {
  /** Decimal native units to always retain. */
  native: string;
  symbol: string;
  /** Which bridge-out rail this floor is sized for (for the operator message). */
  rail: string;
}

const DEFAULTS: Record<Chain, GasReserve> = {
  solana: { native: "0.02", symbol: "SOL", rail: "deBridge (only rail; ~0.015 SOL fixFee + tx)" },
  polygon: { native: "0.15", symbol: "POL", rail: "CCTP-out burn gas (+ Polygon gas-spike buffer)" },
  hyperliquid: { native: "0.003", symbol: "ETH", rail: "Arbitrum CCTP/deBridge out" },
};

/** The native gas-out reserve for a chain (env-overridable). */
export function gasReserveFloor(chain: Chain): GasReserve {
  const env = process.env[`STARLING_GAS_RESERVE_${chain.toUpperCase()}`];
  const d = DEFAULTS[chain];
  return env && /^\d+(\.\d+)?$/.test(env.trim()) ? { ...d, native: env.trim() } : d;
}

export interface GasReserveStatus {
  chain: Chain;
  /** Current native balance (decimal). */
  balance: string;
  /** The reserve floor (decimal). */
  floor: string;
  symbol: string;
  /** balance >= floor. */
  ok: boolean;
  /** balance is so low it may not afford even ONE bridge-out (< ~80% of floor). */
  critical: boolean;
  blocker?: "below_gas_out_reserve";
  note: string;
}

/**
 * Classify a chain's native balance against its gas-out reserve. `ok` false means
 * the wallet is at risk of the strand-trap; `critical` means it likely can't afford
 * even one bridge-out RIGHT NOW (top up before it holds any value it needs to move).
 */
export function gasReserveStatus(chain: Chain, balanceNative: number): GasReserveStatus {
  const r = gasReserveFloor(chain);
  const floor = Number(r.native);
  const ok = balanceNative >= floor;
  const critical = balanceNative < floor * 0.8;
  return {
    chain,
    balance: balanceNative.toFixed(6),
    floor: r.native,
    symbol: r.symbol,
    ok,
    critical,
    blocker: ok ? undefined : "below_gas_out_reserve",
    note: ok
      ? `${balanceNative.toFixed(4)} ${r.symbol} — above the ${r.native} ${r.symbol} bridge-out reserve.`
      : `${balanceNative.toFixed(4)} ${r.symbol} is BELOW the ${r.native} ${r.symbol} bridge-out reserve (${r.rail}). ` +
        `Top up native gas on ${chain} via ensure_gas, or the wallet risks being STRANDED holding USDC it cannot move.`,
  };
}
