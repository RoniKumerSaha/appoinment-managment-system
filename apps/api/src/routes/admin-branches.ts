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
 *   PATCH  /admin/branches/:id      — rename, edit address/timezone, deactivate,
 *                                      or reactivate
 *
 * `address` and `tz` are also editable on
 * `PATCH /admin/branches/:id/hours` (admin-branch-hours.ts). Both routes
 * write the same `branch` columns; the hours route additionally runs the
 * operating-hours impact check, so an admin editing hours should use it.
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
import { isValidTimezone } from './admin-branch-hours-helpers.js';

const NAME_MIN = 1;
const NAME_MAX = 120;
const ADDRESS_MAX = 500;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BranchRow {
  id: string;
  clinic_id: string;
  name: string;
  active: boolean;
  tz: string;
  address: string | null;
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
  RETURNING id, clinic_id, name, active, tz, address, created_at, updated_at;
`;

const SELECT_BRANCH_LIST_SQL = `
  SELECT id, clinic_id, name, active, tz, address, created_at, updated_at
    FROM branch
   WHERE clinic_id = $1
     AND ($2::boolean IS NULL OR active = $2)
   ORDER BY created_at ASC, id ASC;
`;

const SELECT_BRANCH_BY_ID_SQL = `
  SELECT id, clinic_id, name, active, tz, address, created_at, updated_at
    FROM branch
   WHERE id = $1 AND clinic_id = $2;
`;

const SELECT_BRANCH_FOR_UPDATE_SQL = `
  SELECT id, active FROM branch WHERE id = $1 AND clinic_id = $2 FOR UPDATE;
`;

/** Counts the future Scheduled appointments on a branch. The count
 *  (not a bare existence probe) is what the 409 body carries — the
 *  admin UI has to state how many appointments are in the way, and a
 *  hardcoded 0 there reads as a contradiction ("has 0 future
 *  appointments" → "Resolve 0 appointments first"). */
const COUNT_FUTURE_SCHEDULED_SQL = `
  SELECT COUNT(*)::int AS count FROM appointment
   WHERE branch_id = $1
     AND start_datetime > now()
     AND status = 'Scheduled'
`;

function branchJson(r: BranchRow) {
  return {
    id: r.id,
    clinic_id: r.clinic_id,
    name: r.name,
    active: r.active,
    tz: r.tz,
    address: r.address,
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
    // The route owns exactly these fields; anything else is an attempted
    // privilege escalation (role, clinic_id, branch_ids). 400
    // unknown_field surfaces that loudly rather than silently dropping
    // the field.
    //
    // `address` and `tz` were added when 0015 gave `branch` an address
    // column and the branch-hours editor needed a timezone field the
    // branch list could also read. They are editable here AND on
    // `PATCH /admin/branches/:id/hours`; this route is the shortcut for
    // "edit the branch, not the schedule".
    const allowedKeys = new Set(['name', 'active', 'address', 'tz']);
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const hasName = 'name' in body;
    const hasActive = 'active' in body;
    const hasAddress = 'address' in body;
    const hasTz = 'tz' in body;

    if (!hasName && !hasActive && !hasAddress && !hasTz) {
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

    let addressValue: string | null = null;
    if (hasAddress) {
      const raw = body['address'];
      // `null` clears the address. `undefined` is rejected explicitly:
      // it would otherwise bind as NULL and report the field as updated
      // while silently clearing the value.
      if (raw === undefined || (raw !== null && typeof raw !== 'string')) {
        res.status(400).json({ error: 'invalid_address' });
        return;
      }
      if (typeof raw === 'string' && raw.length > ADDRESS_MAX) {
        res.status(400).json({ error: 'invalid_address' });
        return;
      }
      addressValue = raw === null ? null : (raw as string).trim();
    }

    let tzValue: string | null = null;
    if (hasTz) {
      if (typeof body['tz'] !== 'string' || !isValidTimezone(body['tz'])) {
        res.status(400).json({ error: 'invalid_timezone' });
        return;
      }
      tzValue = body['tz'] as string;
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

      // The SET clause list is built once and used by both the fast path
      // (no conflict check needed) and the transactional deactivate path.
      // Placeholder numbering uses ++idx consistently (pre-increment) so
      // the numbering is unambiguous and a future maintainer adding
      // another clause can't accidentally reuse a placeholder index
      // (P-B2 from E1-S1 review-loop-1).
      const setClauses: string[] = [];
      const updateParams: unknown[] = [];
      let placeholder = 0;
      if (hasName) {
        setClauses.push(`name = $${++placeholder}`);
        updateParams.push(normalizedName);
      }
      if (hasAddress) {
        setClauses.push(`address = $${++placeholder}`);
        updateParams.push(addressValue);
      }
      if (hasTz) {
        setClauses.push(`tz = $${++placeholder}`);
        updateParams.push(tzValue);
      }
      if (hasActive) {
        setClauses.push(`active = $${++placeholder}`);
        updateParams.push(activeValue);
      }
      const idPlaceholder = ++placeholder;
      const clinicPlaceholder = ++placeholder;
      updateParams.push(id);
      updateParams.push(clinicId);
      const updateSql = `
        UPDATE branch SET ${setClauses.join(', ')}
         WHERE id = $${idPlaceholder} AND clinic_id = $${clinicPlaceholder}
         RETURNING id, clinic_id, name, active, tz, address, created_at, updated_at;
      `;

      // Fast path: no deactivation, so no appointment conflict check and
      // no transaction needed.
      if (!hasActive || activeValue === true) {
        const { rows } = await pool.query<BranchRow>(updateSql, updateParams);
        if (rows.length === 0) {
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        res.status(200).json(branchJson(rows[0]!));
        return;
      }

      // Deactivate path (with or without a simultaneous rename / address
      // / tz change). Run inside a transaction with SELECT ... FOR UPDATE
      // on the branch row. See file-level comment for the scope-of-lock
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
        const { rows: conflict } = await client.query<{ count: number }>(
          COUNT_FUTURE_SCHEDULED_SQL,
          [id],
        );
        const futureCount = conflict[0]?.count ?? 0;
        if (futureCount > 0) {
          await client.query('ROLLBACK');
          // The count travels with the error so the admin UI can state
          // how many appointments are in the way (BR-059).
          res.status(409).json({
            error: 'branch_has_future_appointments',
            future_appointment_count: futureCount,
          });
          return;
        }
        const { rows } = await client.query<BranchRow>(updateSql, updateParams);
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
