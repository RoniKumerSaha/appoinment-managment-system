/**
 * Public catalog routes — `GET /public/{doctors,branches,appointment-types}`.
 *
 * Patient-facing list endpoints used by the E3 booking flow. These
 * endpoints intentionally return ONLY active rows; the patient picker
 * should never see inactive types / doctors / branches.
 *
 * Per spec-3-1 + spec-3-2 + spec-3-3, the booking flow is:
 *   1. Patient picks a doctor  → GET /public/doctors
 *   2. Patient picks a branch   → GET /public/branches (filtered to the
 *                                doctor's branches server-side when
 *                                `doctor_id` is supplied)
 *   3. Patient picks a type     → GET /public/appointment-types
 *   4. Patient picks date+time  → GET /availability (E3-S1, separate route)
 *   5. Patient submits details  → POST /bookings (E3-S2, separate route)
 *
 * Auth: any authenticated caller (patient, receptionist, doctor, admin).
 * Anonymous → 401. No adminScope — these are public catalog reads.
 *
 * Response shapes mirror the admin DTOs but are trimmed to the minimum
 * the patient picker needs (id, name, [branches | branch_ids], and
 * `duration_minutes` for types). Email + sensitive fields are stripped
 * from the doctor row per NFR-007.
 */
import { Router, type Request as Req, type Response as Res } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_PUBLIC_DOCTORS_SQL = `
  SELECT d.id::text AS id, d.full_name
    FROM doctor d
   WHERE d.clinic_id = $1 AND d.active = true
   ORDER BY d.full_name ASC, d.id ASC;
`;

const SELECT_PUBLIC_BRANCHES_SQL = `
  SELECT b.id::text AS id, b.name, b.tz
    FROM branch b
   WHERE b.clinic_id = $1 AND b.active = true
   ORDER BY b.name ASC, b.id ASC;
`;

// Branches a doctor works at — used by the booking flow to constrain the
// branch picker. The doctor must be active AND at the branch AND the
// branch must be active (the patient's branch picker must never offer
// a branch the doctor isn't at).
//
// Params: $1 = doctor_id, $2 = clinic_id. (Earlier revisions filtered
// `db.branch_id = $2` here — but $2 was bound to the doctor_id in the
// call site, which made the join match zero rows for every doctor.
// Removed that filter; the doctor→branch list is governed by
// `db.doctor_id = d.id` alone.)
const SELECT_DOCTOR_BRANCHES_PUBLIC_SQL = `
  SELECT b.id::text AS id, b.name, b.tz
    FROM doctor d
    JOIN doctor_branch db ON db.doctor_id = d.id
    JOIN branch b ON b.id = db.branch_id AND b.active = true
   WHERE d.id = $1 AND d.clinic_id = $2 AND d.active = true
   ORDER BY b.name ASC, b.id ASC;
`;

const SELECT_PUBLIC_APPOINTMENT_TYPES_SQL = `
  SELECT id::text AS id, name, duration_minutes
    FROM appointment_type
   WHERE clinic_id = $1 AND is_active = true
   ORDER BY name ASC, id ASC;
`;

export const publicCatalogRouter: Router = Router();

publicCatalogRouter.get(
  '/public/doctors',
  async (req: Req, res: Res): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
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
      const { rows } = await pool.query<{
        id: string;
        full_name: string;
      }>(SELECT_PUBLIC_DOCTORS_SQL, [clinicRows[0]!.id]);
      res.status(200).json({
        doctors: rows.map((r) => ({ id: r.id, full_name: r.full_name })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'public_doctors_list_failed',
      );
      throw err;
    }
  },
);

publicCatalogRouter.get(
  '/public/branches',
  async (req: Req, res: Res): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const doctorIdRaw = req.query['doctor_id'];
    const doctorId = typeof doctorIdRaw === 'string' ? doctorIdRaw : '';
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
      let rows: Array<{ id: string; name: string; tz: string }>;
      if (doctorId.length > 0) {
        if (!UUID_RE.test(doctorId)) {
          res.status(400).json({ error: 'invalid_doctor_id' });
          return;
        }
        const result = await pool.query<{
          id: string;
          name: string;
          tz: string;
        }>(SELECT_DOCTOR_BRANCHES_PUBLIC_SQL, [doctorId, clinicId]);
        rows = result.rows;
      } else {
        const result = await pool.query<{
          id: string;
          name: string;
          tz: string;
        }>(SELECT_PUBLIC_BRANCHES_SQL, [clinicId]);
        rows = result.rows;
      }
      res.status(200).json({ branches: rows });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'public_branches_list_failed',
      );
      throw err;
    }
  },
);

publicCatalogRouter.get(
  '/public/appointment-types',
  async (req: Req, res: Res): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
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
      const { rows } = await pool.query<{
        id: string;
        name: string;
        duration_minutes: number;
      }>(SELECT_PUBLIC_APPOINTMENT_TYPES_SQL, [clinicRows[0]!.id]);
      res.status(200).json({
        appointment_types: rows.map((r) => ({
          id: r.id,
          name: r.name,
          duration_minutes: r.duration_minutes,
        })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'public_appointment_types_list_failed',
      );
      throw err;
    }
  },
);