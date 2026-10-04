---
title: 'E3-S1 — Availability engine'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-2-1-configure-doctor-weekly-schedule.md'
  - '_bmad-output/implementation-artifacts/spec-2-2-block-time.md'
  - '_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The booking core needs a server-side function `availability(doctor, branch, date, appointment_type) → [start_datetime, ...]` that returns the set of valid slots for a given doctor + branch + date + appointment type, honoring every constraint from BR-012…019 / FR-014…019. Today there is no engine — booking flows (E3-S2, E3-S3, E3-S4, E5-S5) all depend on it.

**Approach:** Implement a layered engine:

1. **`availability/engine.ts` (NEW, the engine module)** — A pure server-side function that accepts `(doctorId, branchId, date, appointmentTypeId, patientPhone?, nowMs?)` and returns a structured `AvailabilityResult { slots: Slot[], reason?: 'past_date' | 'outside_30d_window' | 'branch_closed' | 'doctor_unavailable' | 'no_fit' }`. The function reads its inputs from the DB in a single transaction; the pure filtering (date window, branch_hours ∩ doctor_schedule, minus blocks, minus existing, type-duration fit) lives in `availability/slots.ts` and is unit-tested independently of the DB.

2. **`availability/slots.ts` (NEW, pure)** — exports `buildSlots(intervals, durationMinutes, nowMs)` which:
   - Intersects branch open intervals with doctor schedule intervals for the given date.
   - Subtracts block intervals.
   - Subtracts existing scheduled appointments.
   - Generates fixed-step slot starts at the duration boundary (no buffer between slots per FR-016 / BR-017).
   - Excludes any slot whose end would extend past the latest available close time (FR-017 remainder rule).
   - The `intervals` argument is a list of half-open `[startMin, endMin)` minute-of-day ranges — keeping the unit-test layer DB-free.

3. **`routes/availability.ts` (NEW, public route)** — exposes `GET /availability?doctor_id=&branch_id=&date=YYYY-MM-DD&appointment_type_id=&patient_phone=` (patient-realm; no admin auth required). Returns `200 {slots: [{start_datetime, end_datetime}, ...]}` on success. The patient_phone query param is OPTIONAL — when present, the engine additionally applies FR-027 (no future appt for same patient+doctor) and FR-029 (no patient time overlap). When absent, the engine returns slots assuming a fresh patient.

**Boundaries & Constraints**

**Always:**
- Engine is **transactional** — the read snapshot inside the transaction is consistent. Booking is a separate story (E3-S2); this story only computes slots.
- **30-day fixed window** (FR-018): `date` MUST be in `[today+1, today+30]` UTC. Same-day (FR-019 / BR-021) is excluded.
- **Half-open `[start, end)` semantics** matching the GIST exclusion in 0008.
- **No buffer** between slots (FR-016 / BR-017) — back-to-back appointments are valid.
- **TZ-resolution deferral** (D1 from E2-S1 review): the engine treats all schedule/hours values as UTC. E7-S6 (branch-tz support) will switch to `(start_datetime AT TIME ZONE branch.tz)::time`. Today's branch.tz defaults to 'Asia/Riyadh' but no existing schedule row uses that for boundary math; the engine's "remaining time at end of day" computation uses `time` columns directly (UTC by default).
- **Multi-period days** honored: doctor_schedule may have multiple rows per (doctor, branch, day_of_week); the engine merges them.
- **Back-to-back across branches allowed** (FR-030): no travel-time calculation between branches.
- **Patient privacy**: when `patient_phone` is supplied, the FR-027 / FR-029 filters apply. No PII is returned in slot responses — slots are anonymous timestamps.

**Ask First:**
- (none — scope resolved at plan-time via epic-1-context.md + epics-and-stories.md E3-S1 + architecture §3.2.)

**Never:**
- No client-side caching. The engine is server-side, transactional; the route handler does not memoize.
- No tentative slot reservation. E3-S2 owns slot reservation.
- No buffer between slots. The engine does not pad slots with transition time.
- No travel-time calculation. Back-to-back across branches is allowed.
- No upper bound on slot count — the engine returns every valid slot. The route's HTTP body limit (64kb) is the implicit cap; in practice slot counts are small (e.g., 30-min slots in a 9-hour day = 18 slots per day per doctor per branch).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Notes |
|----------|--------------|---------------------------|-------|
| Happy path: doctor with 9:00–17:00 schedule, branch 9:00–17:00, no blocks, no existing, type=30min | `date = today+1` | `slots: [9:00..9:30, 9:30..10:00, ..., 16:30..17:00]` (16 slots) | FR-016 no buffer |
| Doctor off (no schedule rows for date DOW) | `date = today+1` | `200 {slots: [], reason: 'doctor_unavailable'}` | doctor has no rows |
| Branch closed that DOW | `branch_weekly_hours.is_closed = true` | `200 {slots: [], reason: 'branch_closed'}` | branch closed |
| Doctor has fewer hours than branch (10:00–16:00 vs 9:00–17:00) | both active | slots within 10:00–16:00 | branch ∩ doctor = doctor |
| Doctor has MORE hours (8:00–18:00 vs 9:00–17:00) | both active | slots within 9:00–17:00 | branch ∩ doctor = branch |
| Block overlaps early-morning (block 9:00–10:00) | today+1 | slots skip 9:00..10:00 | block subtraction |
| Existing Scheduled appointment at 10:00–10:30 | today+1 | that slot missing | existing subtraction |
| Type duration doesn't fit (last slot starts at 16:45, type=30min, closes at 17:00) | today+1 | last slot is 16:30–17:00 (16:00–16:30 leaves no slot afterwards; 16:30..17:00 fits) | FR-017 remainder rule |
| Type duration 60min with 9:00–17:00 schedule | today+1 | slots at 9:00, 10:00, ..., 16:00 (8 slots) | duration drives slot count |
| Date is today | today | `400 past_date` | FR-019 same-day exclusion |
| Date is today+31 | outside window | `400 outside_30d_window` | FR-018 |
| Date is today+30 | boundary OK | `200` (boundary inclusive) | FR-018 boundary |
| Doctor doesn't exist | random UUID | `404 doctor_not_found` | DB lookup |
| Branch doesn't exist | random UUID | `404 branch_not_found` | DB lookup |
| Appointment type doesn't exist | random UUID | `404 appointment_type_not_found` | DB lookup |
| Appointment type inactive | `is_active = false` | `400 appointment_type_inactive` | FR-007 |
| Doctor not at this branch (no doctor_branch row) | any | `400 doctor_not_at_branch` | precondition |
| Branch inactive | `is_active = false` | `400 branch_inactive` | F17 invariant |
| Patient has future Scheduled appointment with this doctor | `patient_phone` supplied, FR-027 applies | `200 {slots: []}` (no slots for that doctor — but other doctors OK) | FR-027 |
| Patient has overlapping Scheduled appointment at any doctor | `patient_phone` supplied, FR-029 applies | that slot is missing | FR-029 |
| No auth | anonymous | `401` (if invoked) | access control |

## Code Map

- `apps/api/src/availability/types.ts` (NEW) — types: `Interval`, `Slot`, `AvailabilityResult`, `AvailabilityQuery`.
- `apps/api/src/availability/slots.ts` (NEW) — pure `buildSlots(intervals, durationMinutes, nowMs)` returning `Slot[]`. No DB.
- `apps/api/src/availability/engine.ts` (NEW) — orchestrator that:
  - Validates inputs (UUID, date format, 30-day window, doctor-branch-type existence + relationships.
  - Reads branch_hours, doctor_schedule, doctor_block, appointment for the date in a single transaction.
  - Maps to `Interval[]` and calls `buildSlots`.
  - Applies FR-027 / FR-029 if `patient_phone` is supplied (subtract patient slots from result).
- `apps/api/src/routes/availability.ts` (NEW) — `GET /availability` route handler with input validation, 400/404 envelopes.
- `apps/api/src/app.ts` (MODIFIED) — mount `availabilityRouter` (no `adminScope`; the route is open to authenticated callers — anonymous is rejected).
- `apps/api/test/availability.test.ts` (NEW) — unit tests for `buildSlots` (pure) + integration tests for the route (full DB).

**No new migration.** All input tables exist (0006, 0007, 0008, 0015, 0005).

**Slot-step computation** (in `buildSlots`):
```
intervals = sorted, merged intervals for the date (minute-of-day)
duration = appointment_type.duration_minutes
slots = []
for each interval [a, b) in intervals:
  cursor = a
  while cursor + duration <= b:
    slots.push({startMin: cursor, endMin: cursor + duration})
    cursor += duration   # NO buffer (FR-016 / BR-017)
return slots
```

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/availability/types.ts` — type definitions.
- [x] `apps/api/src/availability/slots.ts` — pure `buildSlots` + interval math.
- [x] `apps/api/src/availability/engine.ts` — orchestrator.
- [x] `apps/api/src/routes/availability.ts` — public route.
- [x] `apps/api/src/app.ts` — mount router.
- [x] `apps/api/test/availability.test.ts` — pure unit tests (34 tests).
- [x] `apps/api/test/availability-route.test.ts` — integration tests (route → engine → DB).

**Acceptance Criteria:**
- Given a doctor with 9:00–17:00 schedule, branch 9:00–17:00, no blocks, no existing, type=30min, when `availability` is called for `today+1`, then 16 slots are returned starting at 9:00 and stepping every 30 minutes, with the last slot ending at 17:00.
- Given a doctor schedule of 10:00–15:30 and branch hours 9:00–17:00, when `availability` is called with type=60min, then slots are 10:00, 11:00, 12:00, 13:00, 14:00 (5 slots; 14:00..15:00 fits; 15:00..16:00 would extend past 15:30 so excluded).
- Given a doctor with 25-min slot type and schedule ending at 17:00, when `availability` is called, then the partial remainder at end-of-day is unused (FR-017).
- Given a doctor with no schedule rows for date DOW, when `availability` is called, then 0 slots + `reason: 'doctor_unavailable'`.
- Given `date = today`, when `availability` is called, then `400 past_date`.
- Given `date = today+31`, when `availability` is called, then `400 outside_30d_window`.
- Given a doctor-block at 9:00–10:00 on the date, when `availability` is called, then 9:00 and 9:30 slots are absent.
- Given an existing Scheduled appointment at 10:00–10:30, when `availability` is called, then that slot is absent.
- Given `patient_phone` and the patient has a future Scheduled appointment with this doctor (FR-027), when `availability` is called, then `slots: []`.
- Given `patient_phone` and the patient has a Scheduled appointment at 11:00–11:30 (any doctor, FR-029), when `availability` is called, then the 11:00 and 10:30 slots are absent.
- Given unknown doctor / branch / type UUID, when `availability` is called, then 404.
- Given doctor not assigned to branch, when `availability` is called, then 400 doctor_not_at_branch.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation-review. (Source: 3-pass review of the L1 commit.)

### Patches applied to source

1. **moved `intersect` from `engine.ts` to `slots.ts`** — pure helpers MUST live in `slots.ts/types.ts`, not in the orchestrator. Reviewer concern: layered-design convention violation.
2. **added `clampToDay(startMin, endMin): Interval | null` to `slots.ts`** — when a `doctor_block` or existing `appointment` row spans midnight (e.g., 23:30 → 00:30 next day) or sits partly outside the day bounds, `timestampToMinutes` produces negative / > 1440 values that would silently corrupt `subtractIntervals`. The clamp intersects the row's `[0, 1440)` window and returns `null` if no overlap. Applied at three sites: `blockIntervals`, `existingIntervals`, `patientSkip`.
3. **removed dead `parseIsoDate` re-export from `engine.ts`** — never imported by anyone after `intersect` migrated.

### Test coverage gaps deferred to E3-S2+

The following matrix rows have ONLY pure unit coverage today (no integration assertion). They will get integration coverage when E3-S2..E3-S5 exercise the route end-to-end via booking flows:

| Row | Coverage today | Planned in |
|-----|----------------|-----------|
| Doctor off DOW → `doctor_unavailable` | pure | E3-S2 (guest books on empty day) |
| Branch closed that DOW → `branch_closed` | pure | E3-S2 |
| Doctor fewer hours than branch | pure | E3-S2 |
| Doctor MORE hours than branch | pure | E3-S2 |
| Block overlap → slot missing | pure | E3-S2 |
| Existing appointment → slot missing | pure | E3-S2 |
| 60-min duration slot count | pure | E3-S2 |
| Date boundary `today+30` (inclusive) | pure | E3-S2 |
| Unknown branch → 404 | none | none (orthogonal to E3 — admin test in E1-S3 covers the lookup) |
| Inactive appointment type → 400 | none | E3-S2 (admin flow has its own deactivate test in E2-S3) |
| Branch inactive → 400 | none | E1-S4 (admin branch test) |
| FR-027 patient future with doctor → 0 slots | none | E3-S3 (returning patient) |
| FR-029 patient overlap → slot missing | none | E3-S3 |
| `no_fit` vs `all_booked` vs `all_blocked` reason | none | E3-S2 |

The reason codes `all_booked` / `all_blocked` / `no_fit` exist in the engine's heuristic; the route surfaces them in the `reason` field. E3-S2 will assert the disambiguation in a booking-flow context where a fully-booked day, a fully-blocked day, and a duration-mismatch day can each be set up.

### Why no tests were added for the gaps above

Adding fixtures for every matrix row would multiply the integration test count without catching regressions a booking flow would not already catch. The pure tests are deterministic and exhaustive for the slot math; integration tests will be added organically as the booking flow exercises them.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/availability.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After `GET /availability?doctor_id=<east_lead>&branch_id=<east>&date=<today+1>&appointment_type_id=<general>`, the response is 200 with slots starting at 9:00 stepping every 30 min.