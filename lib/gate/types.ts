/**
 * Gate type definitions for MandateGate Phase 2.
 *
 * The gate is the decision engine: it takes a payment request and a mandate,
 * runs all policy checks in order, and returns an approve/reject/hold decision
 * with a full audit trail. This module contains only types — no logic.
 */

// ── Reason codes ─────────────────────────────────────────────────────────────

/**
 * All possible rejection or hold reasons, as a string-literal union.
 * Every value is a constant — no magic strings elsewhere in the codebase.
 *
 * The codes are designed to be self-documenting to the agent receiving them:
 * it should be able to understand exactly what failed without reading source.
 */
export const REASON_CODES = {
  /**
   * No mandate row was found for the given mandate_id.
   * Distinct from INVALID_SIGNATURE: the mandate doesn't exist at all.
   */
  MANDATE_NOT_FOUND: "MANDATE_NOT_FOUND",
  /** The mandate's Ed25519 signature does not match its payload. */
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  /** The mandate's not_after timestamp is in the past. */
  MANDATE_EXPIRED: "MANDATE_EXPIRED",
  /** The mandate has been revoked or exhausted and is no longer active. */
  MANDATE_REVOKED: "MANDATE_REVOKED",
  /** The mandate's not_before timestamp is in the future. */
  MANDATE_NOT_YET_VALID: "MANDATE_NOT_YET_VALID",
  /** This (mandate_id, request_id) pair has already been approved and spent. */
  DUPLICATE_REQUEST: "DUPLICATE_REQUEST",
  /** The merchant or category is not in the mandate's allowlist. */
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  /** The transaction would exceed the mandate's daily_cap. */
  CAP_EXCEEDED: "CAP_EXCEEDED",
  /**
   * The amount exceeds the mandate's confirmation_threshold.
   * Approval is deferred until a human principal explicitly confirms.
   * This is NOT a rejection — the outcome is "pending_confirmation".
   */
  NEEDS_CONFIRMATION: "NEEDS_CONFIRMATION",
  /**
   * The Razorpay order creation failed after the spend was reserved.
   * The reserved amount has been released back to daily_spent.
   * Written to audit_log with decision="settled" to document the compensating event.
   */
  ORDER_CREATION_FAILED_SPEND_RELEASED: "ORDER_CREATION_FAILED_SPEND_RELEASED",
  /**
   * The Razorpay payment failed (webhook: payment.failed).
   * The reserved amount has been released back to daily_spent.
   * Written to audit_log with decision="settled" to document the compensating event.
   */
  SETTLEMENT_FAILED_SPEND_RELEASED: "SETTLEMENT_FAILED_SPEND_RELEASED",
} as const;

/** Union of all reason code string literals. */
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

// ── PaymentRequest ────────────────────────────────────────────────────────────

/**
 * The inbound payment request submitted by an AI agent.
 *
 * request_id is a caller-supplied idempotency key. The agent must generate a
 * fresh UUID for each distinct payment attempt. If the same request_id is
 * submitted twice under the same mandate_id, the second call is rejected as
 * DUPLICATE_REQUEST regardless of any other field values.
 */
export interface PaymentRequest {
  /** The mandate the agent claims authorises this payment. */
  mandate_id: string;
  /**
   * Caller-supplied idempotency key, unique per payment attempt.
   * Must be a fresh UUID for each new request. Re-using an approved
   * request_id will be rejected as DUPLICATE_REQUEST.
   */
  request_id: string;
  /** Amount in paise (smallest INR unit). Must be > 0. */
  amount: number;
  /** Razorpay merchant ID the payment is directed to. */
  merchant_id: string;
  /** MCC-style category code, e.g. "TRAVEL", "SaaS". */
  category: string;
}

// ── GateDecision ─────────────────────────────────────────────────────────────

/** The three possible gate outcomes returned to callers of evaluateGateDecision. */
export type GateOutcome =
  | "approved" // payment may proceed
  | "rejected" // payment is denied
  | "pending_confirmation"; // payment requires human confirmation before proceeding

/**
 * Decisions that may be written to audit_log. A superset of GateOutcome:
 * includes "settled" for post-payment settlement events (captured / failed / order-creation-failed).
 * Kept separate so GateDecision.outcome stays narrow and callers don't need to
 * handle a settlement-only concept.
 */
export type AuditDecision = GateOutcome | "settled";

/**
 * The gate's decision for a given PaymentRequest.
 *
 * reason_code is always present for rejected decisions and for
 * pending_confirmation (NEEDS_CONFIRMATION). It is absent for approved.
 */
export interface GateDecision {
  outcome: GateOutcome;
  reason_code?: ReasonCode;
  mandate_id: string;
  request_id: string;
}

// ── DB row types ─────────────────────────────────────────────────────────────

/**
 * The shape of a row returned from the `mandates` table.
 * Column names follow the flattened SQL naming convention from migration 0001.
 * Used internally by evaluate.ts to hydrate into the Mandate interface.
 */
export interface MandateRow {
  mandate_id: string;
  agent_id: string;
  principal_id: string;
  scope_merchant_allowlist: string[];
  scope_category_allowlist: string[];
  limits_max_per_txn: number;
  limits_daily_cap: number;
  limits_currency: string;
  validity_not_before: string;
  validity_not_after: string;
  confirmation_threshold: number;
  nonce: string;
  status: string;
  signature: string;
  daily_spent: number;
}

/**
 * A row to insert into `audit_log`.
 * id and created_at are generated by the database.
 *
 * decision uses AuditDecision (not GateOutcome) to allow "settled" entries
 * written by the settlement state machine for captures, failures, and
 * order-creation failures.
 */
export interface AuditEntry {
  mandate_id: string;
  request_id: string;
  decision: AuditDecision;
  reason_code: ReasonCode | null;
  amount: number;
  merchant_id: string;
  category: string;
}
