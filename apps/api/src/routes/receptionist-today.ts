/**
 * Receptionist today dashboard — `GET /reception/branch/today`.
 *
 * Per spec-5-4 (E5-S4) + F-12 + BR-063 + Scenario 11: a
 * receptionist signs in and opens the dashboard. They see
 * today's appointments for their assigned branch only —
 * server-side filter, no client payload mixing. Cross-branch
 * URLs return 200 with the receptionist's branch data (the
 * branch_id query param is IGNORED so a receptionist cannot
 * enumerate other branches' data by URL tampering).
 *
 * Date is anchored to the branch's tz (E7-S6) using the SQL
 * `(date::timestamptz AT TIME ZONE branch.tz)` cast. The
 * optional `?date=YYYY-MM-DD` query param, when supplied,
 * navigates to that calendar day in the branch's tz. When
 * omitted, "today" = the calendar day in the branch's tz.
 *
 * Filters (all optional):
 *   - `status` (one of 'Scheduled', 'Cancelled', 'Completed',
 *     'No-Show'): filter by appointment status.
 *   - `doctor_id` (UUID): filter to one doctor at the branch.
 *   - `date` (YYYY-MM-DD): navigate to a specific calendar day.
 *
 * Auth: claim.role === 'receptionist' only. Patient / doctor /
 * admin → 403 forbidden_role. Anonymous → 401.
 *
 * Privacy (E7-S3): the response includes `patient_phone` (the
 * receptionist needs to identify the patient by phone on
 * arrival) but does NOT include `patient_name` or any other PII.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set([
  'Scheduled',
  'Cancelled',
  'Completed',
  'No-Show',
] as const);

const SELECT_BRANCH_SQL = `
  SELECT id::text AS id, name, tz FROM branch WHERE id = $1::uuid;
`;

// Date-window query: `$2::date::timestamptz AT TIME ZONE
// branch.tz` produces the UTC instant for "midnight on
// `date` in the branch's local time". Adding 24h gives the
// upper bound.
const SELECT_TODAY_APPOINTMENTS_SQL = `
  SELECT a.id::text AS id,
         a.doctor_id::text AS doctor_id,
         d.full_name AS doctor_name,
         a.patient_phone,
         a.appointment_type_id::text AS appointment_type_id,
         at.name AS appointment_type_name,
         a.start_datetime, a.end_datetime, a.status
    FROM appointment a
    JOIN doctor d ON d.id = a.doctor_id
    JOIN appointment_type at ON at.id = a.appointment_type_id
   WHERE a.branch_id = $1::uuid
     AND a.start_datetime >= $2::timestamptz
     AND a.start_datetime < $3::timestamptz
     AND ($4::uuid IS NULL OR a.doctor_id = $4::uuid)
     AND ($5::text IS NULL OR a.status = $5::text)
   ORDER BY a.start_datetime ASC, d.full_name ASC;
`;

interface BranchRow {
  id: string;
  name: string;
  tz: string;
}

interface AppointmentRow {
  id: string;
  doctor_id: string;
  doctor_name: string;
  patient_phone: string;
  appointment_type_id: string;
  appointment_type_name: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
}

export const receptionistTodayRouter: Router = Router();

receptionistTodayRouter.get(
  '/reception/branch/today',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'receptionist') {
      // The dashboard is a receptionist surface; patient / doctor /
      // admin each have their own dashboards (E4-S1 / doctor
      // dashboard is out of scope today).
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    // BR-004 single-branch invariant: receptionist.branch_ids
    // carries exactly one branch. The middleware rejects empty
    // branch_ids at the auth layer; we pick the first (and
    // only) entry here.
    if (claim.branch_ids.length === 0) {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    const branchId = claim.branch_ids[0]!;

    // Filters
    const statusFilterRaw = req.query['status'];
    const doctorFilterRaw = req.query['doctor_id'];
    const dateFilterRaw = req.query['date'];
    const branchQueryRaw = req.query['branch_id'];

    let statusFilter: string | null = null;
    if (typeof statusFilterRaw === 'string' && statusFilterRaw.length > 0) {
      if (!VALID_STATUSES.has(statusFilterRaw as 'Scheduled')) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      statusFilter = statusFilterRaw;
    }

    let doctorFilter: string | null = null;
    if (typeof doctorFilterRaw === 'string' && doctorFilterRaw.length > 0) {
      if (!UUID_RE.test(doctorFilterRaw)) {
        res.status(400).json({ error: 'invalid_doctor_id' });
        return;
      }
      doctorFilter = doctorFilterRaw;
    }

    let dateFilter: string | null = null;
    if (typeof dateFilterRaw === 'string' && dateFilterRaw.length > 0) {
      if (!ISO_DATE_RE.test(dateFilterRaw)) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      dateFilter = dateFilterRaw;
    }

    // Scenario 11: `branch_id` query is IGNORED. We acknowledge
    // it silently — no data leak, no 403 — so the receptionist
    // cannot enumerate other branches by URL tampering.
    void branchQueryRaw;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'receptionist_today_connect_failed',
      );
      throw err;
    }
    try {
      const { rows: branchRows } = await client.query<BranchRow>(
        SELECT_BRANCH_SQL,
        [branchId],
      );
      if (branchRows.length === 0) {
        // branch_id from a malformed claim — middleware should
        // have caught this, but defense-in-depth.
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }
      const branch = branchRows[0]!;

      // Resolve the date window. The query param (when supplied)
      // is a YYYY-MM-DD calendar day in the branch tz. When
      // omitted, "today" = the branch-local calendar day.
      // We compute the UTC window via SQL so the database — not
      // the API process — handles DST transitions correctly.
      const dateSql = dateFilter
        ? dateFilter
        : `(now() AT TIME ZONE $1::text)::date::text`;

      // Single round-trip: SELECT the branch tz, then SELECT the
      // appointments filtered by branch_id and the tz-anchored
      // date window. The window SQL casts the local date to a
      // UTC instant via `AT TIME ZONE`.
      const windowSql = `
        WITH d AS (
          SELECT (${dateSql})::date AS day
        )
        SELECT (day::timestamptz AT TIME ZONE $1)::timestamptz AS start_utc,
               ((day::timestamptz AT TIME ZONE $1) + INTERVAL '24 hours')::timestamptz AS end_utc
          FROM d;
      `;

      const { rows: windowRows } = await client.query<{
        start_utc: Date;
        end_utc: Date;
      }>(windowSql, [branch.tz]);
      const window = windowRows[0]!;

      const echoDate = dateFilter ?? (
        window.start_utc.toISOString().slice(0, 10) // UTC date
      );
      // The response `date` field reflects the calendar day in
      // the branch's local time. Re-derive via a small JS calc.
      const responseDate = formatLocalDate(window.start_utc, branch.tz);

      const { rows } = await client.query<AppointmentRow>(
        SELECT_TODAY_APPOINTMENTS_SQL,
        [
          branchId,
          window.start_utc,
          window.end_utc,
          doctorFilter,
          statusFilter,
        ],
      );
      void echoDate; // not used directly — responseDate is canonical

      res.status(200).json({
        date: responseDate,
        branch: {
          id: branch.id,
          name: branch.name,
          tz: branch.tz,
        },
        filters: {
          doctor_id: doctorFilter,
          status: statusFilter,
          date: dateFilter,
        },
        appointments: rows.map((r) => ({
          id: r.id,
          doctor_id: r.doctor_id,
          doctor_name: r.doctor_name,
          patient_phone: r.patient_phone,
          appointment_type_id: r.appointment_type_id,
          appointment_type_name: r.appointment_type_name,
          start_datetime: r.start_datetime.toISOString(),
          end_datetime: r.end_datetime.toISOString(),
          status: r.status,
        })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'receptionist_today_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);

// Format a UTC instant as the calendar date in `tz` (IANA name).
// Uses Intl.DateTimeFormat to handle DST correctly. Returns
// `YYYY-MM-DD`.
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