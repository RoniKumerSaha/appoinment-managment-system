-- E1-S0a: 0013 — clinic singleton enforcement (down).
--
-- Reverse the forward migration. Drop order per spec §Boundaries:
--   index → FK constraint → column
--
-- The FK on admin_user.clinic_id is dropped implicitly with the column
-- (`ALTER TABLE ... DROP COLUMN` removes the FK constraint), so no
-- separate ALTER TABLE ... DROP CONSTRAINT step is needed.

-- Drop the partial unique index. IF EXISTS makes this safe to re-run.
DROP INDEX IF EXISTS idx_clinic_singleton;

-- Drop the column (and its FK to clinic(id)). IF EXISTS makes this safe
-- to re-run on a DB where the column was already dropped.
ALTER TABLE admin_user DROP COLUMN IF EXISTS clinic_id;
