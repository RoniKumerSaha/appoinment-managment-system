---
title: 'E7-S2 — Appointment audit reads (FR-051, NFR-005)'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - 'apps/api/db/migrations/0009_appointment_audit.sql'
  - '_bmad-output/implementation-artifacts/spec-6-2-doctor-conflict-move.md'
  - '_bmad-output/implementation-artifacts/spec-6-4-recurring-occurrence-cancel-reschedule.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD FR-051 ("The system shall write an
appointment audit trail for every important appointment
event") + NFR-005 ("internal-only audit access"), every
appointment event writes one row in `appointment_audit`
(E4-S2, E4-S3, E5-S1, E5-S2, E5-S3, E6-S1, E6-S2). The audit
is the source of truth for "what happened to this
appointment". Without read endpoints, the audit row is
write-only and unreachable.

This story ships the **read side** of the audit table:

- **`GET /doctor/appointments/:id/audit`** — doctor reads
  audit rows for an appointment they OWN
  (`appointment.doctor_id = claim.doctor_id`). Limited to
  the doctor's own appointments — no other-doctor reads.
- **`GET /reception/appointments/:id/audit`** — receptionist
  reads audit rows for an appointment at their branch
  (`appointment.branch_id ∈ claim.branch_ids`). Limited to
  the receptionist's branch.
- **`GET /admin/audit`** — admin reads **configuration
  audit only** (NOT individual appointment audits per PRD
  §2.4: "Admin never touches individual appointments").
  For E7-S2, this route returns a generic
  `{appointments_audit_reads: "rejected_per_role_policy"}`
  response that documents the policy — there is no admin
  appointment-audit endpoint to ship today.

**Why the admin surface is empty:** The PRD §2.4
("Administrator role scope") explicitly excludes
individual-appointment reads from the admin role. The
admin reads *configuration* audit (Doctor / DoctorBranch /
Branch / Receptionist / schedule / block / branch-hours),
but those audit tables don't exist yet (E1-S1 / E1-S2 set
the precedent of no admin audit; the audit table from
E7-S2 covers appointments only). A future E8 hardening
story could add `configuration_audit` for admin
configuration reads — deferred (W51).

**Approach:** Add THREE new routes + ZERO new migrations:

1. **`GET /doctor/appointments/:id/audit`** (NEW) — list
   audit rows for an appointment, doctor-scoped.
2. **`GET /reception/appointments/:id/audit`** (NEW) — list
   audit rows for an appointment, branch-scoped.
3. **`GET /admin/audit`** (NEW) — returns the policy
   envelope documenting why appointment-audit is not
   exposed to admin. The endpoint exists so the admin
   surface doesn't 404 on the spec's expected path.

The audit table (`0009_appointment_audit.sql`) already
exists with the columns this story reads:
`id, appointment_id, actor_role, actor_id, event, payload,
created_at`. The `patient_phone` is read from the
`appointment` table via a JOIN (the audit row's
`appointment_id` resolves to the source appointment). No
schema change.

## Boundaries & Constraints

**Always:**
- The doctor's audit read is doubly-bound to the doctor's
  own appointments: the appointment row's `doctor_id` must
  equal `claim.doctor_id`. If not, 403 outside_branch_scope
  (NOT 404 — doctors are part of the model so a 404 would
  hide existence from colleagues).
- The receptionist's audit read is branch-scoped: the
  appointment row's `branch_id` must be in
  `claim.branch_ids`. If not, 403 outside_branch_scope.
- The patient role has NO audit read endpoint. Patient
  audit access would leak PII (the patient phone and the
  doctor / receptionist notes in the payload). NFR-005
  is "internal-only"; patients see their appointments via
  E4-S1 (upcoming) and E4-S4 (deep-link), not audit.
- The admin role has NO appointment-audit read endpoint.
  PRD §2.4 forbids admin from touching individual
  appointments. The `GET /admin/audit` endpoint exists to
  document the policy and surface the rejection envelope.
- The audit response includes the `payload jsonb` column
  AS-IS (no filtering, no redaction). Internal consumers
  are trusted.
- The audit response includes `patient_phone` (joined from
  the source `appointment` row via `appointment_id`).
  Internal consumers see it; the patient never sees audit.
- Pagination: the endpoint returns at most 200 rows in a
  single response. The `count` field reflects the full
  set before LIMIT. The patient / staff UI is expected to
  read the most recent N audit rows; the "view all"
  affordance is the frontend's responsibility.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E7-S2 + PRD FR-051 + NFR-005 + §2.4.)

**Never:**
- No admin / patient reads of appointment audit data. The
  admin / patient surfaces are explicit rejects per PRD.
- No PII redaction in the payload. Internal consumers
  (doctor / receptionist) are trusted with the full
  payload jsonb.
- No filtering by `event` in the response. The audit log
  is intentionally an unfiltered timeline.
- No migration. The audit table is in place since 0009.
- No new column on `appointment_audit`. The existing
  schema is sufficient.

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Doctor reads own appt audit | doctor | `GET /doctor/appointments/<own>/audit` | `200 {appointment_id, count, audit: [...]}` | happy path |
| Doctor reads other doctor's appt audit | doctor | `GET /doctor/appointments/<other>/audit` | `403 outside_branch_scope` | role + ownership gate |
| Doctor reads non-existent id | doctor | random uuid | `404 not_found` | privacy envelope |
| Doctor reads malformed id | doctor | non-uuid | `404 not_found` | privacy envelope |
| Receptionist reads own-branch appt audit | receptionist | `GET /reception/appointments/<own-branch>/audit` | `200` | happy path |
| Receptionist reads other-branch appt audit | receptionist | `GET /reception/appointments/<other-branch>/audit` | `403 outside_branch_scope` | role + branch gate |
| Admin reads /admin/audit | admin | `GET /admin/audit` | `200 {appointments_audit_reads: "rejected_per_role_policy", reason: "..."}` | policy envelope |
| Patient reads audit | patient | `GET /doctor/appointments/<id>/audit` | `403 forbidden_role` | no patient surface |
| Anonymous reads audit | none | any | `401 unauthenticated` | auth gate |
| Audit row contains `recurring_origin` | — | recurring appt cancel/reschedule | payload echoes recurring_origin verbatim | E6-S4 |
| Audit row contains `moved_by_doctor` | — | doctor conflict move | payload echoes from/to/branch_change/type_change | E6-S2 |
| Audit row contains `recurring_created` | — | recurring confirm | payload echoes series_id/recurrence_kind/occurrence_index | E6-S1 |

## Code Map

- `apps/api/src/routes/doctor-appointment-audit.ts` (NEW) —
  GET /doctor/appointments/:id/audit. Doctor-only role gate;
  ownership check.
- `apps/api/src/routes/reception-appointment-audit.ts` (NEW)
  — GET /reception/appointments/:id/audit. Receptionist-only
  role gate; branch-scope check.
- `apps/api/src/routes/admin-audit.ts` (NEW) — GET
  /admin/audit. Admin-only; returns the policy envelope.
- `apps/api/src/app.ts` (MODIFIED) — mount all three routers
  after authMiddleware.
- `apps/api/test/appointment-audit-reads.test.ts` (NEW) —
  integration tests.

**No new migration.** Reads existing `appointment_audit`
table from 0009.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/doctor-appointment-audit.ts` —
  GET /doctor/appointments/:id/audit.
- [ ] `apps/api/src/routes/reception-appointment-audit.ts` —
  GET /reception/appointments/:id/audit.
- [ ] `apps/api/src/routes/admin-audit.ts` — GET
  /admin/audit (policy envelope).
- [ ] `apps/api/src/app.ts` — mount all three routers after
  authMiddleware.
- [ ] `apps/api/test/appointment-audit-reads.test.ts` —
  integration tests.

**Acceptance Criteria:**
- Given a doctor JWT for `claim.doctor_id=X` and an appointment at doctor X, when GET /doctor/appointments/:id/audit is invoked, then 200 with `{appointment_id, count, audit: [...]}` listing the audit rows in chronological order.
- Given a doctor JWT and an appointment at another doctor, when GET /doctor/appointments/:id/audit is invoked, then 403 outside_branch_scope.
- Given a receptionist JWT and an appointment at the receptionist's branch, when GET /reception/appointments/:id/audit is invoked, then 200 with the audit rows.
- Given a receptionist JWT and an appointment at another branch, when GET /reception/appointments/:id/audit is invoked, then 403 outside_branch_scope.
- Given an admin JWT, when GET /admin/audit is invoked, then 200 with `{appointments_audit_reads: 'rejected_per_role_policy'}`.
- Given a patient JWT, when any audit read is invoked, then 403 forbidden_role.
- Given an anonymous caller, when any audit read is invoked, then 401 unauthenticated.
- Given a doctor JWT and an audit row with `payload: {recurring_origin: {series_id: S}}` (E6-S4 enrichment), when the audit is read, then the payload is echoed verbatim in the response.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review. Patches:

- N1: The audit `patient_phone` is JOINed from the
  `appointment` row (the audit table's columns per 0009 are
  `id, appointment_id, actor_role, actor_id, event, payload,
  created_at` — `patient_phone` is NOT an audit column).
  The spec's "patient_phone is the audit row's column"
  wording was corrected: the column is read from the
  source `appointment` row via a LEFT JOIN.
- N2: The admin policy envelope is a 200 with a
  documentation body, not a 403. The admin IS allowed to
  hit `/admin/*`; the policy rejection is on the DATA,
  not the ROLE. A 403 would be misleading.
- N3: The doctor / receptionist routes are read-only and
  share the same `MAX_AUDIT_ROWS = 200` cap. The `count`
  field reflects the full set before LIMIT (so the UI can
  show "5 mutations" without paging).

## Design Notes

**Why three routes, not one shared route with role middleware:**
The three audiences have different privacy envelopes:
- Doctor sees only their own appointments.
- Receptionist sees only their branch.
- Admin sees nothing (policy rejection envelope).
A shared route would need to switch on `claim.role` and
pick the predicate at runtime; three separate routes make
the contract explicit at the route level. Future auditors
(e.g. a developer running integration tests) can hit the
specific route that matches their role without ambiguity.

**Why the admin route returns 200 with a body, not 403:**
The admin is a valid role; the policy rejection is on the
DATA, not the ROLE. Returning 403 would be misleading (the
admin IS allowed to hit `/admin/*`; the admin is NOT
allowed to read individual appointment audits). A 200 with
a documented envelope lets the admin UI surface the policy
explanatory text in the admin's "Audit" tab without a 4xx
fall-through.

**Why pagination cap is 200:** The audit log for a single
appointment is bounded by the number of mutations
(create + N cancels + M reschedules + 1 status change).
200 is well above the realistic max; future hardening
could add cursor-based pagination (W52 — deferred).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/appointment-audit-reads.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.