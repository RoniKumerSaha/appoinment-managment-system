---
title: 'E3-S4 — Receptionist booking on behalf of patient'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-3-2-guest-booking-first-time.md'
  - '_bmad-output/implementation-artifacts/spec-3-3-returning-patient-booking-known-phone.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A receptionist needs to book an appointment for a walk-in or
phone patient. Today, E3-S2's `POST /bookings` accepts any authenticated
caller and pins the audit row to `actor_role='patient'` /
`actor_id='patient:<phone>'`. That is wrong for the receptionist flow —
the audit row should reflect who actually pressed the button, and the
branch should be locked to the receptionist's assignment (BR-004: a
receptionist is assigned to exactly one branch).

**Approach:** Extend `POST /bookings` to switch behavior when the
caller's `claim.role === 'receptionist'`:

1. **Branch scope gate (NEW):** the `body.branch_id` MUST be present in
   `req.auth.claim.branch_ids`. Otherwise `403 outside_branch_scope`.
   Admins and doctors are unaffected (admins have `scope: 'clinic'` and
   may book anywhere; doctors can self-book at any of their branches via
   the patient flow — out of scope for E3-S4).
2. **Audit attribution (NEW):** when the caller is a receptionist, the
   audit row uses `actor_role='receptionist'` and
   `actor_id='staff:<req.auth.claim.sub>'`. The `created_by` column on
   the `appointment` row also becomes `'staff:<sub>'`.
3. **Audit payload source (NEW):** `payload.source` becomes
   `'receptionist_book'` instead of `'self_book'`. `payload.actor_sub`
   captures the receptionist's `sub` for downstream tooling.

**Boundaries & Constraints**

**Always:**
- The branch lock applies ONLY to `role === 'receptionist'`. Patients
  pick any branch via the form. Doctors and admins bypass the gate
  (their booking paths are out of scope here).
- BR-019 (partial period), BR-031 (one future per patient+doctor), and
  BR-033 (no patient time-overlap) all still hold. The receptionist
  flow has identical conflict checks to the patient self-book flow.
- FR-019 (no same-day) still applies to receptionist bookings.
- The receptionist's branch is the source of truth: if the request
  body says branch East but the receptionist is at branch West, return
  403 — never silently retarget.
- All existing E3-S2 paths (validation, slot re-check, GIST race, audit
  row, patient lifecycle) are unchanged. Only the branch gate + audit
  attribution branch off `claim.role`.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E3-S4 +
  UX-FLOWS F-13.)

**Never:**
- No new route. E3-S4 stays on `POST /bookings`; role is determined from
  the JWT claim. A separate `/receptionist/bookings` would duplicate
  every validator + re-check + audit shape.
- No branch retargeting. If the receptionist submits the wrong branch,
  we surface 403; we do not silently override.
- No change to FR-022/FR-023 invariants. Phone is still the patient
  key; the name UPDATE on returning patients still runs.
- No additional audit columns. The actor_role + actor_id + payload
  fields are sufficient to identify the receptionist.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Receptionist happy path | `role='receptionist'`, branch_ids=[East] | branch=East, valid slot | `201` + audit row with `actor_role='receptionist'`, `actor_id='staff:<sub>'`, `payload.source='receptionist_book'`; appointment.created_by='staff:\<sub\>' | new patient |
| Receptionist returns existing patient | same | phone=seeded, name typed | `201` + audit row, patient.full_name updated per FR-023 | E3-S3 path |
| Receptionist at wrong branch | same | branch=West (not in branch_ids) | `403 outside_branch_scope` | never retargets |
| Patient JWT still works | `role='patient'`, scope='self' | any branch | unchanged from E3-S2 | branch_ids=[] for patients |
| Doctor JWT still works | `role='doctor'`, scope='self' | any branch | unchanged from E3-S2 | no branch gate today |
| Admin JWT still works | `role='admin'`, scope='clinic' | any branch | unchanged from E3-S2 | clinic-scope override |
| Same-day rule | receptionist | start=today | `409 slot_in_past` | identical to E3-S2 |
| 30-day window | receptionist | start=today+31d | `409 outside_30d_window` | identical to E3-S2 |
| Patient FR-027 conflict | receptionist | phone has future with same doctor | `409 patient_has_future_with_doctor` | identical to E3-S2 |
| Patient FR-029 overlap | receptionist | phone has overlapping Scheduled | `409 patient_time_conflict` | identical to E3-S2 |
| No auth | anonymous | any | `401 unauthenticated` | identical to E3-S2 |
| Validation: missing branch_id | receptionist | body missing branch_id | `400 invalid_branch_id` | identical to E3-S2 |
| Validation: invalid phone | receptionist | body.phone='555-0000' | `400 invalid_patient_phone` | identical to E3-S2 |

## Code Map

- `apps/api/src/routes/bookings.ts` (MODIFIED) — branch-scope gate +
  audit/created_by branches based on `claim.role`. The rest of the
  route is unchanged.
- `apps/api/test/bookings.test.ts` (MODIFIED) — +5 tests covering the
  receptionist happy path (with column-level actor_role + actor_id
  pins on the audit row, plus payload.source/actor_sub), branch-scope
  403 negative test (no DB writes), patient JWT bypasses gate control
  test, returning-patient receptionist path (UPDATE fires + source =
  receptionist_book), and same-day rule still applies (FR-019).
  Each test uses a unique receptionist `sub` and appointment_id-scoped
  cleanup so test execution order is independent.

**No new migration.** The `appointment.created_by` column already
accepts any actor-prefixed string.

**Branch scope gate (NEW):**
```typescript
if (
  claim.role === 'receptionist' &&
  !claim.branch_ids.includes(body.branch_id)
) {
  res.status(403).json({ error: 'outside_branch_scope' });
  return;
}
```

**Audit attribution (NEW):**
```typescript
const isReceptionist = claim.role === 'receptionist';
const actorSub = claim.sub; // receptionist's sub is the JWT subject
const createdBy = isReceptionist ? `staff:${actorSub}` : `patient:${body.patient_phone}`;
// ... INSERT_APPOINTMENT_SQL uses createdBy ...

const auditActorRole = isReceptionist ? 'receptionist' : 'patient';
const auditActorId = createdBy;
// ... INSERT_AUDIT_SQL uses auditActorRole + auditActorId + event='created' ...

const auditPayload = JSON.stringify({
  start_datetime: ...,
  end_datetime: ...,
  appointment_type_id: ...,
  doctor_id: ...,
  branch_id: ...,
  source: isReceptionist ? 'receptionist_book' : 'self_book',
  patient_name_after: patientNameAfter,
  // receptionist-only field; absent for self_book
  ...(isReceptionist ? { actor_sub: actorSub } : {}),
});
```

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/routes/bookings.ts` — branch-scope gate + audit attribution branches.
- [x] `apps/api/test/bookings.test.ts` — +5 tests for the receptionist path.

**Acceptance Criteria:**
- Given a receptionist JWT with branch_ids=[branch-east], when POST /bookings is invoked with branch_id=branch-east, then 201 and the audit row's actor_role='receptionist' and actor_id='staff:<sub>'.
- Given a receptionist JWT with branch_ids=[branch-east], when POST /bookings is invoked with branch_id=branch-west, then 403 outside_branch_scope (no DB write).
- Given a patient JWT, when POST /bookings is invoked with any branch_id, then 201 (no branch gate applies to non-receptionists).
- Given a receptionist booking a returning patient, when the request completes, then patient.full_name is updated per FR-023 and the audit payload carries patient_name_after.
- Given any caller (any role), when POST /bookings is invoked with start_datetime in the past, then 409 slot_in_past.
- Given a receptionist JWT, when POST /bookings is invoked, then appointment.created_by='staff:<sub>' and payload.source='receptionist_book'.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (Agent code-review pass).

Code review found no blockers in production code; the implementation
matched the spec. Two test-coverage patches applied:

- **T1 (test count correction):** SC1 code-map stated "+6 tests" but
  the implementation produced +5 tests, with the happy-path test
  folded in the column-level actor_role + actor_id pins (which SC1
  framed as a separate test). Code map corrected to "+5 tests" and
  the happy-path test description now explicitly mentions the
  column-level pin.
- **T2 (test isolation hardening):** Each receptionist test now uses
  a unique `sub` (e.g., `receptionist-east-happy`,
  `receptionist-east-403`, `receptionist-east-returning`) and scopes
  cleanup by `appointment_id` instead of `actor_id LIKE
  'staff:%'`. Removes cross-test coupling and makes the negative test
  robust against test-order permutations.

The route code itself was clean — no production patches.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/bookings.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- A receptionist at branch-east cannot book at branch-west (403).
- The audit row for a receptionist booking carries actor_role='receptionist' and actor_id='staff:receptionist-east'.