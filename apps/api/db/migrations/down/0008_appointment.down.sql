-- E0-S2: 0008 — appointment (down).

DROP INDEX IF EXISTS idx_appointment_doctor_branch_start;
DROP INDEX IF EXISTS idx_appointment_patient_status_start;
DROP INDEX IF EXISTS idx_appointment_patient_doctor_scheduled;

ALTER TABLE appointment DROP CONSTRAINT IF EXISTS appointment_no_overlap;

DROP TRIGGER IF EXISTS trg_appointment_set_updated_at ON appointment;
DROP TABLE IF EXISTS appointment;

DROP TYPE IF EXISTS appointment_status;
