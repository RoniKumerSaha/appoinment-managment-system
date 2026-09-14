-- E1-S0a: 0013 — clinic singleton enforcement (DB-layer).
--
-- Closes the gap from spec-1-0 §Intent: the E0-S1 bootstrap created the
-- `clinic` table without any constraint that would prevent a second
-- INSERT, and the `admin_user` table had no FK link to `clinic` so the
-- product's single-clinic-per-deployment invariant was enforced nowhere.
--
-- This migration does two things, in this order:
--
--   1. Adds `admin_user.clinic_id uuid REFERENCES clinic(id) ON DELETE
--      RESTRICT` — matching the `branch.clinic_id` convention. NOT NULL
--      is set AFTER the backfill UPDATE so existing admin rows (the seed
--      provisions `admin-main`) get anchored to the singleton row first.
--
--   2. Creates the partial unique index `idx_clinic_singleton ON
--      clinic((true))` — a `true` constant is a valid index expression
--      and Postgres treats every row as equal under `=`, so the index
--      can contain at most one row. A second INSERT INTO clinic therefore
--      raises `23505` (unique_violation) at the DB layer, which is the
--      sole source of truth for the singleton invariant. No app-layer
--      count, no trigger, no app check.
--
-- Order matters: the partial unique index is created AFTER the backfill
-- UPDATE so the singleton row already exists when the index is built and
-- the NOT NULL constraint is in place. Creating the index first would
-- also be safe for fresh DBs (the singleton row exists from migration
-- 0001), but creating it last matches the spec's "Always" rule and is
-- a no-op on already-migrated DBs (CREATE INDEX IF NOT EXISTS).
--
-- Idempotency:
--   - ADD COLUMN IF NOT EXISTS  — re-running on an already-migrated DB
--     does not raise.
--   - The UPDATE WHERE clinic_id IS NULL is a no-op when every admin row
--     is already anchored.
--   - ALTER COLUMN ... SET NOT NULL is a no-op when the column is
--     already NOT NULL (Postgres short-circuits).
--   - CREATE UNIQUE INDEX IF NOT EXISTS — re-running does not raise.

-- Step 1a: add the column with the FK. Nullable at this point so the
-- backfill UPDATE can populate it. ON DELETE RESTRICT matches
-- `branch.clinic_id` per spec §Boundaries.
ALTER TABLE admin_user
  ADD COLUMN IF NOT EXISTS clinic_id uuid REFERENCES clinic(id) ON DELETE RESTRICT;

-- Step 1b: backfill every admin row whose `clinic_id` is still NULL to
-- point at the singleton clinic. The seed provisions exactly one clinic
-- row (01_minimum.ts); the defensive WHERE clause handles any future
-- edge case where a pre-existing admin row slipped through without a
-- clinic anchor. LIMIT 1 is fine — partial unique index will be in
-- place by the time a second clinic row could legally exist anyway, and
-- we want this to be a hard error rather than silently picking one.
UPDATE admin_user
  SET clinic_id = (SELECT id FROM clinic LIMIT 1)
  WHERE clinic_id IS NULL;

-- Step 1c: enforce NOT NULL. After this point every admin row is
-- anchored to the singleton clinic at the DB layer.
ALTER TABLE admin_user
  ALTER COLUMN clinic_id SET NOT NULL;

-- Step 2: enforce the single-clinic invariant via a UNIQUE INDEX on a
-- constant expression `(true)`. Postgres allows index expressions and
-- treats `(true) = (true)` as `true`, so the index can contain at most
-- one row. A second INSERT INTO clinic raises SQLSTATE 23505
-- (unique_violation).
--
-- Note on terminology: this is an expression unique index, not a
-- partial unique index — there is no WHERE clause. (Contrast
-- idx_appointment_patient_doctor_scheduled, which IS partial — see
-- migration 0008.) The two patterns are commonly conflated; both rely
-- on UNIQUE + index-expression semantics, but partial adds a predicate
-- and expression uses a non-column expression. This file uses the
-- expression form because there is no row-level condition we want to
-- filter on — every clinic row must be subject to the singleton
-- invariant.
--
-- This is the spec's first use of the expression-unique pattern; future
-- singletons can reuse the same mechanism.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_singleton ON clinic((true));
