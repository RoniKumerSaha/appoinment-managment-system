/**
 * Staff catalog routes — `GET /staff-catalog/{doctors,branches,appointment-types}`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The doctor and receptionist screens (E5, E6, E7) need to populate a
 * doctor picker and an appointment-type picker. Those screens originally
 * called the ADMIN catalog routes:
 *
 *   GET /admin/doctors             → DoctorWithBranchesDto[]
 *   GET /admin/appointment-types   → AppointmentTypeDto[]
 *   GET /admin/branches            → BranchDto[]
 *
 * but `/admin/*` is gated by `adminScope`, which requires
 * `role === 'admin'`. A doctor or receptionist calling those routes
 * gets `403 forbidden_role` — so the pickers silently stayed EMPTY
 * and the walk-in booking flow, the availability browser, and the
 * doctor's recurring-series form were all unusable for exactly the two
 * roles that use them.
 *
 * The `/public/*` catalog routes DO work for staff (they only require
 * an authenticated caller), but their DTO shape is trimmed for the
 * patient picker: no `branches` array, no `email`, no `is_active`,
 * and the list is wrapped in an object rather than returned bare.
 * Swapping the calls over would have meant rewriting the filtering
 * logic in three screens.
 *
 * So this router exposes the SAME shapes the staff screens already
 * consume, over the same data, without the admin-only gate.
 *
 * Auth: any authenticated caller (doctor, receptionist, admin).
 * Anonymous → 401.
 *
 * Data exposure is intentionally narrow — this is a scheduling
 * catalog, not the admin directory:
 *   - doctors: id, full_name, email, active, specialty + branch list
 *     (the screens need `email` to identify a doctor's account and
 *     `branches` to filter by branch). No credentials, no patient data.
 *   - appointment types: id, name, duration_minutes, description,
 *     is_active.
 *   - branches: id, name, tz, address, active.
 *
 * The `?active=` / `?branch_id=` filters mirror the admin routes so
 * the two behave identically.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  specialty: string | null;
}

interface TypeRow {
  id: string;
  name: string;
  duration_minutes: number;
  description: string | null;
  is_active: boolean;
}

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_DOCTORS_BY_CLINIC_SQL = `
  SELECT id, clinic_id, full_name, email, active, specialty
    FROM doctor
   WHERE clinic_id = $1
     AND ($2::boolean IS NULL OR active = $2)
   ORDER BY full_name ASC, id ASC;
`;

const SELECT_DOCTORS_BY_BRANCH_SQL = `
  SELECT DISTINCT d.id, d.clinic_id, d.full_name, d.email, d.active, d.specialty
    FROM doctor d
    JOIN doctor_branch db ON db.doctor_id = d.id
   WHERE d.clinic_id = $1
     AND db.branch_id = $2
     AND ($3::boolean IS NULL OR d.active = $3)
   ORDER BY d.full_name ASC, d.id ASC;
`;

const SELECT_BRANCHES_FOR_DOCTORS_SQL = `
  SELECT db.doctor_id::text AS doctor_id,
         b.id, b.name, b.tz, b.active
    FROM doctor_branch db
    JOIN branch b ON b.id = db.branch_id
   WHERE db.doctor_id = ANY($1::uuid[])
   ORDER BY b.name ASC, b.id ASC;
`;

const SELECT_BRANCHES_SQL = `
  SELECT id, name, tz, active
    FROM branch
   WHERE clinic_id = $1
     AND ($2::boolean IS NULL OR active = $2)
   ORDER BY name ASC, id ASC;
`;

const SELECT_TYPES_SQL = `
  SELECT id, name, duration_minutes, description, is_active
    FROM appointment_type
   WHERE clinic_id = $1
     AND ($2::boolean IS NULL OR is_active = $2)
   ORDER BY name ASC, id ASC;
`;

export const staffCatalogRouter: Router = Router();

/**
 * Parse the `?active=` filter. Absent → null (no filter). Present but
 * not a boolean → 400, matching the admin routes' behaviour.
 */
function parseActiveFilter(raw: unknown): { ok: true; value: boolean | null } | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false };
}

// ===========================================================================
// GET /staff-catalog/doctors
// ===========================================================================
staffCatalogRouter.get(
  '/doctors',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const activeParsed = parseActiveFilter(req.query['active']);
    if (!activeParsed.ok) {
      res.status(400).json({ error: 'invalid_active_filter' });
      return;
    }
    const activeFilter = activeParsed.value;

    const branchIdRaw = req.query['branch_id'];
    let branchId: string | null = null;
    if (branchIdRaw !== undefined) {
      if (typeof branchIdRaw !== 'string' || !UUID_RE.test(branchIdRaw)) {
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

      const doctorRows: DoctorRow[] = branchId
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

      // Batch-load the branch list for every doctor in one query (2
      // queries total, not 1+N).
      const doctorIds = doctorRows.map((d) => d.id);
      const branchesByDoctor = new Map<string, BranchRow[]>();
      if (doctorIds.length > 0) {
        const { rows } = await pool.query<{
          doctor_id: string;
          id: string;
          name: string;
          tz: string;
          active: boolean;
        }>(SELECT_BRANCHES_FOR_DOCTORS_SQL, [doctorIds]);
        for (const r of rows) {
          const list = branchesByDoctor.get(r.doctor_id) ?? [];
          list.push({ id: r.id, name: r.name, tz: r.tz, active: r.active });
          branchesByDoctor.set(r.doctor_id, list);
        }
      }

      const out = doctorRows.map((d) => ({
        id: d.id,
        clinic_id: d.clinic_id,
        full_name: d.full_name,
        email: d.email,
        active: d.active,
        specialty: d.specialty ?? null,
        branches: branchesByDoctor.get(d.id) ?? [],
      }));
      res.status(200).json(out);
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_catalog_doctors_list_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// GET /staff-catalog/appointment-types
// ===========================================================================
staffCatalogRouter.get(
  '/appointment-types',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const activeParsed = parseActiveFilter(req.query['active']);
    if (!activeParsed.ok) {
      res.status(400).json({ error: 'invalid_active_filter' });
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
      const { rows } = await pool.query<TypeRow>(SELECT_TYPES_SQL, [
        clinicRows[0]!.id,
        activeParsed.value,
      ]);
      res.status(200).json(
        rows.map((t) => ({
          id: t.id,
          name: t.name,
          duration_minutes: t.duration_minutes,
          description: t.description ?? null,
          is_active: t.is_active,
        })),
      );
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_catalog_types_list_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ===========================================================================
// GET /staff-catalog/branches
// ===========================================================================
staffCatalogRouter.get(
  '/branches',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const activeParsed = parseActiveFilter(req.query['active']);
    if (!activeParsed.ok) {
      res.status(400).json({ error: 'invalid_active_filter' });
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
      const { rows } = await pool.query<BranchRow>(SELECT_BRANCHES_SQL, [
        clinicRows[0]!.id,
        activeParsed.value,
      ]);
      res.status(200).json(
        rows.map((b) => ({
          id: b.id,
          name: b.name,
          tz: b.tz,
          active: b.active,
        })),
      );
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'staff_catalog_branches_list_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);
