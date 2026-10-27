-- W10a: 0022 — staff password credential.
--
-- Closes the "stub auth" P2 gap: `POST /auth/login/staff` accepted an
-- email and nothing else, so the endpoint proved only that the caller
-- knew a seeded email address. It was confined to dev/test via
-- `staffStubLoginAllowed`, but that left the app with no way to
-- authenticate a staff user at all in production.
--
-- The fix adds a nullable `password_hash` column to each of the three
-- staff tables (admin_user / doctor / receptionist) and teaches the
-- login route to verify a bcrypt credential when one is present.
--
-- Hashing uses Postgres `pgcrypto.crypt(...)` with the `bf` (bcrypt)
-- algorithm rather than pulling in a native npm bcrypt dependency:
-- pgcrypto is already installed (0002) and granted (0011), and the
-- `bf` algorithm is the same bcrypt the ecosystem expects. `gen_salt`
-- uses bcrypt's own cost parameter (default 10).
--
-- NULLABLE BY DESIGN:
--
--   A NULL `password_hash` means "no credential configured" — the
--   account can still sign in via the dev-only email-only path, but
--   the route refuses a password login for it. That keeps every
--   existing seeded row working (no forced password reset on deploy)
--   while making the credential path opt-in per account.
--
--   The alternative — a NOT NULL column with a backfilled default
--   password — would silently ship a well-known credential on every
--   account, which is worse than no credential at all.
--
-- Idempotent: every statement is guarded so a re-apply is a no-op.

-- ===== admin_user =====
ALTER TABLE admin_user
  ADD COLUMN IF NOT EXISTS password_hash text;

-- ===== doctor =====
ALTER TABLE doctor
  ADD COLUMN IF NOT EXISTS password_hash text;

-- ===== receptionist =====
ALTER TABLE receptionist
  ADD COLUMN IF NOT EXISTS password_hash text;

-- A bcrypt hash is a fixed-shape string: `$2a$<cost>$<22-char salt><31-char digest>`.
-- A CHECK constraint keeps a malformed or plaintext value from ever being
-- stored, which would otherwise let a bad write turn into a permanent
-- lockout with no way to diagnose it.
--
-- `crypt()` output for `bf` always starts with `$2a$` (pgcrypto emits
-- `$2a$` regardless of the input). The constraint accepts `$2a$`, `$2b$`
-- and `$2y$` so a hash imported from another tool is still storable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_user_password_hash_format'
  ) THEN
    ALTER TABLE admin_user
      ADD CONSTRAINT admin_user_password_hash_format
      CHECK (
        password_hash IS NULL
        OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'doctor_password_hash_format'
  ) THEN
    ALTER TABLE doctor
      ADD CONSTRAINT doctor_password_hash_format
      CHECK (
        password_hash IS NULL
        OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_password_hash_format'
  ) THEN
    ALTER TABLE receptionist
      ADD CONSTRAINT receptionist_password_hash_format
      CHECK (
        password_hash IS NULL
        OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
      );
  END IF;
END$$;
