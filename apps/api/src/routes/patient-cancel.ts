/**
 * Patient self-service cancel — `POST /patient/appointments/:id/cancel`.
 *
 * Per spec-4-2 (E4-S2), the verified patient cancels their own
 * Scheduled appointment (F-04). The row transitions to status='Cancelled'
 * (BR-038: never deleted), the slot is released (BR-053 / FR-050:
 * the GIST exclusion is scoped on status='Scheduled', so the Cancelled
 * row no longer blocks the time range), and an audit row is written.
 *
 * No cancellation reason is required (FR-033 explicit) — the
 * receptionist flow FR-034 is the one that requires a reason, and
 * that lives in E5-S3.
 *
 * Privacy (E7-S3): the appointment must match `claim.sub`. Any other
 * outcome (not found, wrong owner, wrong status) returns 404 — NEVER
 * 403 — so a patient cannot enumerate other patients' appointments
 * by id. The response is identical for "doesn't exist" and "exists
 * but you don't own it": `404 not_found`.
 *
 * Terminal states (Cancelled / Completed / No-Show) return a
 * distinct envelope `404 not_found_appointment_in_terminal_state`
 * because it is a separate code: the row exists, you own it, but
 * the cancel would be a no-op. The envelope surfaces WHY to the
 * client (so the UI can show "already cancelled" vs "you can't
 * cancel this").
 *
 * Atomic + GIST-protected:
 *   - pool.connect() + SELECT FOR UPDATE on the appointment row +
 *     status UPDATE + audit INSERT + COMMIT. If the audit INSERT
 *     fails, the status change rolls back.
 *   - Concurrent cancel-vs-cancel: SELECT FOR UPDATE serializes both;
 *     the second cancel sees status='Cancelled' and returns 404
 *     not_found_appointment_in_terminal_state (idempotent).
 *   - Concurrent cancel-vs-book (a different patient books the slot
 *     after release): the slot is released the moment the UPDATE
 *     commits; the next POST /bookings can take it. The GIST
 *     exclusion is on Scheduled rows, so a Cancelled row does not
 *     conflict.
 *
 * Auth: claim.role='patient' only. Doctor / admin / receptionist
 * have their own cancel flows (E5-S2 / E5-S3 / E6-S4).
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SELECT FOR UPDATE on the appointment row by id. Scoped by id only;
// // the route enforces `patient_phone = claim.sub` AFTER the SELECT.
// E6-S4: also reads `recurring_series_id` so the audit payload can
// carry `recurring_origin` when the cancelled occurrence was part
// of a recurring series.
const SELECT_APPOINTMENT_FOR_UPDATE_SQL = `
  SELECT id::text AS id, patient_phone, status, branch_id::text AS branch_id,
         doctor_id::text AS doctor_id, appointment_type_id::text AS appointment_type_id,
         recurring_series_id::text AS recurring_series_id,
         start_datetime, end_datetime
    FROM appointment
   WHERE id = $1::uuid
     FOR UPDATE;
`;

const UPDATE_CANCEL_APPOINTMENT_SQL = `
  UPDATE appointment SET status = 'Cancelled' WHERE id = $1::uuid;
`;

// E6-S4: payload is built dynamically so the recurring_origin key
// can be added when the source row has a recurring_series_id.
// When the source row is non-recurring the payload is the empty
// object (matches the pre-E6-S4 contract).
const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1::uuid, 'patient', $2, 'cancelled', $3::jsonb);
`;

interface AppointmentRow {
  id: string;
  patient_phone: string;
  status: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  recurring_series_id: string | null;
  start_datetime: Date;
  end_datetime: Date;
}

export const patientCancelRouter: Router = Router();

patientCancelRouter.post(
  '/patient/appointments/:id/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'patient') {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (!UUID_RE.test(id)) {
      // Same envelope as "doesn't exist" — privacy: don't reveal
      // whether the path itself is valid.
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_cancel_connect_failed',
      );
      throw err;
    }
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<AppointmentRow>(
        SELECT_APPOINTMENT_FOR_UPDATE_SQL,
        [id],
      );
      // E7-S3 privacy: identical envelope for "doesn't exist" and
      // "exists but not yours" so the patient cannot enumerate other
      // patients' appointments by id.
      if (rows.length === 0 || rows[0]!.patient_phone !== claim.sub) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const appt = rows[0]!;
      // FR-033: only Scheduled is cancellable. Terminal states return a
      // distinct envelope so the client can show "already cancelled".
      if (appt.status !== 'Scheduled') {
        await client.query('ROLLBACK');
        res.status(404).json({
          error: 'not_found_appointment_in_terminal_state',
        });
        return;
      }

      await client.query(UPDATE_CANCEL_APPOINTMENT_SQL, [appt.id]);

      // FR-033: no cancellation reason required (receptionist flow FR-034
      // is the one that requires a reason; that's E5-S3).
      // E6-S4: enrich the audit payload with `recurring_origin` when
      // the cancelled occurrence was part of a recurring series.
      const auditPayload = appt.recurring_series_id
        ? JSON.stringify({
            recurring_origin: { series_id: appt.recurring_series_id },
          })
        : '{}';
      await client.query(INSERT_AUDIT_SQL, [
        appt.id,
        `patient:${claim.sub}`,
        auditPayload,
      ]);

      await client.query('COMMIT');

      res.status(200).json({
        appointment: {
          id: appt.id,
          branch_id: appt.branch_id,
          doctor_id: appt.doctor_id,
          appointment_type_id: appt.appointment_type_id,
          start_datetime: appt.start_datetime.toISOString(),
          end_datetime: appt.end_datetime.toISOString(),
          status: 'Cancelled',
        },
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_cancel_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);