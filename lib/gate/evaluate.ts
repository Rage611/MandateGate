import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyMandateSignature } from "../mandate/verify";
import type { Mandate } from "../mandate/types";
import { createServerSupabaseClient } from "../supabase/server";
import {
  REASON_CODES,
  type AuditEntry,
  type GateDecision,
  type MandateRow,
  type PaymentRequest,
} from "./types";

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Converts a flat MandateRow (DB shape) back into the nested Mandate interface.
 *
 * IMPORTANT: the `status` passed here is intentionally the SIGNED status (always
 * "active" at issuance) so that verifyMandateSignature can reconstruct the exact
 * canonical JSON that was signed. The authoritative current status lives on the
 * raw MandateRow and is checked separately — see evaluate.ts step c.
 *
 * If we passed the current DB status to verifyMandateSignature and the status had
 * been mutated (e.g. to "revoked"), the signature check would fail because the
 * signed bytes encoded "active". That would mean we could never distinguish
 * "mandate was tampered" from "mandate was revoked" — both would look like
 * INVALID_SIGNATURE. Keeping the status-for-sig-check as "active" preserves the
 * clean separation: step b = tamper check, step c = lifecycle check.
 */
function rowToMandate(row: MandateRow): Mandate {
  return {
    mandate_id: row.mandate_id,
    agent_id: row.agent_id,
    principal_id: row.principal_id,
    scope: {
      merchant_allowlist: row.scope_merchant_allowlist,
      category_allowlist: row.scope_category_allowlist,
    },
    limits: {
      max_per_txn: row.limits_max_per_txn,
      daily_cap: row.limits_daily_cap,
      currency: row.limits_currency,
    },
    validity: {
      not_before: row.validity_not_before,
      not_after: row.validity_not_after,
    },
    confirmation_threshold: row.confirmation_threshold,
    nonce: row.nonce,
    // Always use "active" for signature verification — that is what was signed.
    // The actual current status is read from row.status and checked in step c.
    status: "active",
    signature: row.signature,
  };
}

/**
 * Writes a row to audit_log. Every gate decision — approved, rejected, or
 * pending_confirmation — must produce exactly one audit row. This function
 * is awaited so that any unexpected write failure is surfaced to the caller
 * (and therefore to tests) rather than silently swallowed.
 *
 * The audit_log table has UPDATE and DELETE revoked (see migration 0002), so
 * this is effectively an append-only write.
 */
async function writeAudit(
  client: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await client.from("audit_log").insert(entry);
  if (error) {
    // Surface DB errors so they don't silently swallow audit entries.
    // In production this should also trigger an alerting path.
    throw new Error(`audit_log write failed: ${error.message}`);
  }
}

// ── Public env constant ──────────────────────────────────────────────────────

/**
 * The base64-encoded SPKI DER public key used to verify mandate signatures.
 * Must be set in the environment as MANDATE_SIGNING_PUBLIC_KEY.
 */
function getPublicKey(): string {
  const key = process.env.MANDATE_SIGNING_PUBLIC_KEY;
  if (!key) {
    throw new Error(
      "MANDATE_SIGNING_PUBLIC_KEY is not set. " +
        "Run `npm run generate-keys` and add the output to .env.local.",
    );
  }
  return key;
}

// ── evaluateGateDecision ─────────────────────────────────────────────────────

/**
 * The gate policy engine. Takes a payment request and evaluates it against the
 * named mandate, running checks in a strict order (fail-fast).
 *
 * Every branch — including every rejection — writes one row to audit_log before
 * returning. There are no silent outcomes.
 *
 * @param request - The inbound payment request from the AI agent.
 * @param client  - Optional Supabase client; defaults to the server client.
 *                  Pass a mock client in tests for full control without a live DB.
 * @returns A GateDecision with outcome and, for non-approved outcomes, a reason_code.
 */
export async function evaluateGateDecision(
  request: PaymentRequest,
  client?: SupabaseClient,
): Promise<GateDecision> {
  const db = client ?? createServerSupabaseClient();
  if (!db) {
    throw new Error(
      "Supabase client is not configured. " +
        "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }
  // Capture non-null reference for closures and downstream async calls.
  const safeDb: SupabaseClient = db;

  const { mandate_id, request_id, amount, merchant_id, category } = request;

  // Shared audit base — all branches add decision/reason_code on top.
  const auditBase = { mandate_id, request_id, amount, merchant_id, category };

  // Helper to write audit + return a rejected decision atomically (no await gap).
  async function reject(
    reason_code: (typeof REASON_CODES)[keyof typeof REASON_CODES],
  ): Promise<GateDecision> {
    await writeAudit(safeDb, {
      ...auditBase,
      decision: "rejected",
      reason_code,
    });
    return { outcome: "rejected", reason_code, mandate_id, request_id };
  }

  // ── Step a: Fetch mandate ────────────────────────────────────────────────
  const { data: row, error: fetchError } = await safeDb
    .from("mandates")
    .select("*")
    .eq("mandate_id", mandate_id)
    .single<MandateRow>();

  if (fetchError || !row) {
    // Mandate not found — treat as invalid signature (no mandate to verify against).
    return reject(REASON_CODES.INVALID_SIGNATURE);
  }

  // ── Step b: Verify signature ─────────────────────────────────────────────
  // rowToMandate() reconstructs the mandate with status="active" (what was
  // signed). This separates tamper detection (step b) from lifecycle checking
  // (step c). See rowToMandate() comment for full rationale.
  const mandateForSigCheck = rowToMandate(row);
  const publicKey = getPublicKey();

  if (!verifyMandateSignature(mandateForSigCheck, publicKey)) {
    return reject(REASON_CODES.INVALID_SIGNATURE);
  }

  // ── Step c: Check mandate status (from DB row — authoritative) ───────────
  // Check AFTER signature verification — an invalid signature is rejected first
  // so we don't leak whether a mandate_id exists by revealing its lifecycle state.
  if (row.status !== "active") {
    // Both "revoked" and "exhausted" map to MANDATE_REVOKED.
    return reject(REASON_CODES.MANDATE_REVOKED);
  }

  // From here on we use mandateForSigCheck (all fields correct, status="active"
  // which matches the DB since we just verified row.status === "active").
  const mandate = mandateForSigCheck;

  // ── Step d: Check temporal validity window ───────────────────────────────
  const now = new Date();
  const notBefore = new Date(mandate.validity.not_before);
  const notAfter = new Date(mandate.validity.not_after);

  if (now < notBefore) {
    return reject(REASON_CODES.MANDATE_NOT_YET_VALID);
  }
  if (now > notAfter) {
    return reject(REASON_CODES.MANDATE_EXPIRED);
  }

  // ── Step e: Idempotency check ─────────────────────────────────────────────
  // Must happen BEFORE scope/cap checks so a retried request can't be charged
  // twice even if it was previously rejected for a different reason.
  const { data: existing } = await safeDb
    .from("consumed_requests")
    .select("request_id")
    .eq("mandate_id", mandate_id)
    .eq("request_id", request_id)
    .maybeSingle();

  if (existing) {
    return reject(REASON_CODES.DUPLICATE_REQUEST);
  }

  // ── Step f: Scope check ──────────────────────────────────────────────────
  const merchantAllowed =
    mandate.scope.merchant_allowlist.length === 0 ||
    mandate.scope.merchant_allowlist.includes(merchant_id);
  const categoryAllowed =
    mandate.scope.category_allowlist.length === 0 ||
    mandate.scope.category_allowlist.includes(category);

  if (!merchantAllowed || !categoryAllowed) {
    return reject(REASON_CODES.OUT_OF_SCOPE);
  }

  // ── Step g: Confirmation threshold check ─────────────────────────────────
  // If the amount exceeds the threshold, the mandate requires human confirmation
  // before this payment can proceed. We do NOT write to consumed_requests or
  // call attempt_spend — the hold is recorded in audit_log only.
  if (amount > mandate.confirmation_threshold) {
    await writeAudit(safeDb, {
      ...auditBase,
      decision: "pending_confirmation",
      reason_code: REASON_CODES.NEEDS_CONFIRMATION,
    });
    return {
      outcome: "pending_confirmation",
      reason_code: REASON_CODES.NEEDS_CONFIRMATION,
      mandate_id,
      request_id,
    };
  }

  // ── Step h: Atomic cap check + spend ─────────────────────────────────────
  // attempt_spend is a Postgres function that atomically checks
  //   daily_spent + amount <= limits_daily_cap
  // AND performs the increment in a single UPDATE ... WHERE ... RETURNING.
  // If the cap would be exceeded the WHERE clause filters the row out and the
  // function returns 0 rows. This prevents the race condition where two concurrent
  // calls both pass the check before either writes.
  const { data: spendRows, error: spendError } = await safeDb.rpc(
    "attempt_spend",
    {
      p_mandate_id: mandate_id,
      p_amount: amount,
    },
  );

  if (spendError) {
    throw new Error(`attempt_spend RPC failed: ${spendError.message}`);
  }

  const spent = spendRows as Array<{ new_daily_spent: number }>;

  if (!spent || spent.length === 0) {
    // Cap would be exceeded — 0 rows returned from the UPDATE's WHERE clause.
    return reject(REASON_CODES.CAP_EXCEEDED);
  }

  // ── Step i: Record approval ───────────────────────────────────────────────
  const { error: idempotencyError } = await safeDb
    .from("consumed_requests")
    .insert({ mandate_id, request_id });

  if (idempotencyError) {
    throw new Error(
      `consumed_requests insert failed: ${idempotencyError.message}`,
    );
  }

  await writeAudit(safeDb, {
    ...auditBase,
    decision: "approved",
    reason_code: null,
  });

  return { outcome: "approved", mandate_id, request_id };
}
