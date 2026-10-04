---
title: 'E3-S5 — Receptionist reads doctor availability'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-3-1-availability-engine.md'
  - '_bmad-output/implementation-artifacts/spec-3-4-receptionist-booking-on-behalf-of-patient.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A receptionist needs to check open slots before booking
on behalf of a patient (F-15). The existing `GET /availability` route
from E3-S1 already returns `{slots: [...]}` for any authenticated caller,
but it accepts any `(doctor_id, branch_id)` pair. The receptionist flow
must enforce BR-004 (receptionist → exactly one branch) at the
availability surface too: a receptionist at branch-east cannot probe
branch-west availability.

**Approach:** Extend `GET /availability` with the same branch-scope
gate used in E3-S4's `POST /bookings`:

1. **Branch-scope gate (NEW):** the `branch_id` query param MUST be
   present in `req.auth.claim.branch_ids` when `claim.role ===
   'receptionist'`. Otherwise `403 outside_branch_scope`.
2. **Doctor-at-branch rule (already exists):** the engine's
   `doctor_not_at_branch` 400 envelope (E3-S1) already rejects a
   `(doctor_id, branch_id)` pair where the doctor isn't assigned to
   the branch. No change needed for the doctor filter — the
   receptionist will simply receive 400 doctor_not_at_branch if
   they pick a doctor not assigned to their branch. (The UI is
   expected to filter the doctor dropdown client-side; the server
   gate is the safety net.)
3. **No-PII-by-default (already satisfied):** E3-S1's response shape
   is `{slots: [{start_datetime, end_datetime}, ...], reason?: ...}`
   — no patient names, no phone numbers. The "no PII beyond
   first-name initial" UX rule is satisfied by construction because
   the response contains zero patient fields.

**Boundaries & Constraints**

**Always:**
- The branch-scope gate fires BEFORE the engine call. No DB work
  for the rejected branch.
- Patients, doctors, and admins are unaffected; their branch-scope
  semantics are out of scope for E3-S5.
- The route stays open to any authenticated caller; only the
  receptionist branch-scope branches off `claim.role`.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E3-S5 +
  UX-FLOWS §F-15.)

**Never:**
- No new route. E3-S5 stays on `GET /availability`.
- No date-range expansion. The route still answers a single date;
  range support is a future enhancement (per E3-S1 SC2 deferral
  matrix).
- No PII expansion. The response shape stays as E3-S1 defined it.
- No booking logic. Receptionist availability is read-only.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Receptionist reads assigned branch | `role='receptionist'`, branch_ids=[East] | branch_id=East | `200 {slots: [...]}` | happy path |
| Receptionist reads OTHER branch | same | branch_id=West | `403 outside_branch_scope` | no DB work |
| Receptionist reads doctor at OTHER branch | `role='receptionist'`, branch_ids=[East] | doctor_id=west-lead, branch_id=East | `400 doctor_not_at_branch` | engine already enforces |
| Patient JWT unchanged | `role='patient'`, scope='self' | any branch | `200 {slots: [...]}` | no gate |
| Doctor JWT unchanged | `role='doctor'`, scope='self' | any branch | `200 {slots: [...]}` | no gate |
| Admin JWT unchanged | `role='admin'`, scope='clinic' | any branch | `200 {slots: [...]}` | no gate |
| Anonymous | none | any | `401 unauthenticated` | unchanged |
| Invalid UUID / date / etc. | any | malformed | `400 invalid_*` envelopes from E3-S1 | unchanged |

## Code Map

- `apps/api/src/routes/availability.ts` (MODIFIED) — branch-scope gate
  added immediately after the E3-S1 validators (after UUID/date/phone
  checks, before `computeAvailability`). Position is consistent with
  E3-S4's POST /bookings gate (after `validateCreateBookingBody`,
  before any DB work): a malformed `branch_id` query always 400s
  invalid_branch_id (consistent with how any other malformed query
  parameter 400s); a well-formed `branch_id` outside the receptionist's
  `branch_ids` 403s outside_branch_scope. The E3-S1 validators and
  engine call are unchanged.
- `apps/api/test/availability-route.test.ts` (MODIFIED) — +4 tests:
  receptionist happy path (asserts slot shape AND no-PII),
  receptionist wrong branch 403, receptionist queries doctor-not-at-
  branch (engine's doctor_not_at_branch — receptionist branch gate
  satisfied, doctor-at-branch rule rejects), control test confirming
  patient JWT bypasses the receptionist branch gate.

**No new migration.** The `doctor_branch` join + the engine's existing
`doctor_not_at_branch` rejection cover everything we need.

**Branch-scope gate (NEW, mirrors E3-S4):**
```typescript
if (
  claim.role === 'receptionist' &&
  !claim.branch_ids.includes(branchId)
) {
  res.status(403).json({ error: 'outside_branch_scope' });
  return;
}
```

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/routes/availability.ts` — branch-scope gate.
- [x] `apps/api/test/availability-route.test.ts` — +4 tests.

**Acceptance Criteria:**
- Given a receptionist JWT with branch_ids=[branch-east], when GET /availability?branch_id=branch-east is invoked, then 200 with `{slots: [...]}` (engine results).
- Given a receptionist JWT with branch_ids=[branch-east], when GET /availability?branch_id=branch-west is invoked, then 403 outside_branch_scope (no engine call, no DB work).
- Given a patient JWT, when GET /availability?branch_id=branch-east is invoked, then 200 (no receptionist gate applies).
- Given a receptionist JWT, when GET /availability?doctor_id=&lt;west-lead&gt;&branch_id=branch-east is invoked, then 400 doctor_not_at_branch (engine enforces).
- Given any caller, when GET /availability is invoked without auth, then 401 unauthenticated.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (Agent code-review pass).

Code review found one blocker (gate placement) and one missing AC test.
Both fixed in this SC:

- **B1 (gate placement):** SC1's Code Map said "gate added immediately
  after auth check, before validation." The first implementation pass
  put the gate after validation. Reviewer correctly flagged the
  deviation. Final placement is AFTER E3-S1 validation, BEFORE
  computeAvailability — consistent with E3-S4's gate positioning.
  This means a receptionist who submits a malformed `branch_id` query
  receives 400 invalid_branch_id (same as any other caller); a
  well-formed but out-of-scope branch_id receives 403. The Code Map
  is amended to match. Reasoning: the gate position is a deliberate
  consistency choice with E3-S4's POST /bookings gate (which fires
  after validateCreateBookingBody, not before). Putting it before
  validation would have made the gate the only pre-validation check
  in the route, which is inconsistent.
- **T1 (missing AC test):** The spec's AC #4 said "Given a receptionist
  JWT, when GET /availability?doctor_id=<west-lead>&branch_id=branch-
  east is invoked, then 400 doctor_not_at_branch." No test covered
  this path. Added a new test asserting the engine's
  `doctor_not_at_branch` envelope fires for the receptionist flow
  when they query a doctor not assigned to their branch.
- **T2 (slot shape pin):** The receptionist happy-path test now
  asserts each slot has start/end ISO timestamps AND that no PII
  fields (patient_name, patient_phone) appear in the response.
  Aligns with the "No PII beyond first-name initial" UX rule from
  F-15.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/availability-route.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.