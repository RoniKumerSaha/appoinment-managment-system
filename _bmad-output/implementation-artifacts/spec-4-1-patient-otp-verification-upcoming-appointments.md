---
title: 'E4-S1 — Patient OTP verification + upcoming appointments'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-0-4-sms-otp-gateway.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A verified patient needs to see their upcoming appointments
(F-03). After OTP verification, the patient lands on a list of their
future Scheduled appointments and can tap one to cancel (E4-S2) or
reschedule (E4-S3). Today the OTP send/verify routes are implemented
(E0-S4 ships `POST /patient/otp/send` + `POST /patient/otp/verify`,
mints a patient JWT with `sub = phone`), but there is no
patient-appointments endpoint — the verified patient has no
"what now?" destination.

**Approach:** Add ONE new route:

1. **`GET /patient/appointments` (NEW)** — server-side filter that
   returns the verified patient's upcoming Scheduled appointments
   (FR-032). The phone comes from the JWT claim (`req.auth.claim.sub`),
   NOT from the request body or a query param (the patient cannot
   enumerate another patient's appointments — E7-S3 invariant). Only
   `status='Scheduled' AND start_datetime > now()` rows are returned;
   Cancelled / Completed / No-Show are filtered out at the DB layer
   per FR-032.

**Boundaries & Constraints**

**Always:**
- OTP send/verify is E0-S4 (already shipped). E4-S1 does NOT touch the
  OTP service; the JWT mint is unchanged. E4-S1 ships only the
  post-verification endpoint.
- The phone comes from `req.auth.claim.sub`, NEVER from a query param
  or body. This is the E7-S3 privacy filter — a patient cannot
  enumerate other patients' appointments.
- Only future Scheduled rows (`status='Scheduled' AND start_datetime >
  now()`) appear in the response. Past appointments, Cancelled,
  Completed, No-Show are excluded (FR-032).
- Auth: `claim.role === 'patient'` only. Doctor / admin / receptionist
  JWTs → 403 (each role has its own dashboard; cross-role access is
  not part of E4-S1).
- Response is a JSON array of appointment rows; each row carries
  `id, doctor_id, branch_id, appointment_type_id, start_datetime,
  end_datetime, status, tz` (matches the POST /bookings 201 shape so
  the patient dashboard can reuse the card component).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E4-S1 +
  PRD FR-031/032 + UX-FLOWS F-03.)

**Never:**
- No query-param `?phone=` (privacy leak via enumeration).
- No list of past appointments in this story. (Future story may
  add `?include=past` for history view; out of scope today.)
- No new migration. The schema has every column we need
  (appointment.status, appointment.start_datetime, branch.tz).
- No pagination in this story. The patient only sees their own
  upcoming rows, which is bounded by the 30-day window × their
  concurrent Scheduled appointments. Realistic max is ~10 rows.

## I/O & Edge-Case Matrix

| Scenario | Caller | Expected | Notes |
|----------|--------|----------|-------|
| Patient with 1 future Scheduled | patient JWT, sub=`+15550000001` | `200 {appointments: [<row>]}` | seeded patient 0001 has 1 |
| Patient with no appointments | patient JWT, sub=`+15550000099` (unseeded) | `200 {appointments: []}` | empty list, NOT 404 |
| Patient with Cancelled row | patient JWT, sub=<cancelled patient> | Cancelled excluded from list | FR-032 |
| Patient with past Scheduled | patient JWT, sub=<past patient> | Past row excluded | filter at DB |
| Patient with Completed / No-Show | patient JWT, sub=<patient with those statuses> | All filtered out | FR-032 |
| Multiple upcoming rows | patient JWT | Returned in `start_datetime ASC` order | deterministic order |
| Anonymous | no auth | `401 unauthenticated` | gate |
| Doctor JWT | `claim.role='doctor'` | `403 forbidden_role` | wrong role |
| Admin JWT | `claim.role='admin'` | `403 forbidden_role` | wrong role |
| Receptionist JWT | `claim.role='receptionist'` | `403 forbidden_role` | wrong role |

## Code Map

- `apps/api/src/routes/patient-appointments.ts` (NEW) — GET
  /patient/appointments handler.
- `apps/api/src/app.ts` (MODIFIED) — mount patientAppointmentsRouter
  after authMiddleware (NOT in the OTP pre-auth chain — this route
  requires a verified JWT).
- `apps/api/test/patient-appointments.test.ts` (NEW) — integration
  tests for the I/O matrix.

**No new migration.**

**SQL (server-side filter):**
```sql
SELECT a.id::text AS id,
       a.doctor_id::text AS doctor_id,
       a.branch_id::text AS branch_id,
       a.appointment_type_id::text AS appointment_type_id,
       a.start_datetime, a.end_datetime,
       a.status,
       b.tz
  FROM appointment a
  JOIN branch b ON b.id = a.branch_id
 WHERE a.patient_phone = $1
   AND a.status = 'Scheduled'
   AND a.start_datetime > now()
 ORDER BY a.start_datetime ASC;
```

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/routes/patient-appointments.ts` — GET /patient/appointments handler.
- [x] `apps/api/src/app.ts` — mount after authMiddleware.
- [x] `apps/api/test/patient-appointments.test.ts` — integration tests.

**Acceptance Criteria:**
- Given a patient JWT whose `sub` matches a patient with 1+ future Scheduled rows, when GET /patient/appointments is invoked, then 200 with `{appointments: [...]}` in `start_datetime ASC` order.
- Given a patient JWT with no upcoming appointments, when GET /patient/appointments is invoked, then 200 `{appointments: []}`.
- Given a patient JWT, when GET /patient/appointments is invoked, then Cancelled / Completed / No-Show / past rows are excluded (FR-032).
- Given an anonymous caller, when GET /patient/appointments is invoked, then 401 unauthenticated.
- Given a doctor JWT, when GET /patient/appointments is invoked, then 403 forbidden_role.
- Given a patient JWT whose `sub` matches no `patient.phone_number`, when GET /patient/appointments is invoked, then 200 `{appointments: []}` (NOT 404 — privacy: don't leak patient existence).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (Agent code-review pass).

Code review found no blockers; one test patch:
- **T1 (FR-032 coverage):** SC1's I/O matrix row "Completed / No-Show"
  had no test coverage. The FR-032 filter test now inserts five rows
  (future Scheduled, past Scheduled, future Cancelled, future
  Completed, future No-Show) and asserts only the future Scheduled
  row appears. Cleanup is scoped by the captured `id` list (no risk
  of touching sibling tests' rows).
- **T2 (cleanup narrowing):** The original cleanup used a broad
  `start_datetime > now() - INTERVAL '1 day'` predicate; the test
  now deletes by the exact `insertedIds` captured during the INSERT
  RETURNING.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/patient-appointments.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After `POST /patient/otp/verify` mints a patient JWT, `GET /patient/appointments` returns the seeded future appointment for patient 0001.