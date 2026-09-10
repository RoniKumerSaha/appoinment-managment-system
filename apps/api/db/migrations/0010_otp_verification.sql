-- E0-S2: 0010 — otp_verification.
--
-- Stores one-time-password verification rows for patient phone-number auth.
-- E0-S4 (SMS OTP gateway) writes/reads these rows; E0-S2 just provisions the
-- schema.
--
-- Important: the spec does NOT use a partial unique index keyed on
-- `expires_at > now()` — Postgres rejects that because `now()` is volatile
-- (partial-index predicates must be immutable). Instead we use a plain
-- UNIQUE on `phone_e164`, and the "only one outstanding OTP" invariant is
-- enforced by an E0-S4 cleanup job that deletes expired rows before inserting
-- a new one.
--
-- code_hash stores the bcrypt/argon2 hash of the OTP code (32–256 chars
-- depending on the algorithm). Plain OTP codes are NEVER stored.

CREATE TABLE IF NOT EXISTS otp_verification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164    text NOT NULL,
  code_hash     text NOT NULL CHECK (length(code_hash) BETWEEN 32 AND 256),
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT otp_verification_phone_unique UNIQUE (phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_otp_verification_phone_created
  ON otp_verification(phone_e164, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_verification_expires_at
  ON otp_verification(expires_at);
