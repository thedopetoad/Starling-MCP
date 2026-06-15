// src/unlock/index.ts
// Resolves the keystore passphrase at boot, per STARLING_UNLOCK_MODE. Every mode
// degrades gracefully and logs reasons to STDERR (stdout is reserved for MCP
// JSON-RPC). There is intentionally NO `stdin-once` mode for the stdio server:
// the MCP client launches this process and immediately speaks JSON-RPC on the
// pipe, so a passphrase cannot be piped in first.
import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { starlingDir } from "../keystore/store.js";

const log = (m: string) => process.stderr.write(`[starling:unlock] ${m}\n`);
const isMainnet = () => (process.env.STARLING_NETWORK ?? "testnet") === "mainnet";

export type UnlockMode = "keychain" | "env" | "tpm" | "kms" | "file";

/** Resolve the passphrase as a Buffer the caller MUST zeroize. */
export async function resolvePassphrase(): Promise<Buffer> {
  const mode = (process.env.STARLING_UNLOCK_MODE ?? "keychain") as UnlockMode;
  switch (mode) {
    case "keychain": {
      const pass = await tryKeychain();
      if (pass) return pass;
      log("keychain unavailable here (SSH/launchd/no-Secret-Service?); falling back to env");
      return fromEnvOrThrow();
    }
    case "env":
      return fromEnvOrThrow();
    case "tpm":
      return fromTpmCredential();
    case "kms":
      return fromKms();
    case "file":
      return fromFileGuarded();
    default:
      throw new Error(`unknown STARLING_UNLOCK_MODE=${mode}`);
  }
}

// PROBE: actually attempt to load + read, catching the dlopen failure when the
// prebuilt @napi-rs/keyring binary can't link libsecret (Alpine/musl/slim/
// headless) or macOS returns "interaction not allowed".
async function tryKeychain(): Promise<Buffer | null> {
  const spec = "@napi-rs/keyring";
  try {
    const mod: any = await import(spec);
    const secret = new mod.Entry("starling-mcp", "keystore-passphrase").getPassword();
    return secret ? Buffer.from(secret, "utf8") : null;
  } catch (e) {
    log(`keychain probe failed: ${(e as Error).message}`);
    return null;
  }
}

function fromEnvOrThrow(): Buffer {
  const v = process.env.STARLING_KEYSTORE_PASSPHRASE;
  if (!v) {
    throw new Error(
      "STARLING_KEYSTORE_PASSPHRASE not set (inject it via a KMS/secrets-manager run-wrapper)",
    );
  }
  return Buffer.from(v, "utf8");
}

async function fromTpmCredential(): Promise<Buffer> {
  const dir = process.env.CREDENTIALS_DIRECTORY; // systemd LoadCredentialEncrypted
  if (!dir) {
    throw new Error("tpm unlock needs systemd LoadCredentialEncrypted ($CREDENTIALS_DIRECTORY unset)");
  }
  return Buffer.from(await fs.readFile(path.join(dir, "starling_passphrase")));
}

async function fromKms(): Promise<Buffer> {
  // Decrypt a sealed blob with the instance role; no static creds. Wiring is
  // deployment-specific — see README "KMS unlock".
  throw new Error("kms unlock requires deployment-specific wiring; see README");
}

// Plaintext file — testnet last resort only. Forbidden on mainnet, and refused
// if it sits inside ~/.starling (co-located plaintext defeats the at-rest win).
async function fromFileGuarded(): Promise<Buffer> {
  const p = process.env.STARLING_PASSPHRASE_FILE;
  if (!p) throw new Error("STARLING_PASSPHRASE_FILE not set");
  if (isMainnet()) {
    throw new Error("plaintext passphrase file is forbidden on mainnet; use --unlock tpm|kms or secrets-manager env");
  }
  if (path.resolve(p).startsWith(path.resolve(starlingDir()))) {
    throw new Error("passphrase file must not live inside ~/.starling");
  }
  if (process.platform !== "win32" && (statSync(p).mode & 0o077) !== 0) {
    throw new Error(`${p} must be mode 0400/0600`);
  }
  return Buffer.from(await fs.readFile(p));
}
