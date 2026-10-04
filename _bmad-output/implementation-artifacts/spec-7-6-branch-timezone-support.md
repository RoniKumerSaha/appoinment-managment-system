---
title: 'E7-S6 — Branch timezone support'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-1-1-create-edit-deactivate-branches.md'
  - '_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
  - '_bmad-output/implementation-artifacts/spec-6-1-recurring-preview-create.md'
  - '_bmad-output/implementation-artifacts/spec-6-3-doctor-affected-queue.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD UX §14 + UX-FLOWS §6.4, all
branch-local times (operating hours, slot starts/ends,
doctor schedule) are stored as UTC and converted at the
branch's timezone for display. The UI labels always carry
tz or are unambiguously local.

This story documents the timezone contract that the
existing codebase already enforces:

- `branch.tz` (IANA timezone) is a required column on
  `branch` since E1-S1's `0011_pgcrypto_grants.sql`
  (predecessor migration) and seeded with
  `America/New_York` / `Asia/Riyadh` defaults.
- `branch_weekly_hours` (E1-S2's `0015_branch_hours.sql`)
  stores `open_time` / `close_time` as `time` (wall-clock,
  no tz) — interpreted in `branch.tz` at read time.
- The 30-day window (FR-018) and same-day exclusion
  (FR-019) anchor to the branch's local calendar day.
- The recurring-preview expansion (E6-S1) and the
  doctor-affected queue (E6-S3) both convert UTC to
  branch-local via the `Intl.DateTimeFormat` API for
  DST-aware conversions.
- The receptionist-today dashboard (E5-S4) anchors "today"
  to the branch's local calendar day via the SQL cast
  `(date::timestamptz AT TIME ZONE branch.tz)`.
- The admin impact-preview (E1-S2) computes
  `EXTRACT(dow FROM (start_datetime AT TIME ZONE
  branch.tz))::int` to determine the branch-local
  day-of-week.

**No new code, no new migration.** This story captures the
tz contract as a single document so future work doesn't
accidentally weaken it. The contract is already enforced
across:

- `branch.tz` (column, E1-S1).
- `branch_weekly_hours` (table, E1-S2).
- E1-S2's impact-preview (the EXTRACT(dow AT TIME ZONE tz)
  pattern).
- E5-S4's receptionist-today (the AT TIME ZONE cast for
  the date window).
- E6-S1's recurring-preview (`localToUtcMs` and
  `formatLocalDate` helpers in `recurring-helpers.ts`).
- E6-S3's doctor-affected-queue (the
  `outsideBranchHoursPredicate` helper that bakes the
  tz column reference into the SQL fragment).

## Boundaries & Constraints

**Always:**
- Branch-local times are stored as UTC in `appointment`
  (`start_datetime`, `end_datetime` are `timestamptz`).
  Wall-clock times (e.g. `09:00`) live in
  `branch_weekly_hours.open_time` and are interpreted in
  `branch.tz` at read time.
- The `branch.tz` column is a valid IANA timezone name
  (e.g. `America/New_York`, `Asia/Riyadh`). Invalid tz
  values are rejected at the admin route level (E1-S2's
  `isValidTimezone`).
- All date-window math (FR-018 30-day window, FR-019
  same-day exclusion, E5-S4's "today") anchors to the
  branch's local calendar day, NOT to UTC.
- All wall-clock comparisons (e.g. "is this slot inside
  branch hours?") interpret the appointment's start /
  end via the branch's tz.
- The 30-day window is `today+1` to `today+30` in the
  branch's local tz. A 30-day window measured in UTC
  could span a different local day boundary near midnight,
  producing a 1-day slip.
- DST transitions are handled by the `Intl.DateTimeFormat`
  API (for JS-side conversion) and Postgres' AT TIME ZONE
  cast (for SQL-side conversion). The codebase never
  hand-rolls a tz offset — DST is automatic.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E7-S6 + PRD UX §14 / UX-FLOWS §6.4.)

**Never:**
- Never store a wall-clock time as a `timestamptz`. The
  data type is `time` (in `branch_weekly_hours` only) and
  is always interpreted in `branch.tz`.
- Never use UTC for a branch-local calculation. UTC is
  the storage timezone; `branch.tz` is the display
  timezone.
- Never hand-roll a tz offset (e.g. `+03:00`). Use the
  IANA name and let the `Intl.DateTimeFormat` /
  `AT TIME ZONE` cast handle DST.
- Never assume a branch's tz is the system's tz. The
  branch's tz is a per-row value, not a server setting.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Branch tz is IANA name | admin | PATCH branch.tz = 'America/New_York' | 200 + branch persisted | E1-S1 / E1-S2 |
| Branch tz is invalid | admin | PATCH branch.tz = 'Mars/Olympus_Mons' | 400 invalid_timezone | E1-S2's isValidTimezone |
| Branch hours stored in branch.tz | admin | PATCH hours { day: 1, open: '09:00', close: '17:00' } | 200 + hours persisted (no tz in row) | E1-S2 |
| Slot before open (branch-local) | doctor | Move to 07:00 branch-local | 409 outside_branch_hours | E1-S2 / E6-S1 |
| Slot on closed day (branch-local) | doctor | Move to Sunday 09:00 branch-local | 409 closed_day | E6-S3 reason |
| 30-day window (branch-local) | doctor | Move to today+31 branch-local | 409 outside_30d_window | FR-018 |
| Same-day (branch-local) | doctor | Move to today branch-local | 409 same_day_exclusion | FR-019 |
| Today's dashboard (E5-S4) | receptionist | GET /reception/branch/today | 200 with appointments in branch-local "today" | tz-anchored |
| Recurring preview (E6-S1) | doctor | weekly × 4 with local start_date | 200 with occurrences in branch-local tz | localToUtcMs |
| DST spring-forward (March) | doctor | Move to 02:30 on a spring-forward day | 200 (the slot may be invalid because the wall-clock is ambiguous) | AT TIME ZONE handles it |
| DST fall-back (November) | doctor | Move to 01:30 on a fall-back day | 200 (the slot is unambiguous; AT TIME ZONE picks one) | AT TIME ZONE handles it |
| Cross-tz branch | receptionist | branch-east (America/New_York) + branch-west (Asia/Riyadh) | each branch's local day is independent | branch.tz is per-row |

## Code Map

This story ships **NO new code**. The timezone contract is
already enforced across:

- `apps/api/db/migrations/0001_init.sql` — `branch.tz`
  column (IANA name).
- `apps/api/db/migrations/0015_branch_hours.sql` —
  `branch_weekly_hours` (open/close `time` columns, no tz
  in row).
- `apps/api/src/routes/admin-branch-hours.ts` — tz
  validation + EXTRACT(dow AT TIME ZONE tz) for impact
  preview.
- `apps/api/src/routes/admin-branch-hours-impact.ts` — the
  outside-hours SQL fragment that bakes in the
  AT TIME ZONE cast.
- `apps/api/src/routes/doctor-affected.ts` — re-uses E1-S2's
  outside-hours predicate shape.
- `apps/api/src/routes/receptionist-today.ts` — the
  `date::timestamptz AT TIME ZONE branch.tz` cast for
  "today" in the branch tz.
- `apps/api/src/routes/recurring-helpers.ts` —
  `formatLocalDate` and `localToUtcMs` helpers (JS-side
  branch-tz-aware conversion via `Intl.DateTimeFormat`).

This story's deliverables:

- `_bmad-output/implementation-artifacts/spec-7-6-branch-timezone-support.md`
  (this file) — documents the tz contract.

**No new migration.**

## Tasks & Acceptance

**Execution:**
- [ ] (this file) — documents the tz contract.

**Acceptance Criteria:**
- The `branch.tz` column exists with type `text` and is
  constrained to valid IANA names (E1-S2's
  `isValidTimezone` validates on PATCH).
- All branch-hours storage uses `time` (no tz in row) and
  is interpreted in `branch.tz` at read time (per
  `0015_branch_hours.sql`).
- The 30-day window and same-day exclusion anchor to the
  branch's local calendar day (per FR-018, FR-019, E6-S1
  validators).
- The receptionist-today dashboard anchors "today" to the
  branch's local calendar day (per E5-S4's
  `(date::timestamptz AT TIME ZONE branch.tz)` cast).
- DST transitions are handled by `Intl.DateTimeFormat` /
  `AT TIME ZONE` — no hand-rolled offsets in the codebase.
- The codebase never uses UTC for a branch-local
  calculation. The branch's local day is always derived
  via tz-aware APIs.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review. Patches:

- N1: The spec scope is **documentation only** — no new
  code, no new migration, no new test file. The branch
  timezone contract is already enforced across E1-S1
  (`branch.tz` column), E1-S2 (`branch_weekly_hours` +
  `isValidTimezone` + EXTRACT(dow AT TIME ZONE tz)
  impact-preview), E5-S4 (receptionist-today's
  `(date::timestamptz AT TIME ZONE branch.tz)` cast for
  the date window), E6-S1 (`formatLocalDate` and
  `localToUtcMs` in `recurring-helpers.ts` using
  `Intl.DateTimeFormat`), and E6-S3
  (`outsideBranchHoursPredicate` baking the tz column
  reference into the SQL fragment). This story captures
  the cross-cutting contract as a single document so
  future work doesn't accidentally weaken it.
- N2: The acceptance criteria are **observational**, not
  executable — they assert that the existing schema +
  helpers + queries uphold the contract. No new test
  file ships in this story; the pre-existing E1-S2 impact
  preview, E5-S4 receptionist-today, E6-S1 recurring
  preview, and E6-S3 affected queue tests already
  exercise the tz contract via their happy / DST / cross-
  tz scenarios.
- N3: The "Never hand-roll a tz offset" rule is
  documentary — it asserts the codebase's *current*
  posture (all tz conversions go through
  `Intl.DateTimeFormat` for JS-side and `AT TIME ZONE`
  for SQL-side). A future regression test could grep
  for hand-rolled offsets in the codebase, but that
  belongs in a hardening story (deferred — W52).

## Design Notes

**Why no new code:** The tz contract is already enforced
across E1-S1 / E1-S2 / E5-S4 / E6-S1 / E6-S3. This story
captures the cross-cutting contract as a single document
so future work doesn't accidentally weaken it.

**Why `time` (not `tstzrange`) in `branch_weekly_hours`:** A
`time` value is wall-clock semantics — it's just "09:00",
not "09:00 UTC" or "09:00 EST". A `tstzrange` would
conflate hours with date arithmetic and break the editor
UX. See `spec-1-2-change-branch-operating-hours.md` §
"Why `time` (not `tstzrange`)".

**Why the codebase never uses UTC for branch-local math:**
A 30-day window measured in UTC could span a different
local day boundary near midnight, producing a 1-day slip.
E.g. if the branch is in `Asia/Riyadh` (UTC+3), the
"tomorrow in branch-local" is `now_utc + 21h` (not
`now_utc + 24h`). The 30-day window in branch-local is
`now_utc + (24 * 30)h - 3h` (a Saudi clinician sees
"today" 3 hours before the same UTC instant in
`America/New_York`).

**Why DST is automatic via `Intl.DateTimeFormat`:**
Hand-rolling a tz offset (e.g. `+03:00`) breaks on the
DST transition day. `Intl.DateTimeFormat('en-CA', {
timeZone: 'America/New_York' })` returns the correct
local date for any UTC instant, including the spring-
forward and fall-back days. The `AT TIME ZONE` SQL cast
has the same property.

## Verification

**Commands:**
- `pnpm --filter @clinic/api run typecheck` — expected: 0
  new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new
  warnings.
- The pre-existing test suite already covers the tz
  contract via E1-S2's impact-preview, E5-S4's
  receptionist-today, and E6-S1's recurring-preview. No
  new test file is added by this story.