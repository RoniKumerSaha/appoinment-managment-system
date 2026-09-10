-- E0-S2: 0009 — appointment_audit (down).

DROP INDEX IF EXISTS idx_appointment_audit_event_created;
DROP INDEX IF EXISTS idx_appointment_audit_actor;
DROP INDEX IF EXISTS idx_appointment_audit_appointment_id;

DROP TRIGGER IF EXISTS trg_appointment_audit_no_delete ON appointment_audit;
DROP TRIGGER IF EXISTS trg_appointment_audit_no_update ON appointment_audit;
DROP FUNCTION IF EXISTS reject_audit_mutation();

ALTER TABLE appointment_audit DROP CONSTRAINT IF EXISTS appointment_audit_appointment_id_fkey;
DROP TABLE IF EXISTS appointment_audit;
