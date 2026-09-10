-- E0-S4: 0012 — sms_otp_send_attempts.
--
-- Adds `last_sent_at` to otp_verification so the 30-second resend cooldown
-- is anchored to the most recent send attempt (not the original `created_at`,
-- which is a row's birthday and would survive a successful verify if we
-- reused it). A fresh row inserted after a verify has a fresh `last_sent_at`,
-- so the cooldown window starts at the latest send.
--
-- The index on (phone_e164, last_sent_at DESC) supports the cooldown query
-- in the send() path:
--   SELECT MAX(last_sent_at) FROM otp_verification WHERE phone_e164 = $1
--   AND last_sent_at > now() - INTERVAL '30 seconds'
-- without forcing a sequential scan of every historical row.
--
-- The plain UNIQUE (phone_e164) constraint from migration 0010 still applies;
-- only one row per phone ever exists in the table at a time (cleaned up by
-- the service's DELETE-expired step inside the same transaction as INSERT).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE otp_verification
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz NOT NULL DEFAULT app_now();

-- F9: backfill pre-existing rows so `last_sent_at` matches the original
-- send time, not the migration run time. Without this, any row that
-- existed before this migration runs would have `last_sent_at` set to
-- migration-time, causing the 30-second cooldown to elapse instantly for
-- outstanding rows (the user could re-send immediately even though they
-- sent just before the migration). Backfill from `created_at`, which is
-- the row's original birth time — that's the closest analogue to a
-- "send time" we have for pre-existing rows.
UPDATE otp_verification
  SET last_sent_at = COALESCE(created_at, app_now())
  WHERE last_sent_at IS NULL OR last_sent_at = app_now();

CREATE INDEX IF NOT EXISTS idx_otp_verification_last_sent
  ON otp_verification(phone_e164, last_sent_at DESC);
