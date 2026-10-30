/**
 * Doctor today dashboard — `GET /doctor/today`.
 *
 * Per `docs/design/user-flows/doctor.md` Act 3 and mockup 12, a
 * doctor signs in and sees the appointments booked against THEM
 * for a given day. This is the doctor's counterpart to the
 * receptionist's `GET /reception/branch/today` (E5-S4 / mock 13):
 * the receptionist sees the whole branch, the doctor sees only
 * their own list.
 *
 * The endpoint did not exist — the doctor's only day-to-day surface
 * was the "affected" queue (`GET /doctor/affected`), which lists
 * ONLY the appointments that fell outside their branch's operating
 * hours. A doctor therefore could not see their ordinary day, and
 * the status actions (mark Completed / No-show), the cancel action
 * and the audit drawer were all reachable only from an affected
 * row. In practice the affected queue is almost always empty, so
 * those actions were unreachable in normal operation.
 *
 * Scope:
 *   - `claim.role === 'doctor'` — role gate.
 *   - `a.doctor_id = claim.doctor_id` — the doctor sees ONLY their
 *     OWN appointments. A doctor can never see a colleague's list.
 *   - `a.branch_id = ANY(claim.branch_ids)` — defence in depth;
 *     the doctor_id predicate already implies this, but the branch
 *     predicate is kept so the SQL states the invariant explicitly.
 *
 * Date window:
 *   - "Today" is the calendar day in the BRANCH's timezone. A
 *     doctor can work at more than one branch, so the window is
 *     computed PER BRANCH: the day is computed in each branch's
 *     own tz, and rows are selected when they fall inside their
 *     branch's local day.
 *   - `?date=YYYY-MM-DD` navigates to that calendar day (also
 *     interpreted per branch tz).
 *
 * Filters (all optional):
 *   - `status` — one of 'Scheduled' | 'Completed' | 'Cancelled' |
 *     'No-show'. The literals mirror the `appointment_status` DB
 *     enum verbatim ('No-show', lowercase 's').
 *   - `branch_id` — narrow to one of the doctor's branches. A
 *     branch outside `claim.branch_ids` is rejected with 403
 *     rather than silently ignored (a doctor cannot probe other
 *     branches).
 *
 * Privacy (E7-S3): the response carries `patient_phone` but NOT
 * `patient_name`. The doctor identifies the patient by the masked
 * phone, the same envelope the affected queue uses.
 *
 * Auth: claim.role === 'doctor' only. Patient / receptionist /
 * admin → 403 forbidden_role. Anonymous → 401.
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
  'No-show',
] as const);

/** Hard cap on the rows one request can return. A single doctor on a
 *  single day rarely exceeds 30; the cap is a safety net against a
 *  runaway join, not a business limit. */
const MAX_ROWS = 500;

interface BranchRow {
  id: string;
  name: string;
  tz: string;
}

interface AppointmentRow {
  id: string;
  branch_id: string;
  branch_name: string;
  branch_tz: string;
  doctor_id: string;
  patient_phone: string;
  appointment_type_id: string;
  appointment_type_name: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
}

/**
 * The day's appointments for the doctor.
 *
 * The date window is computed per branch, in that branch's own
 * timezone:
 *
 *   (a.start_datetime AT TIME ZONE b.tz)::date = $2::date
 *
 * `a.start_datetime` is a `timestamptz`; `AT TIME ZONE b.tz`
 * projects it onto the branch's local wall clock; casting to
 * `date` gives the branch-local calendar day. Comparing that to
 * the requested `YYYY-MM-DD` selects exactly the rows that fall on
 * that local day for their own branch — which is what a doctor
 * working across two branches in two timezones expects.
 *
 * The same expression, with `COALESCE` against the branch-local
 * "today", is what the `?date` param falls back to when it is
 * omitted.
 */
const SELECT_TODAY_SQL = `
  SELECT a.id::text AS id,
         a.branch_id::text AS branch_id,
         b.name AS branch_name,
         b.tz AS branch_tz,
         a.doctor_id::text AS doctor_id,
         a.patient_phone,
         a.appointment_type_id::text AS appointment_type_id,
         at.name AS appointment_type_name,
         a.start_datetime, a.end_datetime, a.status
    FROM appointment a
    JOIN branch b ON b.id = a.branch_id
    JOIN appointment_type at ON at.id = a.appointment_type_id
   WHERE a.doctor_id = $1::uuid
     AND a.branch_id = ANY($2::uuid[])
     AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)
     AND ($4::text IS NULL OR a.status::text = $4::text)
     AND (
       (a.start_datetime AT TIME ZONE b.tz)::date =
         COALESCE($5::date, (now() AT TIME ZONE b.tz)::date)
     )
   ORDER BY a.start_datetime ASC, b.name ASC
   LIMIT ${MAX_ROWS};
`;

export const doctorTodayRouter: Router = Router();

doctorTodayRouter.get(
  '/doctor/today',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'doctor') {
      // The doctor's own day. The receptionist has
      // `/reception/branch/today` (branch-wide), the patient has
      // `/patient/appointments`, the admin has the audit log.
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    if (claim.doctor_id === undefined) {
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }
    if (claim.branch_ids.length === 0) {
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }

    // ── Filters ──────────────────────────────────────────────────
    let statusFilter: string | null = null;
    const statusRaw = req.query['status'];
    if (typeof statusRaw === 'string' && statusRaw.length > 0) {
      if (!VALID_STATUSES.has(statusRaw as 'Scheduled')) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      statusFilter = statusRaw;
    }

    let branchFilter: string | null = null;
    const branchRaw = req.query['branch_id'];
    if (typeof branchRaw === 'string' && branchRaw.length > 0) {
      if (!UUID_RE.test(branchRaw)) {
        res.status(400).json({ error: 'invalid_branch_id' });
        return;
      }
      if (!claim.branch_ids.includes(branchRaw)) {
        // A doctor cannot probe a branch they do not work at.
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }
      branchFilter = branchRaw;
    }

    let dateFilter: string | null = null;
    const dateRaw = req.query['date'];
    if (typeof dateRaw === 'string' && dateRaw.length > 0) {
      if (!ISO_DATE_RE.test(dateRaw)) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      // Postgres rejects a malformed calendar date; probe here so the
      // caller gets a clean 400 envelope rather than a 500.
      const probe = new Date(`${dateRaw}T00:00:00Z`);
      if (Number.isNaN(probe.getTime())) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      dateFilter = dateRaw;
    }

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_today_connect_failed',
      );
      throw err;
    }
    try {
      const { rows: branchRows } = await client.query<BranchRow>(
        `SELECT id::text AS id, name, tz FROM branch WHERE id = ANY($1::uuid[]);`,
        [claim.branch_ids],
      );

      const { rows } = await client.query<AppointmentRow>(SELECT_TODAY_SQL, [
        claim.doctor_id,
        claim.branch_ids,
        branchFilter,
        statusFilter,
        dateFilter,
      ]);

      // The response's `date` echoes the requested calendar day. When
      // no date was requested it is the branch-local today of the
      // doctor's PRIMARY branch (the first one in the claim) — the
      // day the list actually shows.
      const primaryBranch = branchRows.find(
        (b) => b.id === (branchFilter ?? claim.branch_ids[0]),
      );
      const responseDate =
        dateFilter ??
        (primaryBranch !== undefined
          ? formatLocalDate(new Date(), primaryBranch.tz)
          : formatLocalDate(new Date(), 'UTC'));

      res.status(200).json({
        date: responseDate,
        doctor_id: claim.doctor_id,
        branches: branchRows.map((b) => ({
          id: b.id,
          name: b.name,
          tz: b.tz,
        })),
        filters: {
          branch_id: branchFilter,
          status: statusFilter,
          date: dateFilter,
        },
        appointments: rows.map((r) => ({
          id: r.id,
          branch_id: r.branch_id,
          branch_name: r.branch_name,
          branch_tz: r.branch_tz,
          doctor_id: r.doctor_id,
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
        'doctor_today_failed',
      );
      // Surface a 500 rather than rethrowing: an async throw in
      // Express 4 becomes an unhandled rejection, and this codebase's
      // process-level handler exits the whole API on any rejection.
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    } finally {
      client.release();
    }
  },
);

/** Format an instant as the calendar date in `tz` (IANA name). */
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
