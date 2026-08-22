/**
 * Mandate type definitions for MandateGate.
 *
 * A Mandate is a signed, tamper-proof authorization object representing:
 * "This AI agent (agent_id) is authorized by this principal (principal_id)
 * to spend up to X on Y until Z."
 *
 * The `signature` field covers the canonical JSON of all other fields — any
 * mutation of any field will fail signature verification.
 */

export interface MandateScope {
  /** Allowlisted Razorpay merchant IDs this agent may transact with. */
  merchant_allowlist: string[];
  /** Allowlisted MCC-style category codes (e.g. "TRAVEL", "SaaS"). */
  category_allowlist: string[];
}

export interface MandateLimits {
  /**
   * Maximum amount per single transaction, in paise (smallest INR unit).
   * Matches Razorpay's convention: ₹10.00 = 1000 paise.
   */
  max_per_txn: number;
  /** Total daily spending cap, in paise. */
  daily_cap: number;
  /** ISO 4217 currency code, e.g. "INR". */
  currency: string;
}

export interface MandateValidity {
  /** ISO 8601 datetime: mandate is not valid before this time. */
  not_before: string;
  /** ISO 8601 datetime: mandate expires at this time. */
  not_after: string;
}

export type MandateStatus = "active" | "expired" | "revoked" | "exhausted";

export interface Mandate {
  /** UUIDv4 — unique per mandate, generated at issuance. */
  mandate_id: string;
  /** Identifier of the AI agent this mandate is issued to. */
  agent_id: string;
  /** Identifier of the human principal who authorized this mandate. */
  principal_id: string;
  /** Scope constraints: which merchants and categories are permitted. */
  scope: MandateScope;
  /** Spending limits. */
  limits: MandateLimits;
  /** Temporal validity window. */
  validity: MandateValidity;
  /**
   * Amount in paise above which human re-approval is required per transaction.
   * Phase 2 enforcement — stored here for gate logic to read.
   */
  confirmation_threshold: number;
  /**
   * Cryptographically random nonce, unique per mandate.
   * Prevents replay attacks: even identical mandates issued to the same agent
   * produce different signed objects.
   */
  nonce: string;
  /** Lifecycle status of the mandate. */
  status: MandateStatus;
  /**
   * Base64-encoded Ed25519 signature over the canonical JSON of all other fields.
   * Verifying this signature is the primary tamper-detection mechanism.
   */
  signature: string;
}

/** The payload that callers provide to issueMandate(). */
export type MandateInput = Omit<
  Mandate,
  "mandate_id" | "nonce" | "status" | "signature"
>;

/** The mandate object without its signature — this is what gets signed/verified. */
export type UnsignedMandate = Omit<Mandate, "signature">;
