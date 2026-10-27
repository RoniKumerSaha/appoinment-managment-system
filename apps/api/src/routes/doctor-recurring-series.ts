/**
 * Doctor recurring series read — `GET /doctor/recurring-series/:id`.
 *
 * The doctor back-out screen (mock 40) shows what is already on
 * the books after a recurring series was created. It needs the
 * series' occurrences AND the audit trail that says who created
 * them and when, because the screen's whole point is "there is no
 * undo — act one occurrence at a time".
 *
 * `GET /doctor/affected` cannot serve this: it lists only
 * Scheduled appointments that fall OUTSIDE the doctor's branch
 * weekly hours. A normally-scheduled series never appears there.
 *
 * Scope is doubly-bound:
 *   1. `claim.role === 'doctor'` (role gate).
 *   2. Every occurrence's `doctor_id === claim.doctor_id`. A
 *      series belonging to another doctor returns the same 404
 *      envelope as a series that does not exist — the doctor must
 *      not be able to probe for other doctors' series ids.
 *
 * Auth: claim.role === 'doctor' only. Patient / receptionist /
 * admin → 403 forbidden_role. Anonymous → 401.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AUDIT_ROWS = 500;

interface OccurrenceRow {
  series_id: string;
  appointment_id: string;
  doctor_id: string;
  doctor_name: string;
  branch_id: string;
  branch_name: string;
  tz: string;
  appointment_type_id: string | null;
  appointment_type_name: string | null;
  duration_minutes: number | null;
  patient_phone: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
  created_at: Date;
  created_by: string;
}

interface AuditRow {
  id: string;
  appointment_id: string | null;
  actor_role: string;
  actor_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

const SELECT_SERIES_SQL = `
  SELECT a.recurring_series_id::text AS series_id,
         a.id::text AS appointment_id,
         a.doctor_id::text AS doctor_id,
         d.full_name AS doctor_name,
         a.branch_id::text AS branch_id,
         b.name AS branch_name,
         b.tz,
         a.appointment_type_id::text AS appointment_type_id,
         at.name AS appointment_type_name,
         at.duration_minutes,
         a.patient_phone,
         a.start_datetime, a.end_datetime,
         a.status,
         a.created_at,
         a.created_by
    FROM appointment a
    JOIN doctor d ON d.id = a.doctor_id
    JOIN branch b ON b.id = a.branch_id
    LEFT JOIN appointment_type at ON at.id = a.appointment_type_id
   WHERE a.recurring_series_id = $1::uuid
     AND a.doctor_id = $2::uuid
   ORDER BY a.start_datetime ASC, a.id ASC;
`;

const SELECT_AUDIT_SQL = `
  SELECT aa.id::text AS id, aa.appointment_id::text AS appointment_id,
         aa.actor_role, aa.actor_id, aa.event, aa.payload, aa.created_at
    FROM appointment_audit aa
    JOIN appointment a ON a.id = aa.appointment_id
   WHERE a.recurring_series_id = $1::uuid
     AND a.doctor_id = $2::uuid
   ORDER BY aa.created_at ASC, aa.id ASC
   LIMIT ${MAX_AUDIT_ROWS};
`;

export const doctorRecurringSeriesRouter: Router = Router();

doctorRecurringSeriesRouter.get(
  '/doctor/recurring-series/:id',
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
      // Same envelope as "doesn't exist" — don't reveal whether the
      // path itself is a valid id.
      res.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      const pool = await getPool();
      const { rows } = await pool.query<OccurrenceRow>(SELECT_SERIES_SQL, [
        id,
        claim.doctor_id,
      ]);
      if (rows.length === 0) {
        // Either the series does not exist or it belongs to another
        // doctor. Both answer the same way.
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const head = rows[0]!;

      const { rows: auditRows } = await pool.query<AuditRow>(
        SELECT_AUDIT_SQL,
        [id, claim.doctor_id],
      );

      const occurrences = rows.map((r) => ({
        id: r.appointment_id,
        start_datetime: r.start_datetime.toISOString(),
        end_datetime: r.end_datetime.toISOString(),
        status: r.status,
      }));
      const createdCount = rows.filter((r) => r.status === 'Scheduled').length;
      const cancelledCount = rows.filter(
        (r) => r.status === 'Cancelled',
      ).length;
      const completedCount = rows.filter(
        (r) => r.status === 'Completed' || r.status === 'No-Show',
      ).length;

      res.status(200).json({
        series: {
          series_id: head.series_id,
          doctor_id: head.doctor_id,
          doctor_name: head.doctor_name,
          branch_id: head.branch_id,
          branch_name: head.branch_name,
          tz: head.tz,
          appointment_type_id: head.appointment_type_id,
          appointment_type_name: head.appointment_type_name,
          duration_minutes: head.duration_minutes,
          patient_phone: head.patient_phone,
          series_start: head.start_datetime.toISOString(),
          created_at: head.created_at.toISOString(),
          created_by: head.created_by,
          occurrence_count: occurrences.length,
          scheduled_count: createdCount,
          cancelled_count: cancelledCount,
          completed_count: completedCount,
          occurrences,
        },
        audit: auditRows.map((r) => ({
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
        'doctor_recurring_series_failed',
      );
      // Surface a 500 rather than rethrowing: an async route error
      // in Express 4 becomes an unhandledRejection that kills the
      // API process.
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    }
  },
);
