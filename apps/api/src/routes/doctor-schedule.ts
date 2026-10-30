/**
 * Doctor self-service schedule + block routes —
 * `GET /doctor/schedule`, `POST /doctor/schedule-impact`,
 * `POST /doctor/schedule`, `GET /doctor/blocks`,
 * `POST /doctor/blocks-impact`, `POST /doctor/blocks`,
 * `DELETE /doctor/blocks/:block_id`.
 *
 * `docs/design/user-flows/doctor.md` Act 1 lists "Schedule editor"
 * and Act 2 lists "Block time" as DOCTOR sections. Both were
 * implemented as admin-only surfaces:
 * `AdminDoctorSchedule` / `AdminDoctorBlocks` are mounted at
 * `#/admin/doctors/<id>/schedule` and `#/admin/doctors/<id>/blocks`,
 * and the backing routes live under `/admin`, which `app.ts` gates
 * behind `adminScope`. A doctor could not open their own working
 * hours — they had to ask an admin to edit them.
 *
 * These routes give the doctor the same capability, bound to THEIR
 * OWN record:
 *
 *   - There is no `:doctor_id` in the path. The doctor id comes from
 *     `claim.doctor_id` — the only value the server trusts.
 *   - Every read and write is scoped to `claim.doctor_id`. There is
 *     no way to address another doctor's schedule.
 *   - The doctor may only write a schedule row for a branch they
 *     actually work at (`doctor_branch`), same rule the admin route
 *     enforces.
 *   - The impact preview and the 409 conflict response mask the
 *     patient phone, matching the E1-S2 / E2-S1 invariant
 *     (counts-only, no PII).
 *
 * The validation and transaction semantics are deliberately
 * IDENTICAL to the admin routes — this file reuses the admin
 * helpers (`validateScheduleRow`, `findOverlappingRowIndices`,
 * `validateCreateBlockBody`) rather than re-implementing them, so
 * the two surfaces cannot drift.
 *
 * The `created_by` on inserted rows is `staff:${claim.sub}` — the
 * doctor is the actor of record for their own schedule, and the
 * audit trail shows who actually made the change.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  validateScheduleRow,
  findOverlappingRowIndices,
  maskPhone,
  tomorrowIsoUtc,
  type ScheduleRow,
} from './admin-doctor-schedule-helpers.js';
import {
  validateCreateBlockBody,
  type CreateBlockBody,
} from './admin-doctor-block-helpers.js';
import { staffCreatedBy } from './created-by.js';

interface DoctorScheduleRow {
  branch_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
}

interface BlockRow {
  id: string;
  doctor_id: string;
  branch_id: string;
  start_datetime: Date;
  end_datetime: Date;
  reason: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
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

const SELECT_BLOCKS_BY_DOCTOR_SQL = `
  SELECT id::text AS id, doctor_id::text AS doctor_id, branch_id::text AS branch_id,
         start_datetime, end_datetime, reason,
         created_by, created_at, updated_at
    FROM doctor_block
   WHERE doctor_id = $1
     AND ($2::timestamptz IS NULL OR start_datetime >= $2)
     AND ($3::timestamptz IS NULL OR start_datetime <= $3)
   ORDER BY start_datetime ASC;
`;

const SELECT_OVERLAPPING_APPOINTMENTS_SQL = `
  SELECT a.id::text AS id,
         a.patient_phone,
         a.doctor_id::text AS doctor_id,
         a.branch_id::text AS branch_id,
         a.start_datetime, a.end_datetime, a.status
    FROM appointment a
   WHERE a.doctor_id = $1
     AND a.branch_id = $2
     AND a.start_datetime > now()
     AND a.status = 'Scheduled'
     AND tstzrange(a.start_datetime, a.end_datetime, '[)')
         && tstzrange($3::timestamptz, $4::timestamptz, '[)')
   ORDER BY a.start_datetime ASC;
`;

const INSERT_BLOCK_SQL = `
  INSERT INTO doctor_block
    (doctor_id, branch_id, start_datetime, end_datetime, reason, created_by)
  VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)
  RETURNING id::text AS id, doctor_id::text AS doctor_id, branch_id::text AS branch_id,
            start_datetime, end_datetime, reason,
            created_by, created_at, updated_at;
`;

const DELETE_BLOCK_SQL = `
  DELETE FROM doctor_block WHERE id = $1 AND doctor_id = $2 RETURNING id::text AS id;
`;

const ALLOWED_POST_KEYS = new Set(['rows', 'acknowledge']);
const ALLOWED_POST_BLOCK_KEYS = new Set([
  'branch_id',
  'start_datetime',
  'end_datetime',
  'reason',
]);

/**
 * Resolve the doctor principal for this request.
 *
 * Returns `null` and writes the error response when the caller is
 * not a doctor, is anonymous, or the claim carries no doctor id.
 * Every route below bails out on `null`.
 */
function requireDoctor(
  req: Request,
  res: Response,
): { doctorId: string; branchIds: readonly string[] } | null {
  const claim = req.auth?.claim ?? null;
  if (!claim) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  if (claim.role !== 'doctor') {
    // A doctor manages their OWN hours. The admin route
    // (`/admin/doctors/:id/schedule`) is the path for editing
    // somebody else's.
    res.status(403).json({ error: 'forbidden_role' });
    return null;
  }
  if (claim.doctor_id === undefined) {
    res.status(403).json({ error: 'outside_branch_scope' });
    return null;
  }
  return { doctorId: claim.doctor_id, branchIds: claim.branch_ids };
}

/** The set of branches this doctor actually works at. */
async function doctorBranchIds(doctorId: string): Promise<Set<string>> {
  const pool = await getPool();
  const { rows } = await pool.query<{ branch_id: string }>(
    SELECT_DOCTOR_BRANCH_IDS_SQL,
    [doctorId],
  );
  return new Set(rows.map((b) => b.branch_id));
}

/** Is the appointment covered by ANY proposed period? (UTC working plane
 *  — identical to the admin route's semantics.) */
function isAppointmentCovered(
  appt: { branch_id: string; start_datetime: Date; end_datetime: Date },
  rows: ScheduleRow[],
): boolean {
  const dow = appt.start_datetime.getUTCDay();
  const startTime = utcTimeString(appt.start_datetime);
  const endTime = utcTimeString(appt.end_datetime);
  for (const row of rows) {
    if (row.branch_id !== appt.branch_id) continue;
    if (row.day_of_week !== dow) continue;
    if (startTime >= row.start_time && endTime <= row.end_time) return true;
  }
  return false;
}

function utcTimeString(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
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

function jsonifyBlockRow(r: BlockRow): {
  id: string;
  doctor_id: string;
  branch_id: string;
  start_datetime: Date;
  end_datetime: Date;
  reason: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
} {
  return {
    id: r.id,
    doctor_id: r.doctor_id,
    branch_id: r.branch_id,
    start_datetime: r.start_datetime,
    end_datetime: r.end_datetime,
    reason: r.reason,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function jsonifyAffected(a: {
  id: string;
  patient_phone: string;
  doctor_id: string;
  branch_id: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
}): AffectedAppointment {
  return {
    id: a.id,
    patient_phone_masked: maskPhone(a.patient_phone),
    doctor_id: a.doctor_id,
    branch_id: a.branch_id,
    start_datetime: a.start_datetime,
    end_datetime: a.end_datetime,
    status: a.status,
  };
}

export const doctorScheduleRouter: Router = Router();

// ===========================================================================
// GET /doctor/schedule
// ===========================================================================
doctorScheduleRouter.get(
  '/doctor/schedule',
  async (req: Request, res: Response): Promise<void> => {
    const principal = requireDoctor(req, res);
    if (principal === null) return;
    try {
      const pool = await getPool();
      const { rows } = await pool.query<DoctorScheduleRow>(
        SELECT_SCHEDULE_BY_DOCTOR_SQL,
        [principal.doctorId],
      );
      res.status(200).json({
        doctor_id: principal.doctorId,
        schedule: rows.map(jsonifyScheduleRow),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_schedule_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /doctor/schedule-impact  (preview, NO DB write)
// ===========================================================================
doctorScheduleRouter.post(
  '/doctor/schedule-impact',
  async (req: Request, res: Response): Promise<void> => {
    const principal = requireDoctor(req, res);
    if (principal === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((k) => !ALLOWED_POST_KEYS.has(k));
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
      const branchIds = await doctorBranchIds(principal.doctorId);
      const offBranchIndices: number[] = [];
      validated.forEach((row, i) => {
        if (!branchIds.has(row.branch_id)) offBranchIndices.push(i);
      });
      if (offBranchIndices.length > 0) {
        res
          .status(400)
          .json({ error: 'branch_not_in_doctor_branches', fields: offBranchIndices });
        return;
      }
      const pool = await getPool();
      const { rows: appts } = await pool.query<{
        id: string;
        patient_phone: string;
        doctor_id: string;
        branch_id: string;
        start_datetime: Date;
        end_datetime: Date;
        status: string;
      }>(SELECT_AFFECTED_APPOINTMENTS_SQL, [principal.doctorId]);
      const affected = appts
        .filter((a) => !isAppointmentCovered(a, validated))
        .map(jsonifyAffected);
      res.status(200).json({
        future_appointment_count: affected.length,
        affected_appointments: affected,
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_schedule_impact_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /doctor/schedule  (full-set replace, transactional)
// ===========================================================================
doctorScheduleRouter.post(
  '/doctor/schedule',
  async (req: Request, res: Response): Promise<void> => {
    const principal = requireDoctor(req, res);
    if (principal === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((k) => !ALLOWED_POST_KEYS.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    if (!Array.isArray(body['rows'])) {
      res.status(400).json({ error: 'invalid_rows' });
      return;
    }
    // The doctor's explicit acknowledgement that the change is
    // acceptable even though it orphans future appointments.
    //
    // The admin route has NO such flag — it returns 409
    // unconditionally, which makes its own "Continue anyway" checkbox
    // a dead end (ticking it re-sends the same body and gets the same
    // 409). This route adds the flag so the acknowledgement actually
    // does something.
    const ackRaw = body['acknowledge'];
    if (ackRaw !== undefined && typeof ackRaw !== 'boolean') {
      res.status(400).json({ error: 'invalid_acknowledge' });
      return;
    }
    const acknowledge = ackRaw === true;

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
        'doctor_schedule_post_connect_failed',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    try {
      await client.query('BEGIN');
      const { rows: branchRows } = await client.query<{ branch_id: string }>(
        SELECT_DOCTOR_BRANCH_IDS_SQL,
        [principal.doctorId],
      );
      const branchIds = new Set(branchRows.map((b) => b.branch_id));
      const offBranchIndices: number[] = [];
      validated.forEach((row, i) => {
        if (!branchIds.has(row.branch_id)) offBranchIndices.push(i);
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
      }>(SELECT_AFFECTED_APPOINTMENTS_SQL, [principal.doctorId]);
      const affected = appts
        .filter((a) => !isAppointmentCovered(a, validated))
        .map(jsonifyAffected);
      if (affected.length > 0 && !acknowledge) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'schedule_invalidates_future_appointments',
          future_appointment_count: affected.length,
          affected_appointments: affected,
        });
        return;
      }
      await client.query(DELETE_SCHEDULE_BY_DOCTOR_SQL, [principal.doctorId]);
      const createdBy = staffCreatedBy(req.auth?.claim?.sub);
      const inserted: DoctorScheduleRow[] = [];
      for (const row of validated) {
        const { rows } = await client.query<DoctorScheduleRow>(
          INSERT_SCHEDULE_ROW_SQL,
          [
            principal.doctorId,
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
        'doctor_schedule_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// GET /doctor/blocks
// ===========================================================================
doctorScheduleRouter.get(
  '/doctor/blocks',
  async (req: Request, res: Response): Promise<void> => {
    const principal = requireDoctor(req, res);
    if (principal === null) return;
    const fromRaw = req.query['from'];
    const toRaw = req.query['to'];
    let fromIso: string | null = null;
    let toIso: string | null = null;
    if (typeof fromRaw === 'string') {
      if (
        !/[zZ]|[+-]\d{2}:?\d{2}$/.test(fromRaw) ||
        !Number.isFinite(Date.parse(fromRaw))
      ) {
        res.status(400).json({ error: 'invalid_from_filter' });
        return;
      }
      fromIso = fromRaw;
    }
    if (typeof toRaw === 'string') {
      if (
        !/[zZ]|[+-]\d{2}:?\d{2}$/.test(toRaw) ||
        !Number.isFinite(Date.parse(toRaw))
      ) {
        res.status(400).json({ error: 'invalid_to_filter' });
        return;
      }
      toIso = toRaw;
    }
    try {
      const pool = await getPool();
      const { rows } = await pool.query<BlockRow>(
        SELECT_BLOCKS_BY_DOCTOR_SQL,
        [principal.doctorId, fromIso, toIso],
      );
      res.status(200).json({ blocks: rows.map(jsonifyBlockRow) });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_block_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /doctor/blocks-impact  (preview, NO DB write)
// ===========================================================================
doctorScheduleRouter.post(
  '/doctor/blocks-impact',
  async (req: Request, res: Response): Promise<void> => {
    const principal = requireDoctor(req, res);
    if (principal === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter(
      (k) => !ALLOWED_POST_BLOCK_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const v = validateCreateBlockBody(body, Date.now());
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    try {
      const branchIds = await doctorBranchIds(principal.doctorId);
      if (!branchIds.has(v.body.branchId)) {
        res
          .status(400)
          .json({ error: 'branch_not_in_doctor_branches', fields: [v.body.branchId] });
        return;
      }
      const pool = await getPool();
      const { rows: appts } = await pool.query<{
        id: string;
        patient_phone: string;
        doctor_id: string;
        branch_id: string;
        start_datetime: Date;
        end_datetime: Date;
        status: string;
      }>(SELECT_OVERLAPPING_APPOINTMENTS_SQL, [
        principal.doctorId,
        v.body.branchId,
        v.body.startDatetime,
        v.body.endDatetime,
      ]);
      res.status(200).json({
        future_appointment_count: appts.length,
        affected_appointments: appts.map(jsonifyAffected),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_block_impact_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /doctor/blocks  (create, transactional)
// ===========================================================================
doctorScheduleRouter.post(
  '/doctor/blocks',
  async (req: Request, res: Response): Promise<void> => {
    const principal = requireDoctor(req, res);
    if (principal === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter(
      (k) => !ALLOWED_POST_BLOCK_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const v = validateCreateBlockBody(body, Date.now());
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const validated: CreateBlockBody = v.body;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_block_post_connect_failed',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    try {
      await client.query('BEGIN');
      const { rows: branchRows } = await client.query<{ branch_id: string }>(
        SELECT_DOCTOR_BRANCH_IDS_SQL,
        [principal.doctorId],
      );
      const branchIds = new Set(branchRows.map((b) => b.branch_id));
      if (!branchIds.has(validated.branchId)) {
        await client.query('ROLLBACK');
        res
          .status(400)
          .json({ error: 'branch_not_in_doctor_branches', fields: [validated.branchId] });
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
      }>(SELECT_OVERLAPPING_APPOINTMENTS_SQL, [
        principal.doctorId,
        validated.branchId,
        validated.startDatetime,
        validated.endDatetime,
      ]);
      if (appts.length > 0) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'block_overlaps_future_appointments',
          future_appointment_count: appts.length,
          affected_appointments: appts.map(jsonifyAffected),
        });
        return;
      }
      const createdBy = staffCreatedBy(req.auth?.claim?.sub);
      const { rows: inserted } = await client.query<BlockRow>(INSERT_BLOCK_SQL, [
        principal.doctorId,
        validated.branchId,
        validated.startDatetime,
        validated.endDatetime,
        validated.reason,
        createdBy,
      ]);
      await client.query('COMMIT');
      res.status(201).json(jsonifyBlockRow(inserted[0]!));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_block_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// DELETE /doctor/blocks/:block_id
// ===========================================================================
doctorScheduleRouter.delete(
  '/doctor/blocks/:block_id',
  async (req: Request, res: Response): Promise<void> => {
    const principal = requireDoctor(req, res);
    if (principal === null) return;
    const blockIdRaw = req.params['block_id'];
    const blockId = typeof blockIdRaw === 'string' ? blockIdRaw : '';
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        blockId,
      )
    ) {
      res.status(400).json({ error: 'invalid_block_id' });
      return;
    }
    try {
      const pool = await getPool();
      // The `doctor_id = $2` predicate is the ownership check — a
      // block belonging to another doctor is simply not found.
      const { rows } = await pool.query<{ id: string }>(DELETE_BLOCK_SQL, [
        blockId,
        principal.doctorId,
      ]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'block_not_found' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_block_delete_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);
