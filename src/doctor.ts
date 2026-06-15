// src/doctor.ts — `starling-mcp doctor`: boot/hygiene checks for the server side.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { starlingDir, keystoreDir } from "./keystore/store.js";
import { CHAINS } from "./keystore/format.js";

type Level = "PASS" | "WARN" | "FAIL";
const isWin = process.platform === "win32";
const line = (lvl: Level, msg: string) =>
  process.stdout.write(`  ${lvl === "PASS" ? "✓" : lvl === "WARN" ? "!" : "✗"} ${msg}\n`);

export async function run(): Promise<void> {
  let fail = 0;
  process.stdout.write("starling-mcp doctor\n");

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) line("PASS", `Node ${process.versions.node}`);
  else (line("FAIL", `Node ${process.versions.node} — need ≥20`), fail++);

  if (Buffer.compare(randomBytes(32), randomBytes(32)) !== 0) line("PASS", "CSPRNG ok");
  else (line("FAIL", "randomBytes returned identical buffers"), fail++);

  let any = false;
  for (const chain of CHAINS) {
    const p = path.join(keystoreDir(), `${chain}.keystore.json`);
    try {
      const st = await fs.stat(p);
      any = true;
      if (!isWin && (st.mode & 0o077) !== 0) (line("FAIL", `${chain}.keystore.json group/world-readable (chmod 600)`), fail++);
      else line("PASS", `${chain} keystore present`);
    } catch {
      /* venue not configured */
    }
  }
  if (!any) line("WARN", `no keystores in ${keystoreDir()} — run 'agent-wallet init'`);

  const mode = process.env.STARLING_UNLOCK_MODE ?? "keychain";
  if (mode === "env" && !process.env.STARLING_KEYSTORE_PASSPHRASE)
    (line("FAIL", "unlock=env but STARLING_KEYSTORE_PASSPHRASE unset"), fail++);
  else line("PASS", `unlock mode = ${mode}`);

  const leaky = Object.keys(process.env).filter((k) =>
    /^NEXT_PUBLIC_.*(KEY|SECRET|MNEMONIC|PRIV|PASSPHRASE)/i.test(k),
  );
  if (leaky.length) (line("FAIL", `NEXT_PUBLIC_ secrets in env: ${leaky.join(", ")}`), fail++);
  else line("PASS", "no NEXT_PUBLIC_ secret leak");

  if ((process.env.STARLING_NETWORK ?? "testnet") === "mainnet" && mode === "file")
    (line("FAIL", "mainnet + plaintext file unlock is forbidden — use tpm|kms|env"), fail++);

  void starlingDir;
  process.stdout.write(fail ? `\n${fail} FAIL\n` : "\nAll checks passed.\n");
  if (fail) process.exitCode = 1;
}
