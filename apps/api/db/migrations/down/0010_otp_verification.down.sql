-- E0-S2: 0010 — otp_verification (down).

DROP INDEX IF EXISTS idx_otp_verification_expires_at;
DROP INDEX IF EXISTS idx_otp_verification_phone_created;
DROP TABLE IF EXISTS otp_verification;
