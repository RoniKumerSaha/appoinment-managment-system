/**
 * Admin branches routes — branch CRUD against the singleton clinic.
 *
 * Per spec-1-1, the admin manages the branch lifecycle (F-16, BR-005,
 * BR-059): create, rename, deactivate, list, single-fetch. Routes are
 * gated by the existing `adminScope` middleware (mounted in app.ts:83
 * as a sibling router under the same `/admin` path).
 *
 * Routes:
 *   POST   /admin/branches          — create a branch (always active=true)
 *   GET    /admin/branches          — list all branches; optional `?active=true|false`
 *   GET    /admin/branches/:id      — single branch; 404 if unknown
 *   PATCH  /admin/branches/:id      — rename, deactivate, or reactivate
 *
 * The PATCH deactivate path runs INSIDE a transaction with
 * `SELECT ... FOR UPDATE` on the branch row. **Scope-of-lock note**
 * (W35 from E1-S1 review-loop-1): the FOR UPDATE locks the branch row
 * against concurrent admin writers (which prevents admin-vs-admin
 * races on the same branch), but Postgres MVCC means a concurrent
 * `INSERT INTO appointment (branch_id, ...)` will NOT block on the
 * branch row — the FK constraint check uses a ROW SHARE lock, which
 * is compatible with RowExclusive (FOR UPDATE). The conflict-check is
 * therefore a best-effort snapshot read for booking-vs-deactivate
 * races; it correctly rejects any request that already sees future
 * Scheduled appointments, but a future booking that races against an
 * in-flight deactivate will rely on the booking path itself to take a
 * branch-row lock (`FOR SHARE` or `FOR UPDATE`) before the appointment
 * INSERT. When E3-S1 ships, verify the booking transaction takes such
 * a lock; otherwise reopen W35. The 409 envelope is documented in AC-11.
 *
 * Validation mirrors admin-clinic.ts:
 *   - name:    string, 1..120 chars, trim-then-length-check (no whitespace-only)
 *   - active:  boolean (typeof boolean, not 'maybe' / 'true' / 1)
 *   - uuid:    parse via UUID_RE (rejects 'not-a-uuid' before any DB lookup)
 *
 * No DELETE. Deactivate is the only soft-delete path; appointments,
 * doctor schedules, and doctor blocks retain FK ON DELETE RESTRICT to
 * branch so a hard-delete would orphan — but admins never DELETE; they
 * deactivate. Hard-delete is reserved for migrations.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const NAME_MIN = 1;
const NAME_MAX = 120;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BranchRow {
  id: string;
  clinic_id: string;
  name: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function isValidName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  // Reject whitespace-only names — same rationale as admin-clinic.ts:57-60:
  // a name of `"   "` would pass the length check and render as invisible
  // whitespace in the UI. Trim first, then length-check (1..120 chars).
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}

function normalizeName(name: string): string {
  return name.trim();
}

function isValidActive(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const INSERT_BRANCH_SQL = `
  INSERT INTO branch (clinic_id, name, active)
  VALUES ($1, $2, true)
  RETURNING id, clinic_id, name, active, created_at, updated_at;
`;

const SELECT_BRANCH_LIST_SQL = `
  SELECT id, clinic_id, name, active, created_at, updated_at
    FROM branch
   WHERE clinic_id = $1
     AND ($2::boolean IS NULL OR active = $2)
   ORDER BY created_at ASC, id ASC;
`;

const SELECT_BRANCH_BY_ID_SQL = `
  SELECT id, clinic_id, name, active, created_at, updated_at
    FROM branch
   WHERE id = $1 AND clinic_id = $2;
`;

const UPDATE_BRANCH_NAME_SQL = `
  UPDATE branch SET name = $1
   WHERE id = $2 AND clinic_id = $3
   RETURNING id, clinic_id, name, active, created_at, updated_at;
`;

const UPDATE_BRANCH_ACTIVE_SQL = `
  UPDATE branch SET active = $1
   WHERE id = $2 AND clinic_id = $3
   RETURNING id, clinic_id, name, active, created_at, updated_at;
`;

const SELECT_BRANCH_FOR_UPDATE_SQL = `
  SELECT id, active FROM branch WHERE id = $1 AND clinic_id = $2 FOR UPDATE;
`;

const COUNT_FUTURE_SCHEDULED_SQL = `
  SELECT 1 FROM appointment
   WHERE branch_id = $1
     AND start_datetime > now()
     AND status = 'Scheduled'
   LIMIT 1;
`;

function branchJson(r: BranchRow) {
  return {
    id: r.id,
    clinic_id: r.clinic_id,
    name: r.name,
    active: r.active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export const adminBranchesRouter: Router = Router();

// ----- POST /admin/branches -----
adminBranchesRouter.post(
  '/branches',
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('name' in body) || !isValidName(body['name'])) {
      res.status(400).json({ error: 'invalid_name' });
      return;
    }
    const name = normalizeName(body['name'] as string);

    try {
      const pool = await getPool();
      // Fetch singleton clinic_id at runtime; admin scope lives at
      // scope:'clinic' per AD-8 (no clinic_id JWT claim).
      const { rows: clinicRows } = await pool.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const clinicId = clinicRows[0]!.id;
      const { rows } = await pool.query<BranchRow>(INSERT_BRANCH_SQL, [
        clinicId,
        name,
      ]);
      const r = rows[0]!;
      res.status(201).json(branchJson(r));
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_branch_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ----- GET /admin/branches -----
adminBranchesRouter.get(
  '/branches',
  async (req: Request, res: Response): Promise<void> => {
    // Parse `?active=true|false` filter. Anything else → 400.
    const raw = req.query['active'];
    let activeFilter: boolean | null = null;
    if (raw !== undefined) {
      if (raw === 'true') activeFilter = true;
      else if (raw === 'false') activeFilter = false;
      else {
        res.status(400).json({ error: 'invalid_active_filter' });
        return;
      }
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
      const { rows } = await pool.query<BranchRow>(SELECT_BRANCH_LIST_SQL, [
        clinicId,
        activeFilter,
      ]);
      res.status(200).json(rows.map(branchJson));
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_branch_list_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ----- GET /admin/branches/:id -----
adminBranchesRouter.get(
  '/branches/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_branch_id' });
      return;
    }
    const id = req.params['id'] as string;

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
      const { rows } = await pool.query<BranchRow>(SELECT_BRANCH_BY_ID_SQL, [
        id,
        clinicId,
      ]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'branch_not_found' });
        return;
      }
      res.status(200).json(branchJson(rows[0]!));
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_branch_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ----- PATCH /admin/branches/:id -----
adminBranchesRouter.patch(
  '/branches/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_branch_id' });
      return;
    }
    const id = req.params['id'] as string;

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Reject unknown top-level fields (P-A1 from E1-S1 review-loop-1).
    // The route owns exactly two fields; anything else is either a
    // future feature (address, tz) or an attempted privilege escalation
    // (role, clinic_id, branch_ids). 400 unknown_field surfaces both
    // classes loudly rather than silently dropping the field.
    const allowedKeys = new Set(['name', 'active']);
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const hasName = 'name' in body;
    const hasActive = 'active' in body;

    if (!hasName && !hasActive) {
      res.status(400).json({ error: 'no_fields_to_update' });
      return;
    }

    let normalizedName: string | null = null;
    if (hasName) {
      if (!isValidName(body['name'])) {
        res.status(400).json({ error: 'invalid_name' });
        return;
      }
      normalizedName = normalizeName(body['name'] as string);
    }

    let activeValue: boolean | null = null;
    if (hasActive) {
      if (!isValidActive(body['active'])) {
        res.status(400).json({ error: 'invalid_active' });
        return;
      }
      activeValue = body['active'] as boolean;
    }

    const pool = await getPool();
    try {
      const { rows: clinicRows } = await pool.query<{ id: string }>(
        SELECT_CLINIC_ID_SQL,
      );
      if (clinicRows.length === 0) {
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      // Single-field rename path: just UPDATE (no tx needed; no
      // appointment table involved).
      if (hasName && !hasActive) {
        const { rows } = await pool.query<BranchRow>(UPDATE_BRANCH_NAME_SQL, [
          normalizedName,
          id,
          clinicId,
        ]);
        if (rows.length === 0) {
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        res.status(200).json(branchJson(rows[0]!));
        return;
      }

      // Single-field activate path: no conflict check needed.
      if (hasActive && !hasName && activeValue === true) {
        const { rows } = await pool.query<BranchRow>(UPDATE_BRANCH_ACTIVE_SQL, [
          true,
          id,
          clinicId,
        ]);
        if (rows.length === 0) {
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        res.status(200).json(branchJson(rows[0]!));
        return;
      }

      // Deactivate path (with or without a simultaneous rename).
      // Run inside a transaction with SELECT ... FOR UPDATE on the
      // branch row. See file-level comment for the scope-of-lock
      // caveat: the FOR UPDATE blocks admin-vs-admin races but does
      // NOT block booking-vs-deactivate unless the booking path takes
      // a branch-row lock of its own (reopen W35 when E3-S1 lands).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: locked } = await client.query<{
          id: string;
          active: boolean;
        }>(SELECT_BRANCH_FOR_UPDATE_SQL, [id, clinicId]);
        if (locked.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        const { rows: conflict } = await client.query<{ exists: boolean }>(
          COUNT_FUTURE_SCHEDULED_SQL,
          [id],
        );
        if (conflict.length > 0) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'branch_has_future_appointments' });
          return;
        }
        // Build the UPDATE dynamically to handle both fields-updated and
        // active-only paths under one transaction. Use ++idx consistently
        // (pre-increment) so the placeholder numbering is unambiguous and
        // a future maintainer adding another clause can't accidentally
        // reuse a placeholder index (P-B2 from E1-S1 review-loop-1).
        const setClauses: string[] = [];
        const updateParams: unknown[] = [];
        let placeholder = 0;
        if (hasName) {
          setClauses.push(`name = $${++placeholder}`);
          updateParams.push(normalizedName);
        }
        setClauses.push(`active = $${++placeholder}`);
        updateParams.push(activeValue);
        const idPlaceholder = ++placeholder;
        const clinicPlaceholder = ++placeholder;
        updateParams.push(id);
        updateParams.push(clinicId);
        const sql = `
          UPDATE branch SET ${setClauses.join(', ')}
           WHERE id = $${idPlaceholder} AND clinic_id = $${clinicPlaceholder}
           RETURNING id, clinic_id, name, active, created_at, updated_at;
        `;
        const { rows } = await client.query<BranchRow>(sql, updateParams);
        if (rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        await client.query('COMMIT');
        res.status(200).json(branchJson(rows[0]!));
      } catch (innerErr) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failure; surface the original error.
        }
        throw innerErr;
      } finally {
        client.release();
      }
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_branch_patch_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);
