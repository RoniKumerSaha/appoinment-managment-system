---
title: 'E4-S4 — Deep-link entry to cancel / reschedule'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-1-patient-otp-verification-upcoming-appointments.md'
  - '_bmad-output/implementation-artifacts/spec-4-2-patient-cancellation.md'
  - '_bmad-output/implementation-artifacts/spec-4-3-patient-rescheduling.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Staff-generated deep links (for MVP, out-of-app
notification/email delivery is out of scope) must land a verified
patient directly on the cancel or reschedule modal for a specific
appointment id. The route must exist and must respect E7-S3:
- A link with an unknown appointment id is treated as a 404.
- A link for an appointment the phone does not own is rejected at
  the server before any PII leaks (matches the E7-S3 privacy
  filter applied by E4-S2 / E4-S3).

**Approach:** Add ONE new route:

1. **`GET /patient/appointments/:id/deep-link` (NEW)** — returns
   metadata about a deep-link target so the client can route the
   verified patient directly into the right modal after OTP
   verification. The route is authenticated (requires a patient
   JWT, like E4-S2 / E4-S3) so the privacy filter runs server-side
   via `claim.sub` (E7-S3). The response tells the client which
   modals to surface (`can_cancel`, `can_reschedule`) based on the
   appointment's current status.

The route does NOT itself perform cancel or reschedule — those are
E4-S2 / E4-S3. The route is a routing hint: it confirms the link
target is valid for the verified patient and returns a 404 if not.

**Why a server-routed deep-link rather than a client-side query
param?** The spec mandates server-side privacy filtering (E7-S3
NFR-007). A client-side `?appointment_id=...` flow would let any
patient enumerate other patients' appointment ids by tapping a
crafted link. Server-side filtering by `claim.sub` keeps the
enumeration surface zero.

**Why a separate route rather than reusing GET
`/patient/appointments/:id`?** The existing
`GET /patient/appointments` returns the verified patient's list
(FR-032 scope: future Scheduled rows only). A "lookup one id" route
would be a different shape and would need its own 404 envelope to
match E4-S2 / E4-S3. Keeping it as `/deep-link` makes the
intent visible in the URL and isolates the actionability metadata
(`can_cancel`, `can_reschedule`).

**Boundaries & Constraints**

**Always:**
- The appointment must belong to the verified patient
  (`patient_phone = claim.sub`). Any other outcome (not found,
  wrong owner) returns 404 — NOT 403, NOT 200 — so a patient
  cannot enumerate other patients' appointments by id (E7-S3).
- The response carries `appointment_id`, `can_cancel`, and
  `can_reschedule` booleans, plus minimal context the client
  needs to render the right modal (`status`, `start_datetime`,
  `end_datetime`, `branch_id`, `doctor_id`,
  `appointment_type_id`). No patient PII beyond what the patient
  already sees on `GET /patient/appointments` (the response
  shapes are aligned).
- `can_cancel = (status === 'Scheduled')`. The terminal-state
  envelope E4-S2 returns is the same semantic — only Scheduled
  rows are cancellable.
- `can_reschedule = (status === 'Scheduled')`. The terminal-state
  envelope E4-S3 returns is the same semantic.
- Auth: `claim.role === 'patient'` only. Doctor / admin /
  receptionist JWTs → 403 (no deep-link entry from staff roles).
- Response is a JSON object — matches the shape of E4-S2 / E4-S3
  responses (200 with `{...}` or 4xx with `{error: '...'}`).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E4-S4 +
  PRD NFR-007 + UX-FLOWS F-03 deep-link trigger.)

**Never:**
- No PII beyond what the verified patient can already see on
  `GET /patient/appointments`. The response carries appointment
  shape (id, doctor, branch, type, start, end, status) — NEVER
  another patient's data, NEVER internal ids like `clinic_id` or
  `created_by`.
- No cancel/reschedule execution. The route is a metadata probe.
- No token minting. The route reuses the existing patient JWT
  (minting is E4-S1's job).
- No batch lookup. One appointment per request.
- No link generation. Staff-generated links are out of scope; the
  route only handles the patient-facing resolution.
- No new migration. The schema has every column we need
  (`appointment.status`, `appointment.start_datetime`, etc.).

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Deep-link to own Scheduled | patient JWT, sub=`+15550000001` | `:id=<seeded future>` | `200 {appointment_id, can_cancel:true, can_reschedule:true, appointment: {...}}` | happy path |
| Deep-link to own Cancelled | patient JWT | `:id=<cancelled row>` | `200 {can_cancel:false, can_reschedule:false, ...}` | terminal state; both modals hidden |
| Deep-link to own Completed | patient JWT | `:id=<completed row>` | `200 {can_cancel:false, can_reschedule:false, ...}` | terminal state |
| Deep-link to own No-Show | patient JWT | `:id=<no-show row>` | `200 {can_cancel:false, can_reschedule:false, ...}` | terminal state |
| Deep-link to unknown id | patient JWT | `:id=<random uuid>` | `404 not_found` | privacy |
| Deep-link to NOT own appointment | patient JWT, sub=`+15550000001` | `:id=<patient 0002's appointment>` | `404 not_found` | privacy: don't reveal existence |
| Deep-link to malformed UUID | patient JWT | `:id=not-a-uuid` | `404 not_found` | privacy |
| Anonymous | no auth | any | `401 unauthenticated` | auth gate |
| Doctor JWT | doctor | any | `403 forbidden_role` | wrong role |
| Admin JWT | admin | any | `403 forbidden_role` | wrong role |
| Receptionist JWT | receptionist | any | `403 forbidden_role` | wrong role |

## Code Map

- `apps/api/src/routes/patient-deep-link.ts` (NEW) — GET
  /patient/appointments/:id/deep-link handler.
- `apps/api/src/app.ts` (MODIFIED) — mount `patientDeepLinkRouter`
  after authMiddleware.
- `apps/api/test/patient-deep-link.test.ts` (NEW) — integration
  tests for the I/O matrix.

**No new migration.** The schema has every column we need.

**SQL (server-side filter by `patient_phone = claim.sub`):**
```sql
SELECT a.id::text AS id,
       a.branch_id::text AS branch_id,
       a.doctor_id::text AS doctor_id,
       a.appointment_type_id::text AS appointment_type_id,
       a.start_datetime, a.end_datetime, a.status
  FROM appointment a
 WHERE a.id = $1::uuid
   AND a.patient_phone = $2;
```

The single-statement `WHERE id = $1 AND patient_phone = $2`
combines the existence check and the privacy filter: a row that
exists but doesn't match the verified patient's phone returns 0
rows → 404 not_found, identical to a non-existent id (E7-S3).

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/patient-deep-link.ts` — GET /patient/appointments/:id/deep-link handler.
- [ ] `apps/api/src/app.ts` — mount after authMiddleware.
- [ ] `apps/api/test/patient-deep-link.test.ts` — integration tests.

**Acceptance Criteria:**
- Given a verified patient JWT and an appointment id they own with status='Scheduled', when GET /patient/appointments/:id/deep-link is invoked, then 200 with `{appointment_id, can_cancel:true, can_reschedule:true, appointment: {...}}`.
- Given a verified patient JWT and an appointment id they own with status in (Cancelled, Completed, No-Show), when GET /patient/appointments/:id/deep-link is invoked, then 200 with `can_cancel:false, can_reschedule:false`.
- Given a verified patient JWT and an appointment id owned by a different patient, when GET /patient/appointments/:id/deep-link is invoked, then 404 not_found (privacy: don't reveal existence).
- Given a verified patient JWT and an unknown appointment id, when GET /patient/appointments/:id/deep-link is invoked, then 404 not_found.
- Given an anonymous caller, when GET /patient/appointments/:id/deep-link is invoked, then 401 unauthenticated.
- Given a doctor / admin / receptionist JWT, when GET /patient/appointments/:id/deep-link is invoked, then 403 forbidden_role.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/patient-deep-link.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.