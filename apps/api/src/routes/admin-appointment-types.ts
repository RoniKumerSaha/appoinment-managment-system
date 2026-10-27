/**
 * Admin appointment-types routes — type CRUD against the singleton clinic.
 *
 * Per spec-2-3, the admin manages the appointment-type lifecycle (F-08,
 * BR-014…017, FR-006, FR-007): create, list, single-fetch, rename,
 * activate / deactivate. Routes are gated by the existing `adminScope`
 * middleware (mounted in app.ts as a sibling router under the `/admin`
 * path).
 *
 * Routes:
 *   POST   /admin/appointment-types          — create a type (always is_active=true)
 *   GET    /admin/appointment-types          — list all types; `?active=` filter
 *   GET    /admin/appointment-types/:id      — single type
 *   PATCH  /admin/appointment-types/:id      — rename / activate / deactivate
 *
 * The PATCH deactivate path runs inside a transaction with `SELECT ...
 * FOR UPDATE` on the type row to prevent a concurrent PATCH-vs-PATCH
 * interleaving. **Scope-of-lock note** (W35-style from E1-S1
 * review-loop-1, restated for E2-S3): the FOR UPDATE locks the type row
 * against concurrent admin writers (which prevents admin-vs-admin
 * races on the same type), but a concurrent `INSERT INTO appointment
 * (appointment_type_id, ...)` will NOT block on the type row — the FK
 * constraint check uses a ROW SHARE lock, which is compatible with
 * RowExclusive (FOR UPDATE). The future-appointment COUNT is therefore
 * a best-effort snapshot read for booking-vs-deactivate races; it
 * correctly identifies ≥1 future Scheduled appointment when one
 * already exists at scan time, but a future booking that races against
 * an in-flight deactivate will rely on the booking path itself to
 * take a type-row lock before the appointment INSERT. E3-S2/E3-S3
 * should verify the booking transaction takes such a lock.
 *
 * Deactivating a type with future appointments emits a warning (not a
 * 409, F-08 explicit): `warning: 'appointment_type_has_future_appointments'`
 * with `future_appointment_count: N`. The future appointments stay
 * Scheduled; the doctor's kanban (E6) handles the resolution queue.
 *
 * Validation mirrors admin-branch-doctors-helpers.ts:
 *   - name:              1..120 chars, trim-then-length-check
 *   - duration_minutes:  integer 5..480 (matches 0005 CHECK constraint)
 *   - is_active:         typeof boolean
 *   - uuid:              parse via UUID_RE
 *
 * No DELETE. Deactivate is the only soft-delete path; appointments
 * retain FK ON DELETE RESTRICT references to appointment_type via
 * appointment_type_id (0008). Hard-delete is reserved for migrations.
 *
 * No audit row on create / patch. E7-S2 (FR-051) owns the audit story;
 * E2-S3 follows the E1-S2/E1-S3/E1-S4/E2-S1/E2-S2 no-audit precedent.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  isValidUuid,
  validateCreateTypeBody,
  validatePatchTypeBody,
  parseActiveFilter,
} from './admin-appointment-types-helpers.js';
import { staffCreatedBy } from './created-by.js';

interface TypeRow {
  id: string;
  clinic_id: string;
  name: string;
  duration_minutes: number;
  is_active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  description: string | null;
}

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_TYPE_FOR_UPDATE_SQL = `
  SELECT id, clinic_id, name, duration_minutes, is_active,
         created_by, created_at, updated_at, description
    FROM appointment_type
   WHERE id = $1 AND clinic_id = $2
   FOR UPDATE;
`;

const SELECT_TYPE_LIST_SQL = `
  SELECT id, clinic_id, name, duration_minutes, is_active,
         created_by, created_at, updated_at, description
    FROM appointment_type
   WHERE clinic_id = $1
     AND ($2::boolean IS NULL OR is_active = $2)
   ORDER BY name ASC, id ASC;
`;

const SELECT_TYPE_BY_ID_SQL = `
  SELECT id, clinic_id, name, duration_minutes, is_active,
         created_by, created_at, updated_at, description
    FROM appointment_type
   WHERE id = $1 AND clinic_id = $2;
`;

const INSERT_TYPE_SQL = `
  INSERT INTO appointment_type (clinic_id, name, duration_minutes, is_active, created_by, description)
  VALUES ($1, $2, $3, true, $4, $5)
  RETURNING id, clinic_id, name, duration_minutes, is_active,
            created_by, created_at, updated_at, description;
`;

/** Build a dynamic UPDATE that touches only the fields the caller
 *  supplied. Mirrors E1-S1's P-B2 pattern (unambiguous `++placeholder`
 *  + named bindings). The trigger `trg_appointment_type_set_updated_at`
 *  already advances `updated_at` on every UPDATE, so we don't need to
 *  set it explicitly here. */
const UPDATE_TYPE_BASE_SQL = `UPDATE appointment_type SET`;

const COUNT_FUTURE_SCHEDULED_BY_TYPE_SQL = `
  SELECT COUNT(*)::text AS count FROM appointment
   WHERE appointment_type_id = $1
     AND start_datetime > now()
     AND status = 'Scheduled';
`;

function typeJson(r: TypeRow) {
  return {
    id: r.id,
    clinic_id: r.clinic_id,
    name: r.name,
    duration_minutes: r.duration_minutes,
    is_active: r.is_active,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    description: r.description,
  };
}

export const adminAppointmentTypesRouter: Router = Router();

// ===========================================================================
// POST /admin/appointment-types
// ===========================================================================
adminAppointmentTypesRouter.post(
  '/appointment-types',
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedKeys = new Set(['name', 'duration_minutes', 'description']);
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const v = validateCreateTypeBody(body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const { name, durationMinutes } = v;
    const description =
      typeof body['description'] === 'string' ? body['description'].trim() : null;
    if (description !== null && description.length > 500) {
      res.status(400).json({ error: 'invalid_description' });
      return;
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
      const createdBy = staffCreatedBy(req.auth?.claim?.sub);
      const { rows } = await pool.query<TypeRow>(INSERT_TYPE_SQL, [
        clinicId,
        name,
        durationMinutes,
        createdBy,
        description,
      ]);
      const r = rows[0]!;
      res.status(201).json(typeJson(r));
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_appointment_type_post_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// GET /admin/appointment-types
// ===========================================================================
adminAppointmentTypesRouter.get(
  '/appointment-types',
  async (req: Request, res: Response): Promise<void> => {
    const raw = req.query['active'];
    const filterResult = parseActiveFilter(raw);
    if (!filterResult.ok) {
      res.status(400).json({ error: 'invalid_active_filter' });
      return;
    }
    const activeFilter = filterResult.value;
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
      const { rows } = await pool.query<TypeRow>(SELECT_TYPE_LIST_SQL, [
        clinicId,
        activeFilter,
      ]);
      res.status(200).json(rows.map(typeJson));
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_appointment_type_list_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// GET /admin/appointment-types/:id
// ===========================================================================
adminAppointmentTypesRouter.get(
  '/appointment-types/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_appointment_type_id' });
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
      const { rows } = await pool.query<TypeRow>(SELECT_TYPE_BY_ID_SQL, [
        id,
        clinicId,
      ]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'appointment_type_not_found' });
        return;
      }
      res.status(200).json(typeJson(rows[0]!));
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_appointment_type_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// PATCH /admin/appointment-types/:id
// ===========================================================================
adminAppointmentTypesRouter.patch(
  '/appointment-types/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_appointment_type_id' });
      return;
    }
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Allowed: name, is_active, description, duration_minutes. All
    // four are editable; the DB CHECK constraint
    // (duration_minutes BETWEEN 5 AND 480) is the floor/ceiling.
    const allowedKeys = new Set([
      'name',
      'is_active',
      'description',
      'duration_minutes',
    ]);
    const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }
    const hasName = 'name' in body;
    const hasActive = 'is_active' in body;
    const hasDescription = 'description' in body;
    const hasDuration = 'duration_minutes' in body;
    if (!hasName && !hasActive && !hasDescription && !hasDuration) {
      res.status(400).json({ error: 'no_fields_to_update' });
      return;
    }
    const v = validatePatchTypeBody(body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const { name, isActive, description, durationMinutes } = v;

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_appointment_type_patch_connect_failed',
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
      const { rows: typeRows } = await client.query<TypeRow>(
        SELECT_TYPE_FOR_UPDATE_SQL,
        [id, clinicId],
      );
      if (typeRows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'appointment_type_not_found' });
        return;
      }

      // Future-appointment impact: only count when transitioning to
      // inactive AND the type is currently active (idempotent
      // deactivate-already-inactive is a no-op; the warn logic still
      // emits, but with the same count — accept it).
      let futureCount = 0;
      let warning: string | null = null;
      const transitioningToInactive = isActive === false;
      if (transitioningToInactive) {
        const { rows: cntRows } = await client.query<{ count: string }>(
          COUNT_FUTURE_SCHEDULED_BY_TYPE_SQL,
          [id],
        );
        futureCount = Number(cntRows[0]?.count ?? '0');
        if (futureCount > 0) {
          warning = 'appointment_type_has_future_appointments';
        }
      }

      // Build the UPDATE dynamically (mirror E1-S1's P-B2 pattern).
      const setClauses: string[] = [];
      const updateParams: unknown[] = [];
      let placeholder = 0;
      if (name !== null) {
        placeholder += 1;
        setClauses.push(`name = $${placeholder}`);
        updateParams.push(name);
      }
      if (isActive !== null) {
        placeholder += 1;
        setClauses.push(`is_active = $${placeholder}`);
        updateParams.push(isActive);
      }
      if (description !== null || 'description' in body) {
        // body['description'] may be null (clear) or a string; either
        // way we always write the column. The presence check uses
        // 'description' in body so an explicit null PATCH clears it.
        placeholder += 1;
        setClauses.push(`description = $${placeholder}`);
        updateParams.push(description);
      }
      if (durationMinutes !== null) {
        placeholder += 1;
        setClauses.push(`duration_minutes = $${placeholder}`);
        updateParams.push(durationMinutes);
      }
      const idPlaceholder = placeholder + 1;
      const clinicPlaceholder = placeholder + 2;
      const updateSql =
        UPDATE_TYPE_BASE_SQL +
        '\n       ' +
        setClauses.join(',\n       ') +
        `\n   WHERE id = $${idPlaceholder} AND clinic_id = $${clinicPlaceholder}\n   RETURNING id, clinic_id, name, duration_minutes, is_active,\n             created_by, created_at, updated_at, description;`;
      const { rows: updated } = await client.query<TypeRow>(updateSql, [
        ...updateParams,
        id,
        clinicId,
      ]);
      await client.query('COMMIT');

      // Always emit `future_appointment_count` and `warning` on the
      // PATCH response so clients can branch on `warning` without
      // nullable-key concerns. The count is 0 on rename-only /
      // activate / reactivate paths because the variable is initialized
      // to 0 and only populated on the deactivate path (P-A1 from
      // E1-S3 review-loop-1 pattern).
      const body2: Record<string, unknown> = {
        ...typeJson(updated[0]!),
        future_appointment_count: futureCount,
        warning,
      };
      res.status(200).json(body2);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_appointment_type_patch_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    } finally {
      client.release();
    }
  },
);