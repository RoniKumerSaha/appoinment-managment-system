/**
 * Doctor appointment audit read — `GET /doctor/appointments/:id/audit`.
 *
 * Per spec-7-2 (E7-S2) + PRD FR-051 + NFR-005:
 * A doctor reads the audit trail for an appointment they OWN.
 * The audit log is internal-only (NFR-005); patient /
 * receptionist / admin each have their own surfaces (see
 * `reception-appointment-audit.ts` for the receptionist
 * surface and `admin-audit.ts` for the admin's policy
 * envelope).
 *
 * Doctor scope doubly-bound:
 *   1. `claim.role === 'doctor'` (role gate).
 *   2. `appointment.doctor_id === claim.doctor_id` (the
 *      doctor can ONLY read audits for their own
 *      appointments). Cross-doctor reads return
 *      403 outside_branch_scope.
 *
 * Auth: claim.role === 'doctor' only. Patient / receptionist
 * / admin → 403 forbidden_role. Anonymous → 401.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUDIT_ROWS = 200;

interface AppointmentRow {
  id: string;
  doctor_id: string;
  branch_id: string;
  patient_phone: string;
}

interface AuditRow {
  id: string;
  appointment_id: string | null;
  actor_role: string;
  actor_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: Date;
  patient_phone: string;
}

const SELECT_APPOINTMENT_SQL = `
  SELECT id::text AS id, doctor_id::text AS doctor_id,
         branch_id::text AS branch_id, patient_phone
    FROM appointment
   WHERE id = $1::uuid;
`;

const SELECT_AUDIT_SQL = `
  SELECT aa.id::text AS id, aa.appointment_id::text AS appointment_id,
         aa.actor_role, aa.actor_id, aa.event, aa.payload,
         aa.created_at, a.patient_phone
    FROM appointment_audit aa
    LEFT JOIN appointment a ON a.id = aa.appointment_id
   WHERE aa.appointment_id = $1::uuid
   ORDER BY aa.created_at ASC, aa.id ASC
   LIMIT ${MAX_AUDIT_ROWS};
`;

const COUNT_AUDIT_SQL = `
  SELECT COUNT(*)::text AS count
    FROM appointment_audit
   WHERE appointment_id = $1::uuid;
`;

export const doctorAppointmentAuditRouter: Router = Router();

doctorAppointmentAuditRouter.get(
  '/doctor/appointments/:id/audit',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'doctor') {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    if (claim.doctor_id === undefined) {
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (!UUID_RE.test(id)) {
      // Same envelope as "doesn't exist" — privacy: don't
      // reveal whether the path itself is valid.
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_appointment_audit_connect_failed',
      );
      throw err;
    }
    try {
      const { rows: apptRows } = await client.query<AppointmentRow>(
        SELECT_APPOINTMENT_SQL,
        [id],
      );
      if (apptRows.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const appt = apptRows[0]!;
      // Ownership gate: the doctor can ONLY read audits for
      // their own appointments.
      if (appt.doctor_id !== claim.doctor_id) {
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }

      const { rows: countRows } = await client.query<{ count: string }>(
        COUNT_AUDIT_SQL,
        [id],
      );
      const count = Number(countRows[0]?.count ?? 0);

      const { rows } = await client.query<AuditRow>(SELECT_AUDIT_SQL, [id]);

      res.status(200).json({
        appointment_id: appt.id,
        patient_phone: appt.patient_phone,
        count,
        audit: rows.map((r) => ({
          id: r.id,
          appointment_id: r.appointment_id,
          actor_role: r.actor_role,
          actor_id: r.actor_id,
          event: r.event,
          payload: r.payload,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_appointment_audit_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);