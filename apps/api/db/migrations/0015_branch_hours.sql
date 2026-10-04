-- E1-S2: 0015 — branch operating hours.
--
-- Closes the gap from spec-1-2 §Intent: the admin can create and deactivate
-- branches (E1-S1) but the schema has no place to store operating hours, and
-- the SC1-deferred `branch.address` column from E1-S1 still has no home.
-- When admins need to narrow weekend hours, the system cannot tell them
-- which scheduled appointments would land outside the new window — patients
-- discover the conflict only on arrival.
--
-- This migration does three things:
--
--   1. Adds `branch.address text` (nullable; no backfill).
--
--   2. Updates `branch.tz` default to 'Asia/Riyadh'. Pre-existing rows are
--      not touched (the seed uses 'America/New_York' for East and
--      'America/Los_Angeles' for West — the column is NOT NULL today so the
--      default only matters for new branches).
--
--   3. Creates `branch_weekly_hours` — one row per (branch, day_of_week)
--      with `is_closed boolean` + optional `open_time`/`close_time` of type
--      `time` (wall-clock, no tz). The table has UNIQUE(branch_id,
--      day_of_week) so a branch cannot have duplicate day entries; a CHECK
--      constraint enforces `day_of_week BETWEEN 0 AND 6`. A
--      `set_updated_at` trigger mirrors the convention from
--      0004_widen_seed_entities.sql:31-38 so any future UPDATE advances the
--      column automatically.
--
-- Hours are stored as `time` (not `tstzrange`) because the editor UX shows
-- wall-clock values like "09:00 — 17:00" — see spec-1-2 §Design Notes.
-- The `branch.tz` is the single source of timezone; the SQL impact check
-- in the route uses `(start_datetime AT TIME ZONE branch.tz)::time` to
-- convert a future appointment into wall-clock terms.
--
-- Idempotency:
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS — re-run on already-migrated
--     DB is a no-op.
--   - ALTER TABLE ... ALTER COLUMN ... SET DEFAULT — idempotent.
--   - CREATE TABLE IF NOT EXISTS — idempotent.
--   - CREATE UNIQUE INDEX IF NOT EXISTS — idempotent.
--   - CREATE TRIGGER (with DROP TRIGGER IF EXISTS first) — idempotent.

-- ===== Step 1: branch.address =====
ALTER TABLE branch
  ADD COLUMN IF NOT EXISTS address text;

-- ===== Step 2: branch.tz default = 'Asia/Riyadh' =====
-- Only the DEFAULT changes; existing rows keep their seed tzs. A future
-- migration can normalize existing rows if the product decides to move all
-- branches to Asia/Riyadh. The DEFAULT is what new branches inherit; the
-- E1-S2 seed explicitly passes tz='America/New_York' / 'America/Los_Angeles'
-- on INSERT so the new default does not affect the E0-S5 seed values.
ALTER TABLE branch
  ALTER COLUMN tz SET DEFAULT 'Asia/Riyadh';

-- ===== Step 3: branch_weekly_hours =====
CREATE TABLE IF NOT EXISTS branch_weekly_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time   time,
  close_time  time,
  is_closed   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT app_now(),
  updated_at  timestamptz NOT NULL DEFAULT app_now(),
  UNIQUE (branch_id, day_of_week)
);

-- Hot-path read: GET /admin/branches/:id/hours filters by branch_id only,
-- so a btree on branch_id speeds that path.
CREATE INDEX IF NOT EXISTS idx_branch_weekly_hours_branch_id
  ON branch_weekly_hours(branch_id);

-- Mirror the codebase's set_updated_at convention (0004).
DROP TRIGGER IF EXISTS trg_branch_weekly_hours_set_updated_at ON branch_weekly_hours;
CREATE TRIGGER trg_branch_weekly_hours_set_updated_at
  BEFORE UPDATE ON branch_weekly_hours
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();