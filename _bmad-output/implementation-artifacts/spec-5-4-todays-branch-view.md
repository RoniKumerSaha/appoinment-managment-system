---
title: 'E5-S4 — Today''s branch view (receptionist dashboard)'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-5-3-receptionist-cancellation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A receptionist signs in and opens the dashboard
(F-12, BR-063). They see today's appointments for their assigned
branch only — server-side filter, no client payload mixing.
Cross-branch URLs return 403 (Scenario 11). Filters: Date |
Doctor | Status. Empty state: "No appointments scheduled for
today."

**Approach:** Add ONE new route:

1. **`GET /reception/branch/today` (NEW)** — today's appointments
   for the receptionist's assigned branch. The handler:
   - Auth gate: `claim.role === 'receptionist'`. Patient / doctor /
     admin → 403 `forbidden_role`. Anonymous → 401.
   - **Branch is LOCKED to `claim.branch_ids[0]`** (BR-004
     single-branch invariant; E5-S4 on Scenario 11). The
     receptionist CANNOT pass a `branch_id` query param — any
     query value is ignored (the server decides). Cross-branch
     probes (URLs like `/reception/branch/today?branch_id=branch-west`)
     resolve to the SAME receptionist-branch-locked dataset
     regardless of `branch_id` in the query, so a receptionist at
     branch-east cannot see branch-west data.
   - **Date is derived from `claim.branch_ids[0]`'s `tz`** (E7-S6)
     using `now() AT TIME ZONE branch.tz` for the calendar day in
     the branch's local time. The route's `date` query param is
     OPTIONAL and may be used to navigate to a different day (E7-S6
     compliant — the receptionist's tz-anchored "today"). When
     omitted, "today" = the calendar day in the branch tz. When
     supplied, must be `YYYY-MM-DD` and is validated.
   - **Filters (optional query params):**
     - `doctor_id` (optional, UUID): filter to one doctor at the
       branch.
     - `status` (optional, one of `Scheduled`, `Cancelled`,
       `Completed`, `No-Show`): filter by appointment status.
       Defaults to no filter (all statuses returned).
     - If supplied and invalid → 400 `invalid_status` /
       `invalid_doctor_id`.
   - The query: `SELECT appointments at branch_id = $1 AND
     start_datetime::timestamptz falls within the date window
     derived from branch.tz`, ordered by start_datetime ASC, then
     doctor full_name ASC.
   - Response 200 with `{date, branch: {id, name, tz}, filters,
     appointments: [{id, doctor_id, doctor_name, patient_phone,
     appointment_type_id, appointment_type_name, start_datetime,
     end_datetime, status}]}`. Empty array if no rows. No
     "no rows" envelope — the empty array IS the answer.
   - Empty state: client renders "No appointments scheduled for
     today." when `appointments.length === 0`. (Server returns
     `200 {appointments: []}` either way; the client decides the
     message.)

**Boundaries & Constraints**

**Always:**
- The receptionist's branch is bound server-side from
  `claim.branch_ids[0]`. The `branch_id` query param, if
  present, is IGNORED (Scenario 11: cross-branch URLs return 403
  with no data leak). The receptionist cannot see branch-west
  data when signed in as a branch-east receptionist.
- Date is anchored to the branch's `tz` (E7-S6). The route never
  returns a UTC calendar day when the branch is in
  America/New_York — it returns the branch-local calendar day.
- Filters are optional. The route returns 200 with the full
  dataset at the receptionist's branch when no filters are
  supplied.
- Auth: `claim.role === 'receptionist'` only. The dashboard is a
  receptionist surface; patient / doctor / admin → 403.
- The route is read-only (GET). Mark-status (E5-S1), doctor cancel
  (E5-S2), and receptionist cancel (E5-S3) are separate routes.
- The receptionist's `branch_ids` carries exactly one branch per
  BR-004; the membership check enforces the same. An empty
  `branch_ids` is rejected at the middleware (already in place
  for staff tokens).
- Response payload does NOT include `patient_name` or any PII
  beyond `patient_phone` (E7-S3 privacy — the receptionist needs
  to identify the patient by phone to confirm identity on
  arrival, but the API surface must not leak names the receptionist
  doesn't already have access to via the patient profile).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E5-S4 + PRD BR-063 + F-12 + Scenario 11.)

**Never:**
- No admin view of this list. Admin never touches individual
  appointments (PRD §2.4).
- No doctor view of this list (the doctor's dashboard is a
  separate story; out of scope today).
- No patient view of this list (E4-S1 owns the patient
  self-service list).
- No write operations on this route. Mark / cancel live in
  their own routes.
- No PII beyond `patient_phone` in the response (E7-S3).
- No reliance on the client's date — the server anchors to
  branch.tz.
- No reliance on a body. This is a GET.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Receptionist at branch-east opens dashboard for "today" | receptionist-east | `GET /reception/branch/today` | `200 {date, branch: {id, name, tz: 'America/New_York'}, appointments: [...]}` | happy path |
| Receptionist filters by status='Scheduled' | receptionist-east | `?status=Scheduled` | `200 {appointments: [<only Scheduled rows>]}` | filter |
| Receptionist filters by doctor_id | receptionist-east | `?doctor_id=<branch-east doctor>` | `200 {appointments: [<that doctor's rows>]}` | filter |
| Receptionist filters by date=YYYY-MM-DD | receptionist-east | `?date=2026-10-15` | `200 {date: '2026-10-15', appointments: [...]}` | navigate |
| Receptionist combines filters | receptionist-east | `?date=2026-10-15&doctor_id=X&status=Scheduled` | `200` | combined |
| Cross-branch URL | receptionist-east | `?branch_id=branch-west` | `200` with branch-east dataset (the branch_id query is IGNORED) | Scenario 11 |
| Receptionist at branch-west opens dashboard | receptionist-west | `GET /reception/branch/today` | `200` with branch-west dataset | BR-004 |
| Empty state | receptionist-east | `GET /reception/branch/today` on a day with no appointments | `200 {appointments: []}` | client renders empty state |
| Invalid `status` | receptionist-east | `?status=Bogus` | `400 invalid_status` | validation |
| Invalid `doctor_id` (not a UUID) | receptionist-east | `?doctor_id=not-a-uuid` | `400 invalid_doctor_id` | validation |
| Invalid `date` | receptionist-east | `?date=not-a-date` | `400 invalid_date` | validation |
| `doctor_id` exists but not at the branch | receptionist-east | `?doctor_id=<branch-west doctor>` | `200 {appointments: []}` | doctor filter is by doctor_id; doctor-not-at-branch returns empty |
| Patient JWT | patient | any | `403 forbidden_role` | wrong role |
| Doctor JWT | doctor | any | `403 forbidden_role` | wrong role |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Anonymous | none | any | `401 unauthenticated` | auth gate |

## Code Map

- `apps/api/src/routes/receptionist-today.ts` (NEW) — GET
  /reception/branch/today handler.
- `apps/api/src/app.ts` (MODIFIED) — mount `receptionistTodayRouter`
  after authMiddleware (NOT under `/admin/*` — this is a staff
  route, mounted alongside the other staff routes).
- `apps/api/test/receptionist-today.test.ts` (NEW) — integration
  tests for the I/O matrix.

**No new migration.** The schema has every column we need.

**Atomic today-query SQL:**
```sql
-- 1. Resolve branch + tz from the receptionist's claim.
SELECT id, name, tz FROM branch WHERE id = $1 AND active = true;
-- 2. Date window: [date at branch.tz, +24h) — i.e. the
--    calendar day in the branch's local time.
-- 3. SELECT appointments at the branch whose start_datetime
--    falls inside the date window, with optional filters.
SELECT a.id::text AS id,
       a.doctor_id::text AS doctor_id,
       d.full_name AS doctor_name,
       a.patient_phone,
       a.appointment_type_id::text AS appointment_type_id,
       at.name AS appointment_type_name,
       a.start_datetime, a.end_datetime, a.status
  FROM appointment a
  JOIN doctor d ON d.id = a.doctor_id
  JOIN appointment_type at ON at.id = a.appointment_type_id
 WHERE a.branch_id = $1::uuid
   AND a.start_datetime >= $2::timestamptz
   AND a.start_datetime < $3::timestamptz
   AND ($4::uuid IS NULL OR a.doctor_id = $4::uuid)
   AND ($5::text IS NULL OR a.status = $5::text)
 ORDER BY a.start_datetime ASC, d.full_name ASC;
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/receptionist-today.ts` — GET
  /reception/branch/today handler.
- [ ] `apps/api/src/app.ts` — mount after authMiddleware.
- [ ] `apps/api/test/receptionist-today.test.ts` — integration
  tests.

**Acceptance Criteria:**
- Given a receptionist JWT for `claim.branch_ids=[branch-east]`, when GET /reception/branch/today is invoked, then 200 with `{date, branch: {id: <branch-east uuid>, name: 'East Branch', tz: 'America/New_York'}, appointments: [...]}`. The dataset is restricted to `branch_id = claim.branch_ids[0]` server-side.
- Given a receptionist JWT and an optional `?status=Scheduled` filter, when GET /reception/branch/today is invoked, then the response `appointments` array contains only rows with `status='Scheduled'`.
- Given a receptionist JWT and an optional `?doctor_id=<uuid>` filter, when GET /reception/branch/today is invoked, then the response `appointments` array contains only rows with that doctor.
- Given a receptionist JWT and an optional `?date=YYYY-MM-DD` query param, when GET /reception/branch/today is invoked, then the response `date` echoes the supplied date and the dataset is filtered to that calendar day in the branch's tz.
- Given a receptionist JWT and `?branch_id=<other-branch>` in the query string, when GET /reception/branch/today is invoked, then the response dataset is the receptionist's branch (the query value is ignored per Scenario 11).
- Given a receptionist JWT and a `?status=Bogus` query param, when GET /reception/branch/today is invoked, then 400 invalid_status.
- Given a receptionist JWT and a `?doctor_id=not-a-uuid` query param, when GET /reception/branch/today is invoked, then 400 invalid_doctor_id.
- Given a receptionist JWT and a `?date=not-a-date` query param, when GET /reception/branch/today is invoked, then 400 invalid_date.
- Given a day with no appointments at the receptionist's branch, when GET /reception/branch/today is invoked, then 200 with `appointments: []`.
- Given a patient / doctor / admin JWT, when GET /reception/branch/today is invoked, then 403 forbidden_role.
- Given an anonymous caller, when GET /reception/branch/today is invoked, then 401 unauthenticated.
- The route response does NOT include `patient_name` or any PII beyond `patient_phone` (E7-S3).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/receptionist-today.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.