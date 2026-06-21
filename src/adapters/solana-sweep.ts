// src/adapters/solana-sweep.ts
// Build an UNSIGNED legacy Solana transaction that sweeps a wallet to a recipient
// on the SAME chain: an idempotent create of the recipient's USDC ATA, an SPL
// USDC transfer, and a native SOL transfer. No @solana/web3.js — the message wire
// format is hand-assembled (same spirit as solana-tx.ts) so the local @noble
// signer signs it and the Executor broadcasts. The Executor simulates BEFORE it
// sends (simulateFirst), so a malformed build fails closed (no funds move).
//
// Wire format (LEGACY message, no version prefix):
//   [header 3B][shortvec nKeys][keys*32][recentBlockhash 32B][shortvec nIx][ix...]
//   ix = [programIdIndex 1B][shortvec nAccts][acctIdx*1B][shortvec dataLen][data]
// Account ordering MUST be: writable-signer, readonly-signer, writable-nonsigner,
// readonly-nonsigner. Index 0 (writable-signer) = fee payer = the owner.
import { base58 } from "@scure/base";
import { writeShortVec } from "./solana-tx.js";
import { associatedTokenAddress } from "./solana-rpc.js";
import { USDC_MINT } from "./jupiter.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const ZERO_BLOCKHASH = new Uint8Array(32); // Executor.refreshBlockhash overwrites this

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function cat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export interface SweepPlan {
  /** base64 unsigned legacy tx (blockhash is a placeholder the Executor refreshes). */
  unsignedTxB64: string;
  /** Human description of what the tx does (for the ack / logs). */
  summary: string;
}

/**
 * Build the sweep. `usdcBaseUnits` (6dp) and `solLamports` are the amounts to send;
 * pass 0n to skip that leg. Throws if both are zero. The recipient's USDC ATA is
 * created idempotently (cost ~0.002 SOL rent, paid by owner) so it works whether or
 * not the recipient already holds USDC.
 */
export function buildSolanaSweep(args: {
  owner: string;
  recipient: string;
  usdcBaseUnits: bigint;
  solLamports: bigint;
}): SweepPlan {
  const { owner, recipient, usdcBaseUnits, solLamports } = args;
  if (usdcBaseUnits <= 0n && solLamports <= 0n) throw new Error("nothing to sweep (both amounts zero)");
  if (owner === recipient) throw new Error("owner and recipient are the same address");

  const srcAta = associatedTokenAddress(owner, USDC_MINT);
  const dstAta = associatedTokenAddress(recipient, USDC_MINT);
  const doUsdc = usdcBaseUnits > 0n;
  const doSol = solLamports > 0n;

  // ── account table, ordered by privilege (signer-writable, RO-signer, NS-writable, RO-NS) ──
  const keys: string[] = [owner];                 // index 0: writable + signer (fee payer)
  const idx: Record<string, number> = { [owner]: 0 };
  const add = (k: string) => { if (!(k in idx)) { idx[k] = keys.length; keys.push(k); } };

  // writable non-signers
  add(recipient);                                 // system 'to' and/or ATA-create owner slot
  if (doUsdc) { add(dstAta); add(srcAta); }
  const readonlyStart = keys.length;
  // readonly non-signers (incl. all program ids)
  if (doUsdc) { add(USDC_MINT); add(TOKEN_PROGRAM); add(ATA_PROGRAM); }
  add(SYSTEM_PROGRAM);                             // referenced by system transfer and ATA create

  const numReadonlyUnsigned = keys.length - readonlyStart;
  const header = new Uint8Array([1, 0, numReadonlyUnsigned]); // 1 signer, 0 ro-signed, N ro-unsigned

  // ── instructions ────────────────────────────────────────────────────────────
  const encodeIx = (programId: string, acctIdxs: number[], data: Uint8Array) =>
    cat(
      new Uint8Array([idx[programId]]),
      new Uint8Array(writeShortVec(acctIdxs.length)),
      new Uint8Array(acctIdxs),
      new Uint8Array(writeShortVec(data.length)),
      data,
    );

  const ixBytes: Uint8Array[] = [];
  if (doUsdc) {
    // createAssociatedTokenAccountIdempotent (ATA program, data=[1]):
    //   [payer, ata, owner, mint, systemProgram, tokenProgram]
    ixBytes.push(encodeIx(ATA_PROGRAM,
      [idx[owner], idx[dstAta], idx[recipient], idx[USDC_MINT], idx[SYSTEM_PROGRAM], idx[TOKEN_PROGRAM]],
      new Uint8Array([1])));
    // SPL Token Transfer (token program, ix 3): [source, dest, owner], data=[3]+u64(amount)
    ixBytes.push(encodeIx(TOKEN_PROGRAM, [idx[srcAta], idx[dstAta], idx[owner]],
      cat(new Uint8Array([3]), u64le(usdcBaseUnits))));
  }
  if (doSol) {
    // System Transfer (system program, ix 2): [from, to], data=[2,0,0,0]+u64(lamports)
    ixBytes.push(encodeIx(SYSTEM_PROGRAM, [idx[owner], idx[recipient]],
      cat(new Uint8Array([2, 0, 0, 0]), u64le(solLamports))));
  }

  const message = cat(
    header,
    new Uint8Array(writeShortVec(keys.length)),
    ...keys.map((k) => base58.decode(k)),
    ZERO_BLOCKHASH,
    new Uint8Array(writeShortVec(ixBytes.length)),
    ...ixBytes,
  );
  // Legacy tx = [shortvec(1 sig)][1 empty 64B sig slot][message]
  const tx = cat(new Uint8Array(writeShortVec(1)), new Uint8Array(64), message);

  const parts: string[] = [];
  if (doUsdc) parts.push(`${Number(usdcBaseUnits) / 1e6} USDC`);
  if (doSol) parts.push(`${Number(solLamports) / 1e9} SOL`);
  return {
    unsignedTxB64: Buffer.from(tx).toString("base64"),
    summary: `sweep ${parts.join(" + ")} -> ${recipient}`,
  };
}
