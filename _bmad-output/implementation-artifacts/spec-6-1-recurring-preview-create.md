---
title: 'E6-S1 — Recurring appointment preview + partial-success create'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-5-4-no-deletion.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A doctor or receptionist (NOT a patient — FR-045)
previews a recurring series (F-11, BR-047…053, FR-044…050). The
recurrence is Weekly / Every 2 weeks / Custom interval (in days).
Occurrences are capped by the 30-day window (FR-018). Each
occurrence is validated independently — the response separates
`will_create` from `skipped_with_reason`. On confirm, valid
occurrences are created atomically as `Scheduled`; one audit row
per created occurrence. Each created occurrence is an independent
appointment thereafter (BR-052, FR-049 — cancellable /
reschedulable individually).

**Approach:** Add ONE new migration + TWO new routes:

1. **`0018_recurring_series.sql` (NEW)** — adds
   `recurring_series_id` (uuid, nullable) to `appointment`. The
   column groups occurrences of a series for reporting and
   reconstruction. NULL on non-recurring appointments. Optional
   index for read paths.
2. **`POST /recurring/preview` (NEW)** — validates the series
   shape and every occurrence. The handler:
   - Body shape: `{doctor_id, branch_id, appointment_type_id,
     patient_phone, patient_first_name,
     recurrence_kind: 'weekly'|'every_two_weeks'|'custom_days',
     recurrence_interval_days, start_date, time_of_day,
     duration_minutes, occurrences_or_until_date}`.
     `recurrence_kind='weekly'` is sugar for
     `recurrence_interval_days=7`; `recurrence_kind='every_two_weeks'`
     is sugar for `recurrence_interval_days=14`;
     `recurrence_kind='custom_days'` requires
     `recurrence_interval_days >= 1`. Occurrence count is
     derived from `occurrences_or_until_date` AND the 30-day
     window (FR-018): at most the first N occurrences that fit
     inside `[today+1, today+30]` in the branch's local time.
   - Auth: `claim.role ∈ {doctor, receptionist}`. Patient →
     403 `forbidden_role`. Admin → 403 `forbidden_role`.
   - Doctor scope: doubly-bound (appt.doctor_id = claim.doctor_id
     AND appt.branch_id ∈ claim.branch_ids).
   - Receptionist scope: branch-only (appt.branch_id ∈
     claim.branch_ids).
   - For each occurrence: run the per-occurrence validation
     pipeline (the same checks E3-S1's availability engine runs
     on a single slot, extended with FR-027 same-doctor future
     and FR-029 patient time overlap). Each occurrence either
     `will_create` or `skipped_with_reason`. Reasons
     (FR-048): `outside_branch_hours`,
     `doctor_unavailable`, `doctor_blocked`,
     `doctor_inactive`, `branch_inactive`,
     `appointment_type_inactive`, `slot_raced` (parallel
     bookings), `patient_has_future_with_doctor` (FR-027),
     `patient_time_conflict` (FR-029), `outside_30d_window`
     (FR-018), `same_day_exclusion` (FR-019).
   - The preview does NOT mutate state. It is read-only.
3. **`POST /recurring/confirm` (NEW)** — atomic batch insert.
   The handler:
   - Body shape: `{preview_id}` (the preview's stable handle).
     On confirm: per-occurrence re-validation inside the txn
     (BR-049, FR-050 — race-safety net), then INSERT all valid
     occurrences in one batch (single INSERT…SELECT or
     per-row INSERT in one transaction), then one audit row per
     created occurrence.
   - On any race (a slot that was free at preview became taken
     between preview and confirm), the row is skipped; the
     partial-success semantics from preview hold (FR-047).
   - Atomicity: BEGIN; SELECT FOR UPDATE on all relevant rows
     (existing appointments that could conflict); INSERT new
     occurrences; INSERT audit rows; COMMIT. On any failure
     the entire batch rolls back (BR-052 — "all or nothing" for
     the per-occurrence row insert; the per-occurrence
     validation may skip rows, but the batch is atomic).
   - Returns 201 with `{created: [{...}], skipped: [{date,
     reason}]}`.

**Boundaries & Constraints**

**Always:**
- Per-occurrence validation is INDEPENDENT (BR-052, FR-049).
  Sibling occurrences are NOT coupled — cancelling one does not
  cancel others; rescheduling one does not affect siblings.
- The 30-day window (FR-018) caps the occurrence count.
  `today+0` (same-day) is excluded by FR-019 — occurrences on
  the same calendar day as `start_date` (in branch tz) are
  skipped with `same_day_exclusion`.
- The doctor / branch / type / patient / phone fields are
  validated once for the entire series (same shape for every
  occurrence). Per-occurrence validation only re-checks
  time-window-dependent rules (branch hours, doctor schedule,
  blocks, existing overlaps, FR-027, FR-029, FR-018, FR-019).
- Recurrence is NOT coupled to a calendar date — the same
  weekly pattern can start on any future date. The seed branch
  weekly hours cover Mon-Sat 09:00–17:00 (per the E0-S5 seed),
  so a weekly Monday-start works out-of-the-box.
- The audit row per created occurrence carries
  `payload = {series_id, recurrence_kind, recurrence_interval_days,
  occurrence_index}` (1-based). The series_id is the new
  `recurring_series_id` column value.
- Auth: claim.role ∈ {doctor, receptionist}. Patient / admin
  → 403 `forbidden_role`. Anonymous → 401.
- Patient phone is REQUIRED in the body. The receptionist / doctor
  books on behalf of a patient (F-13 / F-15). The phone is
  matched against the `patient` table; an unknown phone returns
  400 `patient_not_found` — the receptionist can use the
  patient-profile route (E3-S3) to confirm the row first.
- The series `id` (a UUID) is generated server-side per
  confirm. All occurrences of a single confirm share the same
  `recurring_series_id`. The series_id is stable across reads
  (it's a column on `appointment`, not an in-memory pointer).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E6-S1 + PRD F-11 + BR-047…053 + FR-044…050.)

**Never:**
- No patient-initiated recurring booking (FR-045). Only doctor /
  receptionist.
- No recurrence for past occurrences (FR-018, FR-019).
- No recurrence that crosses the 30-day window — occurrences
  that would land beyond `today+30` are SKIPPED, not created.
- No PATCH / DELETE on a series. Each occurrence is independent
  (BR-052, FR-049). Per-occurrence ops are E4-S2 (cancel) /
  E4-S3 (reschedule) / E6-S4 (recurring cancel/reschedule
  with `recurring_origin`).
- No "tentative holds" between preview and confirm (E7-S7). The
  preview is a snapshot; the confirm is the atomic write.
- No patient-name field that isn't validated. The body accepts
  `patient_phone` (E.164 required, validated) and an OPTIONAL
  `patient_first_name` (free text, NOT validated against the
  patient row). The patient row's `full_name` is the source
  of truth; `patient_first_name` is for the receptionist's
  own note.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Doctor previews weekly × 4 | doctor | `{doctor_id: own, branch_id: own, type, patient, recurrence: 'weekly', start: tomorrow, time: '09:00', count: 4}` | `200 {will_create: [4], skipped: []}` | happy path |
| 8 weekly + 1 conflict | doctor | `{recurrence: 'weekly', count: 8}` with one occurrence already taken | `200 {will_create: [7], skipped: [{date, reason}]}` | Scenario 10 |
| 9th occurrence same-day | doctor | `{recurrence: 'weekly', start: today, count: 9}` | `200 {will_create: [≤8], skipped: [{date: today, reason: 'same_day_exclusion'}]}` | FR-019 |
| Recurrence crossing 30d | doctor | `{recurrence: 'daily', count: 60}` | `200 {will_create: [≤30], skipped: [...]}` | FR-018 |
| Receptionist previews | receptionist | body | `200` | BR-004 |
| Patient JWT | patient | any | `403 forbidden_role` | FR-045 |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Invalid body shape | doctor | body missing required fields | `400 unknown_field` / `invalid_*` | validation |
| Branch / doctor mismatch | doctor | body `branch_id` not at claim.doctor_id | `400 doctor_not_at_branch` | E3-S2 pattern |
| Doctor inactive | doctor | body `doctor_id` = inactive | `400 doctor_inactive` | E3-S2 pattern |
| Branch inactive | doctor | body `branch_id` = inactive | `400 branch_inactive` | E3-S2 pattern |
| Type inactive | doctor | body `appointment_type_id` = inactive | `400 appointment_type_inactive` | E3-S2 pattern |
| Patient phone not on file | doctor | body `patient_phone` = unknown | `400 patient_not_found` | receptionist-side check |
| Invalid phone format | doctor | body `patient_phone` not E.164 | `400 invalid_patient_phone` | validation |
| `recurrence_kind='custom_days'` with interval=0 | doctor | body | `400 invalid_recurrence_interval` | FR-047 |
| `recurrence_kind='weekly'` with bad time format | doctor | `time_of_day='bad'` | `400 invalid_time_of_day` | validation |
| `duration_minutes` mismatch with type | doctor | body | `400 duration_mismatch` | E3-S2 pattern |
| Confirm with valid `preview_id` | doctor | `{preview_id}` | `201 {created: [...], skipped: [...]}` | FR-047 partial success |
| Confirm with stale `preview_id` | doctor | `{preview_id}` (after a conflicting booking) | `201` with one or more skipped | FR-050 race-safety |
| Confirm with unknown `preview_id` | doctor | `{preview_id: <random uuid>}` | `404 preview_not_found` | preview is server-stateful |
| Confirm: all valid | doctor | `{preview_id}` | `201 {created: [N], skipped: []}` | happy |
| Confirm: atomic — audit rows match | doctor | `{preview_id}` | one audit row per `created` occurrence | FR-050 + audit |
| Audit row inspection | — | — | `actor_role='doctor'|'receptionist'`, `event='recurring_created'`, `payload={series_id, recurrence_kind, ...}` | F-11 |
| Cancelling one occurrence leaves siblings untouched | — | cancel one occurrence | other occurrences remain Scheduled | FR-049 |
| Rescheduling one occurrence leaves siblings untouched | — | reschedule one occurrence | other occurrences remain Scheduled | FR-049 |

## Code Map

- `apps/api/db/migrations/0018_recurring_series.sql` (NEW) —
  adds `recurring_series_id` (uuid, nullable) to `appointment`;
  adds index `idx_appointment_recurring_series_id` for read
  paths.
- `apps/api/src/routes/recurring-preview.ts` (NEW) — POST
  /recurring/preview handler.
- `apps/api/src/routes/recurring-confirm.ts` (NEW) — POST
  /recurring/confirm handler.
- `apps/api/src/app.ts` (MODIFIED) — mount both routers after
  authMiddleware (NOT under `/admin/*`).
- `apps/api/test/recurring-preview.test.ts` (NEW) — preview
  integration tests.
- `apps/api/test/recurring-confirm.test.ts` (NEW) — confirm
  integration tests.

**Migration: `0018_recurring_series.sql`**

```sql
-- E6-S1 — recurring_series_id grouping column.
-- NULL on non-recurring appointments. All occurrences of a single
-- confirm share the same recurring_series_id.
ALTER TABLE appointment
  ADD COLUMN IF NOT EXISTS recurring_series_id uuid;

CREATE INDEX IF NOT EXISTS idx_appointment_recurring_series_id
  ON appointment(recurring_series_id)
  WHERE recurring_series_id IS NOT NULL;
```

**Per-occurrence validation** mirrors the in-txn engine of E3-S1
+ E3-S2, parameterized per occurrence. The pipeline (FR-046):
1. Branch hours (and is_closed).
2. Doctor schedule (effective_from / effective_to).
3. Doctor blocks overlapping the slot.
4. Existing Scheduled appointments at (doctor, branch) overlapping.
5. FR-027 same-doctor future (excluding zero on preview because
   there are no existing occurrences yet — they will be inserted
   by confirm).
6. FR-029 patient time-overlap.
7. FR-018 30-day window.
8. FR-019 same-day exclusion (slot's calendar day == today in
   branch tz).

**Atomic confirm SQL flow:**
```sql
-- BEGIN
-- SELECT FOR UPDATE on all existing Scheduled rows at (doctor,
-- branch) that could conflict with any candidate occurrence.
-- For each candidate occurrence (in order):
--   - Re-run the per-occurrence validation inside the txn
--     (race-safety net). Skip on any failure.
--   - INSERT INTO appointment
--     (..., recurring_series_id = $series_id, ...)
--   - INSERT INTO appointment_audit (event='recurring_created',
--     payload={series_id, recurrence_kind, recurrence_interval_days,
--     occurrence_index}).
-- COMMIT (or ROLLBACK on any DB-level error).
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/db/migrations/0018_recurring_series.sql` —
  recurring_series_id column + index.
- [ ] `apps/api/src/routes/recurring-preview.ts` — POST
  /recurring/preview handler.
- [ ] `apps/api/src/routes/recurring-confirm.ts` — POST
  /recurring/confirm handler.
- [ ] `apps/api/src/app.ts` — mount both routers after
  authMiddleware.
- [ ] `apps/api/test/recurring-preview.test.ts` — preview tests.
- [ ] `apps/api/test/recurring-confirm.test.ts` — confirm tests.

**Acceptance Criteria:**
- Given a doctor JWT for `claim.doctor_id=X` and a valid body for a weekly × 4 recurrence, when POST /recurring/preview is invoked, then 200 with `{will_create: [4 dates], skipped: []}`.
- Given a doctor JWT and a body where one occurrence already conflicts (existing Scheduled appointment at the same time), when POST /recurring/preview is invoked, then 200 with the conflict in `skipped` (Scenario 10: 8 weekly + 1 conflict → 7 will_create + 1 skipped).
- Given any staff JWT and a `recurrence.start_date` equal to today's branch-local date, when POST /recurring/preview is invoked, then the same-day occurrence is in `skipped` with `reason='same_day_exclusion'` (FR-019).
- Given any staff JWT and a `recurrence` whose last occurrence would land beyond `today+30` in the branch tz, when POST /recurring/preview is invoked, then occurrences beyond the window are in `skipped` with `reason='outside_30d_window'` (FR-018).
- Given a patient / admin JWT, when POST /recurring/preview is invoked, then 403 forbidden_role.
- Given an anonymous caller, when POST /recurring/preview is invoked, then 401 unauthenticated.
- Given a doctor JWT and a valid `preview_id` from a previous preview, when POST /recurring/confirm is invoked, then 201 with `{created: [...], skipped: [...]}`. The `created` rows all carry the same `recurring_series_id`. One audit row per created occurrence with `event='recurring_created'`.
- Given a doctor JWT and a `preview_id` whose window has become stale (a different booking took one of the slots), when POST /recurring/confirm is invoked, then 201 with the affected occurrence in `skipped` (FR-047 partial success + FR-050 race-safety).
- Given a doctor JWT and a `preview_id` that doesn't exist (or expired), when POST /recurring/confirm is invoked, then 404 preview_not_found.
- Given any staff JWT and a successful confirm, the per-occurrence cancel/reschedule paths (E4-S2 / E4-S3) work on individual occurrences without affecting siblings (FR-049).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review. Patches:

- N1: Added a `recurring-helpers.ts` module that hosts the body
  validator, the per-occurrence validator, the preview-state store,
  the date helpers, and the occurrence expansion. The two routes
  (`recurring-preview`, `recurring-confirm`) import from it. This
  avoids the duplicated body-validation and per-occurrence pipeline
  that would otherwise sit in both files.
- N2: The `previewStore` is an in-process `Map<id, snapshot>`. The
  spec documents that the preview is "server-stateful" — the spec
  does not pin the storage backend. A future hardening story could
  swap in Redis (W49 — deferred).
- N3: The "Scope re-check at confirm time" branch re-validates the
  JWT's doctor_id + branch_ids against the snapshot. If the JWT
  rotated between preview and confirm, the confirm rejects with 403
  outside_branch_scope rather than blindly writing rows.
- N4: The 30-day window is enforced by the per-occurrence validator
  (NOT by the `expandOccurrences` helper). The expansion produces the
  full candidate list so the response surfaces the
  `outside_30d_window` reason for any occurrence the caller asked
  for. The expansion stops once the calendar day exceeds
  `today+30`.
- N5: Removed the unused `Router`/`RequestHandler` imports and the
  unused `_noExports` marker from `recurring-helpers.ts`. The file
  exports types + pure functions only; routes import directly.
- N6: `validateOccurrenceInTxn` returns `{ok: true, tz, patientId}`
  on success. The route layer only needs `tz` and `patientId` for
  downstream logging; both are captured here.
- N7: `INSERT_APPOINTMENT_SQL` in `recurring-confirm.ts` returns the
  full `recurring_series_id` so the response can echo it back to the
  client (matches the spec's "Returns 201 with
  `{created: [...], skipped: [...]}`" contract; `series_id` is an
  additive field).
- N8: The pre-lock `SELECT FOR UPDATE` on overlapping Scheduled rows
  is wrapped in a `BEGIN/COMMIT`. The lock holds the GIST-protected
  range until the batch commits, giving the in-txn re-validation a
  deterministic snapshot.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/recurring-preview.test.ts` — expected: all green.
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/recurring-confirm.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.