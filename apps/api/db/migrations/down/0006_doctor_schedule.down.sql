-- E0-S2: 0006 — doctor_schedule (down).

DROP INDEX IF EXISTS idx_doctor_schedule_doctor_branch_day;
DROP TRIGGER IF EXISTS trg_doctor_schedule_set_updated_at ON doctor_schedule;
DROP TABLE IF EXISTS doctor_schedule;
