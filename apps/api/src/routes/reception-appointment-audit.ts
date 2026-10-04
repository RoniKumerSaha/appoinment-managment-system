/**
 * Receptionist appointment audit read — `GET /reception/appointments/:id/audit`.
 *
 * Per spec-7-2 (E7-S2) + PRD FR-051 + NFR-005:
 * A receptionist reads the audit trail for an appointment at
 * THEIR branch. The audit log is internal-only (NFR-005);
 * patient / doctor / admin each have their own surfaces.
 *
 * Receptionist scope:
 *   1. `claim.role === 'receptionist'` (role gate).
 *   2. `appointment.branch_id ∈ claim.branch_ids` (the
 *      receptionist can ONLY read audits at their branch).
 *      Cross-branch reads return 403 outside_branch_scope.
 *
 * Auth: claim.role === 'receptionist' only. Patient / doctor
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

export const receptionAppointmentAuditRouter: Router = Router();

receptionAppointmentAuditRouter.get(
  '/reception/appointments/:id/audit',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'receptionist') {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    if (claim.branch_ids.length === 0) {
      // Defense-in-depth: middleware should reject empty
      // branch_ids at the auth layer.
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (!UUID_RE.test(id)) {
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
        'reception_appointment_audit_connect_failed',
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
      // Branch-scope gate.
      if (!claim.branch_ids.includes(appt.branch_id)) {
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
        'reception_appointment_audit_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);