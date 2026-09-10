-- E0-S2: 0008 — appointment.
--
-- The booking spine. Carries Architecture §4 invariants:
--   - status enum is exactly {Scheduled, Completed, Cancelled, No-show}
--   - GIST exclusion prevents a doctor from having two Scheduled appointments
--     at the same (branch, time window). Half-open ranges '[)' so back-to-back
--     appointments like [10:00, 10:30) and [10:30, 11:00) do NOT collide.
--   - Partial unique (patient_phone, doctor_id) WHERE status='Scheduled'
--     prevents a patient from having two Scheduled appointments with the SAME
--     doctor. Cross-doctor Scheduled appointments ARE allowed (Architecture
--     §4 invariant 3 is per-doctor; honors FR-028 "patient may have future
--     appointments with multiple doctors").
--   - Two read-path B-tree indexes for availability latency (Architecture §6):
--     (patient_phone, status, start_datetime) and
--     (doctor_id, branch_id, start_datetime).
--
-- FKs use ON DELETE RESTRICT — appointment rows are never deleted (Cancelled is
-- the terminal state), but a parent DELETE would orphan the rows; RESTRICT
-- fails loud instead of cascading silently.

-- ===== enum =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appointment_status') THEN
    CREATE TYPE appointment_status AS ENUM (
      'Scheduled',
      'Completed',
      'Cancelled',
      'No-show'
    );
  END IF;
END $$;

-- ===== table =====
CREATE TABLE IF NOT EXISTS appointment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
  doctor_id           uuid NOT NULL REFERENCES doctor(id) ON DELETE RESTRICT,
  patient_phone       text NOT NULL,
  appointment_type_id uuid REFERENCES appointment_type(id) ON DELETE RESTRICT,
  start_datetime      timestamptz NOT NULL,
  end_datetime        timestamptz NOT NULL CHECK (end_datetime > start_datetime),
  status              appointment_status NOT NULL DEFAULT 'Scheduled',
  created_by          text NOT NULL CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]{1,255}$'),
  created_at          timestamptz NOT NULL DEFAULT app_now(),
  updated_at          timestamptz NOT NULL DEFAULT app_now()
);

DROP TRIGGER IF EXISTS trg_appointment_set_updated_at ON appointment;
CREATE TRIGGER trg_appointment_set_updated_at
  BEFORE UPDATE ON appointment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== per-doctor uniqueness (Architecture §4 invariant 3) =====
-- A patient can have at most one Scheduled appointment per doctor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_patient_doctor_scheduled
  ON appointment(patient_phone, doctor_id)
  WHERE status = 'Scheduled';

-- ===== GIST exclusion (Architecture §4 invariant 1) =====
-- A doctor cannot have two Scheduled appointments overlapping in time at the
-- same branch. Half-open ranges '[)' so adjacent slots don't collide.
-- Requires btree_gist (0002_extensions) for the equality operator classes on
-- uuid columns.
ALTER TABLE appointment
  DROP CONSTRAINT IF EXISTS appointment_no_overlap;
ALTER TABLE appointment
  ADD CONSTRAINT appointment_no_overlap
  EXCLUDE USING gist (
    doctor_id    WITH =,
    branch_id    WITH =,
    tstzrange(start_datetime, end_datetime, '[)') WITH &&
  )
  WHERE (status = 'Scheduled');

-- ===== read-path B-tree indexes (Architecture §6) =====
CREATE INDEX IF NOT EXISTS idx_appointment_patient_status_start
  ON appointment(patient_phone, status, start_datetime);

CREATE INDEX IF NOT EXISTS idx_appointment_doctor_branch_start
  ON appointment(doctor_id, branch_id, start_datetime);
