/**
 * Staff mark-status — `POST /appointments/:id/mark-status`.
 *
 * Per spec-5-1 (E5-S1), a doctor or receptionist marks an
 * appointment as Completed or No-show (F-10 / subset). The status
 * transitions atomically and an audit row is written. No reason
 * is required (BR-039, BR-040). The slot is NOT released — the
 * row is in the past and the GIST exclusion (scoped on
 * status='Scheduled') already lets past rows coexist.
 *
 * Atomic + GIST-protected:
 *   - pool.connect() + BEGIN.
 *   - SELECT FOR UPDATE on the appointment row by id.
 *   - Role gate (server-trusted, body-ignored): if claim.role is
 *     'doctor', `appt.doctor_id = claim.doctor_id` AND
 *     `appt.branch_id ∈ claim.branch_ids`. If claim.role is
 *     'receptionist', `appt.branch_id ∈ claim.branch_ids`
 *     (BR-004). Otherwise → 403 outside_branch_scope.
 *   - Status gate: only `Scheduled` rows are markable. Terminal
 *     states (Cancelled / Completed / No-Show) → 422
 *     already_in_terminal_state (a distinct envelope from the
 *     patient-facing not_found_appointment_in_terminal_state
 *     because the staff flow has DIFFERENT semantics: the row
 *     is visible in their queue).
 *   - Time gate (BR-040 / FR-037): No-show and Completed can
 *     ONLY be applied to rows whose start_datetime <= now().
 *     Future rows → 422 appointment_in_future.
 *   - UPDATE appointment SET status = $new_status.
 *   - INSERT appointment_audit (actor_role=claim.role,
 *     actor_id='staff:<sub>', event='marked_<status>',
 *     payload='{}' since BR-039 / BR-040 say no reason).
 *   - COMMIT.
 *
 * Auth: claim.role ∈ {doctor, receptionist} only. Patient and
 * admin → 403 forbidden_role. Anonymous → 401 unauthenticated.
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_STATUSES = new Set(['Completed', 'No-show'] as const);
type MarkStatus = 'Completed' | 'No-show';

const SELECT_APPOINTMENT_FOR_UPDATE_SQL = `
  SELECT id::text AS id, patient_phone, status, branch_id::text AS branch_id,
         doctor_id::text AS doctor_id, appointment_type_id::text AS appointment_type_id,
         start_datetime, end_datetime
    FROM appointment
   WHERE id = $1::uuid
     FOR UPDATE;
`;

const UPDATE_STATUS_SQL = `
  UPDATE appointment SET status = $2 WHERE id = $1::uuid;
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1::uuid, $2, $3, $4, '{}'::jsonb);
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

export const staffMarkStatusRouter: Router = Router();

staffMarkStatusRouter.post(
  '/appointments/:id/mark-status',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    // Patient and admin are not authorized to mark-status
    // (PRD §2.4: admin never touches individual appointments).
    // E5-S2 / E5-S3 handle doctor / receptionist cancellation.
    if (claim.role !== 'doctor' && claim.role !== 'receptionist') {
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

    // Body shape: { status: 'Completed' | 'No-show' }.
    // Per spec-0-2 the appointment_status enum is exactly
    // {Scheduled, Completed, Cancelled, No-show} (lowercase 's').
    // The route must mirror the DB enum verbatim, otherwise the
    // UPDATE fails at the SQL layer with `22P02 invalid input value
    // for enum`.
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid_status' });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b['status'] !== 'string' || !ALLOWED_STATUSES.has(b['status'] as MarkStatus)) {
      res.status(400).json({ error: 'invalid_status' });
      return;
    }
    const newStatus = b['status'] as MarkStatus;
    const auditEvent =
      newStatus === 'Completed' ? 'marked_completed' : 'marked_no_show';

    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_mark_status_connect_failed',
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

      // 2. Role-scope gate. Server-trusted; the body is NEVER consulted.
      //    Doctor scope is doubly-bound (doctor_id AND branch).
      //    Receptionist scope is branch-only (BR-004).
      if (claim.role === 'doctor') {
        const doctorMatch = appt.doctor_id === claim.doctor_id;
        const branchMatch = claim.branch_ids.includes(appt.branch_id);
        if (!doctorMatch || !branchMatch) {
          await client.query('ROLLBACK');
          res.status(403).json({ error: 'outside_branch_scope' });
          return;
        }
      } else {
        // claim.role === 'receptionist' (already filtered above).
        if (!claim.branch_ids.includes(appt.branch_id)) {
          await client.query('ROLLBACK');
          res.status(403).json({ error: 'outside_branch_scope' });
          return;
        }
      }

      // 3. Status gate: only Scheduled is markable. Idempotent for
      //    already-marked rows (distinct envelope from patient cancel
      //    because the staff flow sees the row).
      if (appt.status !== 'Scheduled') {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'already_in_terminal_state' });
        return;
      }

      // 4. Time gate (BR-040 / FR-037): mark-status requires the
      //    appointment's start_datetime <= now().
      if (appt.start_datetime.getTime() > Date.now()) {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'appointment_in_future' });
        return;
      }

      // 5. Atomic status UPDATE. The locked SELECT FOR UPDATE row
      //    carries every column the response needs; the UPDATE itself
      //    only flips status.
      await client.query(UPDATE_STATUS_SQL, [appt.id, newStatus]);

      // 6. Audit row. BR-039 / BR-040: no reason — payload is {}.
      await client.query(INSERT_AUDIT_SQL, [
        appt.id,
        claim.role,
        `staff:${claim.sub}`,
        auditEvent,
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
          status: newStatus,
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
        'staff_mark_status_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);