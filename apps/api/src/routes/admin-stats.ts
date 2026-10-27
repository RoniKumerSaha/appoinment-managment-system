/**
 * Admin dashboard stats — `GET /admin/stats`.
 *
 * The path is relative: the router is mounted under `/admin` by
 * `app.ts`, so the route is `/admin/stats` in the running app.
 *
 * The admin dashboards showed counts that were derived from a hash
 * of the entity id, so the numbers were plausible but not real. This
 * route answers the same questions from the actual tables:
 *
 *   - `branches[]`     → doctor_count, future_appointment_count
 *   - `doctors[]`      → future_appointment_count
 *   - `receptionists[]`→ appointments_today, last_login_at
 *   - `appointment_types[]` → bookings_count (last 30 days)
 *
 * Scope: the clinic the admin belongs to. The counts are aggregate
 * and non-PII — a count of appointments, never a patient identity —
 * so the admin surface stays consistent with PRD §2.4 ("admin never
 * touches individual appointments").
 *
 * Auth: claim.role === 'admin' only. Patient / doctor /
 * receptionist → 403 forbidden_role. Anonymous → 401.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

/** Doctors attached to a branch. */
const BRANCH_DOCTOR_COUNT_SQL = `
  SELECT db.branch_id::text AS branch_id, COUNT(*)::int AS doctor_count
    FROM doctor_branch db
    JOIN doctor d ON d.id = db.doctor_id
   WHERE d.active
   GROUP BY db.branch_id;
`;

/** Scheduled appointments in the future, per branch. */
const BRANCH_FUTURE_COUNT_SQL = `
  SELECT a.branch_id::text AS branch_id, COUNT(*)::int AS future_appointment_count
    FROM appointment a
   WHERE a.status = 'Scheduled'
     AND a.start_datetime > now()
   GROUP BY a.branch_id;
`;

/** Scheduled appointments in the future, per doctor. */
const DOCTOR_FUTURE_COUNT_SQL = `
  SELECT a.doctor_id::text AS doctor_id, COUNT(*)::int AS future_appointment_count
    FROM appointment a
   WHERE a.status = 'Scheduled'
     AND a.start_datetime > now()
   GROUP BY a.doctor_id;
`;

/** Appointments the receptionist's branch has today. The day is
 *  computed in the BRANCH's timezone (the branch-local midnight
 *  recipe) so "today" matches what the receptionist sees, not what
 *  the server's UTC offset happens to be. */
const RECEPTIONIST_TODAY_COUNT_SQL = `
  SELECT r.id::text AS receptionist_id, COUNT(a.id)::int AS appointments_today
    FROM receptionist r
    JOIN branch b ON b.id = r.branch_id
    LEFT JOIN appointment a
      ON a.branch_id = r.branch_id
     AND a.status = 'Scheduled'
     AND a.start_datetime >= (now() AT TIME ZONE b.tz)::timestamp AT TIME ZONE b.tz
     AND a.start_datetime <  ((now() AT TIME ZONE b.tz)::timestamp + interval '1 day') AT TIME ZONE b.tz
   GROUP BY r.id;
`;

/** Appointments per appointment type over the last 30 days. */
const TYPE_BOOKINGS_COUNT_SQL = `
  SELECT a.appointment_type_id::text AS appointment_type_id,
         COUNT(*)::int AS bookings_count
    FROM appointment a
   WHERE a.appointment_type_id IS NOT NULL
     AND a.status <> 'Cancelled'
     AND a.start_datetime >= now() - interval '30 days'
   GROUP BY a.appointment_type_id;
`;

export const adminStatsRouter: Router = Router();

adminStatsRouter.get(
  '/stats',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'admin') {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }

    try {
      const pool = await getPool();

      const [branchDoctors, branchFuture, doctorFuture, recToday, typeCounts] =
        await Promise.all([
          pool.query<{ branch_id: string; doctor_count: number }>(
            BRANCH_DOCTOR_COUNT_SQL,
          ),
          pool.query<{ branch_id: string; future_appointment_count: number }>(
            BRANCH_FUTURE_COUNT_SQL,
          ),
          pool.query<{ doctor_id: string; future_appointment_count: number }>(
            DOCTOR_FUTURE_COUNT_SQL,
          ),
          pool.query<{ receptionist_id: string; appointments_today: number }>(
            RECEPTIONIST_TODAY_COUNT_SQL,
          ),
          pool.query<{ appointment_type_id: string; bookings_count: number }>(
            TYPE_BOOKINGS_COUNT_SQL,
          ),
        ]);

      const branchDoctorCount = new Map(
        branchDoctors.rows.map((r) => [r.branch_id, r.doctor_count]),
      );
      const branchFutureCount = new Map(
        branchFuture.rows.map((r) => [r.branch_id, r.future_appointment_count]),
      );
      const doctorFutureCount = new Map(
        doctorFuture.rows.map((r) => [r.doctor_id, r.future_appointment_count]),
      );
      const receptionistTodayCount = new Map(
        recToday.rows.map((r) => [r.receptionist_id, r.appointments_today]),
      );
      const typeBookingCount = new Map(
        typeCounts.rows.map((r) => [r.appointment_type_id, r.bookings_count]),
      );

      // The entity lists themselves come from the existing admin
      // routes' catalogues so this response stays in step with what
      // the screens render.
      const [branches, doctors, receptionists, types] = await Promise.all([
        pool.query<{
          id: string;
          name: string;
          active: boolean;
          tz: string;
        }>(
          `SELECT id::text AS id, name, active, tz FROM branch ORDER BY name ASC;`,
        ),
        pool.query<{
          id: string;
          full_name: string;
          active: boolean;
          specialty: string | null;
        }>(
          `SELECT id::text AS id, full_name, active, specialty
             FROM doctor ORDER BY full_name ASC;`,
        ),
        pool.query<{
          id: string;
          full_name: string;
          branch_id: string;
          active: boolean;
        }>(
          `SELECT id::text AS id, full_name, branch_id::text AS branch_id, active
             FROM receptionist ORDER BY full_name ASC;`,
        ),
        pool.query<{ id: string; name: string; is_active: boolean }>(
          `SELECT id::text AS id, name, is_active FROM appointment_type ORDER BY name ASC;`,
        ),
      ]);

      res.status(200).json({
        branches: branches.rows.map((b) => ({
          id: b.id,
          doctor_count: branchDoctorCount.get(b.id) ?? 0,
          future_appointment_count: branchFutureCount.get(b.id) ?? 0,
        })),
        doctors: doctors.rows.map((d) => ({
          id: d.id,
          specialty: d.specialty,
          future_appointment_count: doctorFutureCount.get(d.id) ?? 0,
        })),
        receptionists: receptionists.rows.map((r) => ({
          id: r.id,
          appointments_today: receptionistTodayCount.get(r.id) ?? 0,
        })),
        appointment_types: types.rows.map((t) => ({
          id: t.id,
          bookings_count: typeBookingCount.get(t.id) ?? 0,
        })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_stats_failed',
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
