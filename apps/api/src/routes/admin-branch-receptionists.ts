/**
 * Admin receptionists routes — receptionist CRUD + single-branch
 * assignment against the singleton clinic.
 *
 * Per spec-1-4, the admin manages the receptionist lifecycle (F-19,
 * BR-004, FR-005): create, list, single-fetch, rename, deactivate, and
 * reassign-branch (single branch_id per receptionist). Routes are gated
 * by the existing `adminScope` middleware (mounted in app.ts as a
 * sibling router under the same `/admin` path).
 *
 * Routes:
 *   POST   /admin/receptionists              — create a receptionist
 *   GET    /admin/receptionists              — list all receptionists
 *                                              (with `?active=`, `?branch_id=`)
 *   GET    /admin/receptionists/:id          — single receptionist with
 *                                              `branch: {...}`
 *   PATCH  /admin/receptionists/:id          — rename / activate /
 *                                              deactivate / reassign branch
 *                                              (deactivate emits a warning,
 *                                              not a 409, per F-19)
 *
 * The PATCH route runs inside a transaction with
 * `SELECT ... FOR UPDATE` on the receptionist row to prevent a
 * concurrent PATCH-vs-PATCH interleaving (admin reassigning the branch
 * while another admin renames).
 *
 * Deactivating a receptionist does NOT block on future Scheduled
 * appointments (F-19 mirrors F-18). The PATCH response includes
 * `warning: 'receptionist_has_future_appointments'` with
 * `future_appointment_count: N` when the count is ≥1. The future
 * appointments stay Scheduled.
 *
 * Receptionists have exactly one branch (BR-004 explicit). No junction
 * table — the `receptionist.branch_id` column IS the assignment.
 *
 * Validation mirrors admin-branch-doctors-helpers.ts:
 *   - full_name: 1..120 chars, trim-then-length-check
 *   - email: 3..254 chars, basic RFC-ish format, lowercased
 *   - branch_id: single UUID string
 *   - active: boolean
 *   - uuid: parse via UUID_RE (rejects 'not-a-uuid' before DB lookup)
 *
 * No DELETE. Deactivate is the only soft-delete path; appointments,
 * branches, and other entities retain FK references to receptionist
 * (none today, but reserved for future). Hard-delete is reserved for
 * migrations.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  validateCreateReceptionistBody,
  validatePatchReceptionistBody,
  parseActiveFilter,
  isValidUuid,
} from './admin-branch-receptionists-helpers.js';

interface BranchRow {
  id: string;
  name: string;
  tz: string;
  active: boolean;
}

interface ReceptionistRow {
  id: string;
  branch_id: string;
  full_name: string;
  email: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ReceptionistWithBranch {
  id: string;
  branch_id: string;
  full_name: string;
  email: string;
  active: boolean;
  branch: BranchRow;
  created_at: Date;
  updated_at: Date;
}

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_RECEPTIONIST_BY_ID_SQL = `
  SELECT id, branch_id, full_name, email, active, created_at, updated_at
    FROM receptionist
   WHERE id = $1;
`;

const SELECT_RECEPTIONIST_FOR_UPDATE_SQL = `
  SELECT id, branch_id FROM receptionist WHERE id = $1 FOR UPDATE;
`;

const INSERT_RECEPTIONIST_SQL = `
  INSERT INTO receptionist (branch_id, full_name, email, active)
  VALUES ($1, $2, $3, true)
  RETURNING id, branch_id, full_name, email, active, created_at, updated_at;
`;

const SELECT_BRANCH_BY_ID_SQL = `
  SELECT id, name, tz, active FROM branch
   WHERE id = $1 AND clinic_id = $2;
`;

const SELECT_BRANCHES_BY_IDS_SQL = `
  SELECT id, name, tz, active FROM branch
   WHERE id = ANY($1::uuid[]) AND clinic_id = $2;
`;

const SELECT_RECEPTIONISTS_BY_CLINIC_SQL = `
  SELECT r.id, r.branch_id, r.full_name, r.email, r.active,
         r.created_at, r.updated_at
    FROM receptionist r
    JOIN branch b ON b.id = r.branch_id
   WHERE b.clinic_id = $1
     AND ($2::boolean IS NULL OR r.active = $2)
   ORDER BY r.full_name ASC, r.id ASC;
`;

const SELECT_RECEPTIONISTS_BY_BRANCH_SQL = `
  SELECT r.id, r.branch_id, r.full_name, r.email, r.active,
         r.created_at, r.updated_at
    FROM receptionist r
   WHERE r.branch_id = $1
     AND ($2::boolean IS NULL OR r.active = $2)
   ORDER BY r.full_name ASC, r.id ASC;
`;

// Future-appointment count is keyed on the receptionist's BRANCH (not
// the receptionist id) because the appointment table has no
// `receptionist_id` column. The receptionist is the operator, not the
// subject — appointments belong to patients at branches. Counting via
// branch is the closest semantic match for "appointments this
// receptionist manages".
const COUNT_BRANCH_FUTURE_SCHEDULED_SQL = `
  SELECT COUNT(*)::int AS count FROM appointment
   WHERE branch_id = $1
     AND start_datetime > now()
     AND status = 'Scheduled';
`;

function receptionistJson(r: ReceptionistRow) {
  return {
    id: r.id,
    branch_id: r.branch_id,
    full_name: r.full_name,
    email: r.email,
    active: r.active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function receptionistWithBranchJson(
  r: ReceptionistRow,
  branch: BranchRow,
): ReceptionistWithBranch {
  return {
    ...receptionistJson(r),
    branch: {
      id: branch.id,
      name: branch.name,
      tz: branch.tz,
      active: branch.active,
    },
  };
}

export const adminBranchReceptionistsRouter: Router = Router();

/** Read the singleton clinic_id at runtime. Admin scope lives at
 *  scope:'clinic' per AD-8. */
async function fetchClinicId(): Promise<string | null> {
  const pool = await getPool();
  const { rows } = await pool.query<{ id: string }>(SELECT_CLINIC_ID_SQL);
  return rows[0]?.id ?? null;
}

/** Load the branch row for a single receptionist. */
async function loadBranchForReceptionist(
  branchId: string,
  clinicId: string,
): Promise<BranchRow | null> {
  const pool = await getPool();
  const { rows } = await pool.query<BranchRow>(SELECT_BRANCH_BY_ID_SQL, [
    branchId,
    clinicId,
  ]);
  return rows[0] ?? null;
}

// ===========================================================================
// POST /admin/receptionists
// ===========================================================================
adminBranchReceptionistsRouter.post(
  '/receptionists',
  async (req: Request, res: Response): Promise<void> => {
    const v = validateCreateReceptionistBody(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const { fullName, email, branchId } = v;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_receptionist_post_connect_failed',
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

      // Validate branch exists in singleton clinic.
      const { rows: branchRows } = await client.query<BranchRow>(
        SELECT_BRANCH_BY_ID_SQL,
        [branchId, clinicId],
      );
      if (branchRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'branch_not_found', fields: [branchId] });
        return;
      }

      // INSERT receptionist. Map unique-violation on
      // `receptionist_email_key` → 409 email_already_exists.
      let receptionistRows: ReceptionistRow[];
      try {
        const result = await client.query<ReceptionistRow>(
          INSERT_RECEPTIONIST_SQL,
          [branchId, fullName, email],
        );
        receptionistRows = result.rows;
      } catch (err) {
        const pgErr = err as { code?: string; constraint?: string };
        if (
          pgErr.code === '23505' &&
          pgErr.constraint === 'receptionist_email_key'
        ) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'email_already_exists' });
          return;
        }
        throw err;
      }

      await client.query('COMMIT');
      res
        .status(201)
        .json(receptionistWithBranchJson(receptionistRows[0]!, branchRows[0]!));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_receptionist_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);

// ===========================================================================
// GET /admin/receptionists
// ===========================================================================
adminBranchReceptionistsRouter.get(
  '/receptionists',
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
        res
          .status(400)
          .json({ error: 'invalid_branch_id', fields: [branchIdRaw] });
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

      // Two SQL paths: branch-filter (scoped via receptionist.branch_id)
      // and no-branch-filter (scoped via branch.clinic_id).
      const receptionistRows = branchId
        ? (
            await pool.query<ReceptionistRow>(SELECT_RECEPTIONISTS_BY_BRANCH_SQL, [
              branchId,
              activeFilter,
            ])
          ).rows
        : (
            await pool.query<ReceptionistRow>(SELECT_RECEPTIONISTS_BY_CLINIC_SQL, [
              clinicId,
              activeFilter,
            ])
          ).rows;

      // Batch-load branches for every receptionist in one query (N+1
      // mitigation: 2 queries total, not 1+N).
      const branchIds = receptionistRows.map((r) => r.branch_id);
      const branchesById = new Map<string, BranchRow>();
      if (branchIds.length > 0) {
        const { rows } = await pool.query<BranchRow>(SELECT_BRANCHES_BY_IDS_SQL, [
          branchIds,
          clinicId,
        ]);
        for (const b of rows) branchesById.set(b.id, b);
      }

      const out = receptionistRows
        .map((r) => {
          const branch = branchesById.get(r.branch_id);
          if (!branch) return null;
          return receptionistWithBranchJson(r, branch);
        })
        .filter((x): x is ReceptionistWithBranch => x !== null);

      res.status(200).json(out);
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_receptionist_list_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// GET /admin/receptionists/:id
// ===========================================================================
adminBranchReceptionistsRouter.get(
  '/receptionists/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_receptionist_id' });
      return;
    }
    const id = req.params['id'] as string;

    try {
      const pool = await getPool();
      const { rows } = await pool.query<ReceptionistRow>(
        SELECT_RECEPTIONIST_BY_ID_SQL,
        [id],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'receptionist_not_found' });
        return;
      }
      const clinicId = await fetchClinicId();
      if (clinicId === null) {
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const branch = await loadBranchForReceptionist(rows[0]!.branch_id, clinicId);
      if (branch === null) {
        // receptionist exists but its branch is missing — invariant
        // violation. Surface as 500.
        res.status(500).json({ error: 'branch_row_missing' });
        return;
      }
      res.status(200).json(receptionistWithBranchJson(rows[0]!, branch));
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_receptionist_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// PATCH /admin/receptionists/:id
// ===========================================================================
adminBranchReceptionistsRouter.patch(
  '/receptionists/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_receptionist_id' });
      return;
    }
    const id = req.params['id'] as string;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedKeys = new Set(['full_name', 'active', 'branch_id']);
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const hasName = 'full_name' in body;
    const hasActive = 'active' in body;
    const hasBranchId = 'branch_id' in body;
    if (!hasName && !hasActive && !hasBranchId) {
      res.status(400).json({ error: 'no_fields_to_update' });
      return;
    }

    const v = validatePatchReceptionistBody(body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const { fullName, active, branchId } = v;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_receptionist_patch_connect_failed',
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

      // Lock the receptionist row to prevent PATCH-vs-PATCH interleaving.
      const { rows: recLock } = await client.query<{ id: string; branch_id: string }>(
        SELECT_RECEPTIONIST_FOR_UPDATE_SQL,
        [id],
      );
      if (recLock.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'receptionist_not_found' });
        return;
      }

      // If reassigning branch, validate the new branch exists in the
      // singleton clinic.
      if (hasBranchId) {
        const { rows: branchRows } = await client.query<BranchRow>(
          SELECT_BRANCH_BY_ID_SQL,
          [branchId, clinicId],
        );
        if (branchRows.length === 0) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'branch_not_found', fields: [branchId] });
          return;
        }
      }

      // Future-appointment count for the warning field. Always emit the
      // count on the response (P-A1 from E1-S3 review-loop-1, also
      // applied here).
      let futureCount = 0;
      let warning: string | null = null;
      if (hasActive && active === false) {
        const targetBranchId = branchId ?? recLock[0]!.branch_id;
        const { rows: countRows } = await client.query<{ count: number }>(
          COUNT_BRANCH_FUTURE_SCHEDULED_SQL,
          [targetBranchId],
        );
        futureCount = Number(countRows[0]?.count ?? 0);
        if (futureCount > 0) {
          warning = 'receptionist_has_future_appointments';
        }
      }

      // Build the UPDATE dynamically.
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
      if (hasBranchId) {
        setClauses.push(`branch_id = $${++placeholder}`);
        updateParams.push(branchId);
      }
      const idPlaceholder = ++placeholder;
      updateParams.push(id);
      const sql = `
        UPDATE receptionist SET ${setClauses.join(', ')}
         WHERE id = $${idPlaceholder}
        RETURNING id, branch_id, full_name, email, active, created_at, updated_at;
      `;
      const { rows: updated } = await client.query<ReceptionistRow>(sql, updateParams);
      if (updated.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'receptionist_not_found' });
        return;
      }
      const receptionist = updated[0]!;

      // Read the branch row for the response.
      const { rows: branchRows } = await client.query<BranchRow>(
        SELECT_BRANCH_BY_ID_SQL,
        [receptionist.branch_id, clinicId],
      );
      if (branchRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'branch_row_missing' });
        return;
      }

      await client.query('COMMIT');

      const body2: Record<string, unknown> = {
        ...receptionistWithBranchJson(receptionist, branchRows[0]!),
      };
      // Always emit `future_appointment_count` and `warning` on the PATCH
      // response so clients can branch on `warning` without nullable-key
      // concerns. `warning` is null when there are no future Scheduled
      // appointments (clean deactivate / rename / reactivate). The count is
      // 0 on rename-only / activate / reactivate paths because the variable
      // is initialized to 0 and only populated when `active === false`
      // (P-A1 from E1-S3 review-loop-1, mirrored here for E1-S4).
      body2['future_appointment_count'] = futureCount;
      body2['warning'] = warning;
      res.status(200).json(body2);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_receptionist_patch_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);