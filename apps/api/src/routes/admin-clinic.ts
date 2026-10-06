/**
 * Admin clinic routes — `GET /admin/clinic` + `PATCH /admin/clinic`.
 *
 * Per spec-1-0, the singleton clinic row (enforced at the DB layer by
 * E1-S0a migration `0013_clinic_anchor.sql`) is exposed for read and
 * update only — no DELETE, no `clinic_id` JWT claim (admin scope lives at
 * `scope: 'clinic'` per AD-8). The route consults ONLY the JWT claim;
 * it NEVER reads `req.body.role` / `req.body.branch_ids` / `req.body.clinic_id`.
 *
 * `GET` runs ONE SQL with 10 correlated subqueries for the counts:
 *   - `branches_total` / `_active` / `_inactive` — branch counts scoped
 *     to the clinic, split by `branch.active` (active column added in
 *     E1-S1, migration `0014_branch_active.sql`)
 *   - `doctors_total` / `_active` / `_inactive` — distinct doctor counts
 *     via `doctor_branch`, split by `doctor.active` (added E1-S3)
 *   - `receptionists_total` / `_active` / `_inactive` — receptionist
 *     counts via branch, split by `receptionist.active` (added E1-S4)
 *   - `patients_total` — global `SELECT COUNT(*) FROM patient`
 *     (no per-clinic linkage exists — see SC1)
 *
 * `*_inactive` covers both `active = FALSE` and `active IS NULL` so the
 * UI can render the mockup's "N inactive" tile correctly even for legacy
 * rows that pre-date the `active` column.
 *
 * `PATCH` validates the body BEFORE any DB call (length 1–120, type
 * checked). The `updated_at` advance is automatic via
 * `trg_clinic_set_updated_at` (E0-S2, migration `0004_widen_seed_entities.sql:31-38`).
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const NAME_MIN = 1;
const NAME_MAX = 120;

interface ClinicRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  branches_total: string;
  branches_active: string;
  branches_inactive: string;
  doctors_total: string;
  doctors_active: string;
  doctors_inactive: string;
  receptionists_total: string;
  receptionists_active: string;
  receptionists_inactive: string;
  patients_total: string;
}

interface ClinicPatchRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

function isValidName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  // Reject whitespace-only names; trim first then length-check.
  // Without the trim a name of `"   "` would pass the length check and
  // render as invisible whitespace in the UI. The spec's "1-120 chars"
  // is interpreted as 1-120 chars after trimming.
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}

function normalizeName(name: string): string {
  return name.trim();
}

const SELECT_CLINIC_SQL = `
  SELECT c.id, c.name, c.created_at, c.updated_at,
    (SELECT COUNT(*) FROM branch
       WHERE clinic_id = c.id) AS branches_total,
    (SELECT COUNT(*) FROM branch
       WHERE clinic_id = c.id AND active = TRUE) AS branches_active,
    (SELECT COUNT(*) FROM branch
       WHERE clinic_id = c.id AND (active = FALSE OR active IS NULL)) AS branches_inactive,
    (SELECT COUNT(DISTINCT d.id)
       FROM doctor d
       JOIN doctor_branch db ON db.doctor_id = d.id
       JOIN branch b ON b.id = db.branch_id
       WHERE b.clinic_id = c.id) AS doctors_total,
    (SELECT COUNT(DISTINCT d.id)
       FROM doctor d
       JOIN doctor_branch db ON db.doctor_id = d.id
       JOIN branch b ON b.id = db.branch_id
       WHERE b.clinic_id = c.id AND d.active = TRUE) AS doctors_active,
    (SELECT COUNT(DISTINCT d.id)
       FROM doctor d
       JOIN doctor_branch db ON db.doctor_id = d.id
       JOIN branch b ON b.id = db.branch_id
       WHERE b.clinic_id = c.id AND (d.active = FALSE OR d.active IS NULL)) AS doctors_inactive,
    (SELECT COUNT(*) FROM receptionist r
       JOIN branch b ON b.id = r.branch_id
       WHERE b.clinic_id = c.id) AS receptionists_total,
    (SELECT COUNT(*) FROM receptionist r
       JOIN branch b ON b.id = r.branch_id
       WHERE b.clinic_id = c.id AND r.active = TRUE) AS receptionists_active,
    (SELECT COUNT(*) FROM receptionist r
       JOIN branch b ON b.id = r.branch_id
       WHERE b.clinic_id = c.id AND (r.active = FALSE OR r.active IS NULL)) AS receptionists_inactive,
    (SELECT COUNT(*) FROM patient) AS patients_total
  FROM clinic c
  LIMIT 1;
`;

const UPDATE_CLINIC_SQL = `
  UPDATE clinic
     SET name = $1
   WHERE id = (SELECT id FROM clinic LIMIT 1)
   RETURNING id, name, created_at, updated_at;
`;

export const adminClinicRouter: Router = Router();

adminClinicRouter.get('/clinic', async (_req: Request, res: Response): Promise<void> => {
  try {
    const pool = await getPool();
    const { rows } = await pool.query<ClinicRow>(SELECT_CLINIC_SQL);
    if (rows.length === 0) {
      // Should be unreachable — the E1-S0a singleton invariant guarantees
      // exactly one clinic row, and `withTestDb` runs `seedWith` which
      // provisions it. If we ever do reach here, surface a stable 500
      // rather than crash the request.
      res.status(500).json({ error: 'clinic_row_missing' });
      return;
    }
    const r = rows[0]!;
    res.status(200).json({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      updated_at: r.updated_at,
      counts: {
        branches_total: Number(r.branches_total),
        branches_active: Number(r.branches_active),
        branches_inactive: Number(r.branches_inactive),
        doctors_total: Number(r.doctors_total),
        doctors_active: Number(r.doctors_active),
        doctors_inactive: Number(r.doctors_inactive),
        receptionists_total: Number(r.receptionists_total),
        receptionists_active: Number(r.receptionists_active),
        receptionists_inactive: Number(r.receptionists_inactive),
        patients_total: Number(r.patients_total),
      },
    });
  } catch (err) {
    getLogger().error(
      { err: err instanceof Error ? err.message : String(err) },
      'admin_clinic_get_failed',
    );
    res.status(500).json({ error: 'internal_error' });
  }
});

adminClinicRouter.patch('/clinic', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Validate BEFORE any DB call so a bad input never hits the trigger or
  // produces a partial UPDATE. Per spec: type-check first, length check
  // (post-trim) second; both failure modes return `400 {error: 'invalid_name'}`.
  if (
    !('name' in body) ||
    body['name'] === null ||
    !isValidName(body['name'])
  ) {
    res.status(400).json({ error: 'invalid_name' });
    return;
  }
  const name = normalizeName(body['name'] as string);

  try {
    const pool = await getPool();
    const { rows } = await pool.query<ClinicPatchRow>(UPDATE_CLINIC_SQL, [name]);
    if (rows.length === 0) {
      res.status(500).json({ error: 'clinic_row_missing' });
      return;
    }
    const r = rows[0]!;
    res.status(200).json({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  } catch (err) {
    getLogger().error(
      { err: err instanceof Error ? err.message : String(err) },
      'admin_clinic_patch_failed',
    );
    res.status(500).json({ error: 'internal_error' });
  }
});
