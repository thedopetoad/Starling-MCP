// src/doctor.ts — `starling-mcp doctor`: boot/hygiene checks for the server side.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { starlingDir, keystoreDir } from "./keystore/store.js";
import { CHAINS } from "./keystore/format.js";
import { resolveKeySource } from "./keysource/index.js";

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

  // Which key source will the server sign from?
  const source = await resolveKeySource().catch((e) => {
    line("FAIL", `key source: ${(e as Error).message}`);
    fail++;
    return null;
  });
  const onMainnet = (process.env.STARLING_NETWORK ?? "testnet") === "mainnet";
  if (!source) {
    line("WARN", "no key source available — set STARLING_PK_* or run 'agent-wallet init'");
  } else {
    line(source.plaintext && onMainnet ? "WARN" : "PASS", `key source: ${source.describe()}`);
    if (source.plaintext && onMainnet) {
      line("WARN", "plaintext keys on mainnet — graduate to the encrypted keystore (agent-wallet init)");
    }
    // keystore source: keep the keystore-file hygiene + unlock checks
    if (source.id === "keystore") {
      for (const chain of CHAINS) {
        const p = path.join(keystoreDir(), `${chain}.keystore.json`);
        try {
          const st = await fs.stat(p);
          if (!isWin && (st.mode & 0o077) !== 0)
            (line("FAIL", `${chain}.keystore.json group/world-readable (chmod 600)`), fail++);
          else line("PASS", `${chain} keystore present`);
        } catch {
          /* venue not configured */
        }
      }
      const mode = process.env.STARLING_UNLOCK_MODE ?? "keychain";
      if (mode === "env" && !process.env.STARLING_KEYSTORE_PASSPHRASE)
        (line("FAIL", "unlock=env but STARLING_KEYSTORE_PASSPHRASE unset"), fail++);
      else if (onMainnet && mode === "file")
        (line("FAIL", "mainnet + plaintext file unlock is forbidden — use tpm|kms|env"), fail++);
      else line("PASS", `unlock mode = ${mode}`);
    }
  }

  const leaky = Object.keys(process.env).filter((k) =>
    /^NEXT_PUBLIC_.*(KEY|SECRET|MNEMONIC|PRIV|PASSPHRASE)/i.test(k),
  );
  if (leaky.length) (line("FAIL", `NEXT_PUBLIC_ secrets in env: ${leaky.join(", ")}`), fail++);
  else line("PASS", "no NEXT_PUBLIC_ secret leak");

  void starlingDir;
  process.stdout.write(fail ? `\n${fail} FAIL\n` : "\nAll checks passed.\n");
  if (fail) process.exitCode = 1;
}
