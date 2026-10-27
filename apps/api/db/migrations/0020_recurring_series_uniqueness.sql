-- E6-S1 follow-up: the per-doctor uniqueness index must not apply across
-- the occurrences of a single recurring series.
--
-- 0008 created:
--
--   CREATE UNIQUE INDEX idx_appointment_patient_doctor_scheduled
--     ON appointment(patient_phone, doctor_id)
--     WHERE status = 'Scheduled';
--
-- That encodes FR-027 ("a patient has at most one Scheduled appointment
-- per doctor"). But a recurring series (F-11 / BR-047…053) creates N
-- Scheduled rows for the same (patient_phone, doctor_id) — one per
-- occurrence — which the index rejected with SQLSTATE 23505. The second
-- and subsequent occurrences were reported as `slot_raced`, so a
-- 3-occurrence confirm silently produced 1 appointment.
--
-- The two rules are reconciled by scoping the index to non-recurring
-- rows. A recurring series is ONE logical appointment with several
-- occurrences; FR-027's intent ("no two concurrent scheduled
-- appointments with the same doctor") is about distinct appointments,
-- not about a series' own occurrences.
--
-- Overlap between occurrences of a series is still prevented — by the
-- GIST exclusion constraint `appointment_no_overlap` (0008), which is
-- independent of this index.
--
-- Idempotent: DROP + CREATE, both guarded.

DROP INDEX IF EXISTS idx_appointment_patient_doctor_scheduled;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_patient_doctor_scheduled
  ON appointment(patient_phone, doctor_id)
  WHERE status = 'Scheduled'
    AND recurring_series_id IS NULL;
