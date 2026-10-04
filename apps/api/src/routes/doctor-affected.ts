/**
 * Doctor affected queue — `GET /doctor/affected`.
 *
 * Per spec-6-3 (E6-S3) + PRD F-09 + epics-and-stories E6-S3:
 * A doctor opens their dashboard and sees the "Resolve"
 * badge listing their Scheduled appointments that fall
 * OUTSIDE the current `branch_weekly_hours` for the
 * appointment's branch. The badge is the read-side
 * counter-part of E1-S2's admin impact-preview and E6-S2's
 * doctor move.
 *
 * Lifecycle:
 *   1. Admin narrows branch hours via
 *      `PATCH /admin/branches/:id/hours` (E1-S2). The PATCH
 *      writes `branch_weekly_hours` (after the impact
 *      preview check) — the appointments themselves are
 *      NOT mutated; they remain Scheduled (saved-and-flagged).
 *   2. The doctor's appointments may now fall outside the
 *      new branch hours. This route surfaces them so the
 *      doctor's UI can show "Resolve (3)" and link each row
 *      to E6-S2's `POST /doctor/affected/:id/move`.
 *   3. The doctor calls E6-S2 to move each row to a new
 *      slot. The slot re-check (FR-046) ensures the new
 *      slot fits the NEW hours.
 *
 * Move semantics:
 *   - The route is READ-ONLY. No state is mutated, no audit
 *     row is written.
 *   - Each row carries `reason: 'closed_day' | 'before_open_or_after_close'`
 *     — same vocabulary as E1-S2's impact-preview, so the
 *     two surfaces (admin preview + doctor badge) cannot
 *     diverge on what counts as "affected".
 *   - Doctor scope doubly-bound: every row has
 *     `doctor_id = claim.doctor_id` AND
 *     `branch_id ∈ claim.branch_ids`.
 *   - Optional `?branch_id=<uuid>` narrows to one branch
 *     (must be in claim.branch_ids; otherwise 403).
 *   - Optional `?date=YYYY-MM-DD` narrows to one
 *     branch-local calendar day.
 *   - Returns at most 200 rows in `appointments`. The
 *     `count` field reflects the full set before LIMIT.
 *
 * Auth: claim.role === 'doctor' only. Patient / receptionist
 * / admin → 403 forbidden_role. Anonymous → 401.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  outsideBranchHoursPredicateColumnRef,
  outsideBranchHoursReasonCaseColumnRef,
  MAX_AFFECTED_ROWS,
} from './doctor-affected-helpers.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface AffectedRow {
  appointment_id: string;
  branch_id: string;
  doctor_id: string;
  patient_phone: string;
  appointment_type_id: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
  reason: 'closed_day' | 'before_open_or_after_close';
}

const COUNT_SQL = `
  SELECT COUNT(*)::text AS count
    FROM appointment a
    JOIN branch b ON b.id = a.branch_id
   WHERE a.doctor_id = $1::uuid
     AND a.branch_id = ANY($2::uuid[])
     AND a.start_datetime > now()
     AND a.status = 'Scheduled'
     AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)
     AND (
       $4::date IS NULL OR
       (a.start_datetime AT TIME ZONE b.tz)::date = $4::date
     )
     AND ${outsideBranchHoursPredicateColumnRef()};
`;

const LIST_SQL = `
  SELECT a.id::text AS appointment_id,
         a.branch_id::text AS branch_id,
         a.doctor_id::text AS doctor_id,
         a.patient_phone,
         a.appointment_type_id::text AS appointment_type_id,
         a.start_datetime,
         a.end_datetime,
         a.status,
         ${outsideBranchHoursReasonCaseColumnRef()} AS reason
    FROM appointment a
    JOIN branch b ON b.id = a.branch_id
   WHERE a.doctor_id = $1::uuid
     AND a.branch_id = ANY($2::uuid[])
     AND a.start_datetime > now()
     AND a.status = 'Scheduled'
     AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)
     AND (
       $4::date IS NULL OR
       (a.start_datetime AT TIME ZONE b.tz)::date = $4::date
     )
     AND ${outsideBranchHoursPredicateColumnRef()}
   ORDER BY a.start_datetime ASC, a.branch_id ASC
   LIMIT ${MAX_AFFECTED_ROWS};
`;

export const doctorAffectedRouter: Router = Router();

doctorAffectedRouter.get(
  '/doctor/affected',
  async (req: Request, res: Response): Promise<void> => {
    const claim = req.auth?.claim ?? null;
    if (!claim) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (claim.role !== 'doctor') {
      // The affected queue is a doctor surface. The patient
      // sees their own appointments (E4-S1); the
      // receptionist has their own dashboard (E5-S4); the
      // admin has the audit log (E7-S2).
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    if (claim.doctor_id === undefined) {
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }
    if (claim.branch_ids.length === 0) {
      // Defense-in-depth: the middleware should reject
      // empty branch_ids at the auth layer, but the
      // ANY-array call would otherwise produce an empty
      // result set rather than a clean error.
      res.status(403).json({ error: 'outside_branch_scope' });
      return;
    }

    // Optional filters.
    let branchFilter: string | null = null;
    const branchFilterRaw = req.query['branch_id'];
    if (typeof branchFilterRaw === 'string' && branchFilterRaw.length > 0) {
      if (!UUID_RE.test(branchFilterRaw)) {
        res.status(400).json({ error: 'invalid_branch_id' });
        return;
      }
      if (!claim.branch_ids.includes(branchFilterRaw)) {
        // The doctor cannot probe other branches. Returning
        // 403 (rather than an empty list) is the standard
        // privacy envelope (E7-S3 / NFR-007).
        res.status(403).json({ error: 'outside_branch_scope' });
        return;
      }
      branchFilter = branchFilterRaw;
    }

    let dateFilter: string | null = null;
    const dateFilterRaw = req.query['date'];
    if (typeof dateFilterRaw === 'string' && dateFilterRaw.length > 0) {
      if (!ISO_DATE_RE.test(dateFilterRaw)) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      // Defense-in-depth: SQL rejects malformed dates, but
      // we surface a clean 400 envelope here.
      const probe = new Date(`${dateFilterRaw}T00:00:00Z`);
      if (Number.isNaN(probe.getTime())) {
        res.status(400).json({ error: 'invalid_date' });
        return;
      }
      dateFilter = dateFilterRaw;
    }

    const pool = await getPool();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_affected_connect_failed',
      );
      throw err;
    }
    try {
      const sqlParams = [
        claim.doctor_id,
        claim.branch_ids,
        branchFilter,
        dateFilter,
      ];

      const { rows: countRows } = await client.query<{ count: string }>(
        COUNT_SQL,
        sqlParams,
      );
      const count = Number(countRows[0]?.count ?? 0);

      const { rows } = await client.query<AffectedRow>(LIST_SQL, sqlParams);

      res.status(200).json({
        count,
        branch_id: branchFilter,
        date: dateFilter,
        appointments: rows.map((r) => ({
          appointment_id: r.appointment_id,
          branch_id: r.branch_id,
          doctor_id: r.doctor_id,
          patient_phone: r.patient_phone,
          appointment_type_id: r.appointment_type_id,
          start_datetime: r.start_datetime.toISOString(),
          end_datetime: r.end_datetime.toISOString(),
          status: r.status,
          reason: r.reason,
        })),
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'doctor_affected_failed',
      );
      throw err;
    } finally {
      client.release();
    }
  },
);