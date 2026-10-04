/**
 * Pure SQL-fragment helpers for the doctor-affected route
 * (GET /doctor/affected, E6-S3).
 *
 * Re-uses the same `outside hours` predicate shape as
 * E1-S2's `admin-branch-hours-impact.ts` (closed_day vs
 * before_open_or_after_close). The two routes MUST agree
 * on the vocabulary so the admin's preview and the doctor's
 * affected queue surface the same rows.
 *
 * The helpers are pure: they build SQL fragments and return
 * SQL strings, no I/O. The route layer passes a PoolClient
 * and assembles the final query.
 *
 * The helpers expose two flavors:
 *   - `outsideBranchHoursPredicate` / `outsideBranchHoursReasonCase`:
 *     parameterized with a tz placeholder (`$2` etc).
 *     Useful when the tz comes from a bound parameter.
 *   - `outsideBranchHoursPredicateColumnRef` /
 *     `outsideBranchHoursReasonCaseColumnRef`:
 *     inlined with the column reference `b.tz` from a JOIN
 *     to `branch`. This is the form the E6-S3 route uses,
 *     because every row already carries its branch's tz via
 *     the `JOIN branch b ON b.id = a.branch_id`.
 */
export type OutsideHoursReason = 'closed_day' | 'before_open_or_after_close';

export const MAX_AFFECTED_ROWS = 200;

/**
 * Build the SQL fragment for the "outside hours" predicate,
 * parameterized with a tz placeholder. The fragment is
 * designed to be embedded in a larger query against
 * `appointment a JOIN branch b ON b.id = a.branch_id`. The
 * fragment references `a` (the appointment alias) and the
 * placeholder.
 */
function buildOutsideBranchHoursPredicate(tzRef: string): string {
  return `
    (
      NOT EXISTS (
        SELECT 1 FROM branch_weekly_hours h
         WHERE h.branch_id = a.branch_id
           AND h.day_of_week =
               EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
      )
      OR (
        SELECT h.is_closed FROM branch_weekly_hours h
         WHERE h.branch_id = a.branch_id
           AND h.day_of_week =
               EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
      ) = true
      OR (
        SELECT h.open_time FROM branch_weekly_hours h
         WHERE h.branch_id = a.branch_id
           AND h.day_of_week =
               EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
      ) IS NOT NULL
        AND (a.start_datetime AT TIME ZONE ${tzRef})::time <
            (
              SELECT h.open_time FROM branch_weekly_hours h
               WHERE h.branch_id = a.branch_id
                 AND h.day_of_week =
                     EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
            )
      OR (
        SELECT h.close_time FROM branch_weekly_hours h
         WHERE h.branch_id = a.branch_id
           AND h.day_of_week =
               EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
      ) IS NOT NULL
        AND (a.start_datetime AT TIME ZONE ${tzRef})::time >=
            (
              SELECT h.close_time FROM branch_weekly_hours h
               WHERE h.branch_id = a.branch_id
                 AND h.day_of_week =
                     EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
            )
    )
  `;
}

function buildOutsideBranchHoursReasonCase(tzRef: string): string {
  return `
    CASE
      WHEN NOT EXISTS (
             SELECT 1 FROM branch_weekly_hours h
              WHERE h.branch_id = a.branch_id
                AND h.day_of_week =
                    EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
           )
        OR (
             SELECT h.is_closed FROM branch_weekly_hours h
              WHERE h.branch_id = a.branch_id
                AND h.day_of_week =
                    EXTRACT(dow FROM (a.start_datetime AT TIME ZONE ${tzRef}))::int
           ) = true
        THEN 'closed_day'::text
      ELSE 'before_open_or_after_close'::text
    END
  `;
}

/**
 * Parameterized form: pass `tzPlaceholder` (1-based, e.g.
 * `2` for `$2`). The fragment references `a` (the
 * appointment alias) and the placeholder.
 */
export function outsideBranchHoursPredicate(
  tzPlaceholder: number,
): string {
  return buildOutsideBranchHoursPredicate(`$${tzPlaceholder}`);
}

export function outsideBranchHoursReasonCase(
  tzPlaceholder: number,
): string {
  return buildOutsideBranchHoursReasonCase(`$${tzPlaceholder}`);
}

/**
 * Column-reference form: inlines `b.tz` (the joined branch
 * column) directly. The route joins `branch b ON b.id =
 * a.branch_id`, so every row's tz is available without a
 * bound parameter.
 */
export function outsideBranchHoursPredicateColumnRef(): string {
  return buildOutsideBranchHoursPredicate('b.tz');
}

export function outsideBranchHoursReasonCaseColumnRef(): string {
  return buildOutsideBranchHoursReasonCase('b.tz');
}