// src/adapters/hl-msgpack.test.ts
// Canonical MessagePack integer vectors — the regression guard for the int encoder.
// The live HL test caught that order ids (> 2^32) and negative ntli (remove-margin)
// were unencodable; these lock the full signed/unsigned range to python msgpack's
// smallest-type output. Map/array/string framing is covered in hl-signing.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { packb } from "./hl-msgpack.js";

const bytes = (n: number) => Array.from(packb(n));

test("non-negative ints: fixint / uint8 / uint16 / uint32 (smallest type)", () => {
  assert.deepEqual(bytes(0), [0x00]);
  assert.deepEqual(bytes(127), [0x7f]);
  assert.deepEqual(bytes(128), [0xcc, 0x80]);
  assert.deepEqual(bytes(255), [0xcc, 0xff]);
  assert.deepEqual(bytes(256), [0xcd, 0x01, 0x00]);
  assert.deepEqual(bytes(65535), [0xcd, 0xff, 0xff]);
  assert.deepEqual(bytes(65536), [0xce, 0x00, 0x01, 0x00, 0x00]);
  assert.deepEqual(bytes(4294967295), [0xce, 0xff, 0xff, 0xff, 0xff]);
});

test("uint64: 2^32 boundary + a real order id round-trip", () => {
  assert.deepEqual(bytes(4294967296), [0xcf, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const oid = 474726498842; // the live order id that previously threw
  const b = packb(oid);
  assert.equal(b[0], 0xcf);
  assert.equal(b.length, 9);
  let v = 0n;
  for (let i = 1; i < 9; i++) v = (v << 8n) | BigInt(b[i]);
  assert.equal(Number(v), oid);
});

test("negative ints: negative-fixint / int8 / int16 / int32 (smallest type)", () => {
  assert.deepEqual(bytes(-1), [0xff]);
  assert.deepEqual(bytes(-32), [0xe0]);
  assert.deepEqual(bytes(-33), [0xd0, 0xdf]);
  assert.deepEqual(bytes(-128), [0xd0, 0x80]);
  assert.deepEqual(bytes(-129), [0xd1, 0xff, 0x7f]);
  assert.deepEqual(bytes(-2_000_000), [0xd2, 0xff, 0xe1, 0x7b, 0x80]); // remove-margin ntli
});

test("int64: a large negative round-trips as two's complement", () => {
  const n = -5_000_000_000; // below -2^31
  const b = packb(n);
  assert.equal(b[0], 0xd3);
  assert.equal(b.length, 9);
  let u = 0n;
  for (let i = 1; i < 9; i++) u = (u << 8n) | BigInt(b[i]);
  const signed = u >= 1n << 63n ? u - (1n << 64n) : u;
  assert.equal(Number(signed), n);
});

test("floats are still rejected (prices/sizes must be strings on the wire)", () => {
  assert.throws(() => packb(1.5), /only integers/);
});
