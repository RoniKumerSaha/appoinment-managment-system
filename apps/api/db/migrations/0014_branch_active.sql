-- E1-S1: 0014 — branch.active column.
--
-- E1-S1 introduces the branch lifecycle (PRD F-16, BR-005, BR-059):
--   - Admin can create a branch (POST).
--   - Admin can edit a branch name.
--   - Admin can deactivate a branch (PATCH active=false).
--   - Deactivation is rejected (409) when future Scheduled appointments
--     exist on the branch.
--
-- The `branch` table shipped from 0001 + 0004 has no `active` column —
-- branch rows are either present or not. The product design needs a
-- soft-delete path: an inactive branch stays in the DB so historical
-- appointments, doctor schedule blocks, and audit rows continue to
-- reference it (FK ON DELETE RESTRICT blocks hard-delete anyway), but
-- admins can hide it from active lists and stop accepting new bookings.
--
-- This migration adds ONE column with the codebase's defensive
-- add-then-backfill-then-constrain pattern (matching 0004 and 0013):
--   1. ADD COLUMN IF NOT EXISTS active boolean DEFAULT true (nullable).
--   2. UPDATE branch SET active = true WHERE active IS NULL (backfill).
--   3. ALTER COLUMN active SET NOT NULL.
--
-- Why the 3-step pattern (P-F1 from review-loop-1):
--   The codebase convention (0004_widen_seed_entities.sql and
--   0013_clinic_anchor.sql) is to never combine ADD COLUMN with NOT NULL
--   in one statement, because if the column already exists as nullable
--   from a prior experimental change, `ADD COLUMN IF NOT EXISTS ... NOT
--   NULL` is a silent no-op — the IF NOT EXISTS short-circuits and the
--   NOT NULL constraint is never enforced. Splitting into 3 statements
--   ensures that on a partially-migrated DB, the UPDATE backfills any
--   pre-existing NULL rows before NOT NULL is applied.
--
-- No new trigger: branch.updated_at already advances on UPDATE via
-- trg_branch_set_updated_at (0004_widen_seed_entities.sql:31-38).

-- Step 1: add the column nullable with the default. The IF NOT EXISTS
-- guards re-runs on an already-migrated DB; in that case the column is
-- already NOT NULL and the subsequent statements are short-circuits.
ALTER TABLE branch
  ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;

-- Step 2: backfill any pre-existing NULL values. Idempotent: a row that
-- already has active=true is unaffected. On a fresh DB no rows match
-- (the column was just added with default true) — no-op.
UPDATE branch
  SET active = true
  WHERE active IS NULL;

-- Step 3: enforce NOT NULL. After this point every branch row carries
-- an active boolean. Idempotent: ALTER COLUMN ... SET NOT NULL on an
-- already-NOT-NULL column is a no-op.
ALTER TABLE branch
  ALTER COLUMN active SET NOT NULL;
