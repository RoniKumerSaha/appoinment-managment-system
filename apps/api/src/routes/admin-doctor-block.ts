/**
 * Admin doctor block routes — `GET /admin/doctors/:id/blocks`,
 * `POST /admin/doctors/:id/blocks-impact` (preview),
 * `POST /admin/doctors/:id/blocks` (create), and
 * `DELETE /admin/doctors/:id/blocks/:block_id`.
 *
 * Per spec-2-2 (E2-S2), blocks are one-off time-off windows stored in
 * `doctor_block` (0007): one row per `(doctor_id, branch_id,
 * start_datetime, end_datetime, reason, created_by)`. Blocks are
 * immutable (no PATCH/rename); to "edit" a block the admin deletes
 * and re-creates. Future audit (E7-S2) will write a `block_created`
 * audit row; E2-S2 follows the E1-S2/E1-S3/E1-S4/E2-S1 no-audit
 * precedent.
 *
 * Conflict semantics (FR-013, BR-011):
 *   - Block-vs-block overlap is NOT enforced at creation — two blocks
 *     may overlap each other (D1 in spec-2-2 SC log).
 *   - Block-vs-Scheduled-appointment overlap IS enforced — any
 *     tstzrange intersection with a future Scheduled appointment on
 *     the same doctor + branch triggers a 409 with masked list.
 *
 * Authorization: `adminScope` middleware (mounted in app.ts).
 *
 * Patient privacy: `patient_phone` is masked to `+1XXXXXXXXXX` form on
 * both the impact preview AND the 409 response — matches E1-S2/E2-S1
 * admin-impact-preview invariant.
 *
 * Validation order (mirrors E1-S1/E1-S2/E1-S3/E1-S4/E2-S1):
 *   1. UUID parse on `:id` and (for DELETE) `:block_id`.
 *   2. Body shape (POST): unknown_field + per-field validators.
 *   3. DB-level doctor lookup — doctor_not_found.
 *   4. branch_id ∈ doctor_branch → branch_not_in_doctor_branches.
 *   5. Impact check (preview) or impact check + INSERT (commit).
 *
 * The `created_by` column on every inserted row is `staff:${admin_sub}`
 * — same pattern as E2-S1.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  isValidUuid,
  validateCreateBlockBody,
  maskPhone,
  type CreateBlockBody,
} from './admin-doctor-block-helpers.js';
import { staffCreatedBy } from './created-by.js';

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

const SELECT_DOCTOR_SQL = `SELECT id FROM doctor WHERE id = $1`;
const SELECT_DOCTOR_FOR_UPDATE_SQL = `SELECT id FROM doctor WHERE id = $1 FOR UPDATE`;

const SELECT_DOCTOR_BRANCH_IDS_SQL = `
  SELECT branch_id::text AS branch_id FROM doctor_branch WHERE doctor_id = $1;
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

const ALLOWED_POST_KEYS = new Set(['branch_id', 'start_datetime', 'end_datetime', 'reason']);

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

export const adminDoctorBlockRouter: Router = Router();

// ===========================================================================
// GET /admin/doctors/:id/blocks
// ===========================================================================
adminDoctorBlockRouter.get(
  '/doctors/:id/blocks',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;
    const fromRaw = req.query['from'];
    const toRaw = req.query['to'];
    let fromIso: string | null = null;
    let toIso: string | null = null;
    if (typeof fromRaw === 'string') {
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(fromRaw) || !Number.isFinite(Date.parse(fromRaw))) {
        res.status(400).json({ error: 'invalid_from_filter' });
        return;
      }
      fromIso = fromRaw;
    }
    if (typeof toRaw === 'string') {
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(toRaw) || !Number.isFinite(Date.parse(toRaw))) {
        res.status(400).json({ error: 'invalid_to_filter' });
        return;
      }
      toIso = toRaw;
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
      const { rows: blocks } = await pool.query<BlockRow>(
        SELECT_BLOCKS_BY_DOCTOR_SQL,
        [id, fromIso, toIso],
      );
      res.status(200).json({
        blocks: blocks.map(jsonifyBlockRow),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_block_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /admin/doctors/:id/blocks-impact  (preview, NO DB write)
// ===========================================================================
adminDoctorBlockRouter.post(
  '/doctors/:id/blocks-impact',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((k) => !ALLOWED_POST_KEYS.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const v = validateCreateBlockBody(body, Date.now());
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const validated = v.body;
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
      if (!doctorBranchIds.has(validated.branchId)) {
        res
          .status(400)
          .json({ error: 'branch_not_in_doctor_branches', fields: [validated.branchId] });
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
      }>(SELECT_OVERLAPPING_APPOINTMENTS_SQL, [
        id,
        validated.branchId,
        validated.startDatetime,
        validated.endDatetime,
      ]);
      res.status(200).json({
        future_appointment_count: appts.length,
        affected_appointments: appts.map(jsonifyAffected),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_block_impact_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// POST /admin/doctors/:id/blocks  (create, transactional)
// ===========================================================================
adminDoctorBlockRouter.post(
  '/doctors/:id/blocks',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((k) => !ALLOWED_POST_KEYS.has(k));
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
        'admin_doctor_block_post_connect_failed',
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
      if (!doctorBranchIds.has(validated.branchId)) {
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
        id,
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
        id,
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
        'admin_doctor_block_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// DELETE /admin/doctors/:id/blocks/:block_id
// ===========================================================================
adminDoctorBlockRouter.delete(
  '/doctors/:id/blocks/:block_id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    if (!isValidUuid(req.params['block_id'])) {
      res.status(400).json({ error: 'invalid_block_id' });
      return;
    }
    const id = req.params['id'] as string;
    const blockId = req.params['block_id'] as string;
    try {
      const pool = await getPool();
      const { rows } = await pool.query<{ id: string }>(DELETE_BLOCK_SQL, [
        blockId,
        id,
      ]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'block_not_found' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_block_delete_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);