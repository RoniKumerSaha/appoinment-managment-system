---
title: 'E5-S5 — No deletion (negative test)'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD FR-038 ("no normal appointment deletion") and
Scenario 15, no appointment row may be deleted by any role. The
transition is always Scheduled → Cancelled / Completed / No-Show;
the row stays in the table with the new status. The audit log
preserves the lifecycle.

**Approach:** Add ONE new test file (no new route, no new
migration). The test asserts:

1. **No DELETE on the appointment row from any role.** A
   `DELETE /appointments/:id` request returns 404 (the route
   doesn't exist; the global JSON 404 fallthrough catches it).
2. **No DELETE on the patient-flow appointment route.** A
   `DELETE /patient/appointments/:id` request also returns 404.
3. **No DELETE on the receptionist-flow appointment route.** A
   `DELETE /reception/appointments/:id` request also returns 404.
4. **The row's status is recoverable.** A test that probes an
   already-Cancelled / Completed / No-Show row via the existing
   read routes (e.g. `GET /patient/appointments/:id/deep-link`)
   confirms the row still exists with the terminal status — it
   is NOT deleted.

The test covers every role × every appointment-route shape. The
spec does NOT add a code path; it documents the negative
guarantee and the test that pins it.

**Boundaries & Constraints**

**Always:**
- The appointment row is append-only. Cancel / mark-status
  transitions are status mutations, not row deletions.
- The test asserts the absence of a DELETE route, not its
  presence. The 404 envelope is the global JSON fallthrough
  (`{ error: 'not_found' }`).
- The test covers all five appointment-related route paths:
  - `/appointments/:id` (staff — E5-S1 / E5-S2)
  - `/appointments/:id/cancel` (E5-S2)
  - `/appointments/:id/mark-status` (E5-S1)
  - `/patient/appointments/:id` (E4-S1 / E4-S2)
  - `/patient/appointments/:id/cancel` (E4-S2)
  - `/patient/appointments/:id/reschedule` (E4-S3)
  - `/patient/appointments/:id/deep-link` (E4-S4)
  - `/reception/appointments/:id` (E5-S3)
  - `/reception/appointments/:id/cancel` (E5-S3)
  - `/reception/branch/today` (E5-S4)

  (Not all are tested for DELETE — the test focuses on the
  no-DEL-on-appointment-row guarantee. Cancellation routes that
  transition status are tested indirectly via Scenario 15's
  "no delete path exists for any role" assertion.)

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E5-S5 + PRD FR-038 + Scenario 15.)

**Never:**
- Never add a DELETE handler. This story is a guard, not a
  feature.
- Never store deletion metadata. There is no "soft delete"
  flag; status is the only state machine.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| DELETE /appointments/:id | any role | valid uuid | `404 not_found` | no DELETE handler |
| DELETE /patient/appointments/:id | patient | valid uuid | `404 not_found` | no DELETE handler |
| DELETE /reception/appointments/:id | receptionist | valid uuid | `404 not_found` | no DELETE handler |
| Cancelled row still readable | patient | `GET /patient/appointments/:id/deep-link` for own Cancelled | `200` with `status: 'Cancelled'` | the row is NOT deleted |
| Completed row still readable | patient | `GET /patient/appointments/:id/deep-link` for own Completed | `200` with `status: 'Completed'` | the row is NOT deleted |
| No-Show row still readable | patient | `GET /patient/appointments/:id/deep-link` for own No-Show | `200` with `status: 'No-Show'` | the row is NOT deleted |

## Code Map

- `apps/api/test/no-deletion.test.ts` (NEW) — integration tests
  for the I/O matrix.

**No new route. No new migration.**

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/test/no-deletion.test.ts` — integration tests.

**Acceptance Criteria:**
- Given any role, when DELETE `/appointments/:id` is invoked, then 404 not_found.
- Given a patient JWT, when DELETE `/patient/appointments/:id` is invoked, then 404 not_found.
- Given a receptionist JWT, when DELETE `/reception/appointments/:id` is invoked, then 404 not_found.
- Given a verified patient and an appointment id for their own Cancelled row, when GET `/patient/appointments/:id/deep-link` is invoked, then 200 with `status: 'Cancelled'` (the row is not deleted).
- Given a verified patient and an appointment id for their own Completed row, when GET `/patient/appointments/:id/deep-link` is invoked, then 200 with `status: 'Completed'` (the row is not deleted).
- Given a verified patient and an appointment id for their own No-Show row, when GET `/patient/appointments/:id/deep-link` is invoked, then 200 with `status: 'No-Show'` (the row is not deleted).

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/no-deletion.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.