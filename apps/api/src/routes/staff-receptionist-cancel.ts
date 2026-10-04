/**
 * Staff receptionist cancel — `POST /reception/appointments/:id/cancel`.
 *
 * Per spec-5-3 (E5-S3) + F-14 + BR-036 / FR-034: the receptionist
 * cancels a Scheduled appointment on behalf of a patient. The
 * receptionist MUST provide a reason (FR-034). The slot is
 * released (BR-053, FR-050) and an audit row is written with
 * `payload = {reason}`. Cancellation is restricted to the
 * receptionist's assigned branch (server-side, BR-004).
 *
 * Atomic + GIST-protected:
 *   - pool.connect() + BEGIN.
 *   - SELECT FOR UPDATE on the appointment row by id.
 *   - Role gate (server-trusted, body-ignored): if claim.role is
 *     'receptionist', `appt.branch_id ∈ claim.branch_ids`.
 *     Otherwise → 403 outside_branch_scope. NO doctor-scope
 *     check — a receptionist can cancel any appointment at
 *     their branch regardless of which doctor is on the row
 *     (BR-004).
 *   - Reason gate (FR-034): body's `reason` MUST be a
 *     non-empty trimmed string ≤ 500 chars. Missing / empty /
 *     whitespace-only → 400 reason_required. > 500 chars → 400
 *     reason_too_long. Same envelope as E5-S2 — both staff
 *     flows share the same reason-validation contract.
 *   - Status gate: only `Scheduled` rows are cancellable.
 *     Already-Cancelled / Completed / No-Show → 422
 *     already_in_terminal_state (same envelope as E5-S1 /
 *     E5-S2 — staff flows share this terminal-state envelope).
 *   - UPDATE appointment SET status = 'Cancelled'.
 *   - INSERT appointment_audit (actor_role='receptionist',
 *     actor_id='staff:<sub>', event='cancelled',
 *     payload={reason: <trimmed>}).
 *   - COMMIT.
 *
 * Auth: claim.role === 'receptionist' only. Patient / admin /
 * doctor → 403 forbidden_role. Anonymous → 401.
 *
 * Route path note: `/reception/appointments/:id/cancel` is the
 * receptionist path; E5-S2 owns `/appointments/:id/cancel` for
 * the doctor flow. Different paths avoid the role-gate
 * discriminator issue. Same path shape as E5-S2 was rejected
 * because routing two role gates to the same path requires a
 * discriminator that doesn't exist in our router stack today.
 */
import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASON_MAX = 500;

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

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload)
  VALUES ($1::uuid, 'receptionist', $2, 'cancelled', $3::jsonb);
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

export const staffReceptionistCancelRouter: Router = Router();

staffReceptionistCancelRouter.post(
  '/reception/appointments/:id/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'receptionist') {
      // E4-S2 handles patient cancel; E5-S2 handles doctor cancel.
      // Admin never touches individual appointments (PRD §2.4).
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

    // Body shape: { reason: string }. FR-034 — required.
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
    // NOTE: the audit payload is finalized INSIDE the txn (after
    // the SELECT FOR UPDATE returns recurring_series_id), so the
    // E6-S4 enrichment can be applied conditionally. The trimmed
    // reason is captured here; the JSON.stringify happens at audit
    // time.

    const pool = await getPool();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_receptionist_cancel_connect_failed',
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

      // 2. Branch-scope gate (BR-004). NO doctor-scope check —
      //    a receptionist can cancel ANY appointment at their
      //    branch regardless of which doctor is on the row.
      if (!claim.branch_ids.includes(appt.branch_id)) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }

      // 3. Status gate: only Scheduled is cancellable. Idempotent
      //    for terminal states.
      if (appt.status !== 'Scheduled') {
        await client.query('ROLLBACK');
        res.status(422).json({ error: 'already_in_terminal_state' });
        return;
      }

      // 4. Atomic status UPDATE. Slot is released by the GIST
      //    exclusion (scoped on status='Scheduled'); a Cancelled
      //    row no longer blocks the time range.
      await client.query(UPDATE_CANCEL_APPOINTMENT_SQL, [appt.id]);

      // 5. Audit row with payload={reason}. FR-034: receptionist
      //    must provide one. E6-S4: enrich with `recurring_origin`
      //    when the cancelled occurrence was part of a recurring
      //    series (so the audit row can be reconstructed later).
      const auditPayload = appt.recurring_series_id
        ? JSON.stringify({
            reason: trimmedReason,
            recurring_origin: { series_id: appt.recurring_series_id },
          })
        : JSON.stringify({ reason: trimmedReason });
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
        'staff_receptionist_cancel_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);