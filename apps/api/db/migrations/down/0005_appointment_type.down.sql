-- E0-S2: 0005 — appointment_type (down).

DROP INDEX IF EXISTS idx_appointment_type_active;
DROP INDEX IF EXISTS idx_appointment_type_clinic_id;

DROP TRIGGER IF EXISTS trg_appointment_type_set_updated_at ON appointment_type;
DROP TABLE IF EXISTS appointment_type;
