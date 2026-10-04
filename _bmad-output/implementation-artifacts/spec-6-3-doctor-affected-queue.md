---
title: 'E6-S3 — Doctor affected queue (branch-hours impact)'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/implementation-artifacts/spec-6-2-doctor-conflict-move.md'
  - '_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
  - 'docs/design/mockups/v1/mockups/08-branch-hours-impact.html'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD F-09 + epics-and-stories E6-S3, when an
admin-level change (branch hours, doctor schedule, doctor block)
invalidates an existing Scheduled appointment, the affected
appointment is queued for the doctor to resolve. E6-S2 already
ships the resolver (`POST /doctor/affected/:id/move`). What is
still missing is the doctor's **list view** — the "Resolve" badge
that points the doctor at the affected queue.

This story ships the read-side counter-part of E1-S2 + E6-S2:

- The admin already has `POST /admin/branches/:id/hours-impact`
  that previews how many Scheduled appointments fall outside the
  proposed hours (spec-1-2). The doctor needs the **opposite
  direction**: "given the CURRENT branch hours, which of MY
  Scheduled appointments now fall outside hours?" — i.e. the
  after-the-fact impact.

- Each row returned carries `reason: 'closed_day'` or
  `reason: 'before_open_or_after_close'` so the doctor knows
  *why* it's affected (E1-S2 vocabulary).

- The route does NOT change behavior. It is read-only — it
  surfaces the existing data so the doctor's dashboard can
  show a "Resolve" badge with a count + a link to E6-S2's
  per-row move.

**Approach:** Add ONE new route + ONE new migration-free helper:

1. **`GET /doctor/affected` (NEW)** — read-only list of the
   doctor's Scheduled appointments that fall outside the
   current `branch_weekly_hours` of the appointment's branch
   (i.e. outside branch hours). The handler:
   - Auth: `claim.role === 'doctor'` only. Patient /
     receptionist / admin → 403 forbidden_role. Anonymous →
     401.
   - Doctor scope doubly-bound: every returned row has
     `doctor_id = claim.doctor_id` AND
     `branch_id ∈ claim.branch_ids`.
   - Optional `?branch_id=<uuid>` filter — when supplied, the
     list is scoped to that branch. The branch must be in
     `claim.branch_ids`; otherwise 403 outside_branch_scope.
     When omitted, the list spans all of the doctor's branches.
   - Optional `?date=YYYY-MM-DD` filter — a branch-local
     calendar day. When supplied, only appointments whose
     `start_datetime AT TIME ZONE branch.tz` falls on that
     day are returned. When omitted, ALL future Scheduled rows
     are returned.
   - The "outside hours" predicate mirrors E1-S2's
     `outsidePredicate` — `EXTRACT(dow FROM
     (start_datetime AT TIME ZONE branch.tz))` either has no
     row in `branch_weekly_hours` (closed_day) or the wall-clock
     time is `< open_time` or `>= close_time`
     (before_open_or_after_close).
   - Each row carries `{appointment_id, branch_id, doctor_id,
     patient_phone, appointment_type_id, start_datetime,
     end_datetime, reason, status}` so the doctor can drive
     the E6-S2 move from it.
   - Returns 200 with `{count: number, branch_id?: string,
     date?: string, appointments: [...]}`.
   - The route NEVER mutates state. Pure read against
     `appointment` joined to `branch` + `branch_weekly_hours`.

**No new migration.** E6-S3 reads from existing
`appointment`, `branch`, `branch_weekly_hours` tables — all
present after E1-S2's `0015_branch_hours.sql`.

## Boundaries & Constraints

**Always:**
- The list is doubly-bound to the doctor: every row's
  `doctor_id = claim.doctor_id`. A doctor cannot see another
  doctor's affected queue.
- The list is branch-scoped: when `?branch_id` is supplied,
  it must be in `claim.branch_ids` (the doctor's assigned
  branches). A doctor cannot probe other branches.
- The list is READ-ONLY. No state is mutated. No audit row
  is written — reading the queue is a normal query, not a
  business event.
- The `reason` field uses the same vocabulary as E1-S2's
  impact-preview: `'closed_day'` or
  `'before_open_or_after_close'`.
- The route returns at most 200 rows in a single response
  (consistent with the E5-S4 receptionist-today limit).
- The response carries `count` (total matching rows, even past
  the 200-row slice) so the UI can show "Resolve (5)" without
  paging.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E6-S3 + PRD F-09 + §4.7.)

**Never:**
- No patient / receptionist / admin caller. The doctor is
  the only actor with a per-row "Resolve" affordance.
- No mutation. The route is read-only; the move is E6-S2.
- No PII beyond what the doctor already sees in
  `GET /doctor/...` (no name fields — `patient_phone` only,
  matching E5-S4's receptionist-today surface). The doctor
  sees the patient phone so they can call ahead; they never
  need the patient name.
- No new column on `appointment`. The "affected" status is
  derived from the relationship between `appointment` and
  `branch_weekly_hours` at read-time, not stored. (See
  "Why no 'affected' column" in Design Notes.)
- No migration to enum-ify `appointment_audit.event` (W50 —
  deferred).

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Doctor with 3 outside-hours Scheduled | doctor | (no filters) | `200 {count: 3, appointments: [3]}` | happy path |
| Doctor with zero outside-hours | doctor | (no filters) | `200 {count: 0, appointments: []}` | empty queue |
| Doctor with `?branch_id=<own>` | doctor | `?branch_id=branch-east` | `200` filtered to branch-east | — |
| Doctor with `?branch_id=<other>` | doctor | `?branch_id=branch-west` (not in claim) | `403 outside_branch_scope` | privacy |
| Doctor with `?date=YYYY-MM-DD` | doctor | `?date=2026-10-08` | `200` filtered to that branch-local day | — |
| Doctor with `?date=bad` | doctor | `?date=2026-13-01` | `400 invalid_date` | validation |
| Doctor with `?branch_id=bad` | doctor | `?branch_id=not-a-uuid` | `400 invalid_branch_id` | validation |
| Patient JWT | patient | any | `403 forbidden_role` | role gate |
| Receptionist JWT | receptionist | any | `403 forbidden_role` | role gate |
| Admin JWT | admin | any | `403 forbidden_role` | role gate |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Doctor with no `claim.doctor_id` | doctor | any | `403 outside_branch_scope` | defense-in-depth |
| Past appointments | doctor | (no filters) | future only; past rows excluded | FR-019 same-day |
| Cancelled rows | doctor | (no filters) | excluded by `status='Scheduled'` | — |
| Row with closed-day branch | doctor | branch closed Sun + Sunday appt | `reason: 'closed_day'` | E1-S2 vocabulary |
| Row before open | doctor | branch 09:00–17:00 + 08:30 appt | `reason: 'before_open_or_after_close'` | E1-S2 vocabulary |
| Other doctor's row | doctor | — | row excluded by `doctor_id = claim.doctor_id` | scope |
| Other branch's row | doctor | — | row excluded by `branch_id ∈ claim.branch_ids` | scope |

## Code Map

- `apps/api/src/routes/doctor-affected.ts` (NEW) — GET
  /doctor/affected handler.
- `apps/api/src/routes/doctor-affected-helpers.ts` (NEW) —
  pure helpers: `outsideBranchHoursPredicate(...)` that
  builds the E6-S3 outside-predicate SQL fragment, given the
  branch-tz column and the `branch_weekly_hours` table alias.
  Re-uses the same predicate shape as E1-S2's
  `admin-branch-hours-impact.ts` so the two cannot diverge.
- `apps/api/src/app.ts` (MODIFIED) — mount
  `doctorAffectedRouter` after authMiddleware.
- `apps/api/test/doctor-affected.test.ts` (NEW) — integration
  tests.

**No new migration.** Reads existing tables.

**SQL shape (sketch):**
```sql
SELECT a.id::text AS appointment_id,
       a.branch_id::text AS branch_id,
       a.doctor_id::text AS doctor_id,
       a.patient_phone,
       a.appointment_type_id::text AS appointment_type_id,
       a.start_datetime,
       a.end_datetime,
       a.status,
       b.tz AS branch_tz,
       CASE
         WHEN NOT EXISTS (
           SELECT 1 FROM branch_weekly_hours h
            WHERE h.branch_id = a.branch_id
              AND h.day_of_week =
                  EXTRACT(dow FROM (a.start_datetime AT TIME ZONE b.tz))::int
         )
           OR (
             SELECT h.is_closed FROM branch_weekly_hours h
              WHERE h.branch_id = a.branch_id
                AND h.day_of_week =
                    EXTRACT(dow FROM (a.start_datetime AT TIME ZONE b.tz))::int
           ) = true
         THEN 'closed_day'::text
         ELSE 'before_open_or_after_close'::text
       END AS reason
  FROM appointment a
  JOIN branch b ON b.id = a.branch_id
 WHERE a.doctor_id = $1::uuid            -- claim.doctor_id
   AND a.branch_id = ANY($2::uuid[])     -- claim.branch_ids
   AND a.start_datetime > now()
   AND a.status = 'Scheduled'
   AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)
   AND <outside-predicate>
 ORDER BY a.start_datetime ASC, a.branch_id ASC
 LIMIT 200;
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/doctor-affected-helpers.ts` — pure
  SQL fragment helpers; re-uses E1-S2 vocabulary.
- [ ] `apps/api/src/routes/doctor-affected.ts` — GET
  /doctor/affected handler.
- [ ] `apps/api/src/app.ts` — mount `doctorAffectedRouter`
  after authMiddleware.
- [ ] `apps/api/test/doctor-affected.test.ts` — integration
  tests.

**Acceptance Criteria:**
- Given a doctor JWT for `claim.doctor_id=X` and X has 3 Scheduled appointments outside branch hours, when GET /doctor/affected is invoked, then 200 with `{count: 3, appointments: [3]}` where each row carries `reason: 'closed_day'|'before_open_or_after_close'`.
- Given a doctor JWT and zero outside-hours appointments, when GET /doctor/affected is invoked, then 200 with `{count: 0, appointments: []}`.
- Given a doctor JWT and `?branch_id=<other>` not in claim.branch_ids, when GET /doctor/affected is invoked, then 403 outside_branch_scope.
- Given a doctor JWT and `?date=2026-13-01`, when GET /doctor/affected is invoked, then 400 invalid_date.
- Given a doctor JWT and `?branch_id=not-a-uuid`, when GET /doctor/affected is invoked, then 400 invalid_branch_id.
- Given a patient / receptionist / admin JWT, when GET /doctor/affected is invoked, then 403 forbidden_role.
- Given an anonymous caller, when GET /doctor/affected is invoked, then 401 unauthenticated.
- Given a doctor JWT and a row owned by another doctor, when GET /doctor/affected is invoked, the row is excluded by `doctor_id = claim.doctor_id`.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review. Patches:

- N1: The route uses `outsideBranchHoursPredicateColumnRef()`
  / `outsideBranchHoursReasonCaseColumnRef()` — the
  column-reference flavors of the helpers — so the predicate
  reads the tz from the joined `branch` row, not a bound
  parameter. This keeps the SQL simpler (no extra `$2` for tz)
  and aligns with how E1-S2's `admin-branch-hours-impact.ts`
  joins `branch` for tz.
- N2: The `?branch_id` privacy envelope returns 403
  `outside_branch_scope` (NOT an empty list) so the doctor
  cannot probe other branches by URL tampering. This matches
  E5-S4's "ignoring the source of truth" pattern (the route
  acknowledges the param but never trusts it).
- N3: The route caps the response at 200 rows (`MAX_AFFECTED_ROWS`)
  but the `count` field reflects the full set before LIMIT —
  mirroring E5-S4's `appointments[]` slice + `count` total.
- N4: Defense-in-depth: `claim.branch_ids.length === 0`
  returns 403 (rather than silently returning an empty list
  via `branch_id = ANY(NULL)`). The middleware should reject
  empty branch_ids at the auth layer; the route guards it
  anyway.
- N5: The helpers expose BOTH parameterized and column-ref
  flavors. The parameterized form is retained for future
  callers (e.g. a variant that reads the tz from a bound
  parameter); the route uses the column-ref form.

## Design Notes

**Why no 'affected' column on `appointment`:** The "outside
hours" state is a *function* of the relationship between the
row and the current `branch_weekly_hours`. Storing a column
would require a write-path-side trigger every time branch
hours change, plus a write on every appointment
insert/update. The read-side predicate is O(1) per row with
the (branch_id, day_of_week) UNIQUE index on
`branch_weekly_hours`. A future hardening story could add an
enum column for fast dashboard counters (W48 — deferred).

**Why `count` returns the full set, not just the slice:**
The route returns at most 200 rows in `appointments` but the
`count` field reflects the full set (before LIMIT). The UI
can show "Resolve (5)" and surface a "view all" affordance
that fetches the rest. This mirrors E5-S4's `appointments`
slice with full `count`.

**Why the route lives under `/doctor/affected` and not
`/doctor/branch/:id/affected`:** The endpoint mirrors the E6-S2
move path (`/doctor/affected/:id/move`) — the `:id` is the
appointment id. The list path is `/doctor/affected` (no id).
This gives the dashboard a single namespace for the entire
"affected queue" experience.

**Why no migration to enum-ify `appointment_audit.event`:**
The audit `event` column is `text` (open enum per 0009).
E6-S2 already used `moved_by_doctor` without an enum change.
E6-S3 does not write new events; it reads the
`branch_weekly_hours` / `appointment` join. An enum migration
is W50 (deferred).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/doctor-affected.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.