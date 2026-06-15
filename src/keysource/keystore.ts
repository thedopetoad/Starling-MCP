// src/keysource/keystore.ts
// The SAFE source: per-chain encrypted "Starling Keystore v1" files written by
// thedopetoad/Agent-Wallet-Setup. Decrypted in-process using the passphrase the
// unlock resolver provides (keychain/env/tpm/kms/file). Keys are encrypted at
// rest; nothing plaintext touches disk.
import { readKeystore, keystoreExists, keystoreDir } from "../keystore/store.js";
import { decryptKeystore } from "../keystore/crypto.js";
import { CHAINS } from "../keystore/format.js";
import { resolvePassphrase } from "../unlock/index.js";
import type { ChainSecret, KeySource } from "./types.js";

export const keystoreSource: KeySource = {
  id: "keystore",
  plaintext: false,
  describe: () =>
    `encrypted keystore at ${keystoreDir()} (unlock=${process.env.STARLING_UNLOCK_MODE ?? "keychain"})`,
  available: async () => {
    for (const c of CHAINS) if (await keystoreExists(c)) return true;
    return false;
  },
  load: async (): Promise<ChainSecret[]> => {
    const pass = await resolvePassphrase();
    try {
      const out: ChainSecret[] = [];
      for (const chain of CHAINS) {
        const ks = await readKeystore(chain).catch(() => null);
        if (!ks) continue;
        out.push({ chain, secret: decryptKeystore(ks, pass) });
      }
      return out;
    } finally {
      pass.fill(0);
    }
  },
};
