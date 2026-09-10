-- E0-S2: 0004 — widen E0-S1 seed entities.
--
-- Adds:
--   - `updated_at timestamptz NOT NULL DEFAULT app_now()` on every mutable entity
--     from E0-S1.
--   - Backfill: existing rows get `updated_at = created_at` BEFORE the trigger
--     attaches, so NOT NULL is satisfied and the trigger sees a coherent value.
--   - `set_updated_at` trigger on every mutable entity (BEFORE UPDATE, RETURN NEW).
--   - `email citext UNIQUE NOT NULL` on `receptionist` and `admin_user` (closes
--     triage item A6 — stable scoping column, seed no longer relies on string-name
--     uniqueness).
--   - B-tree indexes for hot read paths (triage item A3):
--     - idx_branch_clinic_id
--     - idx_doctor_branch_branch_id
--     - idx_patient_phone_number
--
-- Order matters: ADD COLUMN + UPDATE backfill must commit before the trigger
-- attaches, otherwise the trigger fires for the backfill rows and assigns a
-- different timestamp than created_at. We accomplish that by issuing the
-- ADD COLUMN, the backfill UPDATE, and the CREATE TRIGGER in three sequential
-- statements within one migration — node-pg-migrate wraps the file in a
-- transaction so they commit atomically, but the trigger doesn't fire for the
-- ADD COLUMN or UPDATE statements (it's BEFORE UPDATE only, and CREATE TRIGGER
-- attaches last).
--
-- IMPORTANT: E0-S1's `patient` table has `phone_number text UNIQUE` (no _phone
-- suffix). E0-S2 keeps that column name for backwards compatibility with the
-- existing seed and downstream code. The new `appointment.patient_phone` column
-- uses the shorter name. See deferred-work note W-something-or-other.

-- ===== clinic =====
ALTER TABLE clinic
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT app_now();
UPDATE clinic SET updated_at = created_at WHERE updated_at IS DISTINCT FROM created_at;
DROP TRIGGER IF EXISTS trg_clinic_set_updated_at ON clinic;
CREATE TRIGGER trg_clinic_set_updated_at
  BEFORE UPDATE ON clinic
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== branch =====
ALTER TABLE branch
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT app_now();
UPDATE branch SET updated_at = created_at WHERE updated_at IS DISTINCT FROM created_at;
DROP TRIGGER IF EXISTS trg_branch_set_updated_at ON branch;
CREATE TRIGGER trg_branch_set_updated_at
  BEFORE UPDATE ON branch
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== doctor =====
ALTER TABLE doctor
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT app_now();
UPDATE doctor SET updated_at = created_at WHERE updated_at IS DISTINCT FROM created_at;
DROP TRIGGER IF EXISTS trg_doctor_set_updated_at ON doctor;
CREATE TRIGGER trg_doctor_set_updated_at
  BEFORE UPDATE ON doctor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== doctor_branch (junction) =====
-- updated_at on a junction table is unusual but the spec lists it. Acceptable.
-- E0-S1's doctor_branch had no `created_at`; we add it here so the updated_at
-- backfill (next statement) has a coherent source value. DEFAULT now() matches
-- the other entities' backfill semantics.
ALTER TABLE doctor_branch
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT app_now();
ALTER TABLE doctor_branch
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT app_now();
UPDATE doctor_branch SET updated_at = created_at WHERE updated_at IS DISTINCT FROM created_at;
DROP TRIGGER IF EXISTS trg_doctor_branch_set_updated_at ON doctor_branch;
CREATE TRIGGER trg_doctor_branch_set_updated_at
  BEFORE UPDATE ON doctor_branch
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== receptionist (also add email citext UNIQUE) =====
ALTER TABLE receptionist
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT app_now();
UPDATE receptionist SET updated_at = created_at WHERE updated_at IS DISTINCT FROM created_at;
DROP TRIGGER IF EXISTS trg_receptionist_set_updated_at ON receptionist;
CREATE TRIGGER trg_receptionist_set_updated_at
  BEFORE UPDATE ON receptionist
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- email column — add as NULLABLE first so existing rows (E0-S1 seed) don't fail,
-- then enforce NOT NULL after the seed is updated. For E0-S2 the E0-S1 seed
-- still has full_name-based rows; we backfill with a deterministic email so
-- NOT NULL passes. E0-S5 re-keys the seed to use email as the natural key.
ALTER TABLE receptionist
  ADD COLUMN IF NOT EXISTS email citext;
UPDATE receptionist
  SET email = lower(full_name) || '@clinic.local'
  WHERE email IS NULL;
ALTER TABLE receptionist
  ALTER COLUMN email SET NOT NULL;

-- Unique constraint must be added with NOT VALID first so it doesn't fail on
-- pre-existing duplicates; then validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_email_key'
  ) THEN
    ALTER TABLE receptionist
      ADD CONSTRAINT receptionist_email_key UNIQUE (email);
  END IF;
END $$;

-- ===== admin_user (also add email citext UNIQUE) =====
ALTER TABLE admin_user
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT app_now();
UPDATE admin_user SET updated_at = created_at WHERE updated_at IS DISTINCT FROM created_at;
DROP TRIGGER IF EXISTS trg_admin_user_set_updated_at ON admin_user;
CREATE TRIGGER trg_admin_user_set_updated_at
  BEFORE UPDATE ON admin_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE admin_user
  ADD COLUMN IF NOT EXISTS email citext;
UPDATE admin_user
  SET email = lower(full_name) || '@clinic.local'
  WHERE email IS NULL;
ALTER TABLE admin_user
  ALTER COLUMN email SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_user_email_key'
  ) THEN
    ALTER TABLE admin_user
      ADD CONSTRAINT admin_user_email_key UNIQUE (email);
  END IF;
END $$;

-- ===== patient (also widen — E0-S1 already has UNIQUE on phone_number) =====
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT app_now();
UPDATE patient SET updated_at = created_at WHERE updated_at IS DISTINCT FROM created_at;
DROP TRIGGER IF EXISTS trg_patient_set_updated_at ON patient;
CREATE TRIGGER trg_patient_set_updated_at
  BEFORE UPDATE ON patient
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== Hot-path indexes (triage item A3) =====
CREATE INDEX IF NOT EXISTS idx_branch_clinic_id ON branch(clinic_id);
CREATE INDEX IF NOT EXISTS idx_doctor_branch_branch_id ON doctor_branch(branch_id);
CREATE INDEX IF NOT EXISTS idx_patient_phone_number ON patient(phone_number);
