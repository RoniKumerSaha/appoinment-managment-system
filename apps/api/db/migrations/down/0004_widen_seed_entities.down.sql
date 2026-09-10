-- E0-S2: 0004 — widen E0-S1 seed entities (down).

DROP INDEX IF EXISTS idx_patient_phone_number;
DROP INDEX IF EXISTS idx_doctor_branch_branch_id;
DROP INDEX IF EXISTS idx_branch_clinic_id;

DROP TRIGGER IF EXISTS trg_patient_set_updated_at ON patient;
ALTER TABLE patient DROP COLUMN IF EXISTS updated_at;

DROP TRIGGER IF EXISTS trg_admin_user_set_updated_at ON admin_user;
ALTER TABLE admin_user DROP CONSTRAINT IF EXISTS admin_user_email_key;
ALTER TABLE admin_user DROP COLUMN IF EXISTS email;
ALTER TABLE admin_user DROP COLUMN IF EXISTS updated_at;

DROP TRIGGER IF EXISTS trg_receptionist_set_updated_at ON receptionist;
ALTER TABLE receptionist DROP CONSTRAINT IF EXISTS receptionist_email_key;
ALTER TABLE receptionist DROP COLUMN IF EXISTS email;
ALTER TABLE receptionist DROP COLUMN IF EXISTS updated_at;

DROP TRIGGER IF EXISTS trg_doctor_branch_set_updated_at ON doctor_branch;
ALTER TABLE doctor_branch DROP COLUMN IF EXISTS updated_at;

DROP TRIGGER IF EXISTS trg_doctor_set_updated_at ON doctor;
ALTER TABLE doctor DROP COLUMN IF EXISTS updated_at;

DROP TRIGGER IF EXISTS trg_branch_set_updated_at ON branch;
ALTER TABLE branch DROP COLUMN IF EXISTS updated_at;

DROP TRIGGER IF EXISTS trg_clinic_set_updated_at ON clinic;
ALTER TABLE clinic DROP COLUMN IF EXISTS updated_at;
