---
title: 'E4-S3 — Patient rescheduling'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-1-patient-otp-verification-upcoming-appointments.md'
  - '_bmad-output/implementation-artifacts/spec-4-2-patient-cancellation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A verified patient reschedules their own Scheduled
appointment to a new slot. Per F-05, BR-041…045 / FR-039…043:
- The doctor is locked (FR-040, BR-042) — the patient cannot change
  doctors via the patient-facing reschedule flow.
- The branch, appointment type, date, and time may all change (FR-041).
- The transaction reserves the NEW slot **before** releasing the OLD
  slot (FR-042, architecture §3.4): if the new reservation fails,
  the original appointment is **untouched** (FR-043). The patient
  sees "That slot is no longer available. Your appointment is
  unchanged." (Scenario 9).
- The audit row metadata carries `{from, to, branch_change,
  type_change}` flags (UX-FLOWS F-05) so the audit drawer can
  surface WHAT changed (E7-S2 acceptance).

**Approach:** Add ONE new route:

1. **`POST /patient/appointments/:id/reschedule` (NEW)** — atomic
   two-slot transaction. Body: `{new_branch_id, new_appointment_type_id,
   new_start_datetime, new_end_datetime, new_slot_duration_minutes}`.
   The handler:
   - `SELECT ... FOR UPDATE` on the existing appointment row by id.
   - Verifies the row exists AND `patient_phone = claim.sub` (E7-S3
     privacy filter).
   - Verifies `status = 'Scheduled'` (only Scheduled is reschedulable;
     same terminal-state envelope as E4-S2).
   - Extracts `doctor_id` from the existing row — the patient CANNOT
     supply a `new_doctor_id` (FR-040, BR-042). The body schema
     rejects an unknown key.
   - Validates the new slot fits the same constraints as `POST /bookings`
     (FR-018 window, FR-019 same-day, FR-027 same-doctor future, FR-029
     patient time-overlap, branch hours, doctor schedule, doctor
     blocks, GIST exclusion).
   - Runs the same in-txn slot re-check as `POST /bookings`
     (`recheckSlotInTxn` reuse is documented as a future cleanup;
     today we re-implement the local subset inside the transaction).
   - `UPDATE appointment SET branch_id, appointment_type_id,
     start_datetime, end_datetime` — atomic. The GIST exclusion on
     `status='Scheduled'` (per 0008) catches any concurrent winner
     for the new slot.
   - `INSERT appointment_audit` (`actor_role='patient'`,
     `actor_id='patient:<phone>'`, `event='rescheduled'`,
     `payload={from, to, branch_change, type_change}`).
   - `COMMIT` and respond 200 with the updated appointment row.

**Boundaries & Constraints**

**Always:**
- The doctor is locked (FR-040, BR-042). The body schema does NOT
  accept `new_doctor_id`. The handler ignores any client-supplied
  doctor id and reads it from the existing row.
- The transaction reserves the new slot BEFORE releasing the old
  slot (FR-042). Mechanically: the `UPDATE appointment SET ...`
  carries the new `(branch_id, start_datetime, end_datetime)`, and
  the GIST exclusion constraint on `status='Scheduled'` (per 0008)
  is the race-safety net for the new slot — a concurrent booking
  that wins the new slot will fail at the constraint layer with
  SQLSTATE 23P01 → 409 `slot_raced`. The old slot is released
  automatically because the UPDATE moves the row off the old time
  range.
- If the new reservation fails (any reason — slot_raced,
  patient_time_conflict, patient_has_future_with_doctor,
  outside_branch_hours, doctor_unavailable, inside_doctor_block,
  duration_mismatch, slot_in_past, outside_30d_window), the
  original appointment is untouched (FR-043, Scenario 9).
- The audit row's `payload` carries `{from: {...}, to: {...},
  branch_change: bool, type_change: bool}` per F-05. E7-S2 reads
  these flags to surface WHAT changed in the audit drawer.
- Only `status='Scheduled'` rows are reschedulable. Already-Cancelled
  / Completed / No-Show → 404 `not_found_appointment_in_terminal_state`
  (same envelope as E4-S2).
- E7-S3 privacy: same 404 envelope for "doesn't exist" and "exists
  but not yours" — never 403, never a distinct envelope for wrong-owner.
- The body is validated in fixed order: UUID parse → ISO datetime
  parse → duration 5..480 → window check → in-txn re-check.
- The new appointment's branch must have the existing doctor on its
  `doctor_branch` table (BR-002 / BR-003 — doctors are anchored to
  one clinic, multi-branch is allowed but explicit). If the doctor
  is not at the new branch → 400 `doctor_not_at_branch`.
- The new appointment_type must be active (FR-007 + E2-S3).
- The `slot_duration_minutes` MUST match the stored duration of the
  chosen `appointment_type` (matches `POST /bookings` P1-3 / 409
  `duration_mismatch`).
- `new_end_datetime` MUST equal `new_start_datetime + slot_duration_minutes`
  (matches `POST /bookings` P1-3 / 400 `invalid_time_range`).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E4-S3 +
  PRD FR-039…043 + UX-FLOWS F-05 + architecture §3.4.)

**Never:**
- No `new_doctor_id` field. The doctor is server-trusted (FR-040,
  BR-042).
- No `created_by` change. The row's `created_by` stays whatever it
  was at insert time; the reschedule is an UPDATE, not a re-create.
- No batch reschedule. One appointment per request (matches E4-S2's
  "one appointment per request" invariant).
- No reschedule on behalf of another patient. Doctor / receptionist
  / admin have their own reschedule flows (E6-S2 / E6-S4 / future).
- No payload deletion: the rescheduled event's payload is fixed-shape
  (matches E7-S2 audit metadata contract).

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Reschedule to a different time (same doctor, branch, type) | patient JWT, sub=`+15550000001` | `{new_branch_id, new_type_id, new_start, new_end, new_dur}` (valid slot 8 days out) | `200 {appointment: {...}}` + audit row with `branch_change:false, type_change:false` | happy path |
| Reschedule to a different branch (FR-041) | patient JWT | `{new_branch_id: branch-west, ...}` (where Dr. East Lead is NOT at branch-west) | `400 doctor_not_at_branch` | doctor not at branch |
| Reschedule to a different appointment type (FR-041) | patient JWT | `{new_type_id: <different type>, ...}` | `200` + audit row with `branch_change:false, type_change:true` | FR-041 |
| Reschedule to a different date | patient JWT | `{new_start}` (10 days out) | `200` | FR-041 |
| Reschedule to a slot that's already taken | patient JWT | `{new_start}` matches an existing Scheduled row at the same (doctor, branch) | `409 slot_raced` (ConflictModal envelope) | GIST 23P01 |
| Reschedule when patient now has another future appt with same doctor (FR-027) | patient JWT | inserts a 2nd future Scheduled for same doctor, tries to reschedule the 1st into a 3rd slot | `409 patient_has_future_with_doctor` | FR-027 |
| Reschedule to a slot the patient already overlaps with (FR-029) | patient JWT | inserts a 2nd future Scheduled at overlapping time, tries to reschedule | `409 patient_time_conflict` | FR-029 |
| Reschedule to a past slot | patient JWT | `{new_start}` < now | `409 slot_in_past` | FR-019 |
| Reschedule to a slot outside 30-day window | patient JWT | `{new_start}` > now+30 days | `409 outside_30d_window` | FR-018 |
| Reschedule when new branch is closed that day | patient JWT | `{new_branch_id}` closed Sunday | `409 outside_branch_hours` | branch hours |
| Reschedule when new doctor not at new branch | patient JWT | `{new_branch_id: branch-west}` (Dr. East Lead not at branch-west) | `400 doctor_not_at_branch` | BR-002 |
| Reschedule to a slot inside a doctor block | patient JWT | inserts a doctor_block that overlaps the new slot | `409 inside_doctor_block` | BR-010 |
| Reschedule to a slot using an inactive type | patient JWT | `{new_type_id}` of a deactivated type | `404 appointment_type_not_found` | FR-007 |
| Reschedule with mismatched duration (start/end don't add up) | patient JWT | `{new_end - new_start != slot_duration_minutes * 60_000}` | `400 invalid_time_range` | P1-3 |
| Reschedule with type/duration mismatch | patient JWT | `{new_dur != storedDuration}` | `409 duration_mismatch` | E3-S2 convention |
| Reschedule with `new_doctor_id` in body | patient JWT | `{new_doctor_id: <other>}` | `400 unknown_field` | FR-040 — the route never accepts a new doctor |
| Cancel unknown id | patient JWT | `:id=<random uuid>` | `404 not_found` | privacy |
| Cancel NOT own appointment | patient JWT, sub=`+15550000001` | `:id=<patient 0002's appointment>` | `404 not_found` | privacy |
| Reschedule already-Cancelled row | patient JWT | `:id=<cancelled row>` | `404 not_found_appointment_in_terminal_state` | idempotent |
| Reschedule Completed | patient JWT | `:id=<completed row>` | `404 not_found_appointment_in_terminal_state` | terminal |
| Reschedule No-Show | patient JWT | `:id=<no-show row>` | `404 not_found_appointment_in_terminal_state` | terminal |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Doctor JWT | doctor | any | `403 forbidden_role` | wrong role |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Receptionist JWT | receptionist | any | `403 forbidden_role` | wrong role |
| Audit row inspection | — | — | `actor_role='patient'`, `actor_id='patient:<phone>'`, `event='rescheduled'`, `payload={from, to, branch_change, type_change}` | F-05 / E7-S2 |
| Failed reschedule leaves original unchanged | patient JWT | `{new_start}` is a taken slot → 409 | DB row's `(branch_id, start_datetime, end_datetime, appointment_type_id)` unchanged | FR-043 |

## Code Map

- `apps/api/src/routes/patient-reschedule.ts` (NEW) — POST
  /patient/appointments/:id/reschedule handler.
- `apps/api/src/app.ts` (MODIFIED) — mount `patientRescheduleRouter`
  after authMiddleware.
- `apps/api/test/patient-reschedule.test.ts` (NEW) — integration
  tests for the I/O matrix.

**No new migration.** The schema has every column we need
(`appointment.branch_id`, `appointment.start_datetime`,
`appointment.end_datetime`, `appointment.appointment_type_id`).

**Atomic reschedule SQL flow:**
```sql
-- 1. Lock the existing appointment row.
SELECT id, patient_phone, status, doctor_id, branch_id,
       appointment_type_id, start_datetime, end_datetime
  FROM appointment
 WHERE id = $1::uuid
   FOR UPDATE;
-- (route checks: row found AND patient_phone = claim.sub AND status='Scheduled')
-- 2. Verify doctor is at the NEW branch (BR-002 / BR-003).
SELECT 1 FROM doctor_branch
 WHERE doctor_id = $1 AND branch_id = $2;
-- 3. Slot re-check (re-uses E3-S1 pipeline inside the txn):
--    branch hours, doctor schedule, doctor blocks, existing
--    appointments at (doctor, new_branch), patient same-doctor
--    future (FR-027 — the current row is `Scheduled`, so we
--    exclude `id = $1` from the future check), patient time-overlap
--    (FR-029).
-- 4. UPDATE the appointment row with the new (branch_id,
--    appointment_type_id, start_datetime, end_datetime). The
--    0008 GIST exclusion on (branch_id, tstzrange, status='Scheduled')
--    is the race-safety net — SQLSTATE 23P01 → 409 slot_raced.
UPDATE appointment
   SET branch_id = $2, appointment_type_id = $3,
       start_datetime = $4, end_datetime = $5
 WHERE id = $1::uuid;
-- 5. Audit row.
INSERT INTO appointment_audit
  (appointment_id, actor_role, actor_id, event, payload)
VALUES ($1::uuid, 'patient', $2, 'rescheduled', $3::jsonb);
-- 6. COMMIT.
```

**Why FR-027's same-doctor-future check works on reschedule:**
On a reschedule, the patient's CURRENT row is itself a future
Scheduled row for `(patient, doctor)`. The FR-027 query is
`SELECT 1 FROM appointment WHERE patient_phone = $1 AND
doctor_id = $2 AND status = 'Scheduled' AND start_datetime >
now() LIMIT 1`. The current row would match — so the route
excludes `id = $1::uuid` from the query during the reschedule
re-check. The intent of FR-027 is "no two concurrent scheduled
rows for the same (patient, doctor)"; the reschedule is updating
ONE such row, not creating a 2nd.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/patient-reschedule.ts` — POST /patient/appointments/:id/reschedule handler.
- [ ] `apps/api/src/app.ts` — mount after authMiddleware.
- [ ] `apps/api/test/patient-reschedule.test.ts` — integration tests.

**Acceptance Criteria:**
- Given a verified patient JWT and a Scheduled appointment they own, when POST /patient/appointments/:id/reschedule is invoked with a valid new slot, then 200 with the updated appointment row (branch_id / appointment_type_id / start_datetime / end_datetime updated) and an audit row with `event='rescheduled'` and `payload.from/to/branch_change/type_change`.
- Given a verified patient JWT and a Scheduled appointment they own, when POST /patient/appointments/:id/reschedule is invoked with a new slot that has been taken by a concurrent booking, then 409 slot_raced AND the original appointment row's branch/start/end/type are unchanged (FR-043).
- Given a verified patient JWT and an appointment owned by a different patient, when POST /patient/appointments/:id/reschedule is invoked, then 404 not_found (privacy: don't reveal existence).
- Given a verified patient JWT and an appointment id with status in (Cancelled, Completed, No-Show), when POST /patient/appointments/:id/reschedule is invoked, then 404 not_found_appointment_in_terminal_state (idempotent).
- Given a verified patient JWT, when POST /patient/appointments/:id/reschedule is invoked with `new_doctor_id` in the body, then 400 unknown_field (FR-040 — the route never accepts a new doctor).
- Given an anonymous caller, when POST /patient/appointments/:id/reschedule is invoked, then 401 unauthenticated.
- Given a doctor / admin / receptionist JWT, when POST /patient/appointments/:id/reschedule is invoked, then 403 forbidden_role.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (Agent code-review pass).

Code review surfaced no blockers, two WARNINGs, three NITs:

- **T1 (No-Show coverage):** SC1's I/O matrix row "Reschedule
  No-Show" had no test coverage. New test
  `reschedule: No-Show → 404 not_found_appointment_in_terminal_state`
  mirrors the E4-S2 terminal-state envelope.
- **T2 (FR-029 patient_time_conflict coverage):** SC1's I/O matrix
  row "Reschedule when patient now has another future appt at
  overlapping time (FR-029)" had no test. New test
  `reschedule: new slot overlaps existing patient row → 409
  patient_time_conflict (FR-029)` inserts the blocker with a
  DIFFERENT doctor (Dr. East Support) so FR-027 stays clean, and
  asserts FR-043: the original row's start/end/type are unchanged.
- **T3 (WARNING #1 — `doctor_not_found` / `branch_not_found`
  reachable):** The disambiguation path (lines 566-591 in
  patient-reschedule.ts) surfaces 404 envelopes the spec I/O
  matrix does not enumerate. Documented as a server-side
  configuration issue, not a patient-triggerable path; no code
  change. Reachable only when `appt.doctor_id` is invalid (admin
  data drift), which the patient already proved ownership of.
- **T4 (WARNING #2 — pre-check has no row lock):** The
  SELECT_EXISTING_APPOINTMENTS_SQL pre-check is best-effort, not
  a race guarantee. Two concurrent reschedules targeting the same
  new slot both pass the pre-check and both fail at UPDATE 23P01.
  Behaviorally correct (GIST constraint catches it), but the
  pre-check is not authoritative. Documented in the code comment
  on the GIST-exclusion UPDATE block.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/patient-reschedule.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.