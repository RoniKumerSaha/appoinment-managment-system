-- E6-S1: recurring_series_id — grouping column for recurring series.
--
-- Per spec-6-1 (E6-S1) + PRD F-11 + BR-047…053 + FR-044…050:
-- A doctor or receptionist previews a recurring series (Weekly /
-- Every 2 weeks / Custom). On confirm, all valid occurrences are
-- created atomically as Scheduled; one audit row per created
-- occurrence. Per-occurrence independence (BR-052, FR-049) means
-- each created row is an independent appointment thereafter
-- (cancellable / reschedulable individually via E4-S2 / E4-S3).
--
-- The `recurring_series_id` column groups occurrences of a single
-- confirm for reporting and reconstruction. NULL on non-recurring
-- appointments and on pre-existing rows.
--
-- The series id is generated SERVER-SIDE per confirm (uuid); all
-- occurrences of a single confirm share the same value. The value
-- is stable across reads because it lives in the row itself, not
-- in an in-memory pointer.
--
-- The audit row per created occurrence carries
-- `payload = {series_id, recurrence_kind, recurrence_interval_days,
-- occurrence_index}` (1-based).
--
-- Schema after this migration:
--   appointment(
--     id                  uuid PK,
--     clinic_id           uuid NOT NULL FK clinic,
--     branch_id           uuid NOT NULL FK branch,
--     doctor_id           uuid NOT NULL FK doctor,
--     patient_phone       text NOT NULL,
--     appointment_type_id uuid FK appointment_type,
--     start_datetime      timestamptz NOT NULL,
--     end_datetime        timestamptz NOT NULL,
--     status              appointment_status NOT NULL DEFAULT 'Scheduled',
--     recurring_series_id uuid NULL,            -- NEW (E6-S1)
--     created_by          text NOT NULL,
--     created_at          timestamptz NOT NULL DEFAULT app_now(),
--     updated_at          timestamptz NOT NULL DEFAULT app_now()
--   )
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- A re-apply on a migrated DB is a no-op.

ALTER TABLE appointment
  ADD COLUMN IF NOT EXISTS recurring_series_id uuid;

-- Partial B-tree index on recurring_series_id (only the rows that have
-- one). Indexes are sparse by design: non-recurring rows (NULL) do NOT
-- occupy index slots, so the index stays compact. Read paths (reporting,
-- audit reconstruction, "list all occurrences of a series") scan via
-- the partial predicate `recurring_series_id = $1`.
CREATE INDEX IF NOT EXISTS idx_appointment_recurring_series_id
  ON appointment(recurring_series_id)
  WHERE recurring_series_id IS NOT NULL;