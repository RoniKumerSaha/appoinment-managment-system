/**
 * Pure async impact-check helper for branch-hours changes.
 *
 * Called from two places:
 *   1. GET /admin/branches/:id/hours-impact — read-only preview.
 *   2. PATCH /admin/branches/:id/hours — runs inside the same transaction
 *      that writes the new hours, so the impact check sees the same row
 *      state we are about to write. (See admin-branches.ts:354-415 for the
 *      same TOCTOU pattern in the deactivate path.)
 *
 * Returns counts-only by default. Pass `includeAffected: true` to also
 * receive a list of `{appointment_id, start_datetime, end_datetime,
 * doctor_id, appointment_type_id, reason}` rows. Patient PII is NEVER
 * returned — see spec-1-2 §Boundaries "Never".
 *
 * SQL strategy: a single query against the `appointment` table joined to
 * `doctor_branch` (junction) and `branch` (for tz). The "outside the
 * proposed window" predicate is computed in pure SQL by:
 *   - extracting the day-of-week in `branch.tz` (EXTRACT(dow FROM ... AT
 *     TIME ZONE tz)) and checking against the open days in `proposedHours`,
 *   - extracting the wall-clock time in `branch.tz` ((start_datetime AT
 *     TIME ZONE tz)::time) and checking against the per-day open_time /
 *     close_time.
 *
 * The "doctor-not-at-branch" check is `EXISTS (SELECT 1 FROM doctor_branch
 * db WHERE db.doctor_id = a.doctor_id AND db.branch_id = a.branch_id)` —
 * a doctor is considered "at this branch" iff a `doctor_branch` row exists.
 *
 * Two operating modes:
 *   - readOnly=false (default, used by PATCH): the proposed hours are
 *     already persisted to `branch_weekly_hours` via INSERT-ON-CONFLICT-
 *     UPDATE in the same transaction; the impact reads them from the table.
 *   - readOnly=true (used by GET preview): the impact is driven from a
 *     VALUES clause built from the in-memory proposal (no DB writes).
 */
import type { PoolClient } from 'pg';
import type { HoursRow } from './admin-branch-hours-helpers.js';

export interface AffectedAppointment {
  appointment_id: string;
  start_datetime: Date;
  end_datetime: Date;
  doctor_id: string;
  appointment_type_id: string | null;
  reason: 'closed_day' | 'before_open_or_after_close';
}

export interface AffectedDoctor {
  doctor_id: string;
  doctor_name: string;
  count: number;
}

export interface ImpactResult {
  count_affected: number;
  affected?: AffectedAppointment[];
  affected_doctors: AffectedDoctor[];
  requires_doctor_acknowledgement: boolean;
}

export interface ComputeOptions {
  /** Pass the same PoolClient that will write the hours (tx case). */
  client: PoolClient;
  branchId: string;
  /** Already validated by `isValidHoursArray` + normalized Sun..Sat. */
  proposedHours: HoursRow[];
  /** IANA timezone of the branch — used to convert appointment times. */
  branchTz: string;
  includeAffected?: boolean;
  /**
   * When true, the impact runs against a VALUES clause built from the
   * proposed hours (read-only GET preview). When false (PATCH path, the
   * default), the hours are already persisted to `branch_weekly_hours`
   * and we read them.
   */
  readOnly?: boolean;
}

interface OutsideRow {
  id: string;
  start_datetime: Date;
  end_datetime: Date;
  doctor_id: string;
  appointment_type_id: string | null;
  reason: 'closed_day' | 'before_open_or_after_close';
}

/**
 * Build a Postgres VALUES list (e.g. `(0::smallint, '09:00'::time, '17:00'::time,
 * false::boolean), (1::smallint, ...)`) used to drive the read-only impact
 * path. Returns both the SQL fragment and the bound parameters.
 *
 * `startAt` is the placeholder index where this fragment begins. The
 * caller always passes `branchId` and `branchTz` first (so $1, $2), and
 * the VALUES clause starts at $3 by default. We expose `startAt` to
 * keep the helper agnostic of upstream parameter ordering.
 */
function buildHoursValuesClause(
  proposedHours: HoursRow[],
  startAt: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const rows: string[] = [];
  let nextIdx = startAt;
  proposedHours.forEach((h) => {
    params.push(h.day_of_week, h.open_time, h.close_time, h.is_closed);
    rows.push(
      `($${nextIdx}::smallint, $${nextIdx + 1}::time, $${nextIdx + 2}::time, $${nextIdx + 3}::boolean)`,
    );
    nextIdx += 4;
  });
  return { sql: rows.join(', '), params };
}

export async function computeBranchHoursImpact(
  opts: ComputeOptions,
): Promise<ImpactResult> {
  const {
    client,
    branchId,
    proposedHours,
    branchTz,
    includeAffected = false,
    readOnly = false,
  } = opts;

  // Build the params array in deterministic order:
  //   $1 = branchId, $2 = branchTz, then (read-only only) the hours VALUES params.
  const params: unknown[] = [branchId, branchTz];

  // Build the "h" source — either the table (tx path) or a VALUES clause (preview).
  let hSource: string;
  let hBranchFilter: string;
  if (readOnly) {
    // The hours values start at $3 because $1=branchId, $2=branchTz.
    const v = buildHoursValuesClause(proposedHours, 3);
    hSource = `(VALUES ${v.sql}) AS h(day_of_week, open_time, close_time, is_closed)`;
    hBranchFilter = ''; // VALUES has no branch_id column; the per-row lookup is already day-scoped.
    params.push(...v.params);
  } else {
    // CRITICAL (P1 from E1-S2 review-loop-1): the table source MUST be
    // filtered by `branch_id = $1`. Without the filter, the
    // `WHERE h.day_of_week = ...` predicate can match a row from a
    // DIFFERENT branch (e.g. another branch's Sun-closed row when
    // computing today's local-dow for THIS branch), producing wrong
    // impact counts that mix branches.
    hSource = `branch_weekly_hours h`;
    hBranchFilter = ` AND h.branch_id = $1`;
  }

  // Helper: build the per-row lookup CTE-equivalent. We inline it as a
  // scalar subquery because Postgres can't parameterize a LATERAL join
  // referenced from both the SELECT and the WHERE without doubling the
  // row count. The CTE-style "WITH h_lookup AS (...)" approach below
  // gives us one evaluation per row, but Postgres' planner is fine with
  // the inlined scalar subquery — keeping it inline for readability.
  //
  // For each appointment row, the local day-of-week is
  // EXTRACT(dow FROM (start_datetime AT TIME ZONE $2))::int. The matching
  // hours row is `h.day_of_week = local_dow`. We evaluate the lookup
  // multiple times in the same SQL — Postgres' planner caches the result
  // via the inlining, so the cost is small.

  // -- Per-appointment "outside" predicate.
  // The lookup subqueries use `h.day_of_week = EXTRACT(dow FROM ...)::int`
  // to find the matching hours row. For the tx path (table source) we
  // additionally filter on `h.branch_id = $1` so the lookup never
  // crosses branches — a critical correctness fix from E1-S2
  // review-loop-1 (P1). For the readOnly path (VALUES source), the
  // source has no branch_id column and the branch context is supplied
  // by `client.query` already.
  const lookupHours = (col: string) => `
    (
      SELECT ${col} FROM ${hSource}
       WHERE h.day_of_week = EXTRACT(dow FROM (a.start_datetime AT TIME ZONE $2))::int
       ${hBranchFilter}
    )
  `;
  const outsidePredicate = `
    (
      NOT EXISTS (
        SELECT 1 FROM ${hSource}
         WHERE h.day_of_week = EXTRACT(dow FROM (a.start_datetime AT TIME ZONE $2))::int
         ${hBranchFilter}
      )
      OR ${lookupHours('h.is_closed')} = true
      OR (${lookupHours('h.open_time')}) IS NOT NULL
        AND (a.start_datetime AT TIME ZONE $2)::time <
            ${lookupHours('h.open_time')}
      OR (${lookupHours('h.close_time')}) IS NOT NULL
        AND (a.start_datetime AT TIME ZONE $2)::time >=
            ${lookupHours('h.close_time')}
    )
  `;

  // -- Count + (optional) per-appointment rows.
  let outside: OutsideRow[];
  let countAffected: number;

  if (includeAffected) {
    const sql = `
      SELECT a.id,
             a.start_datetime,
             a.end_datetime,
             a.doctor_id,
             a.appointment_type_id,
             CASE
               WHEN NOT EXISTS (
                      SELECT 1 FROM ${hSource}
                       WHERE h.day_of_week = EXTRACT(dow FROM (a.start_datetime AT TIME ZONE $2))::int
                       ${hBranchFilter}
                    )
                 OR ${lookupHours('h.is_closed')} = true
                 THEN 'closed_day'::text
               ELSE 'before_open_or_after_close'::text
             END AS reason
        FROM appointment a
       WHERE a.branch_id = $1
         AND a.start_datetime > now()
         AND a.status = 'Scheduled'
         AND ${outsidePredicate}
    `;
    const { rows } = await client.query<OutsideRow>(sql, params);
    outside = rows;
    countAffected = rows.length;
  } else {
    const sql = `
      SELECT COUNT(*)::text AS count
        FROM appointment a
       WHERE a.branch_id = $1
         AND a.start_datetime > now()
         AND a.status = 'Scheduled'
         AND ${outsidePredicate}
    `;
    const { rows } = await client.query<{ count: string }>(sql, params);
    countAffected = Number(rows[0]?.count ?? 0);
    outside = [];
  }

  // -- Per-doctor breakdown + doctor-at-branch flag.
  const doctorSql = `
    SELECT a.doctor_id::text AS doctor_id,
           d.full_name       AS doctor_name,
           COUNT(*)::text    AS count,
           BOOL_OR(EXISTS (
             SELECT 1 FROM doctor_branch db
              WHERE db.doctor_id = a.doctor_id AND db.branch_id = a.branch_id
           )) AS any_doctor_at_branch
      FROM appointment a
      JOIN doctor d ON d.id = a.doctor_id
     WHERE a.branch_id = $1
       AND a.start_datetime > now()
       AND a.status = 'Scheduled'
       AND ${outsidePredicate}
     GROUP BY a.doctor_id, d.full_name
     ORDER BY a.doctor_id
  `;
  const { rows: doctorRows } = await client.query<{
    doctor_id: string;
    doctor_name: string;
    count: string;
    any_doctor_at_branch: boolean;
  }>(doctorSql, params);

  const affected_doctors: AffectedDoctor[] = doctorRows.map((r) => ({
    doctor_id: r.doctor_id,
    doctor_name: r.doctor_name,
    count: Number(r.count),
  }));

  // requires_doctor_acknowledgement is true iff at least one affected
  // appointment belongs to a doctor who is currently at this branch. If
  // no doctors are at the branch, the count is still surfaced but the
  // ack flag is false (the ack is for the doctor side; if there's no
  // doctor, no ack is required).
  const requires_doctor_acknowledgement = doctorRows.some(
    (r) => r.any_doctor_at_branch,
  );

  const result: ImpactResult = {
    count_affected: countAffected,
    affected_doctors,
    requires_doctor_acknowledgement,
  };
  if (includeAffected) {
    result.affected = outside.map((r) => ({
      appointment_id: r.id,
      start_datetime: r.start_datetime,
      end_datetime: r.end_datetime,
      doctor_id: r.doctor_id,
      appointment_type_id: r.appointment_type_id,
      reason: r.reason,
    }));
  }
  return result;
}