-- E1-S4: receptionist lifecycle — add `active` (deactivate without delete)
-- to the receptionist table.
--
-- Per spec-1-4:
--   - BR-004: receptionist is assigned to exactly one branch (already
--     enforced via `receptionist.branch_id` NOT NULL FK ON DELETE RESTRICT
--     from 0001_init_bootstrap.sql:46).
--   - F-19: admin can deactivate a receptionist (with a warning, not a
--     hard 409 blocking on future appointments).
--   - `receptionist.email` (citext NOT NULL UNIQUE) already exists from
--     0004_widen_seed_entities.sql:86-104 — no need to add it here.
--   - `receptionist.branch_id` (NOT NULL FK branch ON DELETE RESTRICT) is
--     the single-branch anchor; `clinic_id` is implicit via the branch
--     row (branch.clinic_id NOT NULL FK clinic).
--
-- Schema after this migration:
--   receptionist(
--     id          uuid PK,
--     branch_id   uuid NOT NULL FK branch ON DELETE RESTRICT,
--     full_name   text NOT NULL,
--     email       citext NOT NULL UNIQUE,
--     active      boolean NOT NULL DEFAULT true,
--     created_at  timestamptz NOT NULL DEFAULT app_now(),
--     updated_at  timestamptz NOT NULL DEFAULT app_now()
--   )
--
-- Defensive add-then-backfill-then-constrain pattern (matches 0004, 0013,
-- 0014, 0015, 0016):
--   1. ADD COLUMN nullable
--   2. UPDATE backfill (active=true for any pre-existing row)
--   3. SET NOT NULL
--   4. SET DEFAULT true (so future INSERTs without an explicit value land
--      on the canonical contract)
--
-- Idempotent throughout — every statement uses IF NOT EXISTS / column-
-- exists guards so a re-apply on the migrated DB is a no-op (verified in
-- migrations.test.ts).

-- ===== active =====
ALTER TABLE receptionist
  ADD COLUMN IF NOT EXISTS active boolean;

UPDATE receptionist
   SET active = true
 WHERE active IS NULL;

ALTER TABLE receptionist
  ALTER COLUMN active SET NOT NULL;

ALTER TABLE receptionist
  ALTER COLUMN active SET DEFAULT true;

-- ===== receptionist (updated_at trigger already from 0004_widen_seed_entities.sql:77-80) =====
-- No new trigger needed; trg_receptionist_set_updated_at was attached in 0004.