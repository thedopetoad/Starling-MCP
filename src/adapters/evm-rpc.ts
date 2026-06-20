// src/adapters/evm-rpc.ts
// Minimal EVM JSON-RPC client (fetch only) for the broadcast/confirm path — the
// EVM counterpart of solana-rpc.ts. NO key material here. Endpoint per network
// from STARLING_RPC_<NET> (the same env convention cctp.ts already uses). We
// hand-roll JSON-RPC over fetch rather than importing viem's client/transport
// (matches the repo rule stated in cctp.ts); viem is used ONLY for the pure tx
// serialization in evm-broadcast.ts, never its network layer.

/** The real EVM networks this stack touches. Note the repo Chain "hyperliquid"
 *  maps here to "arbitrum" (HL deposit/withdraw funds physically live on Arbitrum).
 *  "hyperevm" is HL's own EVM layer (chainId 999) — distinct from Arbitrum; reached
 *  for the cheap CCTP exit (HyperCore->HyperEVM->CCTP). Native gas = HYPE. */
export type EvmNet = "polygon" | "arbitrum" | "ethereum" | "hyperevm";

/** repo Chain (EVM ones) -> the real network its tx executes on. */
export const EVM_CHAIN_NET: Record<"polygon" | "hyperliquid", EvmNet> = {
  polygon: "polygon",
  hyperliquid: "arbitrum",
};

export const EVM_CHAIN_IDS: Record<EvmNet, number> = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  hyperevm: 999,
};

// Public fallbacks — fine for a tiny self-test; set STARLING_RPC_<NET> for volume.
// Anonymous-friendly public fallbacks (verified reachable without an API key) —
// fine for a tiny self-test; set STARLING_RPC_<NET> to a paid endpoint (Alchemy)
// for the live run. NOTE: the old polygon-rpc.com / llamarpc defaults now 401 or
// hang for anonymous callers — publicnode is the reliable keyless choice.
const PUBLIC_RPC: Record<EvmNet, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  hyperevm: "https://rpc.hyperliquid.xyz/evm",
};

function envRpc(net: EvmNet): string | undefined {
  return process.env[`STARLING_RPC_${net.toUpperCase()}`];
}

export interface EvmReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  transactionHash: string;
}

export interface EvmFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** The slice of EvmRpc the broadcaster depends on (kept narrow so tests inject a
 *  fake without a network). EvmRpc satisfies this structurally. */
export interface EvmRpcLike {
  readonly net: EvmNet;
  readonly chainId: number;
  getChainId(): Promise<number>;
  getPendingNonce(address: string): Promise<number>;
  getLatestNonce(address: string): Promise<number>;
  estimateGas(tx: { from: string; to: string; data?: string; value?: bigint }): Promise<bigint>;
  suggestFees(): Promise<EvmFees>;
  callReadonly(tx: { from: string; to: string; data?: string; value?: bigint }): Promise<string>;
  sendRawTransaction(rawHex: string): Promise<string>;
  getReceipt(hash: string): Promise<EvmReceipt | null>;
}

export class EvmRpc implements EvmRpcLike {
  readonly net: EvmNet;
  /** The chainId the tx MUST be built for; asserted against the live node. */
  readonly chainId: number;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private id = 0;

  constructor(opts: { net: EvmNet; url?: string; fetchImpl?: typeof fetch }) {
    this.net = opts.net;
    this.chainId = EVM_CHAIN_IDS[opts.net];
    this.url = opts.url ?? envRpc(opts.net) ?? PUBLIC_RPC[opts.net];
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    // Retry TRANSPORT errors only (fetch throw = socket/DNS/TLS drop, HTTP 5xx, or
    // 429) — the public RPCs drop connections intermittently and a single blip must
    // not kill a multi-tx money sequence. A legit RPC error (json.error: revert,
    // "nonce too low", "already known") or a 4xx is DETERMINISTIC and never retried
    // — re-sending would not change the outcome. Safe for sendRawTransaction too:
    // the raw bytes are identical (same nonce => same hash), so a node that already
    // has it returns "already known", which the broadcaster swallows + confirms by
    // receipt rather than re-signing.
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params });
    const MAX = 4;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * attempt));
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      } catch (e) {
        lastErr = e; // transport drop — retry
        continue;
      }
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) { lastErr = new Error(`EVM RPC ${method} -> HTTP ${res.status}`); continue; }
        throw new Error(`EVM RPC ${method} -> HTTP ${res.status}`); // 4xx — terminal
      }
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`EVM RPC ${method}: ${json.error.message}`); // RPC-level error — terminal
      return json.result as T;
    }
    throw lastErr instanceof Error ? lastErr : new Error(`EVM RPC ${method} failed after ${MAX} retries`);
  }

  /** eth_chainId — used to ASSERT the RPC matches the chain we built/sign for. */
  async getChainId(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_chainId", [])));
  }

  /** Pending nonce: the nonce the NEXT tx must use. Pinned ONCE per broadcast. */
  async getPendingNonce(address: string): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_getTransactionCount", [address, "pending"])));
  }

  /** Mined-only nonce: how many txs from this address are already on-chain. Used
   *  to detect that OUR pinned nonce was consumed by a DIFFERENT (replacement) tx. */
  async getLatestNonce(address: string): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_getTransactionCount", [address, "latest"])));
  }

  /** Native balance (wei). Feeds gas.ts's NativeBalanceReader for the EVM chains. */
  async getBalanceWei(address: string): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [address, "latest"]));
  }

  /** EIP-1559 fee suggestion: base fee from the pending block + a priority tip,
   *  with a chain-aware floor (Polygon's well-known ~30 gwei min priority fee, or
   *  1 gwei elsewhere) and 2x base headroom for a few blocks of base-fee rise. */
  async suggestFees(): Promise<EvmFees> {
    const block = await this.call<{ baseFeePerGas: string | null }>("eth_getBlockByNumber", ["pending", false]);
    const base = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
    let tip: bigint;
    try {
      tip = BigInt(await this.call<string>("eth_maxPriorityFeePerGas", []));
    } catch {
      tip = 0n;
    }
    const floor = this.net === "polygon" ? 30_000_000_000n : 1_000_000_000n;
    if (tip < floor) tip = floor;
    return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
  }

  async estimateGas(tx: { from: string; to: string; data?: string; value?: bigint }): Promise<bigint> {
    return BigInt(await this.call<string>("eth_estimateGas", [this.txObj(tx)]));
  }

  /** eth_call — a FREE revert pre-check before we spend gas. Throws on revert. */
  async callReadonly(tx: { from: string; to: string; data?: string; value?: bigint }): Promise<string> {
    return this.call<string>("eth_call", [this.txObj(tx), "latest"]);
  }

  async sendRawTransaction(rawHex: string): Promise<string> {
    return this.call<string>("eth_sendRawTransaction", [rawHex]);
  }

  async getReceipt(hash: string): Promise<EvmReceipt | null> {
    const r = await this.call<null | {
      status: string;
      blockNumber: string;
      gasUsed: string;
      transactionHash: string;
    }>("eth_getTransactionReceipt", [hash]);
    if (!r) return null;
    return {
      status: BigInt(r.status) === 1n ? "success" : "reverted",
      blockNumber: BigInt(r.blockNumber),
      gasUsed: BigInt(r.gasUsed),
      transactionHash: r.transactionHash,
    };
  }

  private txObj(tx: { from: string; to: string; data?: string; value?: bigint }) {
    return {
      from: tx.from,
      to: tx.to,
      ...(tx.data ? { data: tx.data } : {}),
      ...(tx.value !== undefined ? { value: `0x${tx.value.toString(16)}` } : {}),
    };
  }
}
