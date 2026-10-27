/**
 * Patient recurring series — `GET /patient/recurring-series`.
 *
 * Per E6-S4 (mock 33) the patient can cancel ONE occurrence of a
 * recurring series. That surface needs the whole series in view —
 * the target occurrence plus its siblings — so the patient can see
 * that cancelling one visit leaves the others alone (BR-052 /
 * FR-049).
 *
 * `GET /patient/appointments` cannot serve this: it filters to
 * `status='Scheduled' AND start_datetime > now()`, so the completed
 * siblings are missing and the ordering is wrong for a series.
 *
 * The phone comes from the JWT claim (`req.auth.claim.sub`), NEVER
 * from a query param — the E7-S3 privacy filter. A patient can only
 * read their own series.
 *
 * Auth: `claim.role === 'patient'` only. Doctor / admin /
 * receptionist → 403 forbidden_role.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

/** Every occurrence of every series the patient owns, in start
 *  order. The series-level fields (doctor, branch, type) ride along
 *  on each row so one query answers the whole page; the grouping
 *  happens in JS. */
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
         a.start_datetime, a.end_datetime,
         a.status,
         a.patient_phone
    FROM appointment a
    JOIN doctor d ON d.id = a.doctor_id
    JOIN branch b ON b.id = a.branch_id
    LEFT JOIN appointment_type at ON at.id = a.appointment_type_id
   WHERE a.patient_phone = $1
     AND a.recurring_series_id IS NOT NULL
   ORDER BY a.recurring_series_id, a.start_datetime ASC;
`;

export const patientRecurringSeriesRouter: Router = Router();

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
  start_datetime: Date;
  end_datetime: Date;
  status: string;
  patient_phone: string;
}

patientRecurringSeriesRouter.get(
  '/patient/recurring-series',
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
    const phone = claim.sub;

    try {
      const pool = await getPool();
      const { rows } = await pool.query<OccurrenceRow>(SELECT_SERIES_SQL, [
        phone,
      ]);

      // The rows arrive grouped by series (the ORDER BY leads with
      // `recurring_series_id`), so one pass builds the whole list.
      const series: Array<{
        series_id: string;
        doctor_id: string;
        doctor_name: string;
        branch_id: string;
        branch_name: string;
        tz: string;
        appointment_type_id: string | null;
        appointment_type_name: string | null;
        duration_minutes: number | null;
        occurrence_count: number;
        series_start: string;
        occurrences: Array<{
          id: string;
          start_datetime: string;
          end_datetime: string;
          status: string;
        }>;
      }> = [];

      for (const row of rows) {
        const head = series[series.length - 1];
        const occurrence = {
          id: row.appointment_id,
          start_datetime: row.start_datetime.toISOString(),
          end_datetime: row.end_datetime.toISOString(),
          status: row.status,
        };
        if (head !== undefined && head.series_id === row.series_id) {
          head.occurrences.push(occurrence);
          continue;
        }
        series.push({
          series_id: row.series_id,
          doctor_id: row.doctor_id,
          doctor_name: row.doctor_name,
          branch_id: row.branch_id,
          branch_name: row.branch_name,
          tz: row.tz,
          appointment_type_id: row.appointment_type_id,
          appointment_type_name: row.appointment_type_name,
          duration_minutes: row.duration_minutes,
          occurrence_count: 0,
          series_start: row.start_datetime.toISOString(),
          occurrences: [occurrence],
        });
      }
      for (const s of series) s.occurrence_count = s.occurrences.length;

      res.status(200).json({ series });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'patient_recurring_series_failed',
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
