// src/adapters/hl-msgpack.ts
// A MINIMAL MessagePack encoder — exactly the value types Hyperliquid L1 actions
// use: maps with string keys in INSERTION order, arrays, UTF-8 strings, booleans,
// and non-negative integers. HL hashes the msgpack bytes of the action, so this
// MUST be byte-exact to the reference encoder (python `msgpack.packb` / the TS
// SDK). It is locked by hl-signing.test.ts, which reproduces the official SDK
// signature vector end-to-end — a single wrong byte changes the action hash and
// the signature no longer matches.
//
// Deliberately NOT a general msgpack lib: floats, negative ints, null, bin, and
// ext are REJECTED so a malformed action can never silently mis-encode (HL order
// prices/sizes are STRINGS on the wire; the only ints are the asset index and an
// optional builder fee). Map key order is taken from JS object insertion order,
// which is well-defined for the non-integer string keys HL uses.

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
  if (typeof v === "number") return packUint(v, out);
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

function packUint(n: number, out: number[]): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`hl-msgpack: only non-negative integers are supported (got ${n})`);
  }
  if (n < 128) out.push(n); // positive fixint
  else if (n < 256) out.push(0xcc, n); // uint8
  else if (n < 65536) out.push(0xcd, (n >> 8) & 0xff, n & 0xff); // uint16
  else if (n < 4294967296) {
    out.push(0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); // uint32
  } else throw new Error("hl-msgpack: integer too large");
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
