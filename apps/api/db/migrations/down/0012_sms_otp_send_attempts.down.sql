-- E0-S4: 0012 down — sms_otp_send_attempts.
--
-- Reverse the up migration: drop the index, then the column.
-- Down-order matches E0-S2 spec: indexes → columns.

DROP INDEX IF EXISTS idx_otp_verification_last_sent;

ALTER TABLE otp_verification
  DROP COLUMN IF EXISTS last_sent_at;
