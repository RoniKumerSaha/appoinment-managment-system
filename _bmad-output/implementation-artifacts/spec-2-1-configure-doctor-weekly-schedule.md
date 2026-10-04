---
title: 'E2-S1 — Configure doctor weekly schedule (multi-period days + effective date)'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-1-1-create-deactivate-branch-doctors.md'
  - '_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
  - '_bmad-output/implementation-artifacts/spec-1-3-create-deactivate-assign-branch-doctors.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `doctor_schedule` table already exists from `0006_doctor_schedule.sql` (E0-S2) with `(doctor_id, branch_id, day_of_week, start_time, end_time, effective_from, effective_to, created_by, created_at, updated_at)` and `effective_to` is NULL-able (open-ended). Multiple rows per `(doctor, branch, day_of_week)` are permitted at the DB layer (multi-period days), and a `CHECK (end_time > start_time)` plus `CHECK (effective_to IS NULL OR effective_to >= effective_from)` keep the row well-formed. There is no admin/doctor surface to create or read this data, no `active` column, and the BR-009/BR-012/FR-008…011/FR-011 conflict semantics (FR-011, BR-009: "save rejected when affected appointments exist") are not encoded anywhere.

**Approach:** Add a new route family `routes/admin-doctor-schedule.ts` exposing `GET /admin/doctors/:id/schedule` (returns every `(branch_id, day_of_week, start_time, end_time, effective_from, effective_to)` for that doctor across all branches they work at), `POST /admin/doctors/:id/schedule` (full-set replace — wipe existing rows for that doctor and insert a new set inside a single transaction), `POST /admin/doctors/:id/schedule-impact` (preview: count future Scheduled appointments that would be invalidated by the proposed schedule), and `PATCH /admin/doctors/:id/schedule` (commit a schedule change, gated by the impact check: returns `409 {error: 'schedule_invalidates_future_appointments', future_appointment_count: N, affected_appointments: [...]}` when N ≥ 1; otherwise commits). All routes gated by `adminScope`. The doctor must already be assigned to the branch(es) in the schedule (BR-007/BR-009 implicit: a doctor can only configure hours at branches they work at). The route validates `effective_from` (today+1 minimum per FR-010, past rejected), per-row validity (start<end, day_of_week 0..6, end_time > start_time), and no-overlap of multiple periods on the same `(branch_id, day_of_week)`.

**Boundaries & Constraints**

**Always:**
- `GET /admin/doctors/:id/schedule` returns `200 {doctor_id, schedule: [{branch_id, day_of_week, start_time, end_time, effective_from, effective_to}, ...]}`. Returns `404 doctor_not_found` for unknown id; `400 invalid_doctor_id` for malformed UUID.
- `POST /admin/doctors/:id/schedule-impact` accepts `{rows: [{branch_id, day_of_week, start_time, end_time, effective_from, effective_to}, ...]}`. Returns `200 {future_appointment_count: N, affected_appointments: [{id, patient_phone_masked, doctor_id, branch_id, start_datetime, end_datetime, status}, ...]}` where patient_phone is masked to `+1XXXXXXXXXX` form (last 8 digits hidden). Returns `400 invalid_doctor_id` / `404 doctor_not_found` / `400 invalid_schedule_row` / `400 branch_not_in_doctor_branches`. NO DB write — this is preview-only.
- `POST /admin/doctors/:id/schedule` (full-set replace) and `PATCH /admin/doctors/:id/schedule` (incremental) — but for E2-S1 we ship ONLY the full-set replace (`POST`) + impact + GET. The `PATCH` route is **out of scope** and deferred to a follow-up story (see D1 in SC).
- `POST /admin/doctors/:id/schedule` accepts the same body shape as the impact route. Behavior: delete every existing `doctor_schedule` row for that doctor, insert the proposed rows inside a transaction, return `201 {inserted_count: N, schedule: [...]}`. Returns `400 invalid_schedule_row` for malformed row, `400 branch_not_in_doctor_branches` when at least one row's branch_id is not in the doctor's branch set (per `doctor_branch`), `404 doctor_not_found`, `409 schedule_invalidates_future_appointments` when ≥1 future Scheduled appointment falls outside the new schedule (F-06 + FR-011 + BR-009).
- Validation runs BEFORE any DB write. `effective_from` must be today + 1 day minimum (FR-010, past rejected). Past effective_from dates return `400 {error: 'effective_from_in_past', fields: [...]}`.
- Each row's `day_of_week` is 0..6, `start_time < end_time`, `effective_to` is null or ≥ `effective_from`, and within a `(branch_id, day_of_week)` group no two rows overlap. Overlap returns `400 {error: 'schedule_rows_overlap', fields: [...]}`.
- The route uses `pool.connect()` + `BEGIN/SELECT FOR UPDATE/COMMIT/ROLLBACK` for both POST and impact-prev-prep (the latter doesn't write but holds the FOR UPDATE so a concurrent schedule change can't interleave between impact and commit).
- Authorization: `adminScope` middleware (E1-S0b) gates /admin/*. The doctor-id path param must reference a row in the `doctor` table; otherwise 404.
- The mask format `+1XXXXXXXXXX` is a deterministic privacy floor — it preserves country code (+1) and area-code indicator (3 hidden digits = 1 of 10 prefixes) while hiding the local-exchange-and-subscriber portion (8 digits hidden). Matches the admin-impact-preview privacy invariant from E1-S2 (counts-only, no PII).

**Ask First:**
- (none — all scope decisions resolved at plan-time via epic-1-context.md + epics-and-stories.md E2-S1. The follow-up `PATCH` route is a separate decision deferred to its own story per D1.)

**Never:**
- No DELETE route. Schedule change is full-set replace (E2-S2 covers block-time DELETE-style operations on a different table).
- No audit row written (E7-S2 lands audit later; E1-S2/E1-S3/E1-S4 set the no-audit precedent for admin operations on clinic-structure entities).
- No branch-hours edits, no doctor edits, no receptionist edits (E1-S2/E1-S3/E1-S4 respectively).
- No multi-doctor schedule editing — each doctor's schedule is independent.
- No "apply immediately" / effective_from=today path. FR-010 requires tomorrow minimum.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `GET /admin/doctors/:id/schedule` happy | admin JWT + valid doctor id with 2 schedule rows | `200 {doctor_id, schedule: [{branch_id, day_of_week, start_time, end_time, effective_from, effective_to}, ...]}` | N/A |
| `GET .../schedule` empty doctor | admin JWT + valid doctor id with 0 schedule rows | `200 {doctor_id, schedule: []}` | N/A |
| `GET .../schedule` unknown doctor | random UUID | `404 {error: 'doctor_not_found'}` | Route |
| `GET .../schedule` non-UUID id | `not-a-uuid` | `400 {error: 'invalid_doctor_id'}` | Route |
| `GET .../schedule` no auth | unauthenticated | `401 {error: 'unauthenticated'}` | auth middleware |
| `GET .../schedule` patient JWT | patient role | `403 {error: 'forbidden_role'}` | adminScope |
| `POST .../schedule-impact` clean | admin JWT + proposed schedule that does NOT invalidate any future appt | `200 {future_appointment_count: 0, affected_appointments: []}` | N/A |
| `POST .../schedule-impact` with affected | admin JWT + proposed schedule that invalidates ≥1 future Scheduled appt | `200 {future_appointment_count: N, affected_appointments: [{id, patient_phone_masked: '+1XXXXXXXXXX', doctor_id, branch_id, start_datetime, end_datetime, status}]}` | N/A (preview-only) |
| `POST .../schedule-impact` no auth | unauthenticated | `401` | auth |
| `POST .../schedule-impact` invalid row | `{rows: [{day_of_week: 7, ...}]}` | `400 {error: 'invalid_schedule_row', fields: [...]}` | validate first |
| `POST .../schedule-impact` branch not in doctor | proposed row with branch_id not in `doctor_branch` for this doctor | `400 {error: 'branch_not_in_doctor_branches', fields: [...]}` | validate first |
| `POST .../schedule` clean | admin JWT + valid rows + no future appt impact | `201 {inserted_count: N, schedule: [...]}` | N/A |
| `POST .../schedule` with future appt impact | admin JWT + valid rows + ≥1 future Scheduled appt invalidated | `409 {error: 'schedule_invalidates_future_appointments', future_appointment_count: N, affected_appointments: [...]}` | transaction rolls back |
| `POST .../schedule` past effective_from | `{rows: [{effective_from: '2020-01-01', ...}]}` | `400 {error: 'effective_from_in_past', fields: [...]}` | validate first |
| `POST .../schedule` overlapping rows | two rows for same (branch_id, day_of_week) with overlapping time windows | `400 {error: 'schedule_rows_overlap', fields: [...]}` | validate first |
| `POST .../schedule` empty rows | `{rows: []}` | `201 {inserted_count: 0, schedule: []}` (vacuous replace) | N/A |
| `POST .../schedule` no auth | unauthenticated | `401` | auth |
| `POST .../schedule` patient JWT | patient role | `403` | adminScope |
| `POST .../schedule` unknown doctor | random UUID | `404 {error: 'doctor_not_found'}` | Route |

</frozen-after-approval>

## Code Map

- `apps/api/src/routes/admin-doctor-schedule-helpers.ts` (NEW) — pure validators: `isValidDayOfWeek`, `isValidTimeString`, `isValidDateString`, `isOverlapping`, `validateScheduleRow`, `validateScheduleRows`, `maskPhone`, `parseEffectiveFrom`. Tagged unions per row + per-request.
- `apps/api/src/routes/admin-doctor-schedule.ts` (NEW) — 3 routes:
  - `GET /admin/doctors/:id/schedule` — UUID validate → SELECT doctor → if doctor not found 404 → SELECT schedule rows → 200 with masked response.
  - `POST /admin/doctors/:id/schedule-impact` — UUID validate → validate rows → SELECT doctor → if doctor not found 404 → verify every branch_id is in doctor_branch → SELECT future Scheduled appointments for this doctor that fall OUTSIDE the union of proposed periods (the "affected" set) → 200 with masked patient_phone.
  - `POST /admin/doctors/:id/schedule` — UUID validate → validate rows → SELECT doctor FOR UPDATE → if doctor not found 404 → verify branches → run impact check inside the transaction → if future_appointment_count > 0 ROLLBACK + 409 → DELETE existing schedule rows for this doctor → INSERT new rows → 201.
- `apps/api/src/app.ts` (MODIFIED) — chain `adminDoctorScheduleRouter` into the existing `app.use('/admin', adminScope, ...)` mount.
- `apps/api/test/admin-doctor-schedule.test.ts` (NEW) — full I/O matrix (~20 tests).
- No new migration. The `doctor_schedule` table from 0006 already has every column this story needs; `effective_to` is already nullable; the multi-period-day rule is already encoded via the absence of a UNIQUE constraint on `(doctor_id, branch_id, day_of_week)`.

**DB schema ground truth (no migration needed):**
- `doctor_schedule(id uuid PK, doctor_id uuid NOT NULL FK doctor ON DELETE RESTRICT, branch_id uuid NOT NULL FK branch ON DELETE RESTRICT, day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), start_time time NOT NULL, end_time time NOT NULL CHECK (end_time > start_time), effective_from date NOT NULL, effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from), created_by text NOT NULL CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]{1,255}$'), created_at timestamptz NOT NULL DEFAULT app_now(), updated_at timestamptz NOT NULL DEFAULT app_now())`

**Impact query (preview + inside the commit transaction):**

```sql
-- Find Scheduled appointments for this doctor that the proposed schedule would
-- invalidate. "Invalidate" = appointment's start_datetime falls outside ANY
-- proposed period for the appointment's (branch_id, day_of_week) AND is in
-- the future. Implementation: walk appointments, compute day_of_week +
-- time-of-day in the appointment's branch.tz (TZ-conversion is deferred to
-- E3-S1 availability engine; for E2-S1, we use UTC as the working plane and
-- document the TZ resolution as a follow-up — see D2 in SC).
SELECT a.id, a.patient_phone, a.doctor_id, a.branch_id,
       a.start_datetime, a.end_datetime, a.status
  FROM appointment a
 WHERE a.doctor_id = $1
   AND a.start_datetime > now()
   AND a.status = 'Scheduled'
   -- exclude any appointment that falls within any proposed period:
   AND NOT EXISTS (
     SELECT 1 FROM unnest($2::uuid[]) AS proposed_branches(proposed_branch_id)
       JOIN unnest($3::day_of_week[]) AS proposed_days(proposed_day)
         ON proposed_branches.proposed_branch_id = a.branch_id
        AND proposed_days.proposed_day = EXTRACT(DOW FROM a.start_datetime AT TIME ZONE 'UTC')::int
       WHERE a.start_datetime::time >= proposed_start
       AND a.end_datetime::time <= proposed_end
   );
```

The exact impact query is pinned in the route; this is the spec prose.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/admin-doctor-schedule-helpers.ts` — pure validators.
- [ ] `apps/api/src/routes/admin-doctor-schedule.ts` — 3 routes.
- [ ] `apps/api/src/app.ts` — chain adminDoctorScheduleRouter.
- [ ] `apps/api/test/admin-doctor-schedule.test.ts` — full I/O matrix.

**Acceptance Criteria:**
- Given a valid admin JWT + valid doctor id with 2 schedule rows, when `GET /admin/doctors/:id/schedule` is called, then response is `200 {doctor_id, schedule: [...]}`.
- Given a valid admin JWT + unknown / non-UUID doctor id, when `GET ...` is called, then 404 / 400 envelopes match the matrix.
- Given a valid admin JWT + proposed schedule that does NOT invalidate any future Scheduled appointment, when `POST .../schedule-impact` is called, then response is `200 {future_appointment_count: 0, affected_appointments: []}`.
- Given a proposed schedule that invalidates ≥1 future Scheduled appointment, when `POST .../schedule-impact` is called, then response is `200 {future_appointment_count: N, affected_appointments: [{id, patient_phone_masked: '+1XXXXXXXXXX', ...}]}`.
- Given a valid admin JWT + valid clean schedule, when `POST .../schedule` is called, then `201 {inserted_count: N, schedule: [...]}` is returned; the DB has exactly N rows for this doctor.
- Given a proposed schedule that invalidates ≥1 future Scheduled appointment, when `POST .../schedule` is called, then `409 {error: 'schedule_invalidates_future_appointments', future_appointment_count: N, affected_appointments: [...]}` is returned; no DB write.
- Given invalid row shapes (day_of_week 7, end_time <= start_time, past effective_from, overlapping rows), when validated, then `400` envelopes with `invalid_schedule_row` / `schedule_rows_overlap` / `effective_from_in_past`.
- Given a row with branch_id not in the doctor's branch set, when validated, then `400 {error: 'branch_not_in_doctor_branches', fields: [...]}`.
- Given a proposed empty rows array, when `POST .../schedule` is called, then `201 {inserted_count: 0, schedule: []}` (a vacuous full-set replace that wipes existing rows).
- Given the new code, when the existing test suites run, then no regression.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, review-loop-1 implementation patches (post-code-review).

- **P-A1** — Removed `LIMIT 200` from the impact query so the count reflects the true total. At realistic scheduling volume the future Scheduled row count for one doctor is in the tens, not thousands, so the full-scan cost is acceptable. P0-4 from review-loop-1.
- **P-A2** — Wired `created_by` to `staff:${req.auth?.claim?.sub ?? 'admin-main'}` instead of the hardcoded `'staff:admin-main'`. The 0006 CHECK constraint requires the `staff:` prefix; `req.auth?.claim?.sub` is populated by the upstream `adminScope` middleware, so the `??` fallback is defensive only for non-middleware test paths. Added a DB-side pin in the test to lock the value. P0-5 from review-loop-1.
- **P-A3** — Strengthened the in-code comment on `SELECT_AFFECTED_APPOINTMENTS_SQL` to frame the TZ-resolution deferral correctly: the count over-reports for non-UTC branches because UTC day-of-week ≠ branch-local day-of-week. E3-S1 will join `branch.tz` and compute day-of-week + time-of-day in the branch's local TZ. The admin UI lists the affected appointments with branch_id + start_datetime so an attentive admin can spot false positives.
- **D2 — TZ resolution deferred to E3-S1** — The impact query uses UTC as the working plane (the spec's pinned query at lines 86-110 uses `AT TIME ZONE 'UTC'`). For any branch where `branch.tz` ≠ UTC, the count over-reports affected appointments. E3-S1 (availability engine) is the right home for the branch.tz-aware replacement because the booking flow needs the same TZ-aware day-of-week semantics. P0-1 / P0-2 from review-loop-1, both closed via this deferral rather than a code change.
- **D3 — Spec coverage gap on impact route** — Spec line 27 enumerates `400 invalid_doctor_id / 404 doctor_not_found / 400 invalid_schedule_row / 400 branch_not_in_doctor_branches` for the impact route. Missing: `400 schedule_rows_overlap`. The code returns it (test at line 306 pins it). Spec touch-up only; no code change.
- **Deferral D1 — PATCH route** — Out of scope for E2-S1 (the spec's "Always" §31 explicitly defers the PATCH route to a follow-up). This story ships only GET / POST-impact / POST-replace.
- **Review-loop iteration: 1** (1 reviewer with detailed report; ship-recommended after P0-1/P0-2 closed via D2, P0-4 fixed, P0-5 fixed).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/admin-doctor-schedule.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After `POST /admin/doctors/<east_lead>/schedule {rows: [{branch_id: <east>, day_of_week: 1, start_time: '09:00:00', end_time: '17:00:00', effective_from: tomorrow, effective_to: null}]}`, query the DB: `SELECT count(*) FROM doctor_schedule WHERE doctor_id = <east_lead>` — confirm count = 1.
- After `POST /admin/doctors/<east_lead>/schedule-impact {rows: [...]}` with empty doctor branch, confirm `future_appointment_count: 0` and `affected_appointments: []`.