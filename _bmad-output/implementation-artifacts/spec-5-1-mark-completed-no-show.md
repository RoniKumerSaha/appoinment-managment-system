---
title: 'E5-S1 — Mark Completed / No-show'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-2-patient-cancellation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A doctor or receptionist marks an appointment as Completed
or No-show (F-10 / subset). The status transitions atomically and an
audit row is written. No reason is required (BR-039, BR-040). The
slot is NOT released — the slot is in the past (BR-053 only applies
to future rows; the GIST exclusion already lets past rows coexist since
their `tstzrange` is in the past).

**Approach:** Add ONE new route:

1. **`POST /appointments/:id/mark-status` (NEW)** — atomic status
   update. Body: `{status: 'Completed' | 'No-Show'}`. The handler:
   - `SELECT ... FOR UPDATE` on the appointment row by id.
   - Role gate (server-trusted, body-ignored): if `claim.role` is
     `doctor`, the appointment's `doctor_id` MUST equal `claim.doctor_id`
     AND the appointment's branch MUST be in `claim.branch_ids`. If
     `claim.role` is `receptionist`, the appointment's branch MUST be
     in `claim.branch_ids` (BR-004). Otherwise → 403 `outside_branch_scope`.
   - Status gate: only `Scheduled` rows can be marked. Already-Cancelled /
     Completed / No-Show → 422 `already_in_terminal_state` (a distinct
     envelope from the patient-facing `not_found_appointment_in_terminal_state`
     because the staff flow has DIFFERENT semantics: the row is visible
     in their queue).
   - Time gate (BR-040 / FR-037): No-show and Completed can ONLY be
     applied to rows whose `start_datetime <= now()` (the appointment
     has begun). Future rows → 422 `appointment_in_future`.
   - `UPDATE appointment SET status = $new_status` — atomic.
   - `INSERT appointment_audit` (`actor_role=claim.role`,
     `actor_id='staff:<claim.sub>'`, `event='marked_<status>'`,
     `payload={}` since BR-039 / BR-040 say no reason required).
   - `COMMIT` and respond 200 with the updated appointment row.

**Boundaries & Constraints**

**Always:**
- The status update is atomic: SELECT FOR UPDATE + UPDATE + audit
  INSERT in a single BEGIN/COMMIT block. If the audit INSERT fails,
  the status change rolls back.
- Doctor scope is doubly-bound: `appt.doctor_id = claim.doctor_id`
  AND `appt.branch_id ∈ claim.branch_ids`. A doctor assigned to
  branch-east cannot mark branch-west appointments, even if both
  branches happen to share an admin.
- Receptionist scope: `appt.branch_id ∈ claim.branch_ids`. The
  receptionist's `branch_ids` carries exactly one branch per BR-004;
  the membership check enforces the same.
- Only `Scheduled` rows are markable. Terminal states
  (Cancelled / Completed / No-Show) → 422 `already_in_terminal_state`.
- No-show and Completed require `start_datetime <= now()`. Future
  rows → 422 `appointment_in_future`.
- The slot is NOT released: the GIST exclusion is scoped on
  `status='Scheduled'` (per 0008) and a Completed / No-Show row is
  not Scheduled, but in either case the row's tstzrange is in the
  past so the engine never lists it as a future slot anyway. No
  additional constraint needed.
- No reason is recorded in the audit row (BR-039 / BR-040). The
  audit `payload` is `{}`.
- Auth: `claim.role ∈ {doctor, receptionist}` only. Patient →
  403 `forbidden_role` (the patient does not have mark-status
  capability). Admin → 403 `forbidden_role` (admin never touches
  individual appointments per PRD §2.4).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E5-S1 +
  PRD BR-039/040 + FR-036/037 + UX-FLOWS F-10.)

**Never:**
- No DELETE on the appointment row (BR-038). The transition is
  always Scheduled → Completed / No-Show.
- No reason required (BR-039, BR-040). The audit payload is `{}`.
- No bulk mark. One appointment per request.
- No list endpoint on this story. The doctor's "today" queue is
  out of scope (E5-S4 covers the receptionist's; the doctor's
  dashboard is part of the broader doctor work surface — out of
  scope today).
- No route on behalf of others across branches. Doctor / receptionist
  are bound to their assigned branches server-side.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Doctor marks own Scheduled Completed | doctor JWT, sub=`doctor-east-lead` | `:id=<own past appointment>`, `status=Completed` | `200 {appointment: {... status:Completed}}` + audit row | happy path |
| Doctor marks own Scheduled No-Show | doctor JWT | `:id=<own past appointment>`, `status=No-Show` | `200` + audit row | happy path |
| Receptionist marks Scheduled Completed | receptionist JWT, branch_ids=[east] | `:id=<branch-east past Scheduled>`, `status=Completed` | `200` | BR-004 |
| Doctor marks other doctor's appointment | doctor-east-lead | `:id=<Dr. East Support's appointment>` | `403 outside_branch_scope` | doctor scope |
| Receptionist at branch-west marks branch-east | receptionist-west | `:id=<branch-east appointment>` | `403 outside_branch_scope` | BR-004 |
| Mark future Scheduled Completed | doctor | `:id=<future Scheduled>` | `422 appointment_in_future` | FR-037 |
| Mark future Scheduled No-Show | doctor | `:id=<future Scheduled>` | `422 appointment_in_future` | FR-037 |
| Mark already-Cancelled | doctor | `:id=<cancelled row>` | `422 already_in_terminal_state` | idempotent-ish |
| Mark already-Completed | doctor | `:id=<completed row>` | `422 already_in_terminal_state` | idempotent-ish |
| Mark already-No-Show | doctor | `:id=<no-show row>` | `422 already_in_terminal_state` | idempotent-ish |
| Patient JWT | patient | any | `403 forbidden_role` | wrong role |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Malformed UUID | doctor | `:id=not-a-uuid` | `404 not_found` | route doesn't reveal existence |
| Unknown id | doctor | `:id=<random uuid>` | `404 not_found` | route doesn't reveal existence |
| Audit row inspection | — | — | `actor_role='doctor' or 'receptionist'`, `actor_id='staff:<sub>'`, `event='marked_completed' or 'marked_no_show'`, `payload='{}'` | FR-036/037 |
| Slot after Completed | doctor | re-query /availability at slot's time | slot NOT visible | BR-053 (already not visible since past) |

## Code Map

- `apps/api/src/routes/staff-mark-status.ts` (NEW) — POST
  /appointments/:id/mark-status handler.
- `apps/api/src/app.ts` (MODIFIED) — mount `staffMarkStatusRouter`
  after authMiddleware (NOT under `/admin/*` — this is a staff
  route, not admin).
- `apps/api/test/staff-mark-status.test.ts` (NEW) — integration
  tests for the I/O matrix.

**No new migration.** The schema has every column we need.

**Atomic mark-status SQL flow:**
```sql
-- 1. Lock the appointment row.
SELECT id, doctor_id, branch_id, status, patient_phone, start_datetime
  FROM appointment
 WHERE id = $1::uuid
   FOR UPDATE;
-- (route checks: row found AND role-scope match AND status='Scheduled' AND start_datetime <= now())
-- 2. Transition status.
UPDATE appointment SET status = $2 WHERE id = $1::uuid;
-- 3. Audit row.
INSERT INTO appointment_audit
  (appointment_id, actor_role, actor_id, event, payload)
VALUES ($1::uuid, $2, 'staff:<sub>', $3, '{}'::jsonb);
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/staff-mark-status.ts` — POST /appointments/:id/mark-status handler.
- [ ] `apps/api/src/app.ts` — mount after authMiddleware.
- [ ] `apps/api/test/staff-mark-status.test.ts` — integration tests.

**Acceptance Criteria:**
- Given a doctor JWT for `claim.doctor_id=X` and an appointment id where `appointment.doctor_id=X`, `appointment.branch_id ∈ claim.branch_ids`, `status='Scheduled'`, and `start_datetime <= now()`, when POST /appointments/:id/mark-status is invoked with `status='Completed'`, then 200 with the updated appointment row and an audit row with `actor_role='doctor'`, `actor_id='staff:<sub>'`, `event='marked_completed'`, `payload='{}'`.
- Same as above but with `status='No-Show'` → 200 with audit row `event='marked_no_show'`.
- Given a receptionist JWT for `claim.branch_ids=[branch-east]` and an appointment at branch-east with `status='Scheduled'`, when POST /appointments/:id/mark-status is invoked, then 200.
- Given a doctor JWT whose `claim.doctor_id` does not match `appointment.doctor_id`, when POST /appointments/:id/mark-status is invoked, then 403 outside_branch_scope.
- Given a receptionist JWT whose `claim.branch_ids` does not include `appointment.branch_id`, when POST /appointments/:id/mark-status is invoked, then 403 outside_branch_scope.
- Given any staff JWT and an appointment with `status='Cancelled'|'Completed'|'No-Show'`, when POST /appointments/:id/mark-status is invoked, then 422 already_in_terminal_state.
- Given any staff JWT and an appointment with `start_datetime > now()`, when POST /appointments/:id/mark-status is invoked, then 422 appointment_in_future.
- Given a patient / admin JWT, when POST /appointments/:id/mark-status is invoked, then 403 forbidden_role.
- Given an anonymous caller, when POST /appointments/:id/mark-status is invoked, then 401 unauthenticated.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review patches.**

Code review against the implemented route + tests surfaced:

- **T1 — Missing receptionist No-Show happy path.** The I/O table row
  "Receptionist marks Scheduled No-Show" was untested. Added a
  test mirroring the Completed variant: insert a past Scheduled
  appointment, POST `{status: 'No-Show'}` as
  `receptionistEastToken`, assert 200 + audit row with
  `actor_role='receptionist'`, `event='marked_no_show'`,
  `payload='{}'`.

- **T2 — Slot-after-Completed probe is a no-op for mark-status.**
  The spec note (BR-053 sub-case) says a Completed / No-Show row's
  `tstzrange` is in the past so the engine never lists it as a
  future slot anyway. The slot-after-Completed probe (which we
  assert in `patient-cancel.test.ts` for the cancel flow) does not
  apply to mark-status — there is no slot to release. No test
  added; the spec's "No additional constraint needed" remark is
  the implementation contract.

- **T3 — N5: drop the redundant `RETURNING` from `UPDATE_STATUS_SQL`.**
  The locked SELECT FOR UPDATE row carries every column the
  response needs; the UPDATE only flips status. Removed the
  `RETURNING` clause and the unused `UpdateRow` interface. The
  response is now built from `appt` with `status` overlaid to
  `newStatus`. Matches `patient-cancel.ts` style.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/staff-mark-status.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.