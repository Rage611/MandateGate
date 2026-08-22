import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "crypto";

/**
 * An Ed25519 keypair encoded as base64 strings for safe storage in env vars.
 *
 * Encoding format:
 *   publicKey  — SPKI  DER → base64
 *   privateKey — PKCS8 DER → base64
 *
 * These are standard formats accepted by Node's `createPublicKey` /
 * `createPrivateKey` without any third-party library.
 */
export interface Ed25519KeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * Generates a fresh Ed25519 keypair and returns both keys as base64 strings.
 *
 * Usage: run `scripts/generate-keys.ts` once, copy the output into .env.local.
 * Never call this at request time — key generation is expensive and keys should
 * be long-lived.
 */
export function generateMandateKeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/**
 * Reconstructs a KeyObject from a base64-encoded SPKI DER public key.
 * Throws if the input is not a valid Ed25519 public key.
 */
export function importPublicKey(base64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "spki",
  });
}

/**
 * Reconstructs a KeyObject from a base64-encoded PKCS8 DER private key.
 * Throws if the input is not a valid Ed25519 private key.
 */
export function importPrivateKey(base64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
}
