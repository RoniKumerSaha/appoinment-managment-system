/**
 * Admin doctor schedule routes — `GET /admin/doctors/:id/schedule`,
 * `POST /admin/doctors/:id/schedule-impact` (preview), and
 * `POST /admin/doctors/:id/schedule` (full-set replace, transactional).
 *
 * Per spec-2-1 (E2-S1), doctor weekly schedule is stored in `doctor_schedule`
 * (one row per `(doctor_id, branch_id, day_of_week, start_time, end_time,
 * effective_from, effective_to)`); multi-period days are permitted by
 * allowing multiple rows per `(doctor_id, branch_id, day_of_week)`. There
 * is no per-row `active` column — deactivation = DELETE the row (covered
 * by the full-set-replace semantics: a save that omits the row deactivates
 * it for that day).
 *
 * Authorization: `adminScope` middleware (mounted in app.ts).
 *
 * Routes:
 *   GET    /admin/doctors/:id/schedule           — list the doctor's schedule
 *   POST   /admin/doctors/:id/schedule-impact    — preview: count + sample
 *                                                 of future Scheduled appts
 *                                                 that the proposed schedule
 *                                                 would invalidate
 *   POST   /admin/doctors/:id/schedule           — full-set replace (DELETE
 *                                                 existing rows for the
 *                                                 doctor + INSERT new rows
 *                                                 inside a single
 *                                                 transaction)
 *
 * `POST .../schedule` runs inside a transaction with SELECT FOR UPDATE on
 * the doctor row to prevent a concurrent POST-vs-POST interleaving (admin
 * A saves a new schedule while admin B is computing the impact preview
 * against the same doctor). The impact check inside the transaction reads
 * the same row state we are about to commit (TOCTOU-safe).
 *
 * Affected appointments: the impact query counts future Scheduled
 * appointments whose (branch_id, day_of_week, time-of-day in UTC) does
 * NOT fall inside ANY proposed period for that (branch, day). The
 * UTC-as-working-plane simplification is documented in spec-2-1 D2
 * (deferred TZ resolution to E3-S1 availability engine).
 *
 * Patient privacy: `patient_phone` is masked to `+1XXXXXXXXXX` form on
 * both the impact preview AND the 409 conflict response — matches E1-S2
 * admin-impact-preview invariant (counts-only, no PII).
 *
 * Validation order (mirrors E1-S1/E1-S2/E1-S3/E1-S4):
 *   1. UUID parse on `:id` — invalid_doctor_id
 *   2. Body shape: unknown_field / invalid_rows array
 *   3. Per-row validation — invalid_schedule_row + fields[]
 *   4. Past effective_from → invalid_schedule_row (fields = indices)
 *   5. Overlap within (branch, day) group → schedule_rows_overlap
 *   6. DB-level doctor lookup — doctor_not_found
 *   7. branch_id ∈ doctor_branch → branch_not_in_doctor_branches
 *
 * The `created_by` column on every inserted row is `staff:admin-main` (the
 * admin's `sub` claim). Future stories (E2-S2 for blocks, E5-* for staff
 * actions) may set it differently, but E2-S1 is admin-only so the admin
 * principal is the only valid actor.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  isValidUuid,
  validateScheduleRow,
  findOverlappingRowIndices,
  maskPhone,
  tomorrowIsoUtc,
  type ScheduleRow,
} from './admin-doctor-schedule-helpers.js';
import { staffCreatedBy } from './created-by.js';

interface DoctorScheduleRow {
  branch_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
}

interface AffectedAppointment {
  id: string;
  patient_phone_masked: string;
  doctor_id: string;
  branch_id: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
}

const SELECT_DOCTOR_SQL = `SELECT id FROM doctor WHERE id = $1`;
const SELECT_DOCTOR_FOR_UPDATE_SQL = `SELECT id FROM doctor WHERE id = $1 FOR UPDATE`;

const SELECT_SCHEDULE_BY_DOCTOR_SQL = `
  SELECT branch_id::text AS branch_id, day_of_week,
         start_time::text AS start_time, end_time::text AS end_time,
         effective_from::text AS effective_from,
         effective_to::text AS effective_to
    FROM doctor_schedule
   WHERE doctor_id = $1
   ORDER BY branch_id ASC, day_of_week ASC, start_time ASC;
`;

const SELECT_DOCTOR_BRANCH_IDS_SQL = `
  SELECT branch_id::text AS branch_id FROM doctor_branch WHERE doctor_id = $1;
`;

/**
 * Find future Scheduled appointments for this doctor that the proposed
 * schedule would invalidate. The query is intentionally simple: we walk
 * every future Scheduled appointment, check (branch_id, day_of_week,
 * time-of-day) does NOT fall inside ANY proposed period for that
 * (branch_id, day_of_week). A row whose (branch, day) has zero proposed
 * periods is unconditionally invalidated (every appointment on that day
 * falls outside).
 *
 * No LIMIT clause: the count MUST reflect the true total (admin's
 * preview is the spec-required signal; truncating at 200 would silently
 * understate the impact). At a single clinic with realistic scheduling
 * volume the future Scheduled row count for one doctor is in the tens,
 * not the thousands, so the full-scan cost is acceptable (P0-4 from
 * E2-S1 review-loop-1).
 *
 * The TZ resolution is UTC — see D2 in spec-2-1 SC log. The coverage
 * check uses `getUTCDay()` + UTC HH:MM:SS for the appointment side, so
 * for any branch where `branch.tz` ≠ UTC, an appointment's UTC day-of-
 * week may differ from its branch-local day-of-week. This means the
 * count over-reports affected appointments (an appointment whose UTC
 * DOW doesn't match the proposed DOW will be flagged, even if the
 * branch-local DOW does match). E3-S1 will join `branch.tz` and compute
 * day-of-week + time-of-day in the branch's local TZ — at that point
 * the count becomes exact. The admin UI lists the affected appointments
 * with branch_id + start_datetime so an attentive admin can spot the
 * false positives.
 */
const SELECT_AFFECTED_APPOINTMENTS_SQL = `
  SELECT a.id::text AS id,
         a.patient_phone,
         a.doctor_id::text AS doctor_id,
         a.branch_id::text AS branch_id,
         a.start_datetime, a.end_datetime, a.status
    FROM appointment a
   WHERE a.doctor_id = $1
     AND a.start_datetime > now()
     AND a.status = 'Scheduled'
   ORDER BY a.start_datetime ASC;
`;

const DELETE_SCHEDULE_BY_DOCTOR_SQL = `
  DELETE FROM doctor_schedule WHERE doctor_id = $1;
`;

const INSERT_SCHEDULE_ROW_SQL = `
  INSERT INTO doctor_schedule
    (doctor_id, branch_id, day_of_week, start_time, end_time,
     effective_from, effective_to, created_by)
  VALUES ($1, $2, $3, $4::time, $5::time, $6::date, $7::date, $8)
  RETURNING branch_id::text AS branch_id, day_of_week,
            start_time::text AS start_time, end_time::text AS end_time,
            effective_from::text AS effective_from,
            effective_to::text AS effective_to;
`;

const ALLOWED_POST_KEYS = new Set(['rows']);
const ALLOWED_POST_IMPACT_KEYS = new Set(['rows']);

/** Compute the set of (branch_id, day_of_week) pairs the proposed schedule
 *  covers, then check whether each affected appointment falls within at
 *  least one proposed period. The schedule doesn't itself encode a TZ,
 *  so we use UTC day_of_week + UTC time-of-day as the working plane. */
function isAppointmentCovered(
  appt: { branch_id: string; start_datetime: Date; end_datetime: Date },
  rows: ScheduleRow[],
): boolean {
  const start = appt.start_datetime as unknown as Date;
  const end = appt.end_datetime as unknown as Date;
  // Postgres EXTRACT(DOW ...) returns 0..6 (Sun=0..Sat=6). JS getUTCDay()
  // returns 0..6 with the same convention. No shift needed.
  const dow = start.getUTCDay();
  const hh = String(start.getUTCHours()).padStart(2, '0');
  const mm = String(start.getUTCMinutes()).padStart(2, '0');
  const ss = String(start.getUTCSeconds()).padStart(2, '0');
  const startTime = `${hh}:${mm}:${ss}`;
  const endHh = String(end.getUTCHours()).padStart(2, '0');
  const endMm = String(end.getUTCMinutes()).padStart(2, '0');
  const endSs = String(end.getUTCSeconds()).padStart(2, '0');
  const endTime = `${endHh}:${endMm}:${endSs}`;
  for (const row of rows) {
    if (row.branch_id !== appt.branch_id) continue;
    if (row.day_of_week !== dow) continue;
    if (startTime >= row.start_time && endTime <= row.end_time) return true;
  }
  return false;
}

function jsonifyScheduleRow(r: DoctorScheduleRow): {
  branch_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
} {
  return {
    branch_id: r.branch_id,
    day_of_week: r.day_of_week,
    start_time: r.start_time,
    end_time: r.end_time,
    effective_from: r.effective_from,
    effective_to: r.effective_to,
  };
}

export const adminDoctorScheduleRouter: Router = Router();

// ===========================================================================
// GET /admin/doctors/:id/schedule
// ===========================================================================
adminDoctorScheduleRouter.get(
  '/doctors/:id/schedule',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;
    try {
      const pool = await getPool();
      const { rows: doctorRows } = await pool.query<{ id: string }>(
        SELECT_DOCTOR_SQL,
        [id],
      );
      if (doctorRows.length === 0) {
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }
      const { rows: scheduleRows } = await pool.query<DoctorScheduleRow>(
        SELECT_SCHEDULE_BY_DOCTOR_SQL,
        [id],
      );
      res.status(200).json({
        doctor_id: id,
        schedule: scheduleRows.map(jsonifyScheduleRow),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_schedule_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /admin/doctors/:id/schedule-impact  (preview, NO DB write)
// ===========================================================================
adminDoctorScheduleRouter.post(
  '/doctors/:id/schedule-impact',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter(
      (k) => !ALLOWED_POST_IMPACT_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    if (!Array.isArray(body['rows'])) {
      res.status(400).json({ error: 'invalid_rows' });
      return;
    }
    const tomorrow = tomorrowIsoUtc(Date.now());
    const validated: ScheduleRow[] = [];
    for (let i = 0; i < body['rows'].length; i++) {
      const v = validateScheduleRow(body['rows'][i], i, tomorrow);
      if (!v.ok) {
        res.status(400).json({ error: 'invalid_schedule_row', fields: [v.index] });
        return;
      }
      validated.push(v.row);
    }
    const overlapIndices = findOverlappingRowIndices(validated);
    if (overlapIndices.length > 0) {
      res.status(400).json({ error: 'schedule_rows_overlap', fields: overlapIndices });
      return;
    }
    try {
      const pool = await getPool();
      const { rows: doctorRows } = await pool.query<{ id: string }>(
        SELECT_DOCTOR_SQL,
        [id],
      );
      if (doctorRows.length === 0) {
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }
      const { rows: branchRows } = await pool.query<{ branch_id: string }>(
        SELECT_DOCTOR_BRANCH_IDS_SQL,
        [id],
      );
      const doctorBranchIds = new Set(branchRows.map((b) => b.branch_id));
      const offBranchIndices: number[] = [];
      validated.forEach((row, i) => {
        if (!doctorBranchIds.has(row.branch_id)) offBranchIndices.push(i);
      });
      if (offBranchIndices.length > 0) {
        res
          .status(400)
          .json({ error: 'branch_not_in_doctor_branches', fields: offBranchIndices });
        return;
      }
      const { rows: appts } = await pool.query<{
        id: string;
        patient_phone: string;
        doctor_id: string;
        branch_id: string;
        start_datetime: Date;
        end_datetime: Date;
        status: string;
      }>(SELECT_AFFECTED_APPOINTMENTS_SQL, [id]);
      const affected: AffectedAppointment[] = [];
      for (const appt of appts) {
        if (!isAppointmentCovered(appt, validated)) {
          affected.push({
            id: appt.id,
            patient_phone_masked: maskPhone(appt.patient_phone),
            doctor_id: appt.doctor_id,
            branch_id: appt.branch_id,
            start_datetime: appt.start_datetime,
            end_datetime: appt.end_datetime,
            status: appt.status,
          });
        }
      }
      res.status(200).json({
        future_appointment_count: affected.length,
        affected_appointments: affected,
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_schedule_impact_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /admin/doctors/:id/schedule  (full-set replace, transactional)
// ===========================================================================
adminDoctorScheduleRouter.post(
  '/doctors/:id/schedule',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter(
      (k) => !ALLOWED_POST_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    if (!Array.isArray(body['rows'])) {
      res.status(400).json({ error: 'invalid_rows' });
      return;
    }
    const tomorrow = tomorrowIsoUtc(Date.now());
    const validated: ScheduleRow[] = [];
    for (let i = 0; i < body['rows'].length; i++) {
      const v = validateScheduleRow(body['rows'][i], i, tomorrow);
      if (!v.ok) {
        res.status(400).json({ error: 'invalid_schedule_row', fields: [v.index] });
        return;
      }
      validated.push(v.row);
    }
    const overlapIndices = findOverlappingRowIndices(validated);
    if (overlapIndices.length > 0) {
      res.status(400).json({ error: 'schedule_rows_overlap', fields: overlapIndices });
      return;
    }
    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_schedule_post_connect_failed',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    try {
      await client.query('BEGIN');
      const { rows: doctorRows } = await client.query<{ id: string }>(
        SELECT_DOCTOR_FOR_UPDATE_SQL,
        [id],
      );
      if (doctorRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }
      const { rows: branchRows } = await client.query<{ branch_id: string }>(
        SELECT_DOCTOR_BRANCH_IDS_SQL,
        [id],
      );
      const doctorBranchIds = new Set(branchRows.map((b) => b.branch_id));
      const offBranchIndices: number[] = [];
      validated.forEach((row, i) => {
        if (!doctorBranchIds.has(row.branch_id)) offBranchIndices.push(i);
      });
      if (offBranchIndices.length > 0) {
        await client.query('ROLLBACK');
        res
          .status(400)
          .json({ error: 'branch_not_in_doctor_branches', fields: offBranchIndices });
        return;
      }
      const { rows: appts } = await client.query<{
        id: string;
        patient_phone: string;
        doctor_id: string;
        branch_id: string;
        start_datetime: Date;
        end_datetime: Date;
        status: string;
      }>(SELECT_AFFECTED_APPOINTMENTS_SQL, [id]);
      const affected: AffectedAppointment[] = [];
      for (const appt of appts) {
        if (!isAppointmentCovered(appt, validated)) {
          affected.push({
            id: appt.id,
            patient_phone_masked: maskPhone(appt.patient_phone),
            doctor_id: appt.doctor_id,
            branch_id: appt.branch_id,
            start_datetime: appt.start_datetime,
            end_datetime: appt.end_datetime,
            status: appt.status,
          });
        }
      }
      if (affected.length > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'schedule_invalidates_future_appointments',
          future_appointment_count: affected.length,
          affected_appointments: affected,
        });
        return;
      }
      await client.query(DELETE_SCHEDULE_BY_DOCTOR_SQL, [id]);
      const createdBy = staffCreatedBy(req.auth?.claim?.sub);
      const inserted: DoctorScheduleRow[] = [];
      for (const row of validated) {
        const { rows } = await client.query<DoctorScheduleRow>(
          INSERT_SCHEDULE_ROW_SQL,
          [
            id,
            row.branch_id,
            row.day_of_week,
            row.start_time,
            row.end_time,
            row.effective_from,
            row.effective_to,
            createdBy,
          ],
        );
        if (rows[0]) inserted.push(rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({
        inserted_count: inserted.length,
        schedule: inserted.map(jsonifyScheduleRow),
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_schedule_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);