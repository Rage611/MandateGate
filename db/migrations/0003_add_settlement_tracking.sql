-- Migration: 0003_add_settlement_tracking.sql
-- Phase 3: Payment attempts table, release_spend function, and audit_log extension.
--
-- Run this AFTER 0002_create_audit_and_idempotency.sql.
--
-- Changes:
--   payment_attempts   — settlement tracking per gate-approved request.
--                        Holds the Razorpay order/payment IDs and transition state.
--   release_spend()    — inverse of attempt_spend: atomically decrements daily_spent,
--                        floored at 0. Used when a payment fails after being reserved.
--   audit_log CHECK    — extended to allow 'settled' decisions (post-payment events).

-- ── payment_attempts ─────────────────────────────────────────────────────────
--
-- WHY a separate table (not columns on consumed_requests):
-- consumed_requests has a single responsibility: idempotency — "has this
-- (mandate_id, request_id) been approved and spent?". Mixing settlement state
-- into that table couples two orthogonal concerns. A future design may retry
-- payment for the same consumed_request (e.g. first order expires, create a
-- new one) — payment_attempts accommodates that cleanly while consumed_requests
-- retains its narrow, invariant semantics.

CREATE TABLE IF NOT EXISTS payment_attempts (
  id                    BIGSERIAL       PRIMARY KEY,
  mandate_id            UUID            NOT NULL REFERENCES mandates (mandate_id)
                                        ON DELETE CASCADE,
  request_id            TEXT            NOT NULL,
  amount                NUMERIC         NOT NULL,
  currency              TEXT            NOT NULL DEFAULT 'INR',
  razorpay_order_id     TEXT,                           -- NULL until createOrder() succeeds
  razorpay_payment_id   TEXT,                           -- NULL until webhook arrives
  settlement_status     TEXT            NOT NULL DEFAULT 'pending'
                          CHECK (settlement_status IN ('pending', 'captured', 'failed')),
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),

  -- Every payment_attempt must correspond to an approved gate decision.
  CONSTRAINT fk_consumed_request
    FOREIGN KEY (mandate_id, request_id)
    REFERENCES consumed_requests (mandate_id, request_id)
    ON DELETE CASCADE
);

-- Fast lookup: all attempts for a given mandate.
CREATE INDEX IF NOT EXISTS idx_payment_attempts_mandate_id
  ON payment_attempts (mandate_id);

-- Fast lookup: by Razorpay order ID (used on webhook arrival to find the row).
CREATE INDEX IF NOT EXISTS idx_payment_attempts_order_id
  ON payment_attempts (razorpay_order_id);

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (bypasses RLS) can access.

-- updated_at trigger (reuse the function from migration 0001).
CREATE OR REPLACE TRIGGER set_payment_attempts_updated_at
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── audit_log: extend decision CHECK to allow 'settled' ──────────────────────
-- Phase 2 created the table with CHECK (decision IN ('approved', 'rejected',
-- 'pending_confirmation')). Phase 3 adds 'settled' to cover post-payment
-- audit rows written by the settlement state machine.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_decision_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_decision_check
  CHECK (decision IN ('approved', 'rejected', 'pending_confirmation', 'settled'));

-- ── release_spend ─────────────────────────────────────────────────────────────
--
-- Atomically decrements daily_spent for a mandate when a payment fails.
-- Uses GREATEST(..., 0) as a floor so a double-release or an accounting bug
-- cannot drive daily_spent negative.
--
-- WHY THIS IS SAFE UNDER CONCURRENT CALLS
-- ──────────────────────────────────────────
-- Like attempt_spend, the entire check-and-update is a single UPDATE statement.
-- Postgres takes a row-level lock at UPDATE time. Two concurrent calls serialize:
-- the first wins the lock and decrements; the second runs after commit and also
-- decrements (possibly to 0 via GREATEST). The primary idempotency guard against
-- double-release is in the application layer (settle.ts checks
-- settlement_status = 'pending' in a CAS UPDATE before calling this function).
-- GREATEST(..., 0) is a defence-in-depth safeguard if that application-layer
-- guard ever fails.
--
-- Return value:
--   1 row  → release succeeded; new_daily_spent reflects the updated value.
--   0 rows → mandate_id not found (caller should treat as an error).

CREATE OR REPLACE FUNCTION release_spend(
  p_mandate_id  UUID,
  p_amount      NUMERIC
)
RETURNS TABLE (new_daily_spent NUMERIC)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    UPDATE mandates
    SET    daily_spent = GREATEST(daily_spent - p_amount, 0),
           updated_at  = now()
    WHERE  mandate_id = p_mandate_id
    RETURNING daily_spent;
END;
$$;
