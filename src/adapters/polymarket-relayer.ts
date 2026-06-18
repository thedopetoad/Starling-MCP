// src/adapters/polymarket-relayer.ts
// The Polymarket gasless RELAYER — hand-rolled, vector-locked to
// @polymarket/builder-relayer-client (which we keep OUT of the prod tree: it pulls
// ethers5 + axios + tsx + typescript as runtime deps). The relayer is the ONLY way
// to drive a V2 DEPOSIT WALLET (an ERC-1967 contract): it can't sign for itself, so
// the owner EOA authorizes a batch of calls with an EIP-712 signature and the
// relayer executes them on-chain, gaslessly. Used for the one-time enable
// (deploy + on-DW approvals) and for pulling pUSD back OUT of the deposit wallet.
//
// Everything here is fetch + viem.hashTypedData + node:crypto HMAC — no SDK, no key
// material leaves the EvmSigner.signDigest boundary. The Batch EIP-712 types/domain
// and the HMAC scheme are transcribed verbatim from the SDK and locked by
// polymarket-relayer.test.ts.

import { hashTypedData, encodeFunctionData, erc20Abi, hexToBytes, type Hex } from "viem";
import { createHmac } from "node:crypto";
import type { EvmSigner } from "../signers/evm.js";
import { DEPOSIT_WALLET_FACTORY } from "./polymarket-deposit-wallet.js";

export const RELAYER_URL = "https://relayer-v2.polymarket.com";
export const RELAYER_DOMAIN_NAME = "DepositWallet";
export const RELAYER_DOMAIN_VERSION = "1";
const POLYGON_CHAIN_ID = 137;
const MAX_UINT256 = (1n << 256n) - 1n;

// V2 trading contracts on Polygon — the spenders the deposit wallet must approve,
// plus pUSD (the collateral) and CTF (the ERC-1155 outcome tokens). Verbatim from
// PolyNews use-deposit-wallet.ts.
export const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as Hex;
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Hex;
const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B" as Hex;
const NEG_RISK_CTF_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59" as Hex;
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as Hex;

const SETAPPROVALFORALL_ABI = [{
  name: "setApprovalForAll", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [],
}] as const;

/** A single call the deposit wallet will make (target/value/data). */
export interface DepositWalletCall { target: Hex; value: string; data: Hex; }

/** Local builder HMAC creds — read once from env, never logged. */
export interface BuilderCreds { key: string; secret: string; passphrase: string; }

export function builderCredsFromEnv(): BuilderCreds | null {
  const key = process.env.STARLING_PM_BUILDER_API_KEY?.trim();
  const secret = process.env.STARLING_PM_BUILDER_SECRET?.trim();
  const passphrase = process.env.STARLING_PM_BUILDER_PASSPHRASE?.trim();
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

// ── EIP-712 Batch (verbatim from builder-relayer-client deposit-wallet.js) ──────
const BATCH_TYPES = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
} as const;

/** Sign the deposit-wallet Batch the owner authorizes — the relayer's auth that the
 *  DW may run `calls`. Standard EIP-712 (domain verifyingContract = the DW). */
export function signDepositWalletBatch(
  signer: Pick<EvmSigner, "signDigest">,
  args: { chainId: number; walletAddress: Hex; nonce: string | number | bigint; deadline: string | number | bigint; calls: DepositWalletCall[] },
): Hex {
  const digest = hashTypedData({
    domain: { name: RELAYER_DOMAIN_NAME, version: RELAYER_DOMAIN_VERSION, chainId: args.chainId, verifyingContract: args.walletAddress },
    types: BATCH_TYPES,
    primaryType: "Batch",
    message: {
      wallet: args.walletAddress,
      nonce: BigInt(args.nonce),
      deadline: BigInt(args.deadline),
      calls: args.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data })),
    },
  });
  return ("0x" + Buffer.from(signer.signDigest(hexToBytes(digest))).toString("hex")) as Hex;
}

// ── Builder HMAC (verbatim from builder-signing-sdk) ────────────────────────────
/** message = ts+method+path(+body); HMAC-SHA256(base64-decoded secret); url-safe b64. */
export function buildBuilderHeaders(creds: BuilderCreds, method: string, path: string, body: string | undefined, ts: number): Record<string, string> {
  let message = ts + method + path;
  if (body !== undefined) message += body;
  const sig = createHmac("sha256", Buffer.from(creds.secret, "base64")).update(message).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return {
    POLY_BUILDER_API_KEY: creds.key,
    POLY_BUILDER_PASSPHRASE: creds.passphrase,
    POLY_BUILDER_SIGNATURE: sig,
    POLY_BUILDER_TIMESTAMP: `${ts}`,
  };
}

// ── The deposit-wallet call builders ────────────────────────────────────────────
/** The 6 approvals the DW needs so the exchanges can move its pUSD + outcome tokens:
 *  3× pUSD.approve(spender, MAX) + 3× CTF.setApprovalForAll(spender, true). */
export function buildApprovalCalls(): DepositWalletCall[] {
  const spenders = [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2, NEG_RISK_ADAPTER];
  const calls: DepositWalletCall[] = [];
  for (const s of spenders) calls.push({ target: PUSD, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s, MAX_UINT256] }) });
  for (const s of spenders) calls.push({ target: CTF, value: "0", data: encodeFunctionData({ abi: SETAPPROVALFORALL_ABI, functionName: "setApprovalForAll", args: [s, true] }) });
  return calls;
}

/** A call that moves `amountRaw` pUSD (6-dp units) FROM the deposit wallet to `to`.
 *  This is how funds come back out of the DW (withdraw / wind-down). */
export function buildTransferPusdCall(to: Hex, amountRaw: bigint): DepositWalletCall {
  return { target: PUSD, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amountRaw] }) };
}

export interface RelaySubmitResult { transactionID: string; state: string; transactionHash?: string }

const SUCCESS_STATES = new Set(["STATE_MINED", "STATE_CONFIRMED"]);
const FAIL_STATES = new Set(["STATE_FAILED", "STATE_INVALID"]);

/** Hand-rolled relayer client: getNonce/getDeployed are open GETs; /submit is HMAC-
 *  authed. Mirrors builder-relayer-client's RelayClient for the WALLET tx type. */
export class PolymarketRelayer {
  private readonly url: string;
  private readonly chainId: number;
  private readonly creds: BuilderCreds;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: { creds: BuilderCreds; chainId?: number; url?: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.creds = opts.creds;
    this.chainId = opts.chainId ?? POLYGON_CHAIN_ID;
    this.url = (opts.url ?? RELAYER_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Relayer-side nonce for this signer's WALLET batches (NOT the on-chain nonce). */
  async getNonce(from: string): Promise<string> {
    const r = await this.get<{ nonce: string }>("/nonce", { address: from, type: "WALLET" });
    return String(r.nonce);
  }

  /** Is the deposit wallet deployed + registered in the relayer's index? */
  async getDeployed(depositWallet: string): Promise<boolean> {
    const r = await this.get<{ deployed: boolean }>("/deployed", { address: depositWallet, type: "WALLET" });
    return !!r.deployed;
  }

  /** Deploy the deposit wallet (gasless WALLET-CREATE). No batch signature needed. */
  async submitDeploy(from: string): Promise<RelaySubmitResult> {
    return this.submit({ type: "WALLET-CREATE", from, to: DEPOSIT_WALLET_FACTORY });
  }

  /** Authorize + submit a batch of calls FROM the deposit wallet (gasless). */
  async submitBatch(signer: Pick<EvmSigner, "signDigest" | "address">, depositWallet: Hex, calls: DepositWalletCall[], deadline: number | string): Promise<RelaySubmitResult> {
    const from = signer.address;
    const nonce = await this.getNonce(from);
    // deadline (and nonce) MUST be a uint256 STRING in the payload — the relayer
    // rejects a JSON number ("invalid transaction request payload"). PolyNews's prod
    // path stringifies it; we match. The EIP-712 sign BigInt()s it either way.
    const deadlineStr = String(deadline);
    const signature = signDepositWalletBatch(signer, { chainId: this.chainId, walletAddress: depositWallet, nonce, deadline: deadlineStr, calls });
    return this.submit({ type: "WALLET", from, to: DEPOSIT_WALLET_FACTORY, nonce, signature, depositWalletParams: { depositWallet, deadline: deadlineStr, calls } });
  }

  /** Poll a submitted relay tx to a terminal state. Resolves the tx hash on success,
   *  throws on STATE_FAILED/STATE_INVALID, throws on timeout. */
  async waitMined(transactionID: string, opts: { maxPolls?: number; pollMs?: number } = {}): Promise<string> {
    const maxPolls = opts.maxPolls ?? 30;
    const pollMs = opts.pollMs ?? 2500;
    for (let i = 0; i < maxPolls; i++) {
      const txns = await this.get<Array<{ state: string; transactionHash?: string }>>("/transaction", { id: transactionID }).catch(() => []);
      const txn = Array.isArray(txns) ? txns[0] : undefined;
      if (txn) {
        if (SUCCESS_STATES.has(txn.state)) return txn.transactionHash ?? "";
        if (FAIL_STATES.has(txn.state)) throw new Error(`relay tx ${transactionID} ${txn.state} (hash ${txn.transactionHash ?? "?"})`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`relay tx ${transactionID} did not reach a terminal state in ${maxPolls} polls`);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`${this.url}${path}?${qs}`, { method: "GET" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`relayer GET ${path} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
    return data as T;
  }

  private async submit(request: unknown): Promise<RelaySubmitResult> {
    const body = JSON.stringify(request);
    const ts = Math.floor(this.now() / 1000);
    const headers = { ...buildBuilderHeaders(this.creds, "POST", "/submit", body, ts), "Content-Type": "application/json" };
    const res = await this.fetchImpl(`${this.url}/submit`, { method: "POST", headers, body });
    const data = (await res.json().catch(() => ({}))) as RelaySubmitResult & { error?: string };
    if (!res.ok || !data.transactionID) throw new Error(`relayer /submit -> HTTP ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }
}
