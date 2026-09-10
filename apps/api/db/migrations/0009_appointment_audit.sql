-- E0-S2: 0009 — appointment_audit.
--
-- Append-only audit trail. Records every event (created, rescheduled,
-- cancelled, completed, marked no-show, etc.) with the actor who performed it
-- and a JSONB payload of event-specific data.
--
-- Append-only enforcement is the trigger `reject_audit_mutation`, which fires
-- BEFORE UPDATE OR DELETE and RAISEs. REVOKE alone is insufficient because
-- superuser bypasses it; the trigger is the primary guard.
--
-- appointment_id is FK NULLABLE because some events (e.g. attempted booking
-- that conflicted) have no associated appointment row. The FK uses
-- NO ACTION DEFERRABLE INITIALLY DEFERRED so that within a transaction that
-- creates an appointment + writes its audit row, the audit's appointment_id
-- resolves correctly even if the appointment row was inserted in the same
-- transaction.

CREATE TABLE IF NOT EXISTS appointment_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid,
  actor_role     text NOT NULL,
  actor_id       text NOT NULL,
  event          text NOT NULL,
  payload        jsonb,
  created_at     timestamptz NOT NULL DEFAULT app_now()
);

-- FK as a separate ALTER so DEFERRABLE works (DEFERRABLE on inline REFERENCES
-- is fine in modern Postgres but explicit ALTER is clearer).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointment_audit_appointment_id_fkey'
  ) THEN
    ALTER TABLE appointment_audit
      ADD CONSTRAINT appointment_audit_appointment_id_fkey
      FOREIGN KEY (appointment_id)
      REFERENCES appointment(id)
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ===== append-only enforcement =====
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'appointment_audit_is_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_appointment_audit_no_update ON appointment_audit;
CREATE TRIGGER trg_appointment_audit_no_update
  BEFORE UPDATE ON appointment_audit
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

DROP TRIGGER IF EXISTS trg_appointment_audit_no_delete ON appointment_audit;
CREATE TRIGGER trg_appointment_audit_no_delete
  BEFORE DELETE ON appointment_audit
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- BEFORE TRUNCATE (statement-level) — TRUNCATE bypasses row-level BEFORE
-- UPDATE/DELETE triggers, so a separate statement-level guard is required to
-- fully honor the "append-only" contract.
DROP TRIGGER IF EXISTS trg_appointment_audit_no_truncate ON appointment_audit;
CREATE TRIGGER trg_appointment_audit_no_truncate
  BEFORE TRUNCATE ON appointment_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

CREATE INDEX IF NOT EXISTS idx_appointment_audit_appointment_id
  ON appointment_audit(appointment_id);
CREATE INDEX IF NOT EXISTS idx_appointment_audit_actor
  ON appointment_audit(actor_role, actor_id);
CREATE INDEX IF NOT EXISTS idx_appointment_audit_event_created
  ON appointment_audit(event, created_at DESC);
