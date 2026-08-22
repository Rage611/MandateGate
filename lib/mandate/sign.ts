import { randomUUID, sign as cryptoSign } from "crypto";
import { canonicalize } from "./canonicalize";
import { importPrivateKey } from "./keys";
import type { Mandate, MandateInput, UnsignedMandate } from "./types";

/**
 * Issues a new, fully signed Mandate.
 *
 * The caller provides the business fields (agent, principal, scope, limits,
 * validity, confirmation_threshold). This function adds the envelope fields
 * (mandate_id, nonce, status), builds the canonical payload, signs it with the
 * Ed25519 private key, and returns the complete Mandate object.
 *
 * @param input       - The mandate fields supplied by the caller.
 * @param privateKeyB64 - Base64-encoded PKCS8 DER private key (from MANDATE_SIGNING_PRIVATE_KEY).
 * @returns A complete, signed Mandate ready to be stored and transmitted.
 *
 * @throws If `privateKeyB64` is not a valid Ed25519 private key.
 */
export function issueMandate(
  input: MandateInput,
  privateKeyB64: string,
): Mandate {
  // Envelope fields generated here — callers must not supply these.
  const mandate_id = randomUUID();

  // The nonce is a separate randomUUID rather than reusing mandate_id so that
  // the nonce remains opaque even if the mandate_id is exposed externally.
  const nonce = randomUUID();

  const unsigned: UnsignedMandate = {
    ...input,
    mandate_id,
    nonce,
    status: "active",
  };

  // Sign the canonical byte sequence.
  const canonicalBytes = Buffer.from(canonicalize(unsigned), "utf8");
  const privateKey = importPrivateKey(privateKeyB64);

  // Ed25519 is a "pure" signature scheme — the hash is internal to the
  // algorithm. Node's crypto.sign() accepts `null` as the digest algorithm
  // for Ed25519, which is the correct and only valid value for this curve.
  const signatureBuffer = cryptoSign(null, canonicalBytes, privateKey);

  return {
    ...unsigned,
    signature: signatureBuffer.toString("base64"),
  };
}
