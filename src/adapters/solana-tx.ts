// src/adapters/solana-tx.ts
// Sign a Solana (v0 or legacy) transaction with ONLY @noble ed25519 + raw bytes —
// no @solana/web3.js. Jupiter returns a base64 UNSIGNED transaction; we parse the
// wire format, sign the exact message bytes locally, and drop our 64-byte sig into
// the fee-payer slot. Grounded in the solana-signing research (solana.com/docs):
//
//   tx = shortvec(sigCount) ++ sigCount×64-byte sig slots ++ MESSAGE
//   signed payload = the ENTIRE message (everything after the sig array),
//                    INCLUDING the v0 0x80 version-prefix byte.
//   account index 0 = fee payer = first required signer = sig slot 0.
//
// We REFUSE to sign unless (a) the tx needs exactly one signature and (b) account
// index 0 equals our own pubkey — so a malformed/foreign tx can't be signed blind.
// The signer is passed as an {address, signBytes} pair (the SolanaSigner) so the
// raw seed stays sealed in its closure and never crosses this boundary.
import { base58 } from "@scure/base";

/** Just the surface signTransaction needs from the local Solana signer. */
export interface MessageSigner {
  address: string;
  signBytes(message: Uint8Array): Uint8Array; // 64-byte detached ed25519 sig
}

export class SolanaTxError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SolanaTxError";
  }
}

/** Decode a compact-u16 (shortvec) at `offset`. Returns [value, bytesRead].
 *  FAILS CLOSED on truncation: reading past the buffer throws instead of
 *  silently treating a missing byte as 0x00 (which would let a truncated tx
 *  decode a phantom count and mis-locate the fee payer). */
export function readShortVec(buf: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let i = 0;
  for (;;) {
    if (offset + i >= buf.length) throw new SolanaTxError("truncated", "shortvec reads past end of buffer");
    const b = buf[offset + i];
    value |= (b & 0x7f) << (7 * i);
    i++;
    if ((b & 0x80) === 0) break;
    if (i > 3) throw new SolanaTxError("bad_shortvec", "compact-u16 exceeds 3 bytes");
  }
  return [value, i];
}

/** Encode a number as a compact-u16 (shortvec). */
export function writeShortVec(n: number): number[] {
  if (n < 0 || n > 0xffff) throw new SolanaTxError("bad_shortvec", `value ${n} out of u16 range`);
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

interface ParsedTx {
  sigCount: number;
  sigStart: number; // offset where the sig slots begin (== shortvec length)
  messageStart: number; // offset where the message begins
  message: Uint8Array;
}

function parseTx(buf: Uint8Array): ParsedTx {
  const [sigCount, sigStart] = readShortVec(buf, 0);
  const messageStart = sigStart + 64 * sigCount;
  if (messageStart > buf.length) throw new SolanaTxError("truncated", "signature region exceeds tx length");
  return { sigCount, sigStart, messageStart, message: buf.subarray(messageStart) };
}

/**
 * The fee payer (account index 0) + required-signature count of a message.
 * Handles both v0 (0x80 prefix) and legacy (no prefix) layouts.
 */
export function readFeePayer(message: Uint8Array): { numRequiredSignatures: number; feePayer: string } {
  if (message.length === 0) throw new SolanaTxError("truncated", "empty message");
  let off = 0;
  const first = message[0];
  if (first & 0x80) off = 1; // v0/versioned: skip the version-prefix byte
  // need the version byte (if any) + the 3-byte header before indexing it
  if (message.length < off + 3) throw new SolanaTxError("truncated", "message too short for header");
  const numRequiredSignatures = message[off]; // header byte 0
  // header is 3 bytes; static account keys count is a shortvec right after it
  const [, kLen] = readShortVec(message, off + 3);
  const accountsStart = off + 3 + kLen;
  const key0 = message.subarray(accountsStart, accountsStart + 32);
  if (key0.length !== 32) throw new SolanaTxError("truncated", "account key 0 is truncated");
  return { numRequiredSignatures, feePayer: base58.encode(key0) };
}

export interface SignResult {
  /** base64 fully-signed transaction, ready for sendTransaction (encoding base64). */
  signedTxB64: string;
  /** base58 of the first signature == the transaction id. */
  txid: string;
}

/**
 * Sign an unsigned base64 transaction with the local signer and return the signed
 * base64 + the txid. REFUSES (throws) unless the tx requires exactly one signature
 * and account index 0 is the signer's address — we never sign a tx whose fee payer
 * isn't us, and never leave a foreign required-signer slot unfilled.
 */
export function signTransaction(unsignedTxB64: string, signer: MessageSigner): SignResult {
  const buf = Uint8Array.from(Buffer.from(unsignedTxB64, "base64"));
  const { sigCount, sigStart, message } = parseTx(buf);

  const { numRequiredSignatures, feePayer } = readFeePayer(message);
  if (numRequiredSignatures !== 1 || sigCount !== 1) {
    throw new SolanaTxError(
      "multisig_unsupported",
      `tx needs ${numRequiredSignatures} signatures (sigCount ${sigCount}); only single-signer txs are supported`,
    );
  }
  if (feePayer !== signer.address) {
    throw new SolanaTxError(
      "fee_payer_mismatch",
      `tx fee payer ${feePayer} != our address ${signer.address} — refusing to sign`,
    );
  }

  const sig = signer.signBytes(message); // 64 bytes over the FULL message
  if (sig.length !== 64) throw new SolanaTxError("bad_signature", `expected 64-byte signature, got ${sig.length}`);
  const signed = Uint8Array.from(buf); // copy
  signed.set(sig, sigStart); // overwrite slot 0 (fee payer)
  return {
    signedTxB64: Buffer.from(signed).toString("base64"),
    txid: base58.encode(sig),
  };
}
