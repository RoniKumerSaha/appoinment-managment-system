/**
 * Staff doctor cancel — `POST /appointments/:id/cancel`.
 *
 * Per spec-5-2 (E5-S2) + F-10 (Cancel branch) + BR-037 / FR-035:
 * the doctor cancels a Scheduled appointment on behalf of a
 * patient. The doctor MUST provide a reason (BR-037, FR-035).
 * The slot is released (BR-053, FR-050) and an audit row is
 * written with `payload = {reason}`.
 *
 * Atomic + GIST-protected:
 *   - pool.connect() + BEGIN.
 *   - SELECT FOR UPDATE on the appointment row by id.
 *   - Role gate (server-trusted, body-ignored): if claim.role is
 *     'doctor', `appt.doctor_id = claim.doctor_id` AND
 *     `appt.branch_id ∈ claim.branch_ids`. Otherwise → 403
 *     outside_branch_scope.
 *   - Reason gate (FR-035): body's `reason` MUST be a
 *     non-empty trimmed string ≤ 500 chars. Missing / empty /
 *     whitespace-only → 400 reason_required. > 500 chars → 400
 *     reason_too_long.
 *   - Status gate: only `Scheduled` rows are cancellable.
 *     Already-Cancelled / Completed / No-Show → 422
 *     already_in_terminal_state (a distinct envelope from the
 *     patient-facing not_found_appointment_in_terminal_state
 *     because the staff flow sees the row in their queue).
 *   - UPDATE appointment SET status = 'Cancelled'.
 *   - INSERT appointment_audit (actor_role='doctor',
 *     actor_id='staff:<sub>', event='cancelled',
 *     payload={reason: <trimmed>}).
 *   - COMMIT.
 *
 * Auth: claim.role === 'doctor' only. Patient / admin /
 * receptionist → 403 forbidden_role. Anonymous → 401.
 *
 * Route path note: `/appointments/:id/cancel` is the staff path;
 * E4-S2 owns `/patient/appointments/:id/cancel` for the patient
 * flow. Same path shape, different role gate.
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASON_MAX = 500;

const SELECT_APPOINTMENT_FOR_UPDATE_SQL = `
  SELECT id::text AS id, patient_phone, status, branch_id::text AS branch_id,
         doctor_id::text AS doctor_id, appointment_type_id::text AS appointment_type_id,
         start_datetime, end_datetime
    FROM appointment
   WHERE id = $1::uuid
     FOR UPDATE;
`;

const UPDATE_CANCEL_APPOINTMENT_SQL = `
  UPDATE appointment SET status = 'Cancelled' WHERE id = $1::uuid;
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1::uuid, 'doctor', $2, 'cancelled', $3::jsonb);
`;

interface AppointmentRow {
  id: string;
  patient_phone: string;
  status: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: Date;
  end_datetime: Date;
}

export const staffDoctorCancelRouter: Router = Router();

staffDoctorCancelRouter.post(
  '/appointments/:id/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'doctor') {
      // E4-S2 handles patient cancel; E5-S3 handles receptionist
      // cancel. Admin never touches individual appointments
      // (PRD §2.4).
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (!UUID_RE.test(id)) {
      // Same envelope as "doesn't exist" — don't reveal whether the
      // path itself is valid.
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Body shape: { reason: string }. FR-035 — required.
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'reason_required' });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b['reason'] !== 'string') {
      res.status(400).json({ error: 'reason_required' });
      return;
    }
    const trimmedReason = b['reason'].trim();
    if (trimmedReason.length === 0) {
      res.status(400).json({ error: 'reason_required' });
      return;
    }
    if (trimmedReason.length > REASON_MAX) {
      res.status(400).json({ error: 'reason_too_long' });
      return;
    }
    // Use the byte length for the cap so multi-byte UTF-8 sequences
    // are not unfairly penalized; the 500-char cap is a UX safety net
    // (UX-FLOWS F-10 mockup limits the input field). A reason with
    // 500 chars of 4-byte sequences would be > 2000 bytes — still
    // well within the audit payload column limits (jsonb) but
    // intentionally capped at the JS char length to keep the
    // contract simple and consistent with the UX.
    const auditPayload = JSON.stringify({ reason: trimmedReason });

    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_doctor_cancel_connect_failed',
      );
      throw err;
    }
    try {
      await client.query('BEGIN');

      // 1. Lock the appointment row.
      const { rows } = await client.query<AppointmentRow>(
        SELECT_APPOINTMENT_FOR_UPDATE_SQL,
        [id],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const appt = rows[0]!;

      // 2. Role-scope gate (doubly-bound for doctors).
      const doctorMatch = appt.doctor_id === claim.doctor_id;
      const branchMatch = claim.branch_ids.includes(appt.branch_id);
      if (!doctorMatch || !branchMatch) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }

      // 3. Status gate: only Scheduled is cancellable. Idempotent
      //    for terminal states (distinct envelope from patient
      //    cancel because the staff flow sees the row).
      if (appt.status !== 'Scheduled') {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'already_in_terminal_state' });
        return;
      }

      // 4. Atomic status UPDATE. Slot is released by the GIST
      //    exclusion (scoped on status='Scheduled'); a Cancelled
      //    row no longer blocks the time range.
      await client.query(UPDATE_CANCEL_APPOINTMENT_SQL, [appt.id]);

      // 5. Audit row with payload={reason}. FR-035: doctor must
      //    provide one.
      await client.query(INSERT_AUDIT_SQL, [
        appt.id,
        `staff:${claim.sub}`,
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
        'staff_doctor_cancel_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);