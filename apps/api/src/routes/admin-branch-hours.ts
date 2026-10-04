/**
 * Admin branch hours routes — `GET /admin/branches/:id/hours`,
 * `POST /admin/branches/:id/hours-impact` (preview), and
 * `PATCH /admin/branches/:id/hours`.
 *
 * Per spec-1-2, hours are stored in `branch_weekly_hours` (one row per
 * (branch_id, day_of_week)) and interpreted in `branch.tz` (wall-clock
 * semantics, NOT tstzrange). PATCH is transactional with `SELECT ... FOR
 * UPDATE` on the branch row; the impact check runs inside the transaction
 * after the hours are written, so the impact SQL reads the same row state
 * we are about to commit (TOCTOU-safe — see file-level comment in
 * admin-branches.ts:1-40 for the same pattern in the deactivate path).
 *
 * Doctor-not-at-branch (BR-031/BR-033): the impact response includes
 * `requires_doctor_acknowledgement: true` when at least one affected
 * appointment belongs to a doctor currently assigned to this branch (via
 * `doctor_branch`). Admin must then re-PATCH with
 * `?acknowledge_doctor_impact=true` to commit; otherwise the response is
 * 409 and the transaction rolls back.
 *
 * Validation order (mirrors E1-S1 admin-branches.ts):
 *   1. UUID parse — invalid_branch_id
 *   2. Body shape — unknown_field, invalid_hours_length, invalid_day_of_week,
 *      invalid_time_range, invalid_timezone (in that order)
 *   3. DB-level branch lookup — branch_not_found
 *
 * `updated_at` advance on `branch` is automatic via `trg_branch_set_updated_at`
 * (E0-S2 0004). The `branch_weekly_hours.updated_at` advance is wired by
 * 0015's `trg_branch_weekly_hours_set_updated_at`.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  isValidUuid,
  isValidTimezone,
  normalizeHoursArray,
  validateHoursArray,
  type HoursRow,
} from './admin-branch-hours-helpers.js';
import { computeBranchHoursImpact } from './admin-branch-hours-impact.js';

interface BranchRow {
  id: string;
  tz: string;
  address: string | null;
  updated_at: Date;
}

interface WeeklyHoursRow {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
}

const ALLOWED_PATCH_KEYS = new Set(['hours', 'address', 'tz']);

export const adminBranchHoursRouter: Router = Router();

// ----- GET /admin/branches/:id/hours -----
adminBranchHoursRouter.get(
  '/branches/:id/hours',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_branch_id' });
      return;
    }
    const id = req.params['id'] as string;
    try {
      const pool = await getPool();
      const { rows: branchRows } = await pool.query<BranchRow>(
        `SELECT id, tz, address, updated_at FROM branch WHERE id = $1`,
        [id],
      );
      if (branchRows.length === 0) {
        res.status(404).json({ error: 'branch_not_found' });
        return;
      }
      const { rows: hoursRows } = await pool.query<WeeklyHoursRow>(
        `SELECT day_of_week,
                CASE WHEN is_closed THEN NULL ELSE open_time::text END   AS open_time,
                CASE WHEN is_closed THEN NULL ELSE close_time::text END  AS close_time,
                is_closed
           FROM branch_weekly_hours
          WHERE branch_id = $1
          ORDER BY day_of_week ASC`,
        [id],
      );
      const branch = branchRows[0]!;
      // If a branch has no rows in branch_weekly_hours (pre-0015 branch
      // before seed backfill), the route returns 200 with `hours: []`.
      // The PATCH path will then upsert 7 rows. The empty array is a
      // legitimate transient state for fresh branches or test branches.
      const hours = hoursRows.map((r) => ({
        day_of_week: r.day_of_week,
        open_time: r.open_time,
        close_time: r.close_time,
        is_closed: r.is_closed,
      }));
      res.status(200).json({
        branch_id: branch.id,
        tz: branch.tz,
        address: branch.address,
        hours,
      });
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_branch_hours_get_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ----- POST /admin/branches/:id/hours-impact (preview) -----
adminBranchHoursRouter.post(
  '/branches/:id/hours-impact',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_branch_id' });
      return;
    }
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const v = validateHoursArray(body['hours']);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const hours = normalizeHoursArray(v.value);
    const includeAffected =
      req.query['include_affected'] === 'true' ||
      (body['include_affected'] === true);

    const pool = await getPool();
    try {
      const { rows: branchRows } = await pool.query<BranchRow>(
        `SELECT id, tz FROM branch WHERE id = $1`,
        [id],
      );
      if (branchRows.length === 0) {
        res.status(404).json({ error: 'branch_not_found' });
        return;
      }
      const branchTz = branchRows[0]!.tz;
      // Acquire a client for the impact query — the helper requires a
      // PoolClient. For the read-only preview path we don't need an
      // explicit transaction, but we still need the same shape so the
      // SQL stays single-string.
      const previewClient = await pool.connect();
      try {
        const impact = await computeBranchHoursImpact({
          client: previewClient,
          branchId: id,
          proposedHours: hours,
          branchTz,
          includeAffected,
          readOnly: true,
        });
        res.status(200).json({
          count_affected: impact.count_affected,
          affected: impact.affected,
          affected_doctors: impact.affected_doctors,
          requires_doctor_acknowledgement: impact.requires_doctor_acknowledgement,
        });
      } finally {
        previewClient.release();
      }
      return;
    } catch (err) {
      getLogger().error(
        { err: err instanceof Error ? err.message : String(err) },
        'admin_branch_hours_impact_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);

// ----- PATCH /admin/branches/:id/hours -----
adminBranchHoursRouter.patch(
  '/branches/:id/hours',
  async (req: Request, res: Response): Promise<void> => {
    if (!isValidUuid(req.params['id'])) {
      res.status(400).json({ error: 'invalid_branch_id' });
      return;
    }
    const id = req.params['id'] as string;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Reject unknown top-level fields (mirrors P-A1 from E1-S1).
    const unknownKeys = Object.keys(body).filter(
      (k) => !ALLOWED_PATCH_KEYS.has(k),
    );
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: 'unknown_field', fields: unknownKeys });
      return;
    }

    const hasHours = 'hours' in body;
    const hasAddress = 'address' in body;
    const hasTz = 'tz' in body;

    if (!hasHours && !hasAddress && !hasTz) {
      res.status(400).json({ error: 'no_fields_to_update' });
      return;
    }

    let hours: HoursRow[] | null = null;
    if (hasHours) {
      const v = validateHoursArray(body['hours']);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      hours = normalizeHoursArray(v.value);
    }

    let address: string | null = null;
    let addressChanged = false;
    if (hasAddress) {
      const raw = body['address'];
      // Reject undefined explicitly (the field is `in body` but null is
      // allowed to clear the address). Without the `undefined` guard, an
      // undefined value would slip through to `address = undefined` and
      // then `updateParams.push(undefined)`, which node-pg binds as NULL —
      // silently clearing the value while reporting the field as updated.
      if (raw === undefined || (raw !== null && typeof raw !== 'string')) {
        res.status(400).json({ error: 'invalid_address' });
        return;
      }
      address = raw;
      addressChanged = true;
    }

    let tz: string | null = null;
    let tzChanged = false;
    if (hasTz) {
      if (typeof body['tz'] !== 'string' || !isValidTimezone(body['tz'])) {
        res.status(400).json({ error: 'invalid_timezone' });
        return;
      }
      tz = body['tz'] as string;
      tzChanged = true;
    }

    const acknowledge =
      req.query['acknowledge_doctor_impact'] === 'true' ||
      body['acknowledge_doctor_impact'] === true;

    const pool = await getPool();
    try {
      const { rows: clinicRows } = await pool.query<{ id: string }>(
        `SELECT id FROM clinic LIMIT 1`,
      );
      if (clinicRows.length === 0) {
        res.status(500).json({ error: 'clinic_row_missing' });
        return;
      }
      const clinicId = clinicRows[0]!.id;

      // Single-field non-hours path (address or tz only) — fast path
      // with no impact check.
      if (!hasHours && (hasAddress || hasTz)) {
        const setClauses: string[] = [];
        const updateParams: unknown[] = [];
        let placeholder = 0;
        if (addressChanged) {
          setClauses.push(`address = $${++placeholder}`);
          updateParams.push(address);
        }
        if (tzChanged) {
          setClauses.push(`tz = $${++placeholder}`);
          updateParams.push(tz);
        }
        const idPlaceholder = ++placeholder;
        const clinicPlaceholder = ++placeholder;
        updateParams.push(id);
        updateParams.push(clinicId);
        const sql = `
          UPDATE branch SET ${setClauses.join(', ')}
           WHERE id = $${idPlaceholder} AND clinic_id = $${clinicPlaceholder}
           RETURNING id, clinic_id, tz, address, updated_at;
        `;
        const { rows } = await pool.query<BranchRow>(sql, updateParams);
        if (rows.length === 0) {
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        res.status(200).json({
          branch_id: rows[0]!.id,
          tz: rows[0]!.tz,
          address: rows[0]!.address,
        });
        return;
      }

      // Hours path — transactional with SELECT FOR UPDATE on branch row.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // SELECT ... FOR UPDATE on branch row (advisory: scopes the lock
        // to admin-vs-admin; booking-vs-hours is not blocked — see the
        // scope-of-lock caveat in admin-branches.ts:14-29).
        const { rows: locked } = await client.query<{
          id: string;
          tz: string;
        }>(
          `SELECT id, tz FROM branch WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
          [id, clinicId],
        );
        if (locked.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'branch_not_found' });
          return;
        }
        const currentTz = locked[0]!.tz;

        // Upsert 7 rows of branch_weekly_hours. INSERT-ON-CONFLICT keeps
        // the upsert atomic.
        for (const h of hours!) {
          await client.query(
            `INSERT INTO branch_weekly_hours
               (branch_id, day_of_week, open_time, close_time, is_closed)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (branch_id, day_of_week) DO UPDATE SET
               open_time = EXCLUDED.open_time,
               close_time = EXCLUDED.close_time,
               is_closed = EXCLUDED.is_closed,
               updated_at = app_now()`,
            [
              id,
              h.day_of_week,
              h.is_closed ? null : h.open_time,
              h.is_closed ? null : h.close_time,
              h.is_closed,
            ],
          );
        }

        // Apply optional branch-level fields (address, tz).
        const setClauses: string[] = [];
        const updateParams: unknown[] = [];
        let placeholder = 0;
        if (addressChanged) {
          setClauses.push(`address = $${++placeholder}`);
          updateParams.push(address);
        }
        if (tzChanged) {
          setClauses.push(`tz = $${++placeholder}`);
          updateParams.push(tz);
        }
        if (setClauses.length > 0) {
          const idPlaceholder = ++placeholder;
          const clinicPlaceholder = ++placeholder;
          updateParams.push(id);
          updateParams.push(clinicId);
          await client.query(
            `UPDATE branch SET ${setClauses.join(', ')}
              WHERE id = $${idPlaceholder} AND clinic_id = $${clinicPlaceholder}`,
            updateParams,
          );
        }

        // Re-read tz in case it was updated above.
        const effectiveTz = tzChanged ? (tz as string) : currentTz;

        // Impact check — runs against the just-written branch_weekly_hours
        // rows in the same transaction. If the count is > 0 and the admin
        // did not acknowledge the doctor edge case, ROLLBACK and 409.
        const impact = await computeBranchHoursImpact({
          client,
          branchId: id,
          proposedHours: hours!,
          branchTz: effectiveTz,
          includeAffected: false,
          readOnly: false,
        });

        if (impact.count_affected > 0) {
          if (
            impact.requires_doctor_acknowledgement &&
            !acknowledge
          ) {
            await client.query('ROLLBACK');
            res.status(409).json({
              error: 'appointments_outside_hours',
              impact: {
                count_affected: impact.count_affected,
                requires_doctor_acknowledgement: true,
                affected_doctors: impact.affected_doctors,
              },
            });
            return;
          }
          if (!impact.requires_doctor_acknowledgement) {
            await client.query('ROLLBACK');
            res.status(409).json({
              error: 'appointments_outside_hours',
              impact: {
                count_affected: impact.count_affected,
                requires_doctor_acknowledgement: false,
                affected_doctors: impact.affected_doctors,
              },
            });
            return;
          }
          // impact.count_affected > 0 && requires_ack && acknowledge=true:
          // fall through to COMMIT.
        }

        await client.query('COMMIT');

        // Return the updated branch + hours. We re-read the hours for
        // the canonical response.
        const { rows: branchAfter } = await client.query<BranchRow>(
          `SELECT id, tz, address, updated_at FROM branch WHERE id = $1`,
          [id],
        );
        const { rows: hoursAfter } = await client.query<WeeklyHoursRow>(
          `SELECT day_of_week,
                  CASE WHEN is_closed THEN NULL ELSE open_time::text END  AS open_time,
                  CASE WHEN is_closed THEN NULL ELSE close_time::text END AS close_time,
                  is_closed
             FROM branch_weekly_hours
            WHERE branch_id = $1
            ORDER BY day_of_week ASC`,
          [id],
        );
        res.status(200).json({
          branch: {
            id: branchAfter[0]!.id,
            tz: branchAfter[0]!.tz,
            address: branchAfter[0]!.address,
            updated_at: branchAfter[0]!.updated_at,
          },
          hours: hoursAfter.map((r) => ({
            day_of_week: r.day_of_week,
            open_time: r.open_time,
            close_time: r.close_time,
            is_closed: r.is_closed,
          })),
          impact: {
            count_affected: impact.count_affected,
            requires_doctor_acknowledgement:
              impact.requires_doctor_acknowledgement,
          },
        });
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
        'admin_branch_hours_patch_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);