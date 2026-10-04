---
title: 'E7-S3 — Patient privacy filter (NFR-007)'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-2-patient-cancellation.md'
  - '_bmad-output/implementation-artifacts/spec-4-3-patient-rescheduling.md'
  - '_bmad-output/implementation-artifacts/spec-4-4-deep-link-entry-cancel-reschedule.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD FR-022 ("phone is the sole patient
key") + FR-031 ("server-side filtering of Appointment
queries by patient.phone_number for the verified session")
+ FR-032 ("the client never receives appointments for any
other phone") + NFR-007 ("penetration test asserts no leak
via deep links, query params, response shape, or timing"),
the API must enforce a strict privacy envelope around
appointment data keyed by phone.

The patient has a JWT claim whose `sub` is their phone
number (E0-S3's `patient:{phone}` shape). The patient
should ONLY ever see their own appointments. Every route
that returns appointment data to a patient JWT MUST:

1. Bind the lookup to `claim.sub` (the phone). The body /
   query / URL parameter CANNOT widen the scope.
3. Return a 404 envelope for "exists but not yours" — NOT
   200 with another patient's data, NOT 403 with an
   existence leak.
4. Return the same 404 envelope for "doesn't exist at all"
   — so the patient cannot enumerate other appointments
   by id.

This story **documents** the privacy contract (no new
migration, no new route). The contract is already enforced
across the codebase:

- `patient-cancel.ts` (E4-S2): SELECT FOR UPDATE returns
  the row; the route checks `patient_phone === claim.sub`
  and returns 404 on mismatch.
- `patient-reschedule.ts`: same pattern.
- `patient-deep-link.ts` (E4-S4): single-statement lookup
  keyed by `(id, patient_phone = claim.sub)` — same 404
  envelope.
- `patient-appointments.ts` (E4-S1): query is bound by
  `patient_phone = claim.sub`.
- `patient-profile.ts` (E3-S3): the `?phone=<e164>` query
  parameter is bound from `claim.sub` server-side.

**No new migration, no new code.** This story captures the
contract that the existing routes already enforce. The
acceptance test is the existing test suite + a new
cross-cutting privacy test that asserts every patient
surface returns the same 404 envelope for "exists but not
yours" and "doesn't exist".

## Boundaries & Constraints

**Always:**
- The patient phone is the sole patient key (FR-022). Two
  `patient` rows with the same phone is rejected by the
  UNIQUE constraint on `patient.phone_number` (per
  `0002_patient.sql`).
- Every patient surface binds the data lookup to
  `claim.sub`. The body / query / URL parameter CANNOT
  widen the scope. A patient cannot enumerate other
  appointments by id, query param, deep link, or timing.
- The 404 envelope is identical for "doesn't exist" and
  "exists but not yours" so the patient cannot probe
  existence.
- A patient cannot see another patient's audit, profile,
  or appointments. (E7-S2 enforces the same privacy
  envelope on the audit reads: no patient surface.)
- Privacy is enforced at the data-access layer (in the
  route's SELECT statement), NEVER in the client. The
  server returns the wrong amount of data; the client
  cannot fix the leak.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E7-S3 + PRD FR-022 / FR-031 / FR-032 / NFR-007.)

**Never:**
- Never return 200 with another patient's data. Privacy
  envelope is 404 (or empty list for the upcoming list).
- Never return 403 with an existence leak. The 403 would
  tell the patient the row exists, leaking existence.
- Never widen the lookup based on body / query / URL
  parameter. The lookup is ALWAYS bound to `claim.sub`.
- Never accept a body / query / URL parameter that
  re-specifies the phone. The phone comes from the JWT
  claim, period.
- Never log PII at the route level. Logging happens via
  the request-logger middleware (E0-S6) which hashes the
  phone; the route never logs the raw phone.

## I/O & Edge-Case Matrix

| Scenario | Caller | Endpoint | Expected | Notes |
|----------|---------|----------|----------|-------|
| Patient cancels own Scheduled | patient | POST /patient/appointments/:id/cancel | 200 + status=Cancelled | E4-S2 |
| Patient cancels another patient's Scheduled | patient | POST /patient/appointments/<other>/cancel | 404 not_found | E7-S3 privacy envelope |
| Patient cancels unknown id | patient | POST /patient/appointments/<random>/cancel | 404 not_found | E7-S3 privacy envelope |
| Patient reschedules own | patient | POST /patient/appointments/:id/reschedule | 200 + updated | E4-S3 |
| Patient reschedules another's | patient | POST /patient/appointments/<other>/reschedule | 404 not_found | E7-S3 privacy envelope |
| Patient deep-link lookup own | patient | GET /patient/appointments/:id/deep-link | 200 + metadata | E4-S4 |
| Patient deep-link lookup other's | patient | GET /patient/appointments/<other>/deep-link | 404 not_found | E7-S3 privacy envelope |
| Patient lists own upcoming | patient | GET /patient/appointments | 200 + own list | E4-S1 |
| Patient list is bound to phone | patient | GET /patient/appointments?phone=<other> | 200 + own list (phone param ignored) | E7-S3 |
| Patient profile lookup | patient | GET /patient/profile?phone=<own> | 200 + own profile | E3-S3 |
| Patient profile lookup other | patient | GET /patient/profile?phone=<other> | 200 + own profile (phone param ignored) | E7-S3 |
| Phone UNIQUE on patient table | DDL | `INSERT INTO patient (phone_number, ...) VALUES (existing_phone, ...)` | SQLSTATE 23505 | 0002_patient.sql |
| Patient JWT has no claim.sub | — | — | route returns 401 unauthenticated | E7-S3 contract |
| Patient phone mismatch in body | — | — | body phone ignored; route binds to claim.sub | E7-S3 contract |

## Code Map

This story ships **NO new code**. The privacy contract is
already enforced across:

- `apps/api/src/routes/patient-cancel.ts` — `patient_phone =
  claim.sub` after the SELECT.
- `apps/api/src/routes/patient-reschedule.ts` — same.
- `apps/api/src/routes/patient-appointments.ts` — query
  bound by `patient_phone = claim.sub`.
- `apps/api/src/routes/patient-deep-link.ts` — single-
  statement lookup keyed by `(id, patient_phone =
  claim.sub)`.
- `apps/api/src/routes/patient-profile.ts` — `?phone=`
  ignored; server-side binds to `claim.sub`.

This story's deliverables:

- `_bmad-output/implementation-artifacts/spec-7-3-patient-privacy-filter.md`
  (this file) — documents the privacy contract.
- `apps/api/test/privacy-filter.test.ts` (NEW) — a single
  cross-cutting test file that asserts the privacy envelope
  on every patient surface. Each test inserts a row owned
  by `+15550000099` and attempts to read / cancel /
  reschedule / deep-link it with a JWT for `+15550000001`
  — every surface MUST return the documented 404 envelope.

**No new migration.**

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/test/privacy-filter.test.ts` — cross-
  cutting privacy test file.

**Acceptance Criteria:**
- Given a patient JWT `+15550000001`, when the patient attempts to cancel another patient's Scheduled appointment, then 404 not_found (NOT 200, NOT 403).
- Given a patient JWT `+15550000001`, when the patient attempts to reschedule another patient's Scheduled appointment, then 404 not_found.
- Given a patient JWT `+15550000001`, when the patient attempts a deep-link lookup of another patient's appointment, then 404 not_found.
- Given a patient JWT `+15550000001`, when the patient lists upcoming appointments with `?phone=+15550000099`, then the response contains ONLY appointments owned by `+15550000001` (the `?phone=` param is ignored).
- Given a patient JWT `+15550000001`, when the patient looks up the profile with `?phone=+15550000099`, then the response contains ONLY the profile for `+15550000001` (the `?phone=` param is ignored).
- Given two `INSERT INTO patient` calls with the same `phone_number`, then the second insert raises SQLSTATE 23505 (UNIQUE violation).
- Given a patient JWT with no `claim.sub`, when any patient surface is invoked, then 401 unauthenticated.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review. Patches:

- N1: The spec scope is "document the privacy contract + add
  a cross-cutting test file that asserts every patient
  surface returns the same 404 envelope". No new code;
  the privacy envelope is already enforced across E3-S3 /
  E4-S1 / E4-S2 / E4-S3 / E4-S4 / E7-S2.
- N2: The cross-cutting test file is
  `apps/api/test/privacy-filter.test.ts`. Each test inserts
  a row owned by `+15550000099` (the "other" patient) and
  attempts to read / cancel / reschedule / deep-link / list
  it with a JWT for `+15550000001` (the "current" patient).
  The test asserts the documented 404 envelope on every
  surface.
- N3: The patient list test asserts that the
  `?phone=<other>` query parameter is ignored — the
  response contains ONLY the current patient's
  appointments. The phone lookup test asserts the same on
  the profile surface.
- N4: The UNIQUE constraint test on `patient.phone_number`
  asserts SQLSTATE 23505 on duplicate insert (FR-022).
  This is a DDL-level assertion that the schema enforces
  the phone-as-key contract, not a route-level test.

## Design Notes

**Why this story ships no new code:** The privacy contract
is already enforced across E3-S3 / E4-S1 / E4-S2 / E4-S3 /
E4-S4. This story captures the cross-cutting contract as a
single document so future work doesn't accidentally weaken
it.

**Why a 404 envelope, not 403:** A 403 with "exists but not
yours" leaks the existence of the appointment. The patient
could probe "does appointment id X exist?" by trying to
cancel / reschedule / deep-link and reading the status
code. A 404 envelope is identical for "doesn't exist" and
"exists but not yours", so the patient cannot probe
existence.

**Why the lookup is bound server-side, not via a body /
query parameter:** The body / query / URL parameter is
ALWAYS treated as untrusted input. The phone comes from the
JWT claim, period. A patient who tries to send a different
phone in the body sees the same response as if they sent
their own phone — the server binds to `claim.sub`
unconditionally.

**Why no patient audit read:** E7-S2's contract: the audit
log is internal-only (NFR-005). A patient audit read would
leak PII (the patient phone and the doctor / receptionist
notes in the payload). The patient sees their
appointments via E4-S1 (upcoming) and E4-S4 (deep-link),
not audit.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/privacy-filter.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.