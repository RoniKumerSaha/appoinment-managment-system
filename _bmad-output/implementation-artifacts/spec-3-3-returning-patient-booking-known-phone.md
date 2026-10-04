---
title: 'E3-S3 — Returning patient booking (known phone)'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-3-2-guest-booking-first-time.md'
  - '_bmad-output/implementation-artifacts/spec-3-1-availability-engine.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** When a returning patient (phone already in `patient` table) books again, the booking flow needs to (a) NOT create a duplicate `patient` row, and (b) update the patient's stored `full_name` to whatever they typed (which may have changed since their last booking). Today, E3-S2 already covers (a) via the `INSERT ON CONFLICT DO NOTHING + SELECT fallback` path. It does NOT cover (b): the existing route silently discards the submitted name when the row already exists.

**Approach:** Add one route + amend `POST /bookings`:

1. **`GET /patient/profile?phone=<e164>` (NEW)** — server-side phone-detection probe. Returns `200 {patient: {phone_number, full_name}}` for a known phone, `404 patient_not_found` for an unknown phone, `401 unauthenticated` for anonymous. The client calls this when the patient tabs off the phone field; if 200, the form switches to "returning patient" mode (name pre-filled, phone read-only).

2. **Amend `POST /bookings`** to UPDATE the existing `patient.full_name` when a row already exists for the supplied phone. The UPDATE is inside the same transaction as the appointment INSERT so the audit row carries the latest name. The audit payload's `payload.patient_name` reflects the post-update name (so an audit consumer can see what was on file at the time of booking).

**Boundaries & Constraints**

**Always:**
- Phone is the patient key (FR-022). No `patient.id` FK on `appointment`; the join key is the phone.
- The phone field is **server-trusted**: whatever phone the patient typed is the source of truth for both detection (profile lookup) and booking (FK to `patient.phone_number`). The JWT `sub` does NOT pin the booking (E3-S2 invariant).
- Returning-patient detection is read-only: a 404 from `/patient/profile` means the phone is new; the client then collects a name and submits a first-time booking (E3-S2 path).
- The name UPDATE on a returning patient is unconditional — `UPDATE patient SET full_name = $1 WHERE phone_number = $2`. The server does not preserve the old name; the booking is the authoritative event for "the patient typed this name now."
- Audit payload (E3-S2's existing audit row) is unchanged in shape — the `source: 'self_book'` field stays. The pre-update name is captured by the audit row's `actor_id` pattern (`patient:<phone>`) plus a `patient_name_after` field in the payload.
- All DB ops inside the existing POST /bookings transaction; the UPDATE is just one more statement before the appointment INSERT.
- Privacy: `/patient/profile` returns `phone_number` and `full_name` only. No PII (email, address, etc.) — there is none anyway, the `patient` schema has only these two columns.

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E3-S3 + FR-023.)

**Never:**
- No client-side detection without a server probe. The client cannot trust a phone is "returning" without the server confirming; otherwise a malicious client could submit a different phone on the booking step.
- No PATCH on the patient table outside of POST /bookings. A future E4-S4 (deep-link entry to cancel/reschedule) or E7-S3 (patient privacy filter) may add dedicated patient mutation routes; today the booking flow is the only mutation surface.
- No DELETE on /patient/profile — read-only by design.
- No rate limiting on `/patient/profile` in this story (deferred to E7-S3 patient privacy filter).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Notes |
|----------|--------------|---------------------------|-------|
| GET /patient/profile?phone=known | seeded patient 0001 | `200 {patient: {phone_number: '+15550000001', full_name: 'Patient One'}}` | pre-fill path |
| GET /patient/profile?phone=unknown | random new phone | `404 patient_not_found` | first-time path |
| GET /patient/profile: invalid phone format | `555-0000` | `400 invalid_patient_phone` | format check |
| GET /patient/profile: no phone query param | `?phone=` empty | `400 missing_patient_phone` | required |
| GET /patient/profile: no auth | anonymous | `401 unauthenticated` | any role may read |
| POST /bookings: returning patient, same name | phone=+15550000001, name='Patient One' | `201` + appointment row + audit row + patient.name unchanged | E3-S2 path |
| POST /bookings: returning patient, **changed** name | phone=+15550000001, name='Patient One Renamed' | `201` + appointment row + audit row + patient.name='Patient One Renamed' (post-txn confirmed) | FR-023: "Editing the name updates the patient's stored name" |
| POST /bookings: returning patient, blank name change | phone=+15550000001, name='' | `400 invalid_patient_name` | name validator unchanged from E3-S2 |
| POST /bookings: first-time patient | phone=+15559990001, name='New Person' | `201` + appointment row + audit row + patient row created | unchanged from E3-S2 |

## Code Map

- `apps/api/src/routes/patient-profile.ts` (NEW) — GET /patient/profile handler.
- `apps/api/src/routes/bookings.ts` (MODIFIED) — patient UPDATE branch added.
- `apps/api/src/app.ts` (MODIFIED) — mount patientProfileRouter after authMiddleware.
- `apps/api/test/patient-profile.test.ts` (NEW) — integration tests for the lookup.
- `apps/api/test/bookings.test.ts` (MODIFIED) — +2 tests: returning patient with CHANGED name (UPDATE branch) and with SAME name (no-op). Both use `try/finally` cleanup so a failed assertion does not leave the seeded `full_name` mutated for sibling tests.

**No new migration.** The `patient` table from 0001 has every column we need.

**Patient UPDATE (in-txn, before appointment INSERT):**
```sql
-- Only runs when the INSERT ON CONFLICT path fell through to SELECT
-- (i.e., the patient row already existed). Idempotent: same name → no-op.
UPDATE patient SET full_name = $1
 WHERE phone_number = $2
   AND full_name IS DISTINCT FROM $1;
```

The `IS DISTINCT FROM` predicate skips the write when the names match, so the audit row's `updated_at` is unchanged for no-op updates. (The `patient` table doesn't have an `updated_at` column today, but the predicate is correct hygiene.)

**Audit payload enrichment (E3-S2 extension):**
```json
{
  "start_datetime": "...",
  "end_datetime": "...",
  "appointment_type_id": "...",
  "doctor_id": "...",
  "branch_id": "...",
  "source": "self_book",
  "patient_name_after": "<post-update name>"   // NEW in E3-S3
}
```

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/routes/patient-profile.ts` — GET /patient/profile handler.
- [x] `apps/api/src/routes/bookings.ts` — patient UPDATE branch added.
- [x] `apps/api/src/app.ts` — mount patientProfileRouter.
- [x] `apps/api/test/patient-profile.test.ts` — integration tests (6 cases).
- [x] `apps/api/test/bookings.test.ts` — +2 tests: returning patient CHANGED name (UPDATE fires) and SAME name (no-op).

**Acceptance Criteria:**
- Given a known phone, when GET /patient/profile is invoked, then 200 with the patient row (phone_number + full_name).
- Given an unknown phone, when GET /patient/profile is invoked, then 404 patient_not_found.
- Given a returning patient who submits POST /bookings with a different name, when the request completes, then `patient.full_name` reflects the new name and the audit row's `payload.patient_name_after` carries the new name.
- Given a returning patient who submits POST /bookings with the same name, when the request completes, then `patient.full_name` is unchanged.
- Given an invalid phone, when GET /patient/profile is invoked, then 400 invalid_patient_phone.
- Given no auth, when GET /patient/profile is invoked, then 401 unauthenticated.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (Agent code-review pass).

Code review found no blockers. Applied one housekeeping patch from the
review's suggestion #2: wrapped the two new bookings.test.ts cases
(returning-patient CHANGED and SAME name) in `try/finally` so the
seeded `patient.full_name` is restored and the freshly-inserted
`appointment` / `appointment_audit` rows are deleted even when a
mid-test assertion fails. This prevents test-ordering coupling and
keeps the seeded state pristine across re-runs. No production code
changed; only the test fixtures.

SC2 also clarifies in the code-map that the bookings test gained
+2 cases (CHANGED and SAME), not +1 as the SC1 code-map said.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/patient-profile.test.ts test/bookings.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After `GET /patient/profile?phone=+15550000001`, the response is 200 with `patient.full_name = 'Patient One'`.