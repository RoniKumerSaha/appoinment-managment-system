---
title: 'E5-S3 — Receptionist cancellation with reason'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-2-patient-cancellation.md'
  - '_bmad-output/implementation-artifacts/spec-5-2-doctor-cancellation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A receptionist cancels a Scheduled appointment on
behalf of a patient (F-14, BR-036 / FR-034). The receptionist MUST
provide a reason. The slot is released (BR-053, FR-050) and an
audit row is written with `metadata = {reason}`. Cancellation is
restricted to the receptionist's assigned branch (server-side).

**Approach:** Add ONE new route:

1. **`POST /reception/appointments/:id/cancel` (NEW)** — atomic
   cancel with reason. The handler:
   - `SELECT ... FOR UPDATE` on the appointment row by id.
   - Role gate (server-trusted, body-ignored): if `claim.role` is
     `receptionist`, the appointment's branch MUST be in
     `claim.branch_ids`. Otherwise → 403 `outside_branch_scope`.
   - Reason gate (FR-034): the body's `reason` field MUST be a
     non-empty string trimmed of whitespace, ≤ 500 chars. Missing
     or empty → 400 `reason_required`; > 500 chars → 400
     `reason_too_long` (same envelope as E5-S2 — both staff flows
     share the same reason-validation contract).
   - Status gate: only `Scheduled` rows can be cancelled.
     Already-Cancelled / Completed / No-Show → 422
     `already_in_terminal_state` (same envelope as E5-S1 / E5-S2;
     staff flows share this terminal-state envelope).
   - `UPDATE appointment SET status = 'Cancelled'` — slot is
     released by the GIST exclusion (scoped on
     `status='Scheduled'`).
   - `INSERT appointment_audit` (`actor_role='receptionist'`,
     `actor_id='staff:<claim.sub>'`, `event='cancelled'`,
     `payload={reason: <trimmed string>}`).
   - `COMMIT` and respond 200 with the updated appointment row.

**Boundaries & Constraints**

**Always:**
- The cancel is atomic: `SELECT FOR UPDATE` + UPDATE + audit
  INSERT in a single BEGIN/COMMIT block. If the audit INSERT
  fails, the status change rolls back.
- Receptionist scope: `appt.branch_id ∈ claim.branch_ids`. The
  receptionist's `branch_ids` carries exactly one branch per
  BR-004; the membership check enforces the same. The receptionist's
  `branch_ids` is the only scope gate — there is no doctor-scope
  check (a receptionist cancels ANY appointment at their branch,
  regardless of which doctor is on the row).
- The reason is required (FR-034). Both staff cancel flows
  (E5-S2 + E5-S3) share the same reason-validation contract.
- Only `Scheduled` rows are cancellable. Terminal states →
  422 `already_in_terminal_state`.
- The slot is released by the UPDATE itself (BR-053, FR-050).
- The reason is stored in the audit `payload` as
  `{reason: <trimmed>}`. The reason is NOT stored on the
  appointment row itself (BR-038: appointments are append-only).
- Auth: `claim.role === 'receptionist'` only. Patient → 403
  `forbidden_role` (E4-S2 is the patient cancel). Doctor → 403
  `forbidden_role` (E5-S2 is the doctor cancel). Admin → 403
  `forbidden_role`.
- The route path is `/reception/appointments/:id/cancel` — NOT
  `/appointments/:id/cancel` (which is the doctor flow from E5-S2).
  The path mirrors the receptionist's other UI surfaces
  (E5-S4's `/reception/branch/today`). Same path shape as E5-S2
  (`/appointments/:id/cancel`) was rejected because it would
  conflict with the doctor route's role gate; routing two role
  gates to the same path requires a discriminator that doesn't
  exist in our router stack today.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E5-S3 + PRD BR-036 + FR-034 + F-14.)

**Never:**
- No DELETE on the appointment row (BR-038). The transition is
  always Scheduled → Cancelled.
- No optional / missing reason. FR-034 says the receptionist
  MUST provide one. Empty string / whitespace-only / missing
  key → 400 `reason_required`.
- No bulk cancel. One appointment per request.
- No list endpoint on this story. The receptionist's "today"
  queue is E5-S4.
- No route on behalf of others across branches. Receptionist
  is bound to their assigned branch server-side (BR-004).
- No doctor-scope check. A receptionist can cancel an
  appointment at their branch regardless of which doctor the
  appointment is with (BR-004).

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Receptionist cancels Scheduled at own branch | receptionist JWT, branch_ids=[east] | `:id=<branch-east Scheduled>`, `reason="Patient no-show"` | `200 {appointment: {... status:'Cancelled'}}` + audit row | happy path |
| Receptionist cancels Scheduled — reason is unicode / multi-byte | receptionist | `reason="Patient withdrew (اعتذر)"` | `200` | reason is a string; UTF-8 safe |
| Receptionist cancels Scheduled — reason at 500 chars | receptionist | `reason=<500 'x'>` | `200` | upper bound |
| Receptionist cancels Scheduled — reason at 501 chars | receptionist | `reason=<501 'x'>` | `400 reason_too_long` | length cap |
| Receptionist cancels Scheduled — empty reason | receptionist | `reason=""` | `400 reason_required` | FR-034 |
| Receptionist cancels Scheduled — whitespace-only reason | receptionist | `reason="   "` | `400 reason_required` | trimmed check |
| Receptionist cancels Scheduled — missing reason | receptionist | body `{}` | `400 reason_required` | FR-034 |
| Receptionist cancels already-Cancelled | receptionist | `:id=<cancelled row>` | `422 already_in_terminal_state` | idempotent-ish |
| Receptionist cancels Completed | receptionist | `:id=<completed row>` | `422 already_in_terminal_state` | terminal |
| Receptionist cancels No-Show | receptionist | `:id=<no-show row>` | `422 already_in_terminal_state` | terminal |
| Receptionist at branch-west cancels branch-east appointment | receptionist-west | `:id=<branch-east Scheduled>` | `403 outside_branch_scope` | BR-004 |
| Slot becomes available after cancel | — | re-query /availability at the slot's time | slot visible in new availability | BR-053 / FR-050 |
| Doctor JWT | doctor | any | `403 forbidden_role` | wrong role — E5-S2 is the doctor flow |
| Patient JWT | patient | any | `403 forbidden_role` | wrong role |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Malformed UUID | receptionist | `:id=not-a-uuid` | `404 not_found` | route doesn't reveal existence |
| Unknown id | receptionist | `:id=<random uuid>` | `404 not_found` | route doesn't reveal existence |
| Audit row inspection | — | — | `actor_role='receptionist'`, `actor_id='staff:<sub>'`, `event='cancelled'`, `payload={reason: '...'}` | FR-034 |
| Reason trim check | receptionist | `reason="   trimmed reason   "` | `200`, audit `payload.reason = "trimmed reason"` | mirrors E5-S2 |

## Code Map

- `apps/api/src/routes/staff-receptionist-cancel.ts` (NEW) — POST
  /reception/appointments/:id/cancel handler.
- `apps/api/src/app.ts` (MODIFIED) — mount
  `staffReceptionistCancelRouter` after authMiddleware (NOT under
  `/admin/*` — this is a staff route).
- `apps/api/test/staff-receptionist-cancel.test.ts` (NEW) —
  integration tests for the I/O matrix.

**No new migration.** The schema has every column we need.

**Atomic receptionist-cancel SQL flow:**
```sql
-- 1. Lock the appointment row.
SELECT id, doctor_id, branch_id, status FROM appointment
 WHERE id = $1::uuid
   FOR UPDATE;
-- (route checks: row found AND branch-scope match AND status='Scheduled')
-- 2. Transition status.
UPDATE appointment SET status = 'Cancelled' WHERE id = $1::uuid;
-- 3. Audit row.
INSERT INTO appointment_audit
  (appointment_id, actor_role, actor_id, event, payload)
VALUES ($1::uuid, 'receptionist', 'staff:<sub>', 'cancelled',
        jsonb_build_object('reason', $2));
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/staff-receptionist-cancel.ts` — POST
  /reception/appointments/:id/cancel handler.
- [ ] `apps/api/src/app.ts` — mount after authMiddleware.
- [ ] `apps/api/test/staff-receptionist-cancel.test.ts` —
  integration tests.

**Acceptance Criteria:**
- Given a receptionist JWT for `claim.branch_ids=[branch-X]` and an appointment at branch-X with `status='Scheduled'`, when POST `/reception/appointments/:id/cancel` is invoked with `reason="<non-empty trimmed string>"`, then 200 with the updated appointment row (status='Cancelled') and an audit row with `actor_role='receptionist'`, `actor_id='staff:<sub>'`, `event='cancelled'`, `payload={"reason": "<trimmed>"}`.
- Given any staff JWT and an appointment with `status ∈ {Cancelled, Completed, No-Show}`, when POST `/reception/appointments/:id/cancel` is invoked, then 422 already_in_terminal_state.
- Given a receptionist JWT whose `claim.branch_ids` does not include `appointment.branch_id`, when POST `/reception/appointments/:id/cancel` is invoked, then 403 outside_branch_scope.
- Given a receptionist JWT and a missing / empty / whitespace-only `reason`, when POST `/reception/appointments/:id/cancel` is invoked, then 400 reason_required.
- Given a receptionist JWT and a `reason` longer than 500 chars, when POST `/reception/appointments/:id/cancel` is invoked, then 400 reason_too_long.
- Given a patient / admin / doctor JWT, when POST `/reception/appointments/:id/cancel` is invoked, then 403 forbidden_role.
- Given an anonymous caller, when POST `/reception/appointments/:id/cancel` is invoked, then 401 unauthenticated.
- After a successful cancel, the cancelled slot is available for re-booking via POST /bookings (BR-053 / FR-050).
- A receptionist can cancel an appointment at their branch regardless of which doctor is on the appointment row (BR-004).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/staff-receptionist-cancel.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.