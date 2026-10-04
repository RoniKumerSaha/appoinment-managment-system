-- E1-S3: doctor lifecycle — add clinic_id (single-clinic anchor), email
-- (natural key), and active (deactivate without delete) to the doctor table.
--
-- Per spec-1-3:
--   - BR-002: doctor belongs to exactly one clinic; admin scope is clinic-scoped.
--   - F-18: admin can deactivate a doctor (with a warning, not a hard 409
--     blocking on future appointments).
--   - Mirrors the existing 0004 `receptionist.email` + `admin_user.email`
--     shape so the admin API has a natural key for the doctor.
--
-- Schema after this migration:
--   doctor(
--     id          uuid PK,
--     clinic_id   uuid NOT NULL FK clinic ON DELETE RESTRICT,
--     full_name   text NOT NULL,
--     email       citext NOT NULL UNIQUE,
--     active      boolean NOT NULL DEFAULT true,
--     created_at  timestamptz NOT NULL DEFAULT app_now(),
--     updated_at  timestamptz NOT NULL DEFAULT app_now()
--   )
--
-- Defensive add-then-backfill-then-constrain pattern (matches 0004, 0013, 0014,
-- 0015):
--   1. ADD COLUMN nullable
--   2. UPDATE backfill
--   3. SET NOT NULL
--   4. CREATE UNIQUE INDEX / FK
-- A silently-no-op ALTER on a partially-migrated DB is the failure mode
-- this pattern defends against (P-F1 from E1-S1 review-loop-1).
--
-- Idempotent throughout — every statement uses IF NOT EXISTS / DO $$
-- guards so a re-apply on the migrated DB is a no-op (verified in
-- migrations.test.ts).

-- ===== clinic_id (single-clinic anchor) =====
ALTER TABLE doctor
  ADD COLUMN IF NOT EXISTS clinic_id uuid;

UPDATE doctor
   SET clinic_id = (SELECT id FROM clinic LIMIT 1)
 WHERE clinic_id IS NULL;

ALTER TABLE doctor
  ALTER COLUMN clinic_id SET NOT NULL;

-- FK to clinic(id) ON DELETE RESTRICT (mirrors admin_user.clinic_id at
-- 0013_clinic_anchor.sql). Deactivating a doctor must not cascade; an
-- actual DELETE of a clinic is forbidden while doctors reference it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'doctor_clinic_id_fkey'
  ) THEN
    ALTER TABLE doctor
      ADD CONSTRAINT doctor_clinic_id_fkey
      FOREIGN KEY (clinic_id) REFERENCES clinic(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_doctor_clinic_id ON doctor(clinic_id);

-- ===== email (natural key, mirrors receptionist.email at 0004) =====
ALTER TABLE doctor
  ADD COLUMN IF NOT EXISTS email citext;

UPDATE doctor
   SET email = lower(regexp_replace(full_name, '\s+', '-', 'g')) || '@clinic.local'
 WHERE email IS NULL;

-- The seed file (apps/api/db/seeds/01_minimum.ts) derives emails using
-- the same shape: `full_name.toLowerCase().replace(/\s+/g, '-') +
-- '@clinic.local'`. The JS regex /\s+/g matches the SQL \s+ exactly,
-- so re-seeding a freshly-migrated DB produces the same email for the
-- same doctor name (P-A4 from E1-S3 review-loop-1).

ALTER TABLE doctor
  ALTER COLUMN email SET NOT NULL;

-- UNIQUE constraint — guard against duplicate creation. We use a
-- conditional DO $$ block (rather than NOT VALID + VALIDATE) because the
-- backfill above already populates email from full_name; if a partially-
-- migrated DB has multiple NULL email rows that get the same derived
-- backfill, the constraint fails the migration. Wrap in DO $$ IF NOT
-- EXISTS so a re-run on the migrated DB is a no-op (P-A5 from E1-S3
-- review-loop-1 corrected the comment — the SQL doesn't use NOT VALID).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'doctor_email_key'
  ) THEN
    ALTER TABLE doctor
      ADD CONSTRAINT doctor_email_key UNIQUE (email);
  END IF;
END $$;

-- ===== active (deactivate without delete; mirrors branch.active at 0014) =====
ALTER TABLE doctor
  ADD COLUMN IF NOT EXISTS active boolean;

UPDATE doctor
   SET active = true
 WHERE active IS NULL;

ALTER TABLE doctor
  ALTER COLUMN active SET NOT NULL;

ALTER TABLE doctor
  ALTER COLUMN active SET DEFAULT true;

-- ===== doctor (updated_at trigger already from 0004_widen_seed_entities.sql:53-56) =====
-- No new trigger needed; trg_doctor_set_updated_at was attached in 0004.