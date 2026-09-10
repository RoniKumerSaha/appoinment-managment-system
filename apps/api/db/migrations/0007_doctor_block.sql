-- E0-S2: 0007 — doctor_block.
--
-- One-off time-off windows for a doctor at a branch. Block-vs-block overlap
-- and block-vs-Scheduled-appointment overlap are enforced at the app layer
-- (E2-S2). E0-S2 just stores the rows.
--
-- created_by is polymorphic (staff / patient prefix). In practice blocks are
-- always doctor/admin-initiated; the patient case never occurs.

CREATE TABLE IF NOT EXISTS doctor_block (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id      uuid NOT NULL REFERENCES doctor(id) ON DELETE RESTRICT,
  branch_id      uuid NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
  start_datetime timestamptz NOT NULL,
  end_datetime   timestamptz NOT NULL CHECK (end_datetime > start_datetime),
  reason         text,
  created_by     text NOT NULL CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]{1,255}$' AND length(created_by) <= 256),
  created_at     timestamptz NOT NULL DEFAULT app_now(),
  updated_at     timestamptz NOT NULL DEFAULT app_now()
);

DROP TRIGGER IF EXISTS trg_doctor_block_set_updated_at ON doctor_block;
CREATE TRIGGER trg_doctor_block_set_updated_at
  BEFORE UPDATE ON doctor_block
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_doctor_block_doctor_branch_time
  ON doctor_block(doctor_id, branch_id, start_datetime);
