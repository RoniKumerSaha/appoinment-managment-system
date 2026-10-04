---
title: 'E2-S4 — Negative-capability: doctor cannot reschedule ordinary patient appointments'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-2-3-manage-appointment-types.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD §2.2 restrictions and BRD §3.2, doctors cannot reschedule ordinary patient appointments. A doctor's appointment actions are limited to: cancel (with reason), mark completed, mark no-show, and resolve affected (E6-S2). A reschedule action against a normally-booked appointment must not exist in the doctor's UI and must 403 from the API.

This story is a **negative capability** — it locks in an invariant by encoding it as a test, NOT by adding a route. The test runs against today's endpoints and pins:
- A doctor JWT hitting any `/admin/*` route returns 403 forbidden_role (already true via `adminScope` middleware).
- A doctor JWT hitting any plausible patient-reschedule path that DOES NOT yet exist (e.g., `POST /patient/appointments/:id/reschedule`) returns 404 today and will return 403 when E4-S3 ships — the test is forward-compatible via two layers:
  - **Layer 1 (today):** assert the doctor's "reschedule" attempt against the `/admin/*` mount is rejected with 403 forbidden_role (proves the role gate exists).
  - **Layer 2 (E4-S3 lands):** E4-S3 will add a patient-side reschedule route with a role check that excludes `doctor`; when E4-S3 lands, the same test pattern will pin 403 at that route too. (Out of E2-S4 scope; tracked in E4-S3.)

**Approach:** Write a single negative test file `test/doctor-reschedule-negative.test.ts` that asserts:
1. Doctor JWT hitting `POST /admin/appointments/:id/reschedule` (a not-yet-existing admin path that, if it ever exists, must reject doctor) returns 403 forbidden_role via the adminScope gate. (Today's behavior: 404 not_found is acceptable IF the path is undeclared; 403 forbidden_role is acceptable IF the path is declared under `/admin`.)
2. The cleaner invariant — doctor JWT at the future patient-reschedule path `POST /patient/appointments/:id/reschedule` is 404 today (path not declared), and will be 403 once E4-S3 ships with a role check.
3. Static code-search assertion: no source file under `apps/api/src/routes/` exposes a path matching `/doctor/appointments/:id/reschedule` or `/doctor/appointments/:id/move`. The negative capability is enforced by route absence + adminScope middleware; there is no imperative code to write.

**Boundaries & Constraints**

**Always:**
- The test pins the invariant: doctor role cannot reach any code path that would reschedule an ordinary patient appointment.
- The test uses `signClaim({role: 'doctor', scope: 'branch', branch_ids: [<seeded-branch-id>]})` to construct a valid doctor token — `branch_ids` must be non-empty for the auth middleware to accept staff tokens.
- Doctor JWT hitting `/admin/*` MUST 403 forbidden_role (adminScope gate).
- Doctor JWT hitting `/patient/appointments/:id/reschedule` today is 404 not_found; after E4-S3 ships it must be 403 forbidden_role. The E2-S4 test pins the current 404; a future test (E4-S3) will pin 403.

**Ask First:**
- (none — scope resolved at plan-time via epic-1-context.md + epics-and-stories.md E2-S4.)

**Never:**
- No new endpoint added by this story. The negative capability is enforced by route absence + adminScope middleware.
- No code change required; the `adminScope` middleware (mounted in app.ts:88) already returns 403 forbidden_role for any non-admin role hitting `/admin/*`. The role-gate path is complete.
- No DELETE / PATCH / PUT on appointment row for doctor role. The future E5 doctor endpoints (cancel-with-reason, mark completed, mark no-show) will live under `/doctor/*` (not yet mounted) with their own doctor-scope middleware that enforces the limited action set.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Notes |
|----------|--------------|---------------------------|-------|
| Doctor JWT → `POST /admin/appointments/:id/reschedule` | valid doctor token + seeded appointment id | `403 {error: 'forbidden_role'}` | adminScope gate (already enforced today) |
| Doctor JWT → `POST /admin/appointments/:id` (any admin path) | valid doctor token | `403 {error: 'forbidden_role'}` | proves role gate is unconditional |
| Doctor JWT → `POST /patient/appointments/:id/reschedule` (future path) | valid doctor token + seeded appointment id | `404 {error: 'not_found'}` today; `403 {error: 'forbidden_role'}` after E4-S3 | pins current absence; E4-S3 will replace with 403 test |
| Doctor JWT → `PATCH /admin/doctors/:id` | valid doctor token | `403 {error: 'forbidden_role'}` | admin gate |
| Doctor JWT → `GET /admin/clinic` | valid doctor token | `403 {error: 'forbidden_role'}` | admin gate |
| Anonymous → `POST /admin/appointments/:id/reschedule` | no token | `401 {error: 'unauthenticated'}` | auth middleware |
| Static code-search: no `/doctor/appointments/:id/reschedule` route exists | grep across `apps/api/src/routes/` | 0 matches | locks the negative capability at the source level |

## Code Map

- `apps/api/test/doctor-reschedule-negative.test.ts` (NEW) — negative test file pinning the invariant. No source-file changes.

**No new migration.** No source-file changes. The `adminScope` middleware (app.ts:88) already enforces the role gate on `/admin/*`.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/test/doctor-reschedule-negative.test.ts` — negative test file.

**Acceptance Criteria:**
- Given a valid doctor JWT, when `POST /admin/appointments/:id/reschedule` is called, then `403 {error: 'forbidden_role'}` is returned (adminScope gate).
- Given a valid doctor JWT, when `POST /patient/appointments/:id/reschedule` is called, then `404 {error: 'not_found'}` is returned today (path absent; E4-S3 will own the 403 pin).
- Given a static code-search of `apps/api/src/routes/`, when looking for paths matching `/doctor/appointments/:id/reschedule` or `/doctor/appointments/:id/move`, then 0 matches are found.
- Given the new code, when the existing test suites run, then no regression.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/doctor-reschedule-negative.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After constructing a doctor JWT and hitting `POST /admin/appointments/<seeded-id>/reschedule`, the response is 403 forbidden_role.