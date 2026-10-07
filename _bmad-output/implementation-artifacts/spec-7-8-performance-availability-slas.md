---
id: spec-7-8-performance-availability-slas
title: E7-S8 — Performance & availability SLAs
epic: epic-7
status: ready-for-dev
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-07
source_story: planning-artifacts/epics-and-stories.md §E7-S8
---

# E7-S8 — Performance & availability SLAs

## Intent

PRD NFR-008, NFR-009, NFR-010 set the availability-and-booking service performance budget.
This story ships the **SLA harness** — load test + chaos test + the per-route perf budgets — and pins the numbers to CI so a regression on any of them blocks deploys.

NFR-008: p95 ≤ 2 s for a typical availability query (one doctor, one branch, one date range).
NFR-009: booking service ≥ 99.5% available per calendar month.
NFR-010: displayed availability reflects committed bookings within 1 s of the write.

The story does **not** change the availability engine (E3-S1) or the booking transaction (E3-S2) — those are already implemented. It adds the test rig that asserts the perf budget holds and the metrics that make "service availability" observable.

### 1. Load test — `GET /availability` p95 < 2 s @ 50 concurrency

**File:** `apps/api/test/load/availability.k6.js` (NEW).

k6 is the project's existing load-test tool (used in E0-S6 observability baseline for `/healthz` smoke).

Scenario: 50 virtual users, 5-minute ramp, 100 iterations each. Each VU:
1. Picks a seeded doctor at random from the 3 seeded doctors.
2. Picks a random date in the next 30 days.
3. Calls `GET /availability?doctor_id=…&branch_id=…&appointment_type_id=…&date=…` with a patient JWT.
4. Records duration + status code.

Pass criteria:
- `http_req_duration{name:availability}: p(95) < 2000` (ms).
- `http_req_failed{name:availability}: rate < 0.01` (1%).

The k6 script exits non-zero if either threshold fails.

### 2. Chaos test — booking-write without audit-row fails

**File:** `apps/api/test/load/booking-chaos.test.ts` (NEW).

The chaos invariant (NFR-010): every successful booking must produce exactly one audit row. Conversely, no failed booking may produce an audit row.

The test:
1. Mocks the audit-write to throw (e.g., monkey-patch the audit insert helper).
2. Issues `POST /bookings` with valid input → expects `500 internal_error` (the audit failure bubbles through the rollback).
4. Asserts `appointment` count = 0 (rollback worked) AND `appointment_audit` count = 0 (no orphan audit row).
5. Restores the audit-write; issues the same booking → expects `201` + audit count = 1.

Pass criteria: rollback integrity under audit-write failure. This is the **consistency** invariant — booking state and audit state stay in lock-step.

### 3. Per-route perf budgets — CI guard

**File:** `apps/api/test/perf/perf-budgets.test.ts` (NEW).

A node-only test that records per-route p50/p95/p99 across a small synthetic load (50 sequential calls), and asserts p50 ≤ budget.

| Route | Budget (ms) |
|---|---|
| `GET /healthz` | 50 |
| `GET /availability` | 200 |
| `GET /admin/clinic` | 200 |
| `GET /admin/branches` | 200 |
| `GET /admin/doctors` | 200 |
| `GET /admin/doctors/:id/schedule` | 200 |
| `GET /admin/appointment-types` | 100 |
| `GET /patient/otp/verify-now` (correct mock) | 300 |
| `POST /bookings` | 500 |
| `POST /patient/appointments/:id/cancel` | 500 |

Pass criteria: every route's measured p50 ≤ budget.

Note: budgets are intentionally conservative for the seeded data (2 branches × 3 doctors × 2 receptionists × 5 patients). They will tighten as data grows; this is the **baseline** snapshot.

### 4. Service-availability metric — `booking_service_uptime_seconds`

**File:** `apps/api/src/metrics/server.ts` (NEW, or extend existing).

A new counter `booking_service_uptime_seconds` increments every 60 s from the `process.uptime()` value. Surfaced on `GET /metrics` alongside the existing counters from E0-S6.

The SLO: `99.5%` over a calendar month = `~216 minutes` of downtime allowed. The metric is per-process — to compute the SLO in production, an aggregator (e.g., Prometheus + alertmanager) sums across instances.

### 5. Consistency metric — `booking_to_availability_lag_seconds`

**File:** `apps/api/src/metrics/server.ts` (EDIT).

A new histogram tracks the lag between `POST /bookings` commit and the next `GET /availability` that observes the new appointment. Sweep is implemented as a 1-second cron (in the test rig) that issues a synthetic availability query and reports the gap.

NFR-010 acceptance: `p95(booking_to_availability_lag_seconds) < 1.0`.

### 6. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-8-performance-availability-slas: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/api/test/load/availability.k6.js` | NEW | Load test for `/availability` |
| `apps/api/test/load/booking-chaos.test.ts` | NEW | Booking-rollback chaos test |
| `apps/api/test/perf/perf-budgets.test.ts` | NEW | Per-route p50 budget enforcement |
| `apps/api/src/metrics/server.ts` | EDIT | `booking_service_uptime_seconds`, `booking_to_availability_lag_seconds` |
| `package.json` | EDIT | Add `test:load:availability` + `test:load:chaos` scripts |
| `_bmad-output/implementation-artifacts/spec-7-8-performance-availability-slas.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Scenario | Expected outcome |
|---|---|
| 50 VU × 100 iterations /availability | p95 < 2000 ms; failure rate < 1% |
| Booking succeeds → audit row exists | Counters: booking.success = 1; appointment_audit = 1 |
| Booking fails (audit-write throws) | 500; appointment = 0; appointment_audit = 0 |
| Per-route p50 budgets | All 10 routes within budget |
| Process uptime | `booking_service_uptime_seconds` increases monotonically |
| Availability lag after booking | p95 < 1.0 s |

## Verification

1. `pnpm --filter @clinic/api test` — `booking-chaos.test.ts`, `perf-budgets.test.ts` green.
2. `k6 run apps/api/test/load/availability.k6.js` — p95 threshold met.
3. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline unchanged).
4. `pnpm --filter @clinic/api lint` — 0 new warnings (4 pre-existing baseline unchanged).
5. `curl http://localhost:3001/metrics | grep booking_service_uptime_seconds` — counter present and increasing.
6. Testcontainers runtime unavailable in this env; suite cannot be re-run for the load test in CI; status relies on spec audit trail + k6 result capture.

## Deferrals (anticipated)

- **D1 — Production-scale load test.** The seeded data is small (3 doctors, 2 branches). A future "scale" story runs the same k6 script against a 50-clinic / 500-doctor seed.
- **D2 — SLO alerting.** `booking_service_uptime_seconds` is the metric; a Prometheus alertmanager config ships in a separate "infra" story.
- **D3 — Front-end availability query lag.** NFR-010 is a server-side commitment; the web client doesn't have its own perf budget here. Belongs to a future web-perf story.

## Spec Change Log

(none yet — first authoring)