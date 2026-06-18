// src/withdraw/pinned-file.test.ts
// Proves the dashboard-pinned treasury reader + the pure mergeTreasury precedence,
// and pins the cross-language commitment vectors that MUST match the Python
// dashboard (tests/test_treasury.py). If canonical normalization ever drifts,
// these and the Python golden tests fail together.
//
// Run: node --test dist/withdraw/pinned-file.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizePinnedAddress,
  mergeTreasury,
  readPinnedTreasury,
  type PinnedTreasuryFile,
} from "./pinned-file.js";
import type { SealedTreasury } from "./allowlist.js";
import { treasuryCommitment } from "../keystore/treasury-seal.js";

const EVM = "0x1111111111111111111111111111111111111111";
const EVM2 = "0x2222222222222222222222222222222222222222";
const EVM_LC = "0xabcdef0000000000000000000000000000000001";
const EVM_UC = "0xABCDEF0000000000000000000000000000000001";
const SOL = "11111111111111111111111111111111"; // 32 base58 '1's = 32 zero bytes (System Program)

// ── address validation / normalization ────────────────────────────────────

test("normalizePinnedAddress: EVM validated + lowercased; Solana kept as-is", () => {
  assert.equal(normalizePinnedAddress("polygon", EVM_UC), EVM_LC);
  assert.equal(normalizePinnedAddress("polygon", `  ${EVM}  `), EVM); // trims
  assert.equal(normalizePinnedAddress("polygon", "0x123"), null); // too short
  assert.equal(normalizePinnedAddress("polygon", EVM.slice(2)), null); // missing 0x
  assert.equal(normalizePinnedAddress("solana", SOL), SOL);
  assert.equal(normalizePinnedAddress("solana", "0OIl_not_base58"), null);
  assert.equal(normalizePinnedAddress("solana", "abc"), null); // decodes to < 32 bytes
  assert.equal(normalizePinnedAddress("polygon", 123 as unknown as string), null);
  assert.equal(normalizePinnedAddress("polygon", ""), null);
});

// ── mergeTreasury precedence matrix ────────────────────────────────────────

const ksOnly: SealedTreasury = { sealed: true, byChain: { polygon: EVM } };
const ksLettered: SealedTreasury = { sealed: true, byChain: { polygon: EVM_LC } };
const plaintext: SealedTreasury = { sealed: false, byChain: {} };

test("mergeTreasury: keystore-only unchanged (file null)", () => {
  const m = mergeTreasury(ksOnly, null);
  assert.equal(m.sealed, true);
  assert.equal(m.byChain.polygon, EVM);
  assert.equal(m.sourceByChain?.polygon, "keystore");
});

test("mergeTreasury: file-only fills a plaintext keystore (sealed stays false)", () => {
  const file: PinnedTreasuryFile = { version: 1, byChain: { polygon: EVM, solana: SOL } };
  const m = mergeTreasury(plaintext, file);
  assert.equal(m.sealed, false);
  assert.equal(m.byChain.polygon, EVM);
  assert.equal(m.sourceByChain?.polygon, "dashboard");
  assert.equal(m.sourceByChain?.solana, "dashboard");
});

test("mergeTreasury: keystore + AGREEING file = keystore (case-insensitive EVM)", () => {
  const m = mergeTreasury(ksLettered, { version: 1, byChain: { polygon: EVM_UC } });
  assert.equal(m.sourceByChain?.polygon, "keystore");
});

test("mergeTreasury: keystore + DISAGREEING file = conflict (keeps keystore addr)", () => {
  const m = mergeTreasury(ksOnly, { version: 1, byChain: { polygon: EVM2 } });
  assert.equal(m.byChain.polygon, EVM); // stronger source's address retained
  assert.equal(m.sourceByChain?.polygon, "conflict");
});

test("mergeTreasury: per-chain mixed (keystore polygon + dashboard solana)", () => {
  const m = mergeTreasury(ksOnly, { version: 1, byChain: { solana: SOL } });
  assert.equal(m.sourceByChain?.polygon, "keystore");
  assert.equal(m.sourceByChain?.solana, "dashboard");
});

test("mergeTreasury: a plaintext keystore's byChain is NOT trusted without a seal", () => {
  // sealed=false means the keystore source isn't authenticated; its byChain is ignored.
  const spoof: SealedTreasury = { sealed: false, byChain: { polygon: EVM2 } };
  const m = mergeTreasury(spoof, { version: 1, byChain: { polygon: EVM } });
  assert.equal(m.byChain.polygon, EVM); // dashboard wins, no false "conflict"
  assert.equal(m.sourceByChain?.polygon, "dashboard");
});

// ── readPinnedTreasury (disk; STARLING_DIR-scoped temp dir) ─────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starling-treasury-"));
  const prev = process.env.STARLING_DIR;
  process.env.STARLING_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.STARLING_DIR;
    else process.env.STARLING_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("readPinnedTreasury: absent file -> null", async () => {
  await withTempDir(async () => assert.equal(await readPinnedTreasury(), null));
});

test("readPinnedTreasury: valid file parses + normalizes EVM", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "treasury.json"), JSON.stringify({ version: 1, byChain: { polygon: EVM_UC, solana: SOL } }));
    const f = await readPinnedTreasury();
    assert.ok(f);
    assert.equal(f.byChain.polygon, EVM_LC);
    assert.equal(f.byChain.solana, SOL);
  });
});

test("readPinnedTreasury: invalid JSON -> null", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "treasury.json"), "{ not json");
    assert.equal(await readPinnedTreasury(), null);
  });
});

test("readPinnedTreasury: drops invalid addresses, keeps valid ones", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "treasury.json"), JSON.stringify({ version: 1, byChain: { polygon: "0xnope", solana: SOL } }));
    const f = await readPinnedTreasury();
    assert.ok(f);
    assert.equal(f.byChain.polygon, undefined);
    assert.equal(f.byChain.solana, SOL);
  });
});

test("readPinnedTreasury: no valid address -> null", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "treasury.json"), JSON.stringify({ version: 1, byChain: { polygon: "0xnope" } }));
    assert.equal(await readPinnedTreasury(), null);
  });
});

// ── commitment cross-vectors (MUST equal the Python dashboard's output) ─────

test("treasuryCommitment golden vectors (match tests/test_treasury.py)", async () => {
  assert.equal(await treasuryCommitment({ chain: "polygon", treasury: EVM }), "aae22ddc");
  assert.equal(await treasuryCommitment({ chain: "polygon", treasury: "0xAbC0000000000000000000000000000000000001" }), "6b2290f4");
  assert.equal(await treasuryCommitment({ chain: "solana", treasury: SOL }), "538f69a0");
});
