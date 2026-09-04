-- Migration: 0004_add_daily_reset.sql
-- Fixes: daily_spent never resets (Codex finding #2).
--
-- Adds a `last_daily_reset` DATE column (UTC date) to the mandates table.
-- Adds a `reset_daily_if_needed` function that atomically resets daily_spent
-- to 0 if the current UTC date is newer than last_daily_reset.
--
-- WHY a DATE column instead of a cron job:
--   A cron job running at midnight UTC would have a race window: requests
--   arriving just after midnight might be evaluated before the cron fires.
--   Worse, the free Supabase tier pauses the DB, meaning a cron could miss
--   days entirely. The per-request approach resets lazily and atomically on
--   the first request of each new day — no cron required, no race window.
--
-- The reset is performed by the application in evaluate.ts before
-- reading daily_spent for the cap pre-check. It is a separate RPC call
-- (not merged into attempt_spend) so the existing atomic spend function
-- remains unchanged and independently testable.
--
-- Run this AFTER 0003_add_settlement_tracking.sql.

-- ── Add last_daily_reset column ──────────────────────────────────────────────
ALTER TABLE mandates
  ADD COLUMN IF NOT EXISTS last_daily_reset DATE NOT NULL DEFAULT (CURRENT_DATE AT TIME ZONE 'UTC');

-- Backfill existing rows: treat today as their last reset so the first
-- request today does not incorrectly trigger a reset that wipes today's spending.
UPDATE mandates
  SET last_daily_reset = (CURRENT_DATE AT TIME ZONE 'UTC')
  WHERE last_daily_reset IS NULL;

-- ── reset_daily_if_needed ────────────────────────────────────────────────────
-- Atomically resets daily_spent to 0 and updates last_daily_reset to today
-- if the stored last_daily_reset is before today (UTC).
--
-- Called by evaluate.ts before the cap pre-check on every request.
--
-- Return value:
--   1 row  → reset was performed; the mandate's counter is now 0.
--   0 rows → no reset needed (already reset today, or mandate not found).
--
-- Concurrency: Two simultaneous first-of-day requests both call this.
-- The UPDATE's WHERE clause (last_daily_reset < today) ensures only one
-- wins — the second evaluates the WHERE clause after the first commits
-- and sees last_daily_reset = today, so it returns 0 rows (no-op).

CREATE OR REPLACE FUNCTION reset_daily_if_needed(
  p_mandate_id  UUID,
  p_today_date  DATE
)
RETURNS TABLE (did_reset BOOLEAN)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    UPDATE mandates
    SET    daily_spent      = 0,
           last_daily_reset = p_today_date,
           updated_at       = now()
    WHERE  mandate_id       = p_mandate_id
      AND  last_daily_reset < p_today_date
    RETURNING TRUE;
END;
$$;
