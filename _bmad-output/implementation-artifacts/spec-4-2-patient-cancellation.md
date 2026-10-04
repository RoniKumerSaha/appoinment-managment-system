---
title: 'E4-S2 — Patient cancellation'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-1-patient-otp-verification-upcoming-appointments.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A verified patient needs to cancel their own Scheduled
appointment (F-04). The appointment row transitions to `status =
'Cancelled'` — it is NEVER deleted (BR-038), the slot is released
(BR-053, FR-050), and an audit row is written with
`actor='patient:<phone>'`. No cancellation reason is required from
the patient (FR-033, in contrast to the receptionist flow FR-034
which DOES require one).

**Approach:** Add ONE new route:

1. **`POST /patient/appointments/:id/cancel` (NEW)** — atomic cancel.
   The handler:
   - `SELECT ... FOR UPDATE` on the appointment row by id.
   - Verifies the row exists AND `patient_phone = claim.sub` (E7-S3
     privacy filter — never reveal that another patient's appointment
     exists).
   - Verifies `status = 'Scheduled'` (only Scheduled is cancellable;
     already-Cancelled / Completed / No-Show are not).
   - `UPDATE appointment SET status = 'Cancelled'` (release the slot).
   - `INSERT appointment_audit` (`actor_role='patient'`,
     `actor_id='patient:<phone>'`, `event='cancelled'`,
     `payload={}` since FR-033 says no reason required).
   - `COMMIT` and respond 200.

**Boundaries & Constraints**

**Always:**
- The appointment must belong to the verified patient
  (`patient_phone = claim.sub`). Any other outcome (not found, wrong
  owner, wrong status) returns 404 — NOT 403, NOT 200 — so a patient
  cannot enumerate other patients' appointments by id.
- The cancel is atomic: `SELECT FOR UPDATE` + UPDATE + audit INSERT
  in a single BEGIN/COMMIT block. If the audit INSERT fails, the
  appointment status change is rolled back.
- No cancellation reason is required (FR-033). The receptionist
  flow FR-034 requires one; that's E5-S3's job.
- Only `status='Scheduled'` rows are cancellable. Already-cancelled
  / completed / no-show → 404 (not_found_appointment_in_terminal_state).
- The slot is released by the UPDATE itself: the GIST exclusion is
  scoped on `status='Scheduled'` (per 0008's
  `appointment_no_overlap` definition), so a Cancelled row no longer
  blocks the time range. BR-053 / FR-050 satisfied.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E4-S2 +
  PRD FR-033/050 + BRD BR-038/053.)

**Never:**
- No PATCH / DELETE on the row. The transition is always
  Scheduled → Cancelled.
- No cancellation reason (FR-033 explicit).
- No bulk cancel — one appointment per request.
- No list endpoint on this story. The patient gets the list from
  E4-S1 (GET /patient/appointments).
- No route on behalf of others. Doctors / receptionists have their
  own cancel flows (E5-S2 / E5-S3).

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Cancel own Scheduled | patient JWT, sub=`+15550000001` | `:id=<seeded future>` | `200 {appointment: {... status:'Cancelled'}}` + audit row | happy path |
| Cancel unknown id | patient JWT | `:id=<random uuid>` | `404 not_found` | privacy |
| Cancel NOT own appointment | patient JWT, sub=`+15550000001` | `:id=<patient 0002's appointment>` | `404 not_found` | privacy: don't reveal existence |
| Cancel already-Cancelled | patient JWT | `:id=<cancelled row>` | `404 not_found_appointment_in_terminal_state` | idempotent semantics |
| Cancel Completed | patient JWT | `:id=<completed row>` | `404 not_found_appointment_in_terminal_state` | terminal |
| Cancel No-Show | patient JWT | `:id=<no-show row>` | `404 not_found_appointment_in_terminal_state` | terminal |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Doctor JWT | doctor | any | `403 forbidden_role` | wrong role |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Receptionist JWT | receptionist | any | `403 forbidden_role` | wrong role |
| Slot becomes available after cancel | — | re-query /availability at the slot's time | slot visible in new availability | BR-053 / FR-050 |
| Audit row inspection | — | — | `actor_role='patient'`, `actor_id='patient:<phone>'`, `event='cancelled'` | FR-033 |

## Code Map

- `apps/api/src/routes/patient-cancel.ts` (NEW) — POST
  /patient/appointments/:id/cancel handler.
- `apps/api/src/app.ts` (MODIFIED) — mount patientCancelRouter
  after authMiddleware.
- `apps/api/test/patient-cancel.test.ts` (NEW) — integration tests
  for the I/O matrix.

**No new migration.** The schema has every column we need.

**Atomic cancel SQL flow:**
```sql
-- 1. Lock the appointment row.
SELECT id, patient_phone, status FROM appointment
 WHERE id = $1::uuid
   FOR UPDATE;
-- (route checks: row found AND patient_phone = claim.sub AND status='Scheduled')
-- 2. Transition status.
UPDATE appointment SET status = 'Cancelled' WHERE id = $1::uuid;
-- 3. Audit row.
INSERT INTO appointment_audit
  (appointment_id, actor_role, actor_id, event, payload)
VALUES ($1::uuid, 'patient', $2, 'cancelled', '{}'::jsonb);
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/patient-cancel.ts` — POST /patient/appointments/:id/cancel handler.
- [ ] `apps/api/src/app.ts` — mount after authMiddleware.
- [ ] `apps/api/test/patient-cancel.test.ts` — integration tests.

**Acceptance Criteria:**
- Given a verified patient JWT and an appointment id they own with status='Scheduled', when POST /patient/appointments/:id/cancel is invoked, then 200 with the updated appointment row (status='Cancelled') and an audit row written.
- Given a verified patient JWT and an appointment id owned by a different patient, when POST /patient/appointments/:id/cancel is invoked, then 404 not_found (privacy: don't reveal existence).
- Given a verified patient JWT and an appointment id with status in (Cancelled, Completed, No-Show), when POST /patient/appointments/:id/cancel is invoked, then 404 not_found_appointment_in_terminal_state (idempotent — already in a final state).
- Given an anonymous caller, when POST /patient/appointments/:id/cancel is invoked, then 401 unauthenticated.
- Given a doctor / admin / receptionist JWT, when POST /patient/appointments/:id/cancel is invoked, then 403 forbidden_role.
- After a successful cancel, the cancelled slot is available for re-booking via POST /bookings (BR-053 / FR-050).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (Agent code-review pass).

Code review surfaced two WARNINGs; both addressed:

- **T1 (BR-053 / FR-050 coverage):** SC1's I/O matrix row
  "Slot becomes available after cancel" had no test coverage. New
  test `cancelled slot reappears in /availability` inserts a
  Scheduled row for a fresh patient on a future day, captures the
  pre-cancel slot count, cancels the row, re-probes `/availability`
  on the same day, and asserts the post-cancel count is strictly
  greater. A fresh patient (no other Scheduled rows) keeps the
  delta attributable solely to the cancelled row.
- **T2 (happy-path fixture rationale):** SC1's I/O matrix row 1
  lists `:id=<seeded future>` but the test inserts a fresh row
  instead. Rationale: the seeded future row belongs to patient
  `+15550000001`, and the test asserts `status='Cancelled'` after
  cancel — mutating the seeded row would leak into sibling tests
  (`patient-appointments.test.ts` reads the same row). Inserting a
  fresh row scoped by `insertedIds` keeps the route's behavior
  fully exercised while isolating the cancel test's footprint.
  The seeded fixture path is covered indirectly by
  `patient-appointments.test.ts` (which reads the row but does not
  mutate it).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/patient-cancel.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.