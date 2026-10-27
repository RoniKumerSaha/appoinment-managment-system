/**
 * Receptionist day schedule — `GET /reception/branch/schedule`.
 *
 * Per F-15 (UX-FLOWS §4) + E5-S4 + BR-004: the receptionist's
 * read-only availability browser shows BOTH open and booked slots
 * for a day. `GET /availability` returns only the open slots, so
 * the booked half of the calendar has to come from somewhere else —
 * this route is that somewhere else.
 *
 * Privacy (F-15): "No PII beyond first-name initial". The route
 * returns `patient_initial` (one letter) and nothing else about
 * the patient — no name, no phone. The receptionist identifies a
 * patient by their arrival, not by browsing the calendar.
 *
 * The route is read-only: the receptionist cannot modify the
 * schedule (role capability matrix). Booking goes through
 * `POST /bookings`.
 *
 * Auth: claim.role === 'receptionist' only. Patient / doctor /
 * admin → 403 forbidden_role. Anonymous → 401.
 *
 * Query params (all optional):
 *   - `date` (YYYY-MM-DD): the calendar day in the branch tz.
 *     Omitted → today in the branch tz.
 *   - `doctor_id` (UUID): filter to one doctor at the branch.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SELECT_BRANCH_SQL = `
  SELECT id::text AS id, name, tz FROM branch WHERE id = $1::uuid;
`;

/** Only Scheduled appointments occupy a slot. A Cancelled /
 *  Completed / No-Show row is not "booked" — the slot is free
 *  again, and the availability engine treats it as such.
 *
 *  `patient` is joined on phone_number (not an id — the
 *  appointment table stores the phone, not a patient FK), and it
 *  is a LEFT JOIN: a receptionist must still see a booked slot
 *  for a patient row that a later cleanup removed. */
const SELECT_BOOKED_SQL = `
  SELECT a.id::text AS id,
         a.doctor_id::text AS doctor_id,
         d.full_name AS doctor_name,
         a.appointment_type_id::text AS appointment_type_id,
         at.name AS appointment_type_name,
         p.full_name AS patient_full_name,
         a.start_datetime, a.end_datetime
    FROM appointment a
    JOIN doctor d ON d.id = a.doctor_id
    LEFT JOIN appointment_type at ON at.id = a.appointment_type_id
    LEFT JOIN patient p ON p.phone_number = a.patient_phone
   WHERE a.branch_id = $1::uuid
     AND a.status = 'Scheduled'
     AND a.start_datetime >= $2::timestamptz
     AND a.start_datetime < $3::timestamptz
     AND ($4::text IS NULL OR a.doctor_id::text = $4::text)
   ORDER BY a.start_datetime ASC, d.full_name ASC;
`;

interface BranchRow {
  id: string;
  name: string;
  tz: string;
}

interface BookedRow {
  id: string;
  doctor_id: string;
  doctor_name: string;
  appointment_type_id: string;
  appointment_type_name: string;
  patient_full_name: string | null;
  start_datetime: Date;
  end_datetime: Date;
}

export const receptionScheduleRouter: Router = Router();

receptionScheduleRouter.get(
  '/reception/branch/schedule',
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
    // BR-004: a receptionist is pinned to exactly one branch. The
    // middleware rejects empty branch_ids; defense in depth here.
    if (claim.branch_ids.length === 0) {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    const branchId = claim.branch_ids[0]!;

    const dateFilterRaw = req.query['date'];
    const doctorFilterRaw = req.query['doctor_id'];

    let dateFilter: string | null = null;
    if (typeof dateFilterRaw === 'string' && dateFilterRaw.length > 0) {
      if (!ISO_DATE_RE.test(dateFilterRaw)) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      dateFilter = dateFilterRaw;
    }

    let doctorFilter: string | null = null;
    if (typeof doctorFilterRaw === 'string' && doctorFilterRaw.length > 0) {
      if (!UUID_RE.test(doctorFilterRaw)) {
        res.status(400).json({ error: 'invalid_doctor_id' });
        return;
      }
      doctorFilter = doctorFilterRaw;
    }

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'reception_schedule_connect_failed',
      );
      throw err;
    }
    try {
      const { rows: branchRows } = await client.query<BranchRow>(
        SELECT_BRANCH_SQL,
        [branchId],
      );
      if (branchRows.length === 0) {
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }
      const branch = branchRows[0]!;

      // The date window is computed in SQL so the database — not the
      // API process — handles the branch's DST transitions. The
      // `day::timestamp AT TIME ZONE branch.tz` cast is the canonical
      // "midnight in branch tz" recipe.
      const windowSql = `
        WITH d AS (
          SELECT COALESCE($2::text::date, (now() AT TIME ZONE $1)::date) AS day
        )
        SELECT ((day::timestamp AT TIME ZONE $1)) AS start_utc,
               ((day::timestamp AT TIME ZONE $1) + INTERVAL '24 hours') AS end_utc
          FROM d;
      `;
      const { rows: windowRows } = await client.query<{
        start_utc: Date;
        end_utc: Date;
      }>(windowSql, [branch.tz, dateFilter]);
      const window = windowRows[0]!;

      const { rows } = await client.query<BookedRow>(
        SELECT_BOOKED_SQL,
        [branchId, window.start_utc, window.end_utc, doctorFilter],
      );

      res.status(200).json({
        date: formatLocalDate(window.start_utc, branch.tz),
        branch: { id: branch.id, name: branch.name, tz: branch.tz },
        booked: rows.map((r) => ({
          id: r.id,
          doctor_id: r.doctor_id,
          doctor_name: r.doctor_name,
          appointment_type_id: r.appointment_type_id,
          appointment_type_name: r.appointment_type_name,
          patient_initial: firstInitial(r.patient_full_name),
          start_datetime: r.start_datetime.toISOString(),
          end_datetime: r.end_datetime.toISOString(),
        })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'reception_schedule_failed',
      );
      // Surface a 500 rather than rethrowing: an async route error
      // in Express 4 becomes an unhandledRejection that kills the
      // API process.
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    } finally {
      client.release();
    }
  },
);

/** The patient's first-name initial — the only patient identifier
 *  the calendar exposes (F-15). A patient with no name on file
 *  gets a neutral placeholder rather than a blank cell. */
export function firstInitial(fullName: string | null): string {
  const trimmed = (fullName ?? '').trim();
  if (trimmed === '') return '•';
  const first = trimmed.split(/\s+/)[0] ?? '';
  const ch = first.charAt(0);
  return ch === '' ? '•' : ch.toUpperCase();
}

/** Format a UTC instant as the calendar date in `tz` (IANA name). */
function formatLocalDate(utc: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(utc);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}
