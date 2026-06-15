// AUTO-GENERATED shared interop vector — DO NOT EDIT BY HAND.
// This frozen keystore is encrypted with "Starling Keystore v1" and is shipped
// IDENTICALLY in both Agent-Wallet-Setup and Starling-MCP. Each repo's test
// decrypts it and asserts the secret + re-derived address, so any drift in
// src/keystore/crypto.ts breaks CI in at least one repo.
import type { KeystoreV1 } from "./format.js";

export const VECTOR_PASSPHRASE = "starling-interop-test-vector-v1";

export interface Vector {
  chain: string;
  address: string;
  secretHex: string;
  keystore: KeystoreV1;
}

export const VECTORS: Vector[] = [
  {
    "chain": "polygon",
    "address": "0x6370eF2f4Db3611D657b90667De398a2Cc2a370C",
    "secretHex": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    "keystore": {
      "version": 1,
      "chain": "polygon",
      "address": "0x6370eF2f4Db3611D657b90667De398a2Cc2a370C",
      "uuid": "dcd1bfe4-a57a-40e3-a848-913c25077c2a",
      "crypto": {
        "kdf": {
          "function": "argon2id",
          "params": {
            "m": 65536,
            "t": 3,
            "p": 1,
            "salt": "11a3429e644be1fc1978a4c9e120569d"
          }
        },
        "cipher": {
          "function": "xchacha20poly1305",
          "params": {
            "nonce": "e6676d43a0042b01efdce0aa312d29a8c4d30a7ae9931167"
          },
          "message": "75d13cff2e4e5e8bdde7c91fa4b0b89c412582b9cba2a6474fcb21e39648feab1a5c4f47ec513413a63a0212565d7809"
        }
      }
    }
  },
  {
    "chain": "solana",
    "address": "GcQfK48DV9BzDuDeCyV2sShbAAY4vqmK8JSj1NBrwoVZ",
    "secretHex": "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40",
    "keystore": {
      "version": 1,
      "chain": "solana",
      "address": "GcQfK48DV9BzDuDeCyV2sShbAAY4vqmK8JSj1NBrwoVZ",
      "uuid": "e9431717-65f2-4fcb-804d-103a5dc714d4",
      "crypto": {
        "kdf": {
          "function": "argon2id",
          "params": {
            "m": 65536,
            "t": 3,
            "p": 1,
            "salt": "2c7492b9fb6bc6d4cabbe46a3b76a1c7"
          }
        },
        "cipher": {
          "function": "xchacha20poly1305",
          "params": {
            "nonce": "529efc64293a42186ec7e240c76b438e5d28f2faa0eef771"
          },
          "message": "09c3fa61e51f5c67df7bddb17383b24e1af5ce868f6cfff0918d93a91b155ef9b05b8726eb9de28db00a55b262c87d93"
        }
      }
    }
  }
];
