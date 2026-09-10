-- E0-S2: 0006 — doctor_schedule.
--
-- Weekly recurring availability for a doctor at a branch. Multi-period days
-- are supported by allowing multiple rows per (doctor, branch, day_of_week).
-- effective_from / effective_to bracket a date range; NULL effective_to means
-- open-ended.
--
-- Overlap of multiple rows for the same (doctor, branch, day_of_week) is NOT
-- enforced at the DB layer (per deferred-work W4) — the app layer (E2-S2)
-- prevents the user from entering conflicting rows.

CREATE TABLE IF NOT EXISTS doctor_schedule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid NOT NULL REFERENCES doctor(id) ON DELETE RESTRICT,
  branch_id       uuid NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
  day_of_week     smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time      time NOT NULL,
  end_time        time NOT NULL CHECK (end_time > start_time),
  effective_from  date NOT NULL,
  effective_to    date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by      text NOT NULL CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]{1,255}$' AND length(created_by) <= 256),
  created_at      timestamptz NOT NULL DEFAULT app_now(),
  updated_at      timestamptz NOT NULL DEFAULT app_now()
);

DROP TRIGGER IF EXISTS trg_doctor_schedule_set_updated_at ON doctor_schedule;
CREATE TRIGGER trg_doctor_schedule_set_updated_at
  BEFORE UPDATE ON doctor_schedule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_doctor_schedule_doctor_branch_day
  ON doctor_schedule(doctor_id, branch_id, day_of_week);
