-- Migration: 0005_payment_attempts_unique.sql
-- Finding #8: payment_attempts had no unique constraint per (mandate_id, request_id).
--
-- WHY THIS MATTERS:
--   Two concurrent threads can both call beginSettlement for the same request
--   (e.g. a retry arriving before the first call completes). Without this
--   constraint, both succeed and create two Razorpay orders for the same payment
--   — a potential double-charge.
--
-- HOW IT WORKS:
--   The DB UNIQUE constraint is the last-line defence. If both threads pass the
--   application-level check simultaneously, only one INSERT can succeed. The
--   second gets a unique-violation error, which beginSettlement catches,
--   releases spend (fix A1), and surfaces as a 502 to the caller.
--
-- PREREQUISITE: Run AFTER 0004_add_daily_reset.sql.

ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_mandate_request_unique
  UNIQUE (mandate_id, request_id);
