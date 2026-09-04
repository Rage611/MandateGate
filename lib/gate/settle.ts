/**
 * lib/gate/settle.ts — Phase 3
 *
 * The settlement state machine: connects a gate-approved decision to a
 * Razorpay payment and manages the full lifecycle.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  evaluateGateDecision() → "approved"                             │
 * │    attempt_spend() has already reserved the amount in daily_cap  │
 * │                                                                  │
 * │  beginSettlement(request, decision)                              │
 * │    ├─ createOrder() OK  → insert payment_attempts (pending)      │
 * │    └─ createOrder() FAIL → release_spend() + audit               │
 * │                            ORDER_CREATION_FAILED_SPEND_RELEASED  │
 * │                                                                  │
 * │  Razorpay webhook arrives                                        │
 * │    ├─ payment.captured → handleCaptured()                        │
 * │    │     CAS UPDATE WHERE status='pending' → 'captured'          │
 * │    │     If 0 rows (already processed) → return early            │
 * │    │     Else → write audit 'settled'                            │
 * │    │                                                             │
 * │    └─ payment.failed  → handleFailed()                           │
 * │          CAS UPDATE WHERE status='pending' → 'failed'            │
 * │          If 0 rows (already processed) → return early            │
 * │          Else → release_spend() + audit SETTLEMENT_FAILED        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * All database state transitions use the same atomic single-statement
 * discipline as attempt_spend: WHERE clause enforces the precondition,
 * RETURNING detects whether the transition happened.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "../supabase/server";
import { verifyMandateSignature } from "../mandate/verify";
import {
  REASON_CODES,
  type AuditEntry,
  type GateDecision,
  type MandateRow,
  type PaymentRequest,
} from "./types";
import { createOrder } from "../razorpay/orders";

// ── Internal helpers ─────────────────────────────────────────────────────────

function requireDb(client?: SupabaseClient): SupabaseClient {
  const db = client ?? createServerSupabaseClient();
  if (!db) {
    throw new Error(
      "Supabase client is not configured. " +
        "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
    );
  }
  return db;
}

async function writeAudit(
  db: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  const { error } = await db.from("audit_log").insert(entry);
  if (error) {
    throw new Error(`audit_log write failed: ${error.message}`);
  }
}

/** Converts a flat MandateRow back into the nested Mandate shape (status hardcoded to "active" for sig check). */
function rowToMandateForSigCheck(row: MandateRow) {
  return {
    mandate_id: row.mandate_id,
    agent_id: row.agent_id,
    principal_id: row.principal_id,
    scope: {
      merchant_allowlist: row.scope_merchant_allowlist,
      category_allowlist: row.scope_category_allowlist,
    },
    limits: {
      max_per_txn: Number(row.limits_max_per_txn),
      daily_cap: Number(row.limits_daily_cap),
      currency: row.limits_currency,
    },
    validity: {
      not_before: new Date(row.validity_not_before).toISOString(),
      not_after: new Date(row.validity_not_after).toISOString(),
    },
    confirmation_threshold: Number(row.confirmation_threshold),
    nonce: row.nonce,
    status: "active" as const,
    signature: row.signature,
  };
}

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

// ── PaymentAttemptRow ─────────────────────────────────────────────────────────

interface PaymentAttemptRow {
  id: number;
  mandate_id: string;
  request_id: string;
  amount: number;
  currency: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  settlement_status: "pending" | "captured" | "failed";
}

// ── beginSettlement ───────────────────────────────────────────────────────────

/**
 * Called immediately after evaluateGateDecision() returns "approved".
 *
 * Creates a Razorpay order and records a payment_attempts row.
 * If order creation fails, immediately releases the reserved spend back to
 * daily_cap and writes an audit row — because no webhook will ever arrive
 * for an order that was never created.
 *
 * @param request  - Original PaymentRequest (for amount, currency, request_id).
 * @param decision - The approved GateDecision (for mandate_id, request_id).
 * @param client   - Optional Supabase client for DI in tests.
 * @returns The Razorpay order ID.
 * @throws  On createOrder failure (after releasing spend). On DB errors.
 */
export async function beginSettlement(
  request: PaymentRequest,
  decision: GateDecision,
  client?: SupabaseClient,
): Promise<{ razorpayOrderId: string }> {
  if (decision.outcome !== "approved") {
    throw new Error(
      `beginSettlement called with non-approved outcome: ${decision.outcome}`,
    );
  }

  const db = requireDb(client);
  const { mandate_id, request_id, amount } = request;
  const auditBase = {
    mandate_id,
    request_id,
    amount,
    merchant_id: request.merchant_id,
    category: request.category,
  };

  // ── Insert pending payment_attempts row ───────────────────────────────────
  // Insert before calling createOrder so that any row is visible if we need
  // to release_spend in the catch block.
  const { error: insertError } = await db.from("payment_attempts").insert({
    mandate_id,
    request_id,
    amount,
    currency: "INR",
    settlement_status: "pending",
  });

  if (insertError) {
    throw new Error(`payment_attempts insert failed: ${insertError.message}`);
  }

  // ── Create Razorpay order ─────────────────────────────────────────────────
  // If this throws, the spend is already reserved and no webhook will ever
  // arrive — so we must release_spend immediately to avoid a permanent leak.
  let razorpayOrderId: string;
  try {
    const order = await createOrder(amount, "INR", request_id);
    razorpayOrderId = order.id;
  } catch (err) {
    // Order creation failed. Release the reserved spend and audit it.
    await db.rpc("release_spend", {
      p_mandate_id: mandate_id,
      p_amount: amount,
    });

    await writeAudit(db, {
      ...auditBase,
      decision: "settled",
      reason_code: REASON_CODES.ORDER_CREATION_FAILED_SPEND_RELEASED,
    });

    // Update the payment_attempts row to 'failed' so the record is accurate.
    await db
      .from("payment_attempts")
      .update({ settlement_status: "failed" })
      .eq("mandate_id", mandate_id)
      .eq("request_id", request_id)
      .eq("settlement_status", "pending");

    // Rethrow — the caller should surface this as an error to the agent.
    throw err;
  }

  // ── Stamp the Razorpay order ID on the row ────────────────────────────────
  const { error: updateError } = await db
    .from("payment_attempts")
    .update({ razorpay_order_id: razorpayOrderId })
    .eq("mandate_id", mandate_id)
    .eq("request_id", request_id);

  if (updateError) {
    throw new Error(
      `payment_attempts order_id update failed: ${updateError.message}`,
    );
  }

  return { razorpayOrderId };
}

// ── handleCaptured ────────────────────────────────────────────────────────────

/**
 * Called when Razorpay sends a `payment.captured` webhook.
 *
 * Idempotent: uses a CAS UPDATE (WHERE settlement_status = 'pending')
 * so a duplicate webhook delivery is a no-op.
 *
 * @param razorpayOrderId   - From webhook payload.payment.entity.order_id
 * @param razorpayPaymentId - From webhook payload.payment.entity.id
 * @param client            - Optional Supabase client for DI in tests.
 */
export async function handleCaptured(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  client?: SupabaseClient,
): Promise<void> {
  const db = requireDb(client);

  // CAS update: only transition if currently pending.
  const { data: rows, error } = await db
    .from("payment_attempts")
    .update({
      settlement_status: "captured",
      razorpay_payment_id: razorpayPaymentId,
    })
    .eq("razorpay_order_id", razorpayOrderId)
    .eq("settlement_status", "pending")
    .select<"*", PaymentAttemptRow>("*");

  if (error) {
    throw new Error(`handleCaptured DB update failed: ${error.message}`);
  }

  if (!rows || rows.length === 0) {
    // Already processed (double webhook) — safe to ignore.
    return;
  }

  const attempt = rows[0];

  // Write settled audit row.
  await writeAudit(db, {
    mandate_id: attempt.mandate_id,
    request_id: attempt.request_id,
    amount: attempt.amount,
    merchant_id: "", // not stored on payment_attempts; audit for settlement context
    category: "",
    decision: "settled",
    reason_code: null,
  });
}

// ── handleFailed ──────────────────────────────────────────────────────────────

/**
 * Called when Razorpay sends a `payment.failed` webhook.
 *
 * Idempotent: uses a CAS UPDATE (WHERE settlement_status = 'pending').
 * If the row is already 'failed', release_spend is NOT called again.
 *
 * On first invocation:
 * 1. CAS update payment_attempts → 'failed'
 * 2. Call release_spend RPC to return the reserved amount to daily_cap
 * 3. Write settled audit row with SETTLEMENT_FAILED_SPEND_RELEASED
 *
 * @param razorpayOrderId - From webhook payload.payment.entity.order_id
 * @param client          - Optional Supabase client for DI in tests.
 */
export async function handleFailed(
  razorpayOrderId: string,
  client?: SupabaseClient,
): Promise<void> {
  const db = requireDb(client);

  // CAS update: only transition if currently pending.
  const { data: rows, error } = await db
    .from("payment_attempts")
    .update({ settlement_status: "failed" })
    .eq("razorpay_order_id", razorpayOrderId)
    .eq("settlement_status", "pending")
    .select<"*", PaymentAttemptRow>("*");

  if (error) {
    throw new Error(`handleFailed DB update failed: ${error.message}`);
  }

  if (!rows || rows.length === 0) {
    // Already processed — idempotent, do not release_spend again.
    return;
  }

  const attempt = rows[0];

  // Release the reserved spend back to daily_cap.
  const { error: releaseError } = await db.rpc("release_spend", {
    p_mandate_id: attempt.mandate_id,
    p_amount: attempt.amount,
  });

  if (releaseError) {
    throw new Error(`release_spend RPC failed: ${releaseError.message}`);
  }

  // Write settled audit row documenting the compensating event.
  await writeAudit(db, {
    mandate_id: attempt.mandate_id,
    request_id: attempt.request_id,
    amount: attempt.amount,
    merchant_id: "",
    category: "",
    decision: "settled",
    reason_code: REASON_CODES.SETTLEMENT_FAILED_SPEND_RELEASED,
  });
}

// ── confirmPendingPayment ─────────────────────────────────────────────────────

/**
 * Programmatic confirmation of a payment that was held at pending_confirmation.
 * Used by Phase 4's simulator (and any future confirmation API route) to
 * execute the steps that evaluateGateDecision skipped when it returned
 * "pending_confirmation".
 *
 * WHY this re-runs almost all gate checks:
 * - A pending_confirmation hold can sit for minutes or hours before a human
 *   (or simulator) confirms it. During that window:
 *   - The mandate may have been revoked or may have expired.
 *   - Other approved payments may have consumed the daily cap.
 * - All of these must be re-evaluated at confirmation time, not at the time
 *   the original request arrived.
 *
 * Steps executed (explicitly listed, not loosely described):
 *  a. Fetch mandate row from DB (may have been deleted)
 *  b. Verify Ed25519 signature (tamper check)
 *  c. Check DB row.status (may have been revoked or exhausted)
 *  d. Check temporal validity (may have expired)
 *  e. Idempotency check — consumed_requests (may have been double-confirmed)
 *  f. Scope check (allowlists)
 *  [skip g: confirmation_threshold — this IS the confirmation]
 *  h. attempt_spend — THE critical step: cap may have been consumed
 *  i. Insert into consumed_requests
 *  j. Write approved audit row
 *
 * @param request - The original PaymentRequest that was held as pending_confirmation.
 * @param client  - Optional Supabase client for DI in tests.
 * @returns A GateDecision with outcome "approved", or a rejection with reason_code.
 */
export async function confirmPendingPayment(
  request: PaymentRequest,
  client?: SupabaseClient,
): Promise<GateDecision> {
  const db = requireDb(client);
  const { mandate_id, request_id, amount, merchant_id, category } = request;
  const auditBase = { mandate_id, request_id, amount, merchant_id, category };

  async function reject(
    reason_code: (typeof REASON_CODES)[keyof typeof REASON_CODES],
  ): Promise<GateDecision> {
    await writeAudit(db, {
      ...auditBase,
      decision: "rejected",
      reason_code,
    });
    return { outcome: "rejected", reason_code, mandate_id, request_id };
  }

  // ── a: Fetch mandate ──────────────────────────────────────────────────────
  const { data: row, error: fetchError } = await db
    .from("mandates")
    .select("*")
    .eq("mandate_id", mandate_id)
    .single<MandateRow>();

  if (fetchError || !row) {
    return reject(REASON_CODES.MANDATE_NOT_FOUND);
  }

  // ── b: Verify signature ───────────────────────────────────────────────────
  const mandateForSigCheck = rowToMandateForSigCheck(row);
  if (!verifyMandateSignature(mandateForSigCheck, getPublicKey())) {
    return reject(REASON_CODES.INVALID_SIGNATURE);
  }

  // ── c: Check mandate status (from DB row) ─────────────────────────────────
  if (row.status !== "active") {
    return reject(REASON_CODES.MANDATE_REVOKED);
  }

  const mandate = mandateForSigCheck;

  // ── d: Check temporal validity ────────────────────────────────────────────
  const now = new Date();
  if (now < new Date(mandate.validity.not_before)) {
    return reject(REASON_CODES.MANDATE_NOT_YET_VALID);
  }
  if (now > new Date(mandate.validity.not_after)) {
    return reject(REASON_CODES.MANDATE_EXPIRED);
  }

  // ── e: Idempotency check ──────────────────────────────────────────────────
  // Guard against double-confirmation of the same request_id.
  // FAIL CLOSED: DB error → throw, don't silently allow a potential double-spend.
  const { data: existing, error: idempotencyLookupError } = await db
    .from("consumed_requests")
    .select("request_id")
    .eq("mandate_id", mandate_id)
    .eq("request_id", request_id)
    .maybeSingle();

  if (idempotencyLookupError) {
    throw new Error(
      `Idempotency check failed — cannot safely confirm: ${idempotencyLookupError.message}`,
    );
  }

  if (existing) {
    return reject(REASON_CODES.DUPLICATE_REQUEST);
  }

  // ── f: Scope check ────────────────────────────────────────────────────────
  const merchantAllowed =
    mandate.scope.merchant_allowlist.length === 0 ||
    mandate.scope.merchant_allowlist.includes(merchant_id);
  // Normalize category to uppercase for consistent matching (mirrors evaluate.ts).
  const normalizedCategory = category.toUpperCase();
  const categoryAllowed =
    mandate.scope.category_allowlist.length === 0 ||
    mandate.scope.category_allowlist.includes(normalizedCategory);

  if (!merchantAllowed || !categoryAllowed) {
    return reject(REASON_CODES.OUT_OF_SCOPE);
  }

  // ── f.5: Per-transaction limit check ─────────────────────────────────────
  // max_per_txn applies at confirmation time too — the human cannot approve
  // an amount the mandate policy never permitted per transaction.
  if (amount > mandate.limits.max_per_txn) {
    return reject(REASON_CODES.EXCEEDS_PER_TXN_LIMIT);
  }

  // ── [SKIP g: confirmation_threshold] — this IS the confirmation ───────────

  // ── h: Atomic cap check + spend ───────────────────────────────────────────
  // Re-evaluated at confirmation time: other approved payments may have
  // consumed the cap while this payment was waiting for human confirmation.
  const { data: spendRows, error: spendError } = await db.rpc("attempt_spend", {
    p_mandate_id: mandate_id,
    p_amount: amount,
  });

  if (spendError) {
    throw new Error(`attempt_spend RPC failed: ${spendError.message}`);
  }

  const spent = spendRows as Array<{ new_daily_spent: number }>;
  if (!spent || spent.length === 0) {
    return reject(REASON_CODES.CAP_EXCEEDED);
  }

  // ── i: Insert into consumed_requests ─────────────────────────────────────
  // IMPORTANT: attempt_spend reserved the budget. If this insert fails, we MUST
  // release the spend so the budget is not permanently consumed.
  const { error: consumedInsertError } = await db
    .from("consumed_requests")
    .insert({ mandate_id, request_id });

  if (consumedInsertError) {
    // Release the reserved spend before throwing — budget must not leak.
    await db.rpc("release_spend", { p_mandate_id: mandate_id, p_amount: amount });
    throw new Error(
      `consumed_requests insert failed (spend released): ${consumedInsertError.message}`,
    );
  }

  // ── j: Write approved audit row ───────────────────────────────────────────
  try {
    await writeAudit(db, {
      ...auditBase,
      decision: "approved",
      reason_code: null,
    });
  } catch (auditErr) {
    // Audit write failed but spend + idempotency are committed — don't release.
    console.error(
      `[confirm] AUDIT WRITE FAILED for confirmed request ${request_id} on mandate ${mandate_id}:`,
      auditErr,
    );
  }

  return { outcome: "approved", mandate_id, request_id };
}
