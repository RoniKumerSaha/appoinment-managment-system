---
title: 'E5-S2 — Doctor cancellation with reason'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-2-patient-cancellation.md'
  - '_bmad-output/implementation-artifacts/spec-5-1-mark-completed-no-show.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A doctor cancels a Scheduled appointment on behalf of a
patient (F-10, Cancel branch). The doctor MUST provide a reason
(BR-037, FR-035). The slot is released (BR-053, FR-050) and an
audit row is written with `metadata = {reason}`.

**Approach:** Add ONE new route:

1. **`POST /appointments/:id/cancel` (NEW, doctor flow)** —
   atomic cancel with reason. The handler:
   - `SELECT ... FOR UPDATE` on the appointment row by id.
   - Role gate (server-trusted, body-ignored): if `claim.role` is
     `doctor`, the appointment's `doctor_id` MUST equal
     `claim.doctor_id` AND the appointment's branch MUST be in
     `claim.branch_ids`. Otherwise → 403 `outside_branch_scope`.
   - Reason gate (FR-035): the body's `reason` field MUST be a
     non-empty string trimmed of whitespace, ≤ 500 chars. Missing
     or empty → 400 `reason_required` (the receptionist flow FR-034
     also requires a reason — the same envelope works for both,
     mirroring how E4-S2 surfaced `not_found_appointment_in_terminal_state`
     for both patient and staff flows).
   - Status gate: only `Scheduled` rows can be cancelled by the
     doctor. Already-Cancelled / Completed / No-Show → 422
     `already_in_terminal_state` (a distinct envelope from the
     patient-facing `not_found_appointment_in_terminal_state` for
     the same reason as E5-S1: the staff flow sees the row in
     their queue).
   - `UPDATE appointment SET status = 'Cancelled'` — slot is
     released because the GIST exclusion is scoped on
     `status='Scheduled'` (per 0008).
   - `INSERT appointment_audit` (`actor_role='doctor'`,
     `actor_id='staff:<claim.sub>'`, `event='cancelled'`,
     `payload={reason: <trimmed string>}`).
   - `COMMIT` and respond 200 with the updated appointment row.

**Boundaries & Constraints**

**Always:**
- The cancel is atomic: `SELECT FOR UPDATE` + UPDATE + audit
  INSERT in a single BEGIN/COMMIT block. If the audit INSERT
  fails, the status change rolls back.
- Doctor scope is doubly-bound: `appt.doctor_id = claim.doctor_id`
  AND `appt.branch_id ∈ claim.branch_ids`. A doctor assigned to
  branch-east cannot cancel branch-west appointments, even if both
  branches share an admin.
- The reason is required (FR-035). The receptionist flow (E5-S3)
  uses the same FR-034 — both staff flows converge on the same
  reason-validation contract.
- Only `Scheduled` rows are cancellable. Terminal states
  (Cancelled / Completed / No-Show) → 422
  `already_in_terminal_state`.
- The slot is released by the UPDATE itself (BR-053, FR-050):
  the GIST exclusion constraint scoped on `status='Scheduled'`
  means a `Cancelled` row no longer blocks the time range.
- The reason is stored in the audit `payload` as
  `{reason: <trimmed>}`. The reason is NOT stored on the
  appointment row itself (BR-038: appointments are append-only;
  the reason lives in the audit log).
- Auth: `claim.role === 'doctor'` only. Patient → 403
  `forbidden_role` (E4-S2 is the patient cancel). Admin → 403
  `forbidden_role` (admin never touches individual appointments
  per PRD §2.4). Receptionist → 403 `forbidden_role` (E5-S3 is
  the receptionist cancel).
- The route path `/appointments/:id/cancel` is intentionally NOT
  under `/patient/*` — it's a staff route. E4-S2 owns
  `/patient/appointments/:id/cancel` for the patient flow; this
  story owns `/appointments/:id/cancel` for the doctor flow.
  Same path shape, different role gate.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E5-S2 + PRD BR-037 + FR-035 + F-10.)

**Never:**
- No DELETE on the appointment row (BR-038). The transition is
  always Scheduled → Cancelled.
- No optional / missing reason. FR-035 says the doctor MUST
  provide one. Empty string / whitespace-only / missing key →
  400 `reason_required`.
- No bulk cancel. One appointment per request.
- No list endpoint on this story. The doctor's "today" queue
  is out of scope (E5-S4 covers the receptionist's; the doctor's
  dashboard is part of the broader doctor work surface — out of
  scope today).
- No route on behalf of others across branches. Doctor is bound
  to their assigned branches server-side.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Doctor cancels own Scheduled | doctor JWT, sub=`doctor-east-lead` | `:id=<own future Scheduled>`, `reason="Patient requested reschedule"` | `200 {appointment: {... status:'Cancelled'}}` + audit row | happy path |
| Doctor cancels Scheduled — reason is unicode / multi-byte | doctor | `reason="Patient withdrew (اعتذر المريض)"` | `200` | reason is a string; UTF-8 safe |
| Doctor cancels Scheduled — reason at 500 chars | doctor | `reason=<500 'x'>` | `200` | upper bound |
| Doctor cancels Scheduled — reason at 501 chars | doctor | `reason=<501 'x'>` | `400 reason_too_long` | length cap |
| Doctor cancels Scheduled — empty reason | doctor | `reason=""` | `400 reason_required` | FR-035 |
| Doctor cancels Scheduled — whitespace-only reason | doctor | `reason="   "` | `400 reason_required` | trimmed check |
| Doctor cancels Scheduled — missing reason | doctor | body `{}` | `400 reason_required` | FR-035 |
| Doctor cancels already-Cancelled | doctor | `:id=<cancelled row>` | `422 already_in_terminal_state` | idempotent-ish |
| Doctor cancels Completed | doctor | `:id=<completed row>` | `422 already_in_terminal_state` | terminal |
| Doctor cancels No-Show | doctor | `:id=<no-show row>` | `422 already_in_terminal_state` | terminal |
| Doctor cancels other doctor's appointment | doctor-east-lead | `:id=<Dr. East Support's appointment>` | `403 outside_branch_scope` | doctor scope |
| Doctor cancels branch-other appointment | doctor-west-lead | `:id=<branch-east appointment>` | `403 outside_branch_scope` | doctor scope |
| Slot becomes available after cancel | — | re-query /availability at the slot's time | slot visible in new availability | BR-053 / FR-050 |
| Patient JWT | patient | any | `403 forbidden_role` | wrong role |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Receptionist JWT | receptionist | any | `403 forbidden_role` | wrong role — E5-S3 is the receptionist flow |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Malformed UUID | doctor | `:id=not-a-uuid` | `404 not_found` | route doesn't reveal existence |
| Unknown id | doctor | `:id=<random uuid>` | `404 not_found` | route doesn't reveal existence |
| Audit row inspection | — | — | `actor_role='doctor'`, `actor_id='staff:<sub>'`, `event='cancelled'`, `payload={reason: '...'}` | FR-035 |

## Code Map

- `apps/api/src/routes/staff-doctor-cancel.ts` (NEW) — POST
  /appointments/:id/cancel handler.
- `apps/api/src/app.ts` (MODIFIED) — mount
  `staffDoctorCancelRouter` after authMiddleware (NOT under
  `/admin/*` — this is a staff route).
- `apps/api/test/staff-doctor-cancel.test.ts` (NEW) —
  integration tests for the I/O matrix.

**No new migration.** The schema has every column we need.

**Atomic doctor-cancel SQL flow:**
```sql
-- 1. Lock the appointment row.
SELECT id, doctor_id, branch_id, status FROM appointment
 WHERE id = $1::uuid
   FOR UPDATE;
-- (route checks: row found AND role-scope match AND status='Scheduled')
-- 2. Transition status.
UPDATE appointment SET status = 'Cancelled' WHERE id = $1::uuid;
-- 3. Audit row.
INSERT INTO appointment_audit
  (appointment_id, actor_role, actor_id, event, payload)
VALUES ($1::uuid, 'doctor', 'staff:<sub>', 'cancelled',
        jsonb_build_object('reason', $2));
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/staff-doctor-cancel.ts` — POST
  /appointments/:id/cancel handler.
- [ ] `apps/api/src/app.ts` — mount after authMiddleware.
- [ ] `apps/api/test/staff-doctor-cancel.test.ts` — integration
  tests.

**Acceptance Criteria:**
- Given a doctor JWT for `claim.doctor_id=X` and an appointment id where `appointment.doctor_id=X`, `appointment.branch_id ∈ claim.branch_ids`, `status='Scheduled'`, when POST `/appointments/:id/cancel` is invoked with `reason="<non-empty trimmed string>"`, then 200 with the updated appointment row (status='Cancelled') and an audit row with `actor_role='doctor'`, `actor_id='staff:<sub>'`, `event='cancelled'`, `payload={"reason": "<trimmed>"}`.
- Given any staff JWT and an appointment with `status ∈ {Cancelled, Completed, No-Show}`, when POST `/appointments/:id/cancel` is invoked, then 422 already_in_terminal_state.
- Given a doctor JWT whose `claim.doctor_id` does not match `appointment.doctor_id`, when POST `/appointments/:id/cancel` is invoked, then 403 outside_branch_scope.
- Given a doctor JWT whose `claim.branch_ids` does not include `appointment.branch_id`, when POST `/appointments/:id/cancel` is invoked, then 403 outside_branch_scope.
- Given a doctor JWT and a missing / empty / whitespace-only `reason`, when POST `/appointments/:id/cancel` is invoked, then 400 reason_required.
- Given a doctor JWT and a `reason` longer than 500 chars, when POST `/appointments/:id/cancel` is invoked, then 400 reason_too_long.
- Given a patient / admin / receptionist JWT, when POST `/appointments/:id/cancel` is invoked, then 403 forbidden_role.
- Given an anonymous caller, when POST `/appointments/:id/cancel` is invoked, then 401 unauthenticated.
- After a successful cancel, the cancelled slot is available for re-booking via POST /bookings (BR-053 / FR-050).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/staff-doctor-cancel.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.