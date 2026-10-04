---
title: 'E3-S2 — Guest booking (first-time)'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-3-1-availability-engine.md'
  - '_bmad-output/implementation-artifacts/spec-2-2-block-time.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Booking core needs an endpoint that takes a slot the patient picked from `/availability` and atomically creates an `appointment` row. Today, the availability engine returns a slot list (E3-S1), but there's no POST that converts a `(doctor, branch, date, type, slot_start)` into a `Scheduled` row. E3-S3 (returning patient), E3-S4 (receptionist on-behalf-of) and E3-S5 (receptionist availability) all build on this story's atomic create.

**Approach:** Implement `POST /bookings` as a transactional, GIST-protected create:

1. **`routes/bookings.ts` (NEW)** — Single POST handler that:
   - Validates body shape (UUID parse + ISO datetime parse + E.164 phone + 1..120 name + `slot_duration_minutes` integer 5..480).
   - Verifies the (doctor, branch, appointment_type) trio exists and is active at the clinic (single SELECT).
   - Re-validates the slot is still bookable using the same constraints E3-S1 enforces (branch_hours, doctor_schedule, doctor_block, existing Future Scheduled) — runs **inside the same transaction** as the INSERT so a concurrent booking can't slip a row in between the check and the insert.
   - Inserts the row + writes a `created` audit row in the same transaction.
   - Returns `201 {appointment: {id, doctor_id, branch_id, appointment_type_id, start_datetime, end_datetime, status, tz}}` on success.
   - On any conflict (slot raced, patient overlap with another doctor, branch hours changed mid-transaction, etc.), returns `409 {error, code, what, why, details?}`.

2. **`routes/bookings-helpers.ts` (NEW)** — Pure validators: `isValidUuid`, `isValidIsoDateTime`, `isValidE164Phone`, `isValidName`, `isValidDurationMinutes`, `validateCreateBookingBody`.

**Boundaries & Constraints**

**Always:**
- **Atomic + transactional.** All DB reads + the INSERT + the audit-row write happen in a single `BEGIN/COMMIT` block.
- **GIST protection.** The 0008 exclusion constraint `appointment_no_overlap` is the race-safety net; a concurrent booking that slips past the application check fails at the constraint layer with SQLSTATE `23P01` (exclusion_violation) and is mapped to `409 slot_raced`.
- **Patient reuse by phone** (FR-022): `patient.phone_number` is UNIQUE. A first-time booking either inserts a new `patient` row or reuses the existing one keyed by phone (no `patient_id` FK on `appointment` — the phone is the join key, matching the existing schema).
- **Same-day exclusion** (FR-019): `start_datetime::date` MUST be ≥ `(now()::date + 1)`. Same-day → `409 slot_in_past`.
- **30-day window** (FR-018): `start_datetime::date` MUST be ≤ `(now()::date + 30)`. Outside → `409 outside_30d_window`.
- **FR-027**: A patient with a future Scheduled appointment with this doctor → `409 patient_has_future_with_doctor`.
- **FR-029**: A patient with a Scheduled appointment overlapping the slot → `409 patient_time_conflict`.
- **Audit on every booking.** `appointment_audit` row written in same transaction: `actor_role='patient'`, `actor_id='patient:<phone>'`, `event='created'`, `payload={start_datetime, end_datetime, appointment_type_id, doctor_id, branch_id, source: 'self_book'}`. Append-only — the row is INSERT-only, no UPDATE/DELETE.
- **TZ resolution**: branch.tz is returned alongside the row so the client can render the local time without re-deriving from the UTC timestamp.
- **Reuse E3-S1's slot math** — `availability/slots.ts` exports `buildSlots`, `intersect`, `subtractIntervals`, `clampToDay`. The booking route reuses them via the orchestrator.
- **Patient privacy**: `patient_phone` in the response is masked to `+1XXXXXXXXXX` form (audit row carries the real one). The booking itself echoes the submitted phone back unchanged (the patient just typed it).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md E3-S2 + architecture §5 API surface + 0008 GIST exclusion.)

**Never:**
- No client-side slot reservation. The route is server-side, transactional; the client does not hold a slot.
- No PATCH on `/bookings/:id` (reschedule is a separate story E4-S3).
- No DELETE on `/bookings/:id` (cancellation is a separate story E4-S2).
- No duration override — `slot_duration_minutes` MUST equal the stored `appointment_type.duration_minutes`. Mismatch → `409 duration_mismatch`.
- No buffer insertion — the inserted row uses the exact `(start_datetime, end_datetime)` submitted; no `+5min`/`+transition`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Notes |
|----------|--------------|---------------------------|-------|
| Happy path: valid slot on East Lead, General 30min | slot in 9–17 tomorrow | `201 {appointment: {...status: 'Scheduled'}}` + row inserted + audit row written | FR-024 immediate confirmation |
| Doctor not at branch | doctor East Lead, branch West | `400 doctor_not_at_branch` | precondition |
| Doctor unknown | random UUID | `404 doctor_not_found` | DB lookup |
| Branch unknown | random UUID | `404 branch_not_found` | DB lookup |
| Appointment type unknown | random UUID | `404 appointment_type_not_found` | DB lookup |
| Appointment type inactive | `is_active = false` | `404 appointment_type_not_found` | SC2-1: collapsed with not_found |
| Slot UTC no TZ | `2026-10-05T09:00:00` (no Z, no offset) | `400 invalid_start_datetime` | strict ISO 8601 with TZ |
| Slot equals `appointment_type.duration_minutes` but `slot_duration_minutes` differs | `slot_duration_minutes=45`, type=30 | `409 duration_mismatch` | safety |
| `end_datetime - start_datetime` ≠ `slot_duration_minutes × 60s` | (start, end) = 30-min slot but duration=45 | `400 invalid_time_range` | SC2-2 |
| Slot start_datetime in past (today) | `2026-10-04T09:00:00Z` when now=2026-10-04T15:00Z | `409 slot_in_past` | FR-019; SC2-3 changed 400 → 409 |
| Slot start_datetime > today+30 | `2026-12-15T09:00:00Z` when now=2026-10-04 | `409 outside_30d_window` | FR-018; SC2-3 changed 400 → 409 |
| Slot outside branch hours | 18:00 when branch closes 17:00 | `409 outside_branch_hours` | re-validation |
| Doctor off (no schedule row for DOW) | Sunday when doctor has no Sunday schedule | `409 doctor_unavailable` | re-validation |
| Slot inside doctor_block | block 09:00–10:00 | `409 inside_doctor_block` | re-validation |
| Slot inside another Scheduled | another patient booked the same slot | `409 slot_raced` (terminal ConflictModal envelope) | GIST exclusion catches the race; 23P01 path returns the same envelope |
| Patient already has future with this doctor (FR-027) | patient+0001 already has east.lead future | `409 patient_has_future_with_doctor` | reuses E3-S1's SELECT |
| Patient time-overlap on this slot (FR-029) | patient has 09:30..10:00 booked elsewhere | `409 patient_time_conflict` | reuses E3-S1's SELECT |
| Phone not E.164 | `555-0000` | `400 invalid_patient_phone` | format check |
| Phone new (no Patient row yet) | `+15550009999` | insert `patient` row, reuse row for `appointment.patient_phone` | FR-022 |
| Phone existing (Patient row exists) | `+15550000002` | reuse existing row | FR-022 |
| Name blank / 121 chars | `""` or `'a'.repeat(121)` | `400 invalid_patient_name` | length + trim |
| Unknown JSON field | `{foo: 'bar'}` | `400 unknown_field` | matches E1-S3 pattern |
| No auth | anonymous | `401 unauthenticated` | open to any role |
| Patient JWT booking for someone else | patient JWT, submits phone `+15559998888` | succeed — phone is the patient key, not the session | per FR-022 (the patient is who they say they are by phone) |

## Code Map

- `apps/api/src/routes/bookings.ts` (NEW) — `POST /bookings` handler.
- `apps/api/src/routes/bookings-helpers.ts` (NEW) — pure validators.
- `apps/api/src/app.ts` (MODIFIED) — mount `bookingsRouter` after authMiddleware (before `/admin` chain).
- `apps/api/test/bookings.test.ts` (NEW) — integration tests.

**No new migration.** The `appointment`, `appointment_audit`, `patient` tables from 0001, 0008, 0009 are sufficient.

**Booking transaction (POST /bookings)** — atomic flow:
```
BEGIN;
  -- 1. SELECT clinic_id (singleton anchor)
  -- 2. Verify doctor at branch + active + branch active + type active + duration match
  -- 3. Window check (today+1..today+30)
  -- 4. Re-validate slot via the same constraints E3-S1 enforces:
  --    branch_weekly_hours ∩ doctor_schedule ∩ ¬block ∩ ¬existing
  --    (run INSIDE the transaction so a concurrent booking can't slip through)
  -- 5. Patient filters (no future with this doctor; no time-overlap anywhere)
  -- 6. INSERT INTO patient if phone new (ON CONFLICT DO NOTHING + re-SELECT for the id)
  -- 7. INSERT INTO appointment ... RETURNING * + JOIN branch to fetch tz
  -- 8. INSERT INTO appointment_audit (actor_role='patient', actor_id='patient:<phone>',
  --                                    event='created', payload=...)
COMMIT;
```

**SQLSTATE mapping for race losses:**
- `23P01` (exclusion_violation on `appointment_no_overlap`) → `409 slot_raced` (terminal)
- `23505` on `idx_appointment_patient_doctor_scheduled` → `409 patient_has_future_with_doctor`
- `23505` on `patient.phone_number` (race losing on INSERT) → loop back to re-SELECT and reuse

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/routes/bookings-helpers.ts` — pure validators.
- [x] `apps/api/src/routes/bookings.ts` — POST /bookings handler.
- [x] `apps/api/src/app.ts` — mount router.
- [x] `apps/api/test/bookings.test.ts` — integration tests (23 tests, testcontainer runtime not available).
- [x] `apps/api/test/bookings-helpers.test.ts` — pure unit tests (31 tests, all green).

**Acceptance Criteria:**
- Given a valid slot tomorrow, when POST /bookings is invoked, then 201 with the inserted appointment row + tz + an audit row is written in the same transaction.
- Given the slot is in the past, when POST /bookings is invoked, then 409 slot_in_past.
- Given the slot is outside the 30-day window, when POST /bookings is invoked, then 409 outside_30d_window.
- Given the slot is already booked by another patient, when POST /bookings is invoked, then 409 slot_raced (terminal ConflictModal shape).
- Given the patient already has a future Scheduled appointment with this doctor, when POST /bookings is invoked, then 409 patient_has_future_with_doctor.
- Given the patient has a Scheduled appointment overlapping the slot, when POST /bookings is invoked, then 409 patient_time_conflict.
- Given an unknown JSON field in the body, when POST /bookings is invoked, then 400 unknown_field.
- Given no auth, when POST /bookings is invoked, then 401 unauthenticated.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation-review. (Source: 3-pass review of the L1 commit.)

### Patches applied to source

1. **`appointment_type_inactive` collapsed into `404 appointment_type_not_found`** (P0-2). Inactive types are not exposed to clients — there is no useful distinction between "the type doesn't exist" and "the type is hidden", so the 404 envelope is the right answer. The matrix row was added with a note.
2. **`slot_in_past` and `outside_30d_window` now return 409 instead of 400** (P1-1). The matrix originally pinned 400, but the FR-018/FR-019 cases are not validation errors — they're "the requested slot is not in the bookable window", which is a logical conflict at the application layer (the slot the patient selected was valid at /availability time but is no longer in the bookable window). 409 is the right envelope; the codes themselves are unchanged.
3. **`end_datetime - start_datetime !== slot_duration_minutes × 60s` returns `400 invalid_time_range`** (P1-3). The route now refuses to accept an arbitrary (start, end) pair — clients must submit a (start, end) consistent with the stored `appointment_type.duration_minutes`. The matrix row was added.
4. **Combined the disambiguation query with the in-txn recheck query** (P0-1, P1-4). The route now runs a single `SELECT_DOCTOR_BRANCH_HOURS_SQL` that returns doctor_active, branch_active, tz, open_time, close_time, is_closed in one trip. The post-COMMIT `branch.tz` SELECT is gone — tz is captured in-txn and returned in the 201 response. Closes a narrow window where a pool-acquisition failure after a successful COMMIT could turn a 201 into a 500.
5. **`is_closed = NULL` (no branch_hours row for the slot's DOW) is no longer mapped to `outside_branch_hours`** (P0-3). The previous `is_closed !== false` check treated absent rows the same as closed days, masking `doctor_unavailable` when both are absent (Sunday with no schedule). The recheck now falls through to the doctor-schedule check, so the disambiguation is honest. `is_closed = true` still returns `outside_branch_hours`.
6. **`RecheckOutcome` is now a discriminated union** (`{ok: true} | {ok: false, code: RecheckFailureCode}`). Removed the meaningless `code: 'doctor_not_at_branch' as const` from the success path.
7. **Removed the `void subtractIntervals` lie and the unused import** (P0-6). The route never subtracts intervals; the SQL `&&` overlap check returns `inside_doctor_block` if any block row exists.

### Test coverage gaps closed during review

Added 4 new integration tests to `bookings.test.ts`:
- `unknown branch → 404 branch_not_found`
- `duration_mismatch → 409`
- `end_datetime != start+duration → 400 invalid_time_range`
- `slot outside branch hours (18:00) → 409 outside_branch_hours`
- `slot inside doctor_block → 409 inside_doctor_block`

Updated 2 existing tests to assert 409 instead of 400 for the window envelopes.

### Duplication note (P1-5)

`recheckSlotInTxn` in `bookings.ts` deliberately duplicates a portion of `computeAvailability` in `availability/engine.ts`. The in-txn recheck answers a one-slot question, not a full-day list; refactoring the engine into a "check-this-slot" mode is a future cleanup story. Documented in the route's header comment.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/bookings.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After `POST /bookings` with a valid payload, the response is 201 with `appointment.status === 'Scheduled'` and the response carries `tz` from `branch.tz`.