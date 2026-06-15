// src/keystore/store.ts
// On-disk handling of keystores: atomic O_EXCL create at mode 0600 (no
// writeFile-then-chmod TOCTOU window), a restrictive Windows DACL via icacls,
// and a load-side refusal of group/world-readable files (ssh-style abort).
import { promises as fs, constants as FS } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isKeystoreV1, type KeystoreV1 } from "./format.js";

const isWin = process.platform === "win32";

/** Honour STARLING_DIR so tests / multi-profile setups can relocate everything. */
export function starlingDir(): string {
  return process.env.STARLING_DIR
    ? path.resolve(process.env.STARLING_DIR)
    : path.join(os.homedir(), ".starling");
}
export function keystoreDir(): string {
  return path.join(starlingDir(), "keystore");
}

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(keystoreDir(), { recursive: true, mode: 0o700 });
  if (!isWin) {
    await fs.chmod(starlingDir(), 0o700).catch(() => {});
  } else {
    lockdownWindowsAcl(starlingDir(), true);
  }
}

// Windows: POSIX chmod 0600 is a no-op on NTFS. Strip inheritance and grant ONLY
// the current user — referenced by SID, which always resolves to the running
// account (a `DOMAIN\user` string can fail to map and lock the owner OUT). icacls
// ships with Windows. (OI)(CI) inheritance flags are valid for directories only.
function currentUserSid(): string | null {
  try {
    const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const m = out.match(/S-1-[0-9-]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function lockdownWindowsAcl(p: string, isDir: boolean): void {
  const sid = currentUserSid();
  if (!sid) return; // best-effort — never risk locking the owner out
  const grant = isDir ? `*${sid}:(OI)(CI)F` : `*${sid}:(F)`;
  try {
    execFileSync("icacls", [p, "/inheritance:r", "/grant:r", grant], { stdio: "ignore" });
  } catch {
    /* surfaced by `doctor` rather than hard-failing the write */
  }
}

/**
 * Atomic, race-free write at the restrictive mode at CREATE time. O_EXCL means
 * we never clobber; writing to a temp file in the SAME dir then renaming means
 * the ciphertext never exists at the umask-default mode.
 */
export async function writeKeystore(ks: KeystoreV1): Promise<string> {
  await ensureDirs();
  const dest = path.join(keystoreDir(), `${ks.chain}.keystore.json`);
  const tmp = path.join(keystoreDir(), `.${ks.chain}.${process.pid}.tmp`);
  const body = JSON.stringify(ks, null, 2);

  await fs.rm(tmp, { force: true });
  const fh = await fs.open(tmp, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY, 0o600);
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, dest); // atomic on the same filesystem
  if (isWin) lockdownWindowsAcl(dest, false);
  return dest;
}

/** Refuse to load a keystore that an ssh-style hard abort would also refuse. */
export async function readKeystore(chain: string): Promise<KeystoreV1> {
  const p = path.join(keystoreDir(), `${chain}.keystore.json`);
  const st = await fs.stat(p);
  if (!isWin && (st.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to load ${p}: file is group/world-accessible (mode ${(st.mode & 0o777).toString(8)}). ` +
        `Run: chmod 600 "${p}"`,
    );
  }
  const parsed = JSON.parse(await fs.readFile(p, "utf8"));
  if (!isKeystoreV1(parsed)) throw new Error(`${p} is not a valid Starling Keystore v1`);
  return parsed;
}

export async function keystoreExists(chain: string): Promise<boolean> {
  return fs
    .access(path.join(keystoreDir(), `${chain}.keystore.json`))
    .then(() => true)
    .catch(() => false);
}
