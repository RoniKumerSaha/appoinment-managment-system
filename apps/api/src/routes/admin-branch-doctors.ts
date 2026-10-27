/**
 * Admin doctors routes — doctor CRUD + branch assignment against the
 * singleton clinic.
 *
 * Per spec-1-3, the admin manages the doctor lifecycle (F-18, BR-002,
 * BR-003, FR-004): create, list, single-fetch, rename, deactivate,
 * and full-set branch assignment. Routes are gated by the existing
 * `adminScope` middleware (mounted in app.ts as a sibling router under
 * the same `/admin` path).
 *
 * Routes:
 *   POST   /admin/doctors              — create a doctor (always active=true)
 *   GET    /admin/doctors              — list all doctors; `?active=`,
 *                                        `?branch_id=` filters
 *   GET    /admin/doctors/:id          — single doctor with `branches: [...]`
 *   PATCH  /admin/doctors/:id          — rename / activate / deactivate
 *                                        (deactivate emits a warning, not a
 *                                        409, per F-18)
 *   PUT    /admin/doctors/:id/branches — full-set branch assignment
 *                                        (idempotent; replaces entire set)
 *
 * The PUT /branches route runs inside a transaction with
 * `SELECT ... FOR UPDATE` on the doctor row to prevent a concurrent
 * PUT-vs-PATCH interleaving: a deactivate during a branch-replace
 * would otherwise be lost (the row-level lock makes the doctor's row
 * single-writer for the duration).
 *
 * Deactivating a doctor does NOT block on future Scheduled appointments
 * (F-18 explicit: "raises a warning... but does not block"). The PATCH
 * response includes `warning: 'doctor_has_future_appointments'` with
 * `future_appointment_count: N` when the count is ≥1. The future
 * appointments stay Scheduled; the doctor's kanban (E6) handles the
 * resolution queue.
 *
 * Validation mirrors admin-branches.ts / admin-branch-hours-helpers.ts:
 *   - full_name:  1..120 chars, trim-then-length-check
 *   - email:      3..254 chars, basic RFC-ish format, lowercased
 *   - branch_ids: non-empty array of UUIDs
 *   - active:     boolean
 *   - uuid:       parse via UUID_RE (rejects 'not-a-uuid' before DB lookup)
 *
 * No DELETE. Deactivate is the only soft-delete path; appointments,
 * doctor_branch rows, and schedules retain FK references to doctor.
 * Hard-delete is reserved for migrations.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  validateCreateDoctorBody,
  validatePatchDoctorBody,
  validatePutBranchesBody,
  parseActiveFilter,
  isValidUuid,
} from './admin-branch-doctors-helpers.js';

interface BranchRow {
  id: string;
  name: string;
  tz: string;
  active: boolean;
}

interface DoctorRow {
  id: string;
  clinic_id: string;
  full_name: string;
  email: string;
  active: boolean;
  /** E7-UX (migration 0019). Nullable. */
  specialty: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DoctorWithBranches {
  id: string;
  clinic_id: string;
  full_name: string;
  email: string;
  active: boolean;
  specialty: string | null;
  branches: BranchRow[];
  created_at: Date;
  updated_at: Date;
}

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_DOCTOR_FOR_UPDATE_SQL = `
  SELECT id, clinic_id FROM doctor WHERE id = $1 AND clinic_id = $2 FOR UPDATE;
`;

const INSERT_DOCTOR_SQL = `
  INSERT INTO doctor (clinic_id, full_name, email, active, specialty)
  VALUES ($1, $2, $3, true, $4)
  RETURNING id, clinic_id, full_name, email, active, specialty, created_at, updated_at;
`;

const INSERT_DOCTOR_BRANCH_SQL = `
  INSERT INTO doctor_branch (doctor_id, branch_id) VALUES ($1, $2);
`;

const SELECT_DOCTOR_BY_ID_SQL = `
  SELECT id, clinic_id, full_name, email, active, specialty, created_at, updated_at
    FROM doctor
   WHERE id = $1 AND clinic_id = $2;
`;

const SELECT_BRANCHES_FOR_DOCTOR_SQL = `
  SELECT b.id, b.name, b.tz, b.active
    FROM doctor_branch db
    JOIN branch b ON b.id = db.branch_id
   WHERE db.doctor_id = $1
   ORDER BY b.name ASC, b.id ASC;
`;

const SELECT_DOCTORS_BY_CLINIC_SQL = `
  SELECT id, clinic_id, full_name, email, active, specialty, created_at, updated_at
    FROM doctor
   WHERE clinic_id = $1
     AND ($2::boolean IS NULL OR active = $2)
   ORDER BY full_name ASC, id ASC;
`;

const SELECT_DOCTORS_BY_BRANCH_SQL = `
  SELECT DISTINCT d.id, d.clinic_id, d.full_name, d.email, d.active,
                  d.specialty, d.created_at, d.updated_at
    FROM doctor d
    JOIN doctor_branch db ON db.doctor_id = d.id
   WHERE d.clinic_id = $1
     AND db.branch_id = $2
     AND ($3::boolean IS NULL OR d.active = $3)
   ORDER BY d.full_name ASC, d.id ASC;
`;

const COUNT_DOCTOR_FUTURE_SCHEDULED_SQL = `
  SELECT COUNT(*)::int AS count FROM appointment
   WHERE doctor_id = $1
     AND start_datetime > now()
     AND status = 'Scheduled';
`;

const DELETE_DOCTOR_BRANCH_BY_DOCTOR_SQL = `
  DELETE FROM doctor_branch WHERE doctor_id = $1;
`;

function doctorJson(r: DoctorRow) {
  return {
    id: r.id,
    clinic_id: r.clinic_id,
    full_name: r.full_name,
    email: r.email,
    active: r.active,
    // E7-UX (migration 0019). Nullable — the admin card renders
    // "Not set" when it is null.
    specialty: r.specialty ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function doctorWithBranchesJson(r: DoctorRow, branches: BranchRow[]) {
  return {
    ...doctorJson(r),
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      tz: b.tz,
      active: b.active,
    })),
  };
}

export const adminBranchDoctorsRouter: Router = Router();

/** Read the singleton clinic_id at runtime. Admin scope lives at
 *  scope:'clinic' per AD-8 (no clinic_id JWT claim). */
async function fetchClinicId(): Promise<string | null> {
  const pool = await getPool();
  const { rows } = await pool.query<{ id: string }>(SELECT_CLINIC_ID_SQL);
  return rows[0]?.id ?? null;
}

/** Load the branch rows for the given doctor. */
async function loadBranchesForDoctor(
  doctorId: string,
): Promise<BranchRow[]> {
  const pool = await getPool();
  const { rows } = await pool.query<BranchRow>(SELECT_BRANCHES_FOR_DOCTOR_SQL, [
    doctorId,
  ]);
  return rows;
}

/** Verify all branch ids exist in the singleton clinic. Returns the
 *  list of unknown ids (caller emits the 400 envelope). */
async function findUnknownBranchIds(
  branchIds: string[],
  clinicId: string,
): Promise<string[]> {
  if (branchIds.length === 0) return [];
  const pool = await getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE id = ANY($1::uuid[]) AND clinic_id = $2`,
    [branchIds, clinicId],
  );
  const known = new Set(rows.map((r) => r.id));
  return branchIds.filter((id) => !known.has(id));
}

/** Shape a doctor row plus its branch list. */
async function loadDoctorWithBranches(
  doctorId: string,
  clinicId: string,
): Promise<DoctorWithBranches | null> {
  const pool = await getPool();
  const { rows } = await pool.query<DoctorRow>(SELECT_DOCTOR_BY_ID_SQL, [
    doctorId,
    clinicId,
  ]);
  if (rows.length === 0) return null;
  const branches = await loadBranchesForDoctor(doctorId);
  return doctorWithBranchesJson(rows[0]!, branches);
}

// ===========================================================================
// POST /admin/doctors
// ===========================================================================
adminBranchDoctorsRouter.post(
  '/doctors',
  async (req: Request, res: Response): Promise<void> => {
    const v = validateCreateDoctorBody(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const { fullName, email, branchIds, specialty } = v;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_post_connect_failed',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    try {
      await client.query('BEGIN');

      // Singleton clinic_id (read inside tx; we don't read the JWT claim).
      const { rows: clinicRows } = await client.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      // Validate every branch_id is real and in the singleton clinic.
      const unknown = await findUnknownBranchIds(branchIds, clinicId);
      if (unknown.length > 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'branch_not_found', fields: unknown });
        return;
      }

      // Deduplicate branch ids — the doctor_branch PK is (doctor_id,
      // branch_id), so a duplicate branch_id in the input would raise
      // 23505 on the second INSERT and surface as a 500 (P-A2 from
      // E1-S3 review-loop-1). Dedup FIRST so the user gets a clean
      // 201 with the right row count.
      const uniqueBranchIds = Array.from(new Set(branchIds));

      // INSERT doctor. The unique constraint on `email` is what surfaces
      // a 409 — ON CONFLICT (email) DO NOTHING would swallow it; we want
      // the pg error so we can map 23505 (specifically on this
      // constraint) → 409 (P-A3 from E1-S3 review-loop-1: a future
      // UNIQUE constraint added elsewhere would otherwise be mis-mapped).
      let doctorRows: DoctorRow[];
      try {
        const result = await client.query<DoctorRow>(INSERT_DOCTOR_SQL, [
          clinicId,
          fullName,
          email,
          specialty,
        ]);
        doctorRows = result.rows;
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (pgErr.code === '23505' && pgErr.constraint === 'doctor_email_key') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'email_already_exists' });
          return;
        }
        throw err;
      }
      const doctorId = doctorRows[0]!.id;

      // INSERT doctor_branch rows.
      for (const bid of uniqueBranchIds) {
        await client.query(INSERT_DOCTOR_BRANCH_SQL, [doctorId, bid]);
      }

      // Read the freshly-inserted branches (in name order, like GET).
      const { rows: branchRows } = await client.query<BranchRow>(
        SELECT_BRANCHES_FOR_DOCTOR_SQL,
        [doctorId],
      );

      await client.query('COMMIT');
      res
        .status(201)
        .json(doctorWithBranchesJson(doctorRows[0]!, branchRows));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure; surface the original error.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// GET /admin/doctors
// ===========================================================================
adminBranchDoctorsRouter.get(
  '/doctors',
  async (req: Request, res: Response): Promise<void> => {
    const activeParsed = parseActiveFilter(req.query['active']);
    if (!activeParsed.ok) {
      res.status(400).json({ error: 'invalid_active_filter' });
      return;
    }
    const activeFilter = activeParsed.value;
    const branchIdRaw = req.query['branch_id'];
    let branchId: string | null = null;
    if (branchIdRaw !== undefined) {
      if (typeof branchIdRaw !== 'string' || !isValidUuid(branchIdRaw)) {
        res.status(400).json({ error: 'invalid_branch_id', fields: [branchIdRaw] });
        return;
      }
      branchId = branchIdRaw;
    }

    try {
      const pool = await getPool();
      const { rows: clinicRows } = await pool.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      // Two SQL paths: branch-filter vs no-branch-filter. Both return the
      // doctor rows; the route then fetches the branch lists in a single
      // batch query (N+1 mitigation: 2 queries total, not 1+N).
      const doctorRows = branchId
        ? (
            await pool.query<DoctorRow>(SELECT_DOCTORS_BY_BRANCH_SQL, [
              clinicId,
              branchId,
              activeFilter,
            ])
          ).rows
        : (
            await pool.query<DoctorRow>(SELECT_DOCTORS_BY_CLINIC_SQL, [
              clinicId,
              activeFilter,
            ])
          ).rows;

      // Batch-load branches for every doctor in one query.
      const doctorIds = doctorRows.map((d) => d.id);
      const branchesByDoctor: Map<string, BranchRow[]> = new Map();
      if (doctorIds.length > 0) {
        const { rows } = await pool.query<{ doctor_id: string; id: string; name: string; tz: string; active: boolean }>(
          `SELECT db.doctor_id::text AS doctor_id,
                  b.id, b.name, b.tz, b.active
             FROM doctor_branch db
             JOIN branch b ON b.id = db.branch_id
            WHERE db.doctor_id = ANY($1::uuid[])
            ORDER BY b.name ASC, b.id ASC`,
          [doctorIds],
        );
        for (const r of rows) {
          const list = branchesByDoctor.get(r.doctor_id) ?? [];
          list.push({ id: r.id, name: r.name, tz: r.tz, active: r.active });
          branchesByDoctor.set(r.doctor_id, list);
        }
      }

      const out = doctorRows.map((d) =>
        doctorWithBranchesJson(d, branchesByDoctor.get(d.id) ?? []),
      );
      res.status(200).json(out);
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_list_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// GET /admin/doctors/:id
// ===========================================================================
adminBranchDoctorsRouter.get(
  '/doctors/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;

    try {
      const clinicId = await fetchClinicId();
      if (clinicId === null) {
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const doctor = await loadDoctorWithBranches(id, clinicId);
      if (doctor === null) {
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }
      res.status(200).json(doctor);
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// PATCH /admin/doctors/:id
// ===========================================================================
adminBranchDoctorsRouter.patch(
  '/doctors/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedKeys = new Set(['full_name', 'active', 'specialty']);
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const hasName = 'full_name' in body;
    const hasActive = 'active' in body;
    const hasSpecialty = 'specialty' in body;
    if (!hasName && !hasActive && !hasSpecialty) {
      res.status(400).json({ error: 'no_fields_to_update' });
      return;
    }

    const v = validatePatchDoctorBody(body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const { fullName, active, specialty } = v;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_patch_connect_failed',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    try {
      await client.query('BEGIN');

      const { rows: clinicRows } = await client.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      // Lock the doctor row so a concurrent PUT /branches waits for our
      // commit. The lock scope covers admin-vs-admin races; the doctor
      // kanban path (E6) is out of scope for E1-S3.
      const { rows: doctorLock } = await client.query<{ id: string }>(
        SELECT_DOCTOR_FOR_UPDATE_SQL,
        [id, clinicId],
      );
      if (doctorLock.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }

      // Future-appointment count for the warning field. Only relevant
      // when we're flipping to active=false; computed eagerly regardless
      // so the response shape is stable (clients can branch on `warning`).
      let futureCount = 0;
      let warning: string | null = null;
      if (hasActive && active === false) {
        const { rows: countRows } = await client.query<{ count: number }>(
          COUNT_DOCTOR_FUTURE_SCHEDULED_SQL,
          [id],
        );
        futureCount = Number(countRows[0]?.count ?? 0);
        if (futureCount > 0) {
          warning = 'doctor_has_future_appointments';
        }
      }

      // Build the UPDATE dynamically (mirror E1-S1's P-B2 pattern).
      const setClauses: string[] = [];
      const updateParams: unknown[] = [];
      let placeholder = 0;
      if (hasName) {
        setClauses.push(`full_name = $${++placeholder}`);
        updateParams.push(fullName);
      }
      if (hasActive) {
        setClauses.push(`active = $${++placeholder}`);
        updateParams.push(active);
      }
      if (hasSpecialty) {
        setClauses.push(`specialty = $${++placeholder}`);
        updateParams.push(specialty ?? null);
      }
      const idPlaceholder = ++placeholder;
      const clinicPlaceholder = ++placeholder;
      updateParams.push(id);
      updateParams.push(clinicId);
      const sql = `
        UPDATE doctor SET ${setClauses.join(', ')}
         WHERE id = $${idPlaceholder} AND clinic_id = $${clinicPlaceholder}
        RETURNING id, clinic_id, full_name, email, active, specialty, created_at, updated_at;
      `;
      const { rows: updated } = await client.query<DoctorRow>(sql, updateParams);
      if (updated.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }
      const doctor = updated[0]!;

      // Read the branch list for the response (single SELECT, same shape
      // as GET /doctors/:id).
      const { rows: branchRows } = await client.query<BranchRow>(
        SELECT_BRANCHES_FOR_DOCTOR_SQL,
        [id],
      );

      await client.query('COMMIT');

      const body2: Record<string, unknown> = {
        ...doctorWithBranchesJson(doctor, branchRows),
      };
      // Always emit `future_appointment_count` on the PATCH response so
      // clients can branch on `warning` without nullable-key concerns. The
      // count is 0 on rename-only / activate / reactivate paths because
      // the variable is initialized to 0 and only populated when
      // `active === false` (P-A1 from E1-S3 review-loop-1).
      body2['future_appointment_count'] = futureCount;
      if (warning !== null) {
        body2['warning'] = warning;
      }
      res.status(200).json(body2);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_patch_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// PUT /admin/doctors/:id/branches
// ===========================================================================
adminBranchDoctorsRouter.put(
  '/doctors/:id/branches',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_doctor_id' });
      return;
    }
    const id = req.params['id'] as string;

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Reject unknown top-level fields (E1-S1's P-A1 pattern).
    const allowedKeys = new Set(['branch_ids']);
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }

    // Empty arrays get the dedicated error code (matches the spec's I/O
    // matrix row: "PUT empty branch_ids → 400 doctor_must_work_at_least_one_branch").
    if (
      'branch_ids' in body &&
      Array.isArray(body['branch_ids']) &&
      body['branch_ids'].length === 0
    ) {
      res.status(400).json({ error: 'doctor_must_work_at_least_one_branch' });
      return;
    }

    const v = validatePutBranchesBody(body);
    if (!v.ok) {
      // Empty array + non-array + non-UUID cases all funnel to
      // `invalid_branch_ids` here; the empty-array case has already
      // returned above. The non-UUID case carries the offending keys
      // in `fields` so the caller can debug.
      const invalidList: string[] = [];
      if (
          'branch_ids' in body &&
          Array.isArray(body['branch_ids'])
        ) {
        for (const x of body['branch_ids'] as unknown[]) {
          if (typeof x !== 'string' || !isValidUuid(x)) {
            invalidList.push(typeof x === 'string' ? x : String(x));
          }
        }
      } else if ('branch_ids' in body) {
        invalidList.push(String(body['branch_ids']));
      }
      if (invalidList.length > 0) {
        res.status(400).json({ error: 'invalid_branch_id', fields: invalidList });
        return;
      }
      res.status(400).json({ error: v.error });
      return;
    }
    const { branchIds } = v;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_put_branches_connect_failed',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    try {
      await client.query('BEGIN');

      const { rows: clinicRows } = await client.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      // Lock the doctor row so a concurrent PATCH (e.g. a rename) waits
      // for the branch-replace commit. The PUT-vs-PATCH interleaving
      // would otherwise be lost: PATCH commits, then DELETE wipes its
      // (already-committed) rename via the doctor_branch cascade? No —
      // the doctor_branch FK has ON DELETE CASCADE on doctor, not on
      // branch. So the rename survives. But the FOR UPDATE here is
      // still right: it prevents a PATCH from reading partial state
      // mid-replace. Cheap insurance.
      const { rows: doctorLock } = await client.query<{ id: string }>(
        SELECT_DOCTOR_FOR_UPDATE_SQL,
        [id, clinicId],
      );
      if (doctorLock.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }

      // Validate every branch_id is real and in the singleton clinic.
      const { rows: branchCheck } = await client.query<{ id: string }>(
        `SELECT id FROM branch WHERE id = ANY($1::uuid[]) AND clinic_id = $2`,
        [branchIds, clinicId],
      );
      const known = new Set(branchCheck.map((r) => r.id));
      const unknown = branchIds.filter((bid) => !known.has(bid));
      if (unknown.length > 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'branch_not_found', fields: unknown });
        return;
      }

      // Idempotent full-set replace: DELETE all rows for this doctor,
      // then INSERT the new set. ON CONFLICT would be cleaner, but
      // DELETE-then-INSERT is what makes the "no-op when set is
      // unchanged" semantic obvious in the test (the DELETE/INSERT
      // pair runs, but the row count delta is zero). Dedup FIRST so
      // a duplicate branch_id doesn't 23505 on the second INSERT
      // (P-A2 from E1-S3 review-loop-1).
      const uniqueBranchIds = Array.from(new Set(branchIds));
      await client.query(DELETE_DOCTOR_BRANCH_BY_DOCTOR_SQL, [id]);
      for (const bid of uniqueBranchIds) {
        await client.query(INSERT_DOCTOR_BRANCH_SQL, [id, bid]);
      }

      // Read back the doctor + branches for the response.
      const { rows: doctorRows } = await client.query<DoctorRow>(
        SELECT_DOCTOR_BY_ID_SQL,
        [id, clinicId],
      );
      if (doctorRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'doctor_not_found' });
        return;
      }
      const { rows: branchRows } = await client.query<BranchRow>(
        SELECT_BRANCHES_FOR_DOCTOR_SQL,
        [id],
      );

      await client.query('COMMIT');
      res
        .status(200)
        .json(doctorWithBranchesJson(doctorRows[0]!, branchRows));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_doctor_put_branches_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);