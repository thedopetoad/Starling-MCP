// src/adapters/hl-msgpack.ts
// A MINIMAL MessagePack encoder — exactly the value types Hyperliquid L1 actions
// use: maps with string keys in INSERTION order, arrays, UTF-8 strings, booleans,
// and non-negative integers. HL hashes the msgpack bytes of the action, so this
// MUST be byte-exact to the reference encoder (python `msgpack.packb` / the TS
// SDK). It is locked by hl-signing.test.ts, which reproduces the official SDK
// signature vector end-to-end — a single wrong byte changes the action hash and
// the signature no longer matches.
//
// Deliberately NOT a general msgpack lib: floats, null, bin, and ext are REJECTED
// so a malformed action can never silently mis-encode (HL order prices/sizes are
// STRINGS on the wire). Integers ARE fully supported across the canonical range:
//   - non-negative -> fixint / uint8 / uint16 / uint32 / uint64 (smallest), and
//   - negative -> negative-fixint / int8 / int16 / int32 / int64 (smallest),
// matching python msgpack.packb. This matters because real actions carry large
// uints (cancel `o` = order id > 2^32; vaultTransfer `usd` micro-USD) and SIGNED
// ints (updateIsolatedMargin `ntli` is negative when REMOVING margin). Map key
// order is JS object insertion order, well-defined for the string keys HL uses.

const utf8 = new TextEncoder();

export function packb(value: unknown): Uint8Array {
  const out: number[] = [];
  packValue(value, out);
  return Uint8Array.from(out);
}

function packValue(v: unknown, out: number[]): void {
  if (v === true) return void out.push(0xc3);
  if (v === false) return void out.push(0xc2);
  if (typeof v === "string") return packStr(v, out);
  if (typeof v === "number") return packInt(v, out);
  if (Array.isArray(v)) return packArray(v, out);
  if (v !== null && typeof v === "object") return packMap(v as Record<string, unknown>, out);
  throw new Error(`hl-msgpack: unsupported value ${String(v)} (${typeof v})`);
}

function packStr(s: string, out: number[]): void {
  const bytes = utf8.encode(s);
  const n = bytes.length;
  if (n < 32) out.push(0xa0 | n); // fixstr
  else if (n < 256) out.push(0xd9, n); // str8
  else if (n < 65536) out.push(0xda, (n >> 8) & 0xff, n & 0xff); // str16
  else throw new Error("hl-msgpack: string too long");
  for (const b of bytes) out.push(b);
}

function packInt(n: number, out: number[]): void {
  if (!Number.isInteger(n)) {
    throw new Error(`hl-msgpack: only integers are supported (got ${n})`);
  }
  if (!Number.isSafeInteger(n)) {
    // > 2^53: JS can't represent it exactly, so we'd hash the wrong bytes. Refuse.
    throw new Error(`hl-msgpack: integer exceeds MAX_SAFE_INTEGER (${n})`);
  }
  if (n >= 0) {
    if (n < 0x80) out.push(n); // positive fixint
    else if (n < 0x100) out.push(0xcc, n); // uint8
    else if (n < 0x10000) out.push(0xcd, (n >> 8) & 0xff, n & 0xff); // uint16
    else if (n < 0x100000000) out.push(0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); // uint32
    else pushBig8(0xcf, BigInt(n), out); // uint64 (e.g. order ids, large micro-USD)
    return;
  }
  // negative — smallest signed type, two's complement (matches python msgpack).
  if (n >= -0x20) out.push(0x100 + n); // negative fixint (-32..-1)
  else if (n >= -0x80) out.push(0xd0, n & 0xff); // int8
  else if (n >= -0x8000) out.push(0xd1, (n >> 8) & 0xff, n & 0xff); // int16
  else if (n >= -0x80000000) out.push(0xd2, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); // int32
  else pushBig8(0xd3, BigInt(n) & ((1n << 64n) - 1n), out); // int64 (large negative ntli)
}

/** Push a tag byte then `u` as 8 big-endian bytes (uint64 / int64 body). */
function pushBig8(tag: number, u: bigint, out: number[]): void {
  out.push(tag);
  for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((u >> shift) & 0xffn));
}

function packArray(arr: unknown[], out: number[]): void {
  const n = arr.length;
  if (n < 16) out.push(0x90 | n); // fixarray
  else if (n < 65536) out.push(0xdc, (n >> 8) & 0xff, n & 0xff); // array16
  else throw new Error("hl-msgpack: array too long");
  for (const el of arr) packValue(el, out);
}

function packMap(obj: Record<string, unknown>, out: number[]): void {
  const keys = Object.keys(obj); // INSERTION order — HL relies on this exact order
  const n = keys.length;
  if (n < 16) out.push(0x80 | n); // fixmap
  else if (n < 65536) out.push(0xde, (n >> 8) & 0xff, n & 0xff); // map16
  else throw new Error("hl-msgpack: map too large");
  for (const k of keys) {
    packStr(k, out);
    packValue(obj[k], out);
  }
}
