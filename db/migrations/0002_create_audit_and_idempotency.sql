-- Migration: 0002_create_audit_and_idempotency.sql
-- Phase 2: Idempotency table, audit log, and atomic spend function.
--
-- Run this AFTER 0001_create_mandates_table.sql.
--
-- Tables created:
--   consumed_requests  — idempotency store: (mandate_id, request_id) pairs that
--                        have already been approved and spent. Prevents double-spend
--                        on retried requests.
--   audit_log          — append-only record of every gate decision, including
--                        rejections. REVOKE UPDATE/DELETE from all roles so no
--                        code path (including bugs) can overwrite history.
--
-- Function created:
--   attempt_spend(p_mandate_id UUID, p_amount NUMERIC) — atomically checks the
--   daily cap and increments daily_spent in a single UPDATE ... WHERE ... RETURNING.
--   Returns 1 row on success, 0 rows if the cap would be exceeded.

-- ── consumed_requests ────────────────────────────────────────────────────────
-- Each (mandate_id, request_id) pair appears at most once: the UNIQUE constraint
-- is the database-level guard against double-processing if two threads pass the
-- in-application idempotency check at the same time.

CREATE TABLE IF NOT EXISTS consumed_requests (
  mandate_id    UUID          NOT NULL REFERENCES mandates (mandate_id)
                              ON DELETE CASCADE,
  request_id    TEXT          NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT consumed_requests_pkey PRIMARY KEY (mandate_id, request_id)
);

-- Index for fast lookups: "has this request_id been consumed under this mandate?"
CREATE INDEX IF NOT EXISTS idx_consumed_requests_mandate_request
  ON consumed_requests (mandate_id, request_id);

ALTER TABLE consumed_requests ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (which bypasses RLS) can access this table.

-- ── audit_log ────────────────────────────────────────────────────────────────
-- Append-only — REVOKE ensures no application role can UPDATE or DELETE rows.
-- id is a surrogate BIGSERIAL so rows have a natural insertion order independent
-- of created_at clock resolution.

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL     PRIMARY KEY,
  mandate_id    UUID          NOT NULL,           -- FK not enforced: log must survive mandate deletion
  request_id    TEXT          NOT NULL,
  decision      TEXT          NOT NULL
                  CHECK (decision IN ('approved', 'rejected', 'pending_confirmation')),
  reason_code   TEXT,                             -- NULL for approved/pending_confirmation
  amount        NUMERIC       NOT NULL,
  merchant_id   TEXT          NOT NULL,
  category      TEXT          NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Fast lookup: all audit entries for a given mandate.
CREATE INDEX IF NOT EXISTS idx_audit_log_mandate_id
  ON audit_log (mandate_id);

-- Fast lookup: all audit entries for a given request_id (useful for debugging duplicates).
CREATE INDEX IF NOT EXISTS idx_audit_log_request_id
  ON audit_log (request_id);

-- ── Immutability enforcement ─────────────────────────────────────────────────
-- Revoke UPDATE and DELETE from the public role (and therefore from all non-
-- superuser roles including service_role's own grants). This makes audit_log
-- effectively append-only at the database privilege level.
--
-- service_role is a Supabase-managed role with BYPASSRLS but NOT with SUPERUSER,
-- so REVOKE applies to it too when operating through the REST API / pooler.
-- A superuser can still update during migrations — that is intentional.
REVOKE UPDATE ON audit_log FROM PUBLIC;
REVOKE DELETE ON audit_log FROM PUBLIC;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role can INSERT (bypasses RLS). UPDATE/DELETE are
-- revoked above, providing defence-in-depth beyond RLS.

-- ── attempt_spend ────────────────────────────────────────────────────────────
-- Atomically checks and increments daily_spent for a mandate.
--
-- WHY THIS MUST BE A SINGLE SQL STATEMENT
-- ─────────────────────────────────────────
-- If the cap check and the increment are separate statements (SELECT then UPDATE),
-- two concurrent requests can both read the same daily_spent, both decide they fit
-- under the cap, and both commit — doubling the spend. This is the classic
-- check-then-act race condition.
--
-- The fix: express both operations as one UPDATE with the cap check in the WHERE
-- clause. Postgres takes a row-level lock at UPDATE time, so only one of two
-- concurrent callers can win the lock. The loser re-evaluates the WHERE clause
-- after the winner commits and (if the cap is now exceeded) returns 0 rows.
--
-- Return value:
--   1 row  → spend succeeded; new_daily_spent is the updated value.
--   0 rows → cap would be exceeded; caller must reject with CAP_EXCEEDED.

CREATE OR REPLACE FUNCTION attempt_spend(
  p_mandate_id  UUID,
  p_amount      NUMERIC
)
RETURNS TABLE (new_daily_spent NUMERIC)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    UPDATE mandates
    SET    daily_spent = daily_spent + p_amount,
           updated_at  = now()
    WHERE  mandate_id  = p_mandate_id
      AND  daily_spent + p_amount <= limits_daily_cap
    RETURNING daily_spent;
END;
$$;
