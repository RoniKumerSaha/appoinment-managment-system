---
title: 'E1-S2 — Change branch operating hours'
type: 'feature'
created: '2026-09-15'
status: 'done'
review_loop_iteration: 1
context:
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-1-1-create-edit-deactivate-branches.md'
  - '_bmad-output/implementation-artifacts/spec-1-0-admin-clinic-api.md'
  - 'docs/design/mockups/v1/mockups/08-branch-hours-impact.html'
  - 'docs/design/mockups/v1/mockups/28-admin-branch-hours-editor.html'
  - 'docs/design/mockups/v1/mockups/39-admin-branch-hours-resolution.html'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The admin can create and deactivate branches (E1-S1) but cannot edit operating hours. Hours live nowhere in the schema, and the SC1-deferred `branch.address` column has no home. When admins need to narrow weekend hours, the system cannot tell them which scheduled appointments would land outside the new window — patients discover the conflict only on arrival.

**Approach:** Ship `0015_branch_hours.sql` adding `branch.address` (deferred from E1-S1 per SC1), updating `branch.tz` default to `'Asia/Riyadh'`, and introducing `branch_weekly_hours`. Expose three admin endpoints behind the existing `adminScope` middleware — GET current hours, PATCH new hours (transactional with `SELECT ... FOR UPDATE` + impact check before commit), and GET impact preview that returns counts-only (no patient PII per BR-065). Defer audit logging to E7-S2 to match the codebase's current no-audit precedent in admin routes.

## Boundaries & Constraints

**Always:**
- Hours are stored in `branch.tz` and interpreted as wall-clock times (HH:MM); the column type is `time` without timezone.
- Each branch must always carry exactly 7 rows in `branch_weekly_hours` covering `day_of_week` 0–6 (Sun–Sat). Default on first save: closed Sun, open Mon–Sat 09:00–17:00.
- `open_time < close_time` whenever `is_closed = false`. Closed days may carry NULL times.
- PATCH is transactional (`pool.connect()` + `BEGIN/COMMIT/ROLLBACK`); the impact check runs inside the transaction against `branch_weekly_hours` AND against future Scheduled appointments.
- Impact preview returns counts-only by default; the affected-list endpoint requires `?include_affected=true` and never includes patient name, phone, or any PII.
- The "doctor-not-at-branch" edge case is real: when the proposed hours would orphan a doctor's scheduled appointments at this branch (i.e. a `doctor_branch` row exists and the doctor has future Scheduled appointments at this branch outside the new window), the PATCH response must include a `requires_doctor_acknowledgement: true` flag and the admin must POST a follow-up confirmation (`?acknowledge_doctor_impact=true`) to commit.
- Doctor-not-at-branch check joins `doctor_branch` (table exists at 0001:38-42, widened 0004:63-71) — no E1-S3 dependency.

**Ask First:**
- If the user proposes audit writes in this story, HALT. Audit infrastructure belongs to E7-S2 (cross-cutting appointment-audit). E1-S2 follows E1-S1's no-audit precedent.
- If the user proposes a `branch.default_hours_template_id` or weekly-templates table, HALT — out of scope for E1-S2.

**Never:**
- Never silently invalidate appointments on hours change — always save-and-flag (status remains `Scheduled`, a future-appointment-impact count is returned).
- Never expose patient name, phone, MRN, or any PII on the admin impact endpoint.
- Never allow the admin to bypass the impact count; the "doctor-not-at-branch" path is the only deferral.
- Never use UTC for hours; always interpret via `branch.tz` in both SQL (`start_datetime AT TIME ZONE branch.tz`) and in route-level validation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| GET hours · happy | valid admin JWT + branch id | `200 {branch_id, tz, address, hours:[7 rows]}` | — |
| GET hours · unknown branch | valid JWT + random uuid | `404 {error:'branch_not_found'}` | — |
| GET hours · bad uuid | valid JWT + non-uuid id | `400 {error:'invalid_branch_id'}` | validate UUID before DB |
| GET hours · patient JWT | patient bearer | `403 {error:'forbidden_role'}` | adminScope middleware |
| GET hours · no auth | no header | `401 {error:'unauthenticated'}` | adminScope middleware |
| PATCH hours · happy | valid JWT + valid hours array | `200 {branch, hours:[7 rows], impact:{count_affected:0, requires_doctor_acknowledgement:false}}` | — |
| PATCH hours · closed days with NULL times | valid body with `is_closed=true` + NULL `open_time`/`close_time` | `200` (accepted) | — |
| PATCH hours · open day with NULL times | `is_closed=false` + NULL `open_time` | `400 {error:'invalid_time_range'}` | validate before BEGIN |
| PATCH hours · open_time >= close_time | `open_time=17:00, close_time=09:00, is_closed=false` | `400 {error:'invalid_time_range'}` | validate before BEGIN |
| PATCH hours · not 7 rows | hours array length 6 or 8 | `400 {error:'invalid_hours_length'}` | — |
| PATCH hours · missing day | hours array covers 0..5 not 6 | `400 {error:'invalid_day_of_week'}` | — |
| PATCH hours · bad day_of_week | `day_of_week: 7` or `-1` | `400 {error:'invalid_day_of_week'}` | — |
| PATCH hours · invalid tz | `tz: 'Mars/Olympus_Mons'` | `400 {error:'invalid_timezone'}` | validate against `Intl.supportedValuesOf('timeZone')` or a curated list |
| PATCH hours · impact_count > 0 (no doctors affected) | valid body + 3 future appts outside new window, no doctors at branch | `409 {error:'appointments_outside_hours', impact:{count_affected:3, requires_doctor_acknowledgement:false}}` | impact runs inside tx; rollback |
| PATCH hours · doctor-not-at-branch | valid body + future appts owned by a doctor at this branch outside the new window | `409 {error:'appointments_outside_hours', impact:{count_affected:N, requires_doctor_acknowledgement:true, affected_doctors:[{doctor_id, doctor_name, count}]}}` | rollback; admin re-PATCH with `?acknowledge_doctor_impact=true` |
| PATCH hours · doctor acknowledged | re-PATCH with `?acknowledge_doctor_impact=true` + same body | `200` + hours saved + audit deferral note | — |
| GET impact · happy | valid JWT + valid proposed body | `200 {count_affected, requires_doctor_acknowledgement, affected_doctors:[...]}` (counts only by default) | — |
| GET impact · `?include_affected=true` | same | `200 {count_affected, affected:[{appointment_id, start_datetime, end_datetime, doctor_id, appointment_type_id, reason}]}` | no PII |
| GET impact · unknown branch | random uuid | `404 {error:'branch_not_found'}` | — |
| Unknown PATCH fields | `{address:..., hours:..., surprise:true}` | `400 {error:'unknown_field', fields:['surprise']}` | match E1-S1's `unknown_field` envelope |

</frozen-after-approval>

## Code Map

- `apps/api/db/migrations/0015_branch_hours.sql` (NEW) — add `branch.address text` (nullable, no backfill), `ALTER COLUMN branch.tz SET DEFAULT 'Asia/Riyadh'`, new table `branch_weekly_hours (id uuid PK default gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branch(id) ON DELETE CASCADE, day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), open_time time, close_time time, is_closed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT app_now(), updated_at timestamptz NOT NULL DEFAULT app_now(), UNIQUE(branch_id, day_of_week))` with trigger `trg_branch_weekly_hours_set_updated_at` mirroring `trg_branch_set_updated_at` from `0004_widen_seed_entities.sql:31-38`.
- `apps/api/src/routes/admin-branch-hours.ts` (NEW) — `export const adminBranchHoursRouter: Router = Router();` mirroring the shape at `admin-branches.ts:137`. Three routes: GET `/branches/:id/hours`, GET `/branches/:id/hours-impact` (read-only impact preview with proposed body via query or POST), PATCH `/branches/:id/hours` (transactional). Error envelope: `{error: 'code'}` (E1-S1 shape at `admin-branches.ts:139, 224, 244, 372`) with optional `fields` array for `unknown_field` (`admin-branches.ts:277`).
- `apps/api/src/app.ts` (MODIFIED) — import `adminBranchHoursRouter` from `./routes/admin-branch-hours.js` at line 31; change line 83 from `app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter)` to `app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter, adminBranchHoursRouter)`.
- `apps/api/src/routes/admin-branch-hours-helpers.ts` (NEW) — pure validation helpers: `isValidDayOfWeek`, `isValidTime`, `isValidTimeRange(day)`, `isValidHoursArray(arr)`, `isValidTimezone(tz)` (uses `Intl.DateTimeFormat` with the proposed tz and catches `RangeError` to detect invalid IANA names). Validation runs before the transaction in PATCH.
- `apps/api/src/routes/admin-branch-hours-impact.ts` (NEW) — extracts the impact-preview SQL into a pure async function so GET and PATCH share the same logic. SQL: `SELECT a.id, a.start_datetime, a.end_datetime, a.doctor_id, at.id AS appointment_type_id, CASE WHEN EXTRACT(dow FROM a.start_datetime AT TIME ZONE b.tz) NOT IN ($open_days) THEN 'closed_day' WHEN (a.start_datetime AT TIME ZONE b.tz)::time < $open OR (a.start_datetime AT TIME ZONE b.tz)::time >= $close THEN 'before_open_or_after_close' END AS reason FROM appointment a JOIN branch b ON b.id = a.branch_id JOIN appointment_type at ON at.id = a.appointment_type_id WHERE a.branch_id = $1 AND a.start_datetime > now() AND a.status = 'Scheduled' AND <outside-window-predicate>`. Doctor impact: `SELECT doctor_id, doctor.full_name, COUNT(*) AS count FROM appointment a JOIN doctor ON doctor.id = a.doctor_id WHERE a.branch_id = $1 AND a.start_datetime > now() AND a.status = 'Scheduled' AND <outside-window-predicate> GROUP BY doctor_id, doctor.full_name`.
- `apps/api/db/seeds/01_minimum.ts` (MODIFIED) — backfill branch_weekly_hours on the seeded branches (East, West) with closed Sun + Mon–Sat 09:00–17:00 so E1-S2 tests have a known starting state. Wrap in a single new INSERT-ON-CONFLICT batch.
- `apps/api/test/admin-branch-hours.test.ts` (NEW) — full I/O matrix covering the table above. Imports match `admin-branches.test.ts:31-39`. `before/after` hooks mirror `admin-branches.test.ts:44-73` with the same scoped cleanup pattern.
- `apps/api/test/migrations.test.ts` (MODIFIED) — add 3 tests: (1) `0015 adds branch.address` — column exists, nullable, defaults NULL; (2) `0015 updates branch.tz default to Asia/Riyadh` — `pg_get_expr(adbin, adrelid)` returns `'Asia/Riyadh'::text`; (3) `0015 creates branch_weekly_hours` — table exists with all expected columns and the CHECK constraint.
- `apps/api/test/seed.test.ts` (MODIFIED) — add 1 test: `01_minimum.ts backfills 2 branches × 7 days = 14 rows in branch_weekly_hours; idempotent on re-seed (ON CONFLICT DO NOTHING)`.

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/db/migrations/0015_branch_hours.sql` -- add `branch.address text NULL`, `ALTER COLUMN branch.tz SET DEFAULT 'Asia/Riyadh'`, create `branch_weekly_hours` table with CHECK constraint, UNIQUE(branch_id, day_of_week), trigger mirroring `trg_branch_set_updated_at`; idempotent via `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS`.
- [x] `apps/api/db/seeds/01_minimum.ts` -- backfill `branch_weekly_hours` for East + West branches on seed run; ON CONFLICT DO NOTHING.
- [x] `apps/api/src/routes/admin-branch-hours-helpers.ts` -- validation helpers (no DB): `isValidDayOfWeek`, `isValidTime`, `isValidTimeRange`, `isValidHoursArray` (length 7, days 0..6 unique, open_time < close_time when !is_closed), `isValidTimezone` (Intl.DateTimeFormat round-trip).
- [x] `apps/api/src/routes/admin-branch-hours-impact.ts` -- pure async `computeBranchHoursImpact(client, branchId, proposedHours, branchTz)`: returns `{count_affected: number, affected: [...]?, affected_doctors: [{doctor_id, doctor_name, count}], requires_doctor_acknowledgement: boolean}`. Reuses transaction client if provided.
- [x] `apps/api/src/routes/admin-branch-hours.ts` -- `adminBranchHoursRouter` with GET `/branches/:id/hours`, POST `/branches/:id/hours-impact` (preview; the spec said GET but POST keeps the body clean and matches the spec's prose — see SC1), PATCH `/branches/:id/hours` (transactional with `BEGIN/SELECT FOR UPDATE/INSERT-ON-CONFLICT/UPDATE branch/impact-check/decision/COMMIT|ROLLBACK`).
- [x] `apps/api/src/app.ts` -- import `adminBranchHoursRouter`; chain it into the `app.use('/admin', ...)` line.
- [x] `apps/api/test/admin-branch-hours.test.ts` -- full I/O matrix (happy GET, 404 GET, 400 invalid uuid GET, 401 GET, 403 GET; happy PATCH, 400 invalid_hours_length, 400 invalid_day_of_week, 400 invalid_time_range, 400 invalid_timezone, 400 unknown_field, 409 appointments_outside_hours no-doctors, 409 appointments_outside_hours doctors-not-at-branch, happy PATCH with `?acknowledge_doctor_impact=true`; happy impact POST, impact with `?include_affected=true`, impact 404).
- [x] `apps/api/test/migrations.test.ts` -- add 3 tests as described in Code Map.
- [x] `apps/api/test/seed.test.ts` -- add 1 test as described in Code Map.

**Acceptance Criteria:**
- Given a valid admin JWT, when `GET /admin/branches/:id/hours` is called on a seeded branch, then response is `200` with `branch_id, tz='America/New_York' (existing seed), address=null, hours[7]` (Sun closed, Mon-Sat 09:00–17:00 per backfill).
- Given a valid admin JWT, when `PATCH /admin/branches/:id/hours` is called with valid body `{hours: [{day_of_week:0,is_closed:true},{day_of_week:1,open_time:'08:00',close_time:'16:00',is_closed:false},...]}` covering 7 days, then response is `200`, `branch_weekly_hours` rows are upserted, `branch.updated_at` advances, and `impact.count_affected=0` for branches with no future Scheduled appointments outside the new window.
- Given `PATCH` with `hours` array length 6, when validated, then response is `400 {error:'invalid_hours_length'}` and no DB write occurs.
- Given `PATCH` with `day_of_week: 7`, when validated, then response is `400 {error:'invalid_day_of_week'}` and no DB write occurs.
- Given `PATCH` with `open_time='17:00', close_time='09:00', is_closed=false` on day 1, when validated, then response is `400 {error:'invalid_time_range'}` and no DB write occurs.
- Given `PATCH` with `tz: 'Mars/Olympus_Mons'`, when validated, then response is `400 {error:'invalid_timezone'}` and no DB write occurs.
- Given `PATCH` where 3 future Scheduled appointments fall outside the new window, no doctors are assigned at this branch (`doctor_branch` returns 0 rows for any doctor with these appointments), when the impact check runs inside the transaction, then response is `409 {error:'appointments_outside_hours', impact:{count_affected:3, requires_doctor_acknowledgement:false}}` and `branch_weekly_hours` is rolled back.
- Given `PATCH` where 2 future Scheduled appointments fall outside the new window AND belong to a doctor assigned at this branch (via `doctor_branch`), when the impact check runs, then response is `409` with `requires_doctor_acknowledgement: true, affected_doctors: [{doctor_id, doctor_name, count:2}]` and rolled back.
- Given the same 409 from the previous AC, when admin re-PATCHes with `?acknowledge_doctor_impact=true` and the same body, then response is `200`, hours are saved, `branch.updated_at` advances, and the appointments remain `Scheduled` (saved-and-flagged, not silently invalidated).
- Given the new code, when the existing test suite runs, then no regression — pre-existing baseline (auth-bearer, log, sms-otp bytea, etc.) failures unchanged from `deferred-work.md`; new branch-hours tests all green; no migration re-run error.

## Spec Change Log

**SC1 — 2026-10-04, plan-step (no loopback). Decision recorded before spec approval.**
- **Trigger:** The spec prose mentioned "GET impact" with a query-encoded body for `?include_affected=true`. A GET with a body is awkward (URL-encoded arrays) and the spec's Code Map notes "the impact endpoint accepts POST to keep the body clean".
- **Amendment:** Implemented `POST /admin/branches/:id/hours-impact` instead of GET. The `include_affected` flag is read from `?include_affected=true` query OR `body.include_affected=true`. The I/O matrix's GET-only rows are replaced by POST rows.
- **Avoided known-bad state:** A GET-with-body would either require URL-encoding the hours array (the spec's own concern) or produce a malformed-request error on strict clients. POST keeps the body as standard JSON.

**SC2 — 2026-10-04, review-loop-1 (4 patches applied, 4 deferrals, no spec changes).**
- **Trigger:** Step-04 review (3 reviewers — verification-gap, blind-hunter, edge-case-hunter) returned ~25 findings collectively. After triage: 0 intent_gap, 0 bad_spec, 4 patch, 4 defer, remainder rejected as noise.
- **Patches:**
  - **P-A — Tx path `branch_weekly_hours h` lacked `branch_id = $1` filter (P1, blind-hunter #3):** Without the filter, the `WHERE h.day_of_week = EXTRACT(dow FROM ...)` predicate could match a row from a different branch (e.g. another branch's Sun-closed row when computing today's local-dow for THIS branch). Fix: introduce `hBranchFilter` that's only appended for the table-source path; the VALUES-source (readOnly preview) doesn't need it because the literal has no branch_id. The helper exposes `lookupHours(col)` that wraps the per-row subquery and injects `hBranchFilter` once.
  - **P-B — `invalid_time_range` collapsed into `invalid_day_of_week` (P1, verification-gap #1, #4):** Spec AC line 102 mandates a distinct `400 {error: 'invalid_time_range'}` envelope for `open_time >= close_time`. The boolean-returning `isValidHoursArray` could not disambiguate. Fix: introduce `validateHoursArray(arr)` returning a tagged union `{ok: true, value} | {ok: false, error: 'invalid_hours_length' | 'invalid_day_of_week' | 'invalid_time_range'}`. The route emits the exact spec envelope. `isValidHoursArray` is preserved as a thin boolean wrapper for any future callers.
  - **P-C — `address = undefined` slipped through as null (P2, blind-hunter #2):** Without the explicit `undefined` guard, `address: undefined` would silently clear the address while reporting the field as updated. Fix: `if (raw === undefined || (raw !== null && typeof raw !== 'string'))` → 400 `invalid_address`.
  - **P-D — Redundant `idx_branch_weekly_hours_branch_day` UNIQUE INDEX (P3, blind-hunter #12, edge-case #7):** The column-level `UNIQUE (branch_id, day_of_week)` already creates an index. Fix: drop the redundant `CREATE UNIQUE INDEX` statement from migration 0015. The migration now declares only the inline UNIQUE constraint and a non-unique `idx_branch_weekly_hours_branch_id` for the GET hot path.
- **Tests added:**
  - `PATCH open_time=17:00, close_time=09:00 → 400 invalid_time_range` (was: invalid_day_of_week; corrected envelope).
  - `PATCH open_time === close_time → 400 invalid_time_range` (boundary).
  - `PATCH open_time=25:00 → 400 invalid_time_range` (out-of-range time format).
  - `PATCH day_of_week=7 → 400 invalid_day_of_week` (PATCH path).
  - `PATCH 409 with NO doctor-at-branch → requires_doctor_acknowledgement=false` (full no-doctor-at-branch path).
  - Pinned `affected_doctors[0]` shape: `{doctor_id: string, doctor_name: string, count: number}`.
  - Migration idempotency test (`0015 forward run is idempotent; 8 columns preserved`).
- **Deferrals (deferred-work.md):**
  - **W39 — `acknowledge_doctor_impact` in body**: Currently read from both query string AND body. Should be query-only per spec intent. Low risk; reopen if the frontend wants to lock this down.
  - **W40 — 7 INSERT round-trips per PATCH (N+1)**: Could batch into one multi-VALUES INSERT. Defensive perf optimization; reopen if the route's RPS matters.
  - **W41 — Address/tz fast-path response shape inconsistency**: Returns `{branch_id, tz, address}` while hours path returns `{branch, hours, impact}`. Spec doesn't mandate a single shape; document and unify in a future cross-cutting story.
  - **W42 — `BOOL_OR(EXISTS doctor_branch)` semantic**: After triage, the SQL is correct (per-row EXISTS collapses via GROUP BY to a single group-level check). The reviewer's concern was a false positive; documented in this PR comment.
- **Avoided known-bad state:** Without P-A, a branch-hours change for branch X could count branch Y's appointments as affected when the local-dow matched Y's closed day — a cross-branch data leak. Without P-B, the spec's `invalid_time_range` envelope would silently degrade to `invalid_day_of_week`, breaking the UI's ability to show the right message. Without P-C, a bug like `JSON.stringify({address: undefined})` (which omits the key) would leave the test path ambiguous but a `Content-Type: application/json` body with `{address: undefined}` would silently clear the address.
- **Verification post-patches:** Typecheck 0 new errors (3 pre-existing baseline errors unchanged). Lint 0 new warnings (4 pre-existing baseline warnings unchanged). New `admin-branch-hours.test.ts` has 24+ tests (added 5 in this review pass).

## Design Notes

**Why `time` (not `tstzrange`):** Wall-clock semantics. The `branch.tz` is the only timezone that matters; storing `time` lets the SQL impact check compute `(start_datetime AT TIME ZONE branch.tz)::time` cleanly. A `tstzrange` would conflate hours with date arithmetic and break the editor UX.

**Why impact runs inside the transaction:** Same TOCTOU pattern as E1-S1's deactivate branch (see `admin-branches.ts:354-415`). Between impact-preview and PATCH-commit, a booking could land. Running the impact check against the same row state we are about to write eliminates the race; the 409 response includes the same impact data the preview would have shown.

**Why no audit row in this story:** The codebase's only audit table is `appointment_audit` (per-appointment-event, `0009_appointment_audit.sql`). Adding a generic admin audit table is a cross-cutting concern (E7-S2). E1-S1 set the precedent of no admin audit; E1-S2 follows it. This is documented as an explicit deferral, not an oversight.

**Why a separate GET impact endpoint:** The mockup-08 5-step flow shows an explicit "Preview impact" CTA before "Save". A separate endpoint lets the UI re-preview without committing. The same `computeBranchHoursImpact` helper backs both GET impact and the PATCH-commit impact check, so they cannot diverge.

**Doctor-not-at-branch as runtime check:** `doctor_branch` table exists today (0001:38-42 + 0004:63-71). The check is `EXISTS (SELECT 1 FROM doctor_branch db WHERE db.doctor_id = a.doctor_id AND db.branch_id = a.branch_id)`. No E1-S3 dependency; no foreign-key deferred.

**Default hours on backfill:** Closed Sun, Mon–Sat 09:00–17:00. Matches the product brief's typical Saudi clinic hours. Idempotent via ON CONFLICT DO NOTHING so re-seeding doesn't reset existing rows.

**Time format in HTTP:** `HH:MM` (24-hour) per the UX hand-off. Out-of-range times (e.g. `25:00`) caught by `isValidTime` via Date parse.

## Verification

**Commands:**
- `pnpm --filter @clinic/api typecheck` -- expected: 0 new errors; pre-existing baseline errors unchanged.
- `pnpm --filter @clinic/api lint` -- expected: 0 new warnings; pre-existing baseline warnings unchanged.
- `pnpm --filter @clinic/api test` -- expected: full suite green except for the pre-existing baseline failures in `auth.test.ts`, `log.test.ts`, and `sms-otp` bytea-parser (documented in `deferred-work.md`); new `admin-branch-hours.test.ts` + 3 new `migrations.test.ts` + 1 new `seed.test.ts` tests all green.
- `psql -f apps/api/db/migrations/0015_branch_hours.sql` against a fresh DB -- expected: idempotent re-run succeeds.
- `curl -X POST http://localhost:3000/admin/branches/<id>/hours-impact -H 'Authorization: Bearer <admin>' -H 'Content-Type: application/json' -d '{"hours":[...]}'` -- expected: `200 {count_affected, ...}`.

**Manual checks:**
- Open `imports/app/index.html#/admin/branch-hours` and click through mockups 08, 28, 39 in the connected shell — they should all still render (E1-S2 didn't touch the web side; the mockups are the spec).
