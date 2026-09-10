-- E0-S2: 0005 — appointment_type.
--
-- A named appointment kind (e.g. "consultation", "follow-up") with a fixed
-- duration in minutes. Owned by a clinic; a doctor can offer multiple types.
-- is_active toggles whether the type is bookable.
--
-- E3 (booking core) reads this table to compute slot duration; E2-S3 manages
-- the rows via an admin form (out of E0-S2 scope).

CREATE TABLE IF NOT EXISTS appointment_type (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  name             text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  is_active        boolean NOT NULL DEFAULT true,
  created_by       text NOT NULL CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]{1,255}$' AND length(created_by) <= 256),
  created_at       timestamptz NOT NULL DEFAULT app_now(),
  updated_at       timestamptz NOT NULL DEFAULT app_now()
);

DROP TRIGGER IF EXISTS trg_appointment_type_set_updated_at ON appointment_type;
CREATE TRIGGER trg_appointment_type_set_updated_at
  BEFORE UPDATE ON appointment_type
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_appointment_type_clinic_id ON appointment_type(clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointment_type_active ON appointment_type(clinic_id) WHERE is_active;
