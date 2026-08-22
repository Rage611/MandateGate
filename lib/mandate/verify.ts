import { verify as cryptoVerify } from "crypto";
import { canonicalize } from "./canonicalize";
import { importPublicKey } from "./keys";
import type { Mandate } from "./types";

/**
 * Verifies the Ed25519 signature on a Mandate.
 *
 * Re-canonicalises the mandate (excluding the `signature` field), then checks
 * the signature against the provided public key.
 *
 * SAFETY CONTRACT
 * ───────────────
 * This function MUST NOT THROW under any circumstance, including:
 *   - Malformed or garbage `signature` (not valid base64, wrong length, etc.)
 *   - Invalid or corrupted `publicKeyB64` (not valid SPKI DER)
 *   - Structurally invalid `mandate` object (missing fields, wrong types)
 *   - Tampered fields (any mutation of any field will cause verification to fail)
 *
 * All such cases return `false`. This makes the function safe to call directly
 * on untrusted input (e.g. from an API request body) without a surrounding
 * try/catch at the call site.
 *
 * @param mandate       - The Mandate object to verify (may be untrusted).
 * @param publicKeyB64  - Base64-encoded SPKI DER public key (from MANDATE_SIGNING_PUBLIC_KEY).
 * @returns `true` if the signature is valid; `false` in all other cases.
 */
export function verifyMandateSignature(
  mandate: Mandate,
  publicKeyB64: string,
): boolean {
  try {
    // Destructure to separate the signature from the fields that were signed.
    // `rest` is the UnsignedMandate that was originally canonicalised & signed.
    const { signature, ...rest } = mandate;

    // Re-canonicalise exactly as issueMandate() did — same deterministic bytes.
    const canonicalBytes = Buffer.from(canonicalize(rest), "utf8");

    const publicKey = importPublicKey(publicKeyB64);
    const sigBuffer = Buffer.from(signature, "base64");

    // crypto.verify() returns a boolean and does not throw on bad signatures
    // (it throws only on a bad key format, which is caught below).
    return cryptoVerify(null, canonicalBytes, publicKey, sigBuffer);
  } catch {
    // Any exception — bad key, bad base64, missing field, wrong type — is
    // treated as a verification failure, not a server error.
    return false;
  }
}
