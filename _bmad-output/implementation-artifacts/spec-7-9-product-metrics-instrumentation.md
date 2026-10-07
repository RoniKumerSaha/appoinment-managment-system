---
id: spec-7-9-product-metrics-instrumentation
title: E7-S9 — Product metrics instrumentation
epic: epic-7
status: ready-for-dev
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-07
source_story: planning-artifacts/epics-and-stories.md §E7-S9
---

# E7-S9 — Product metrics instrumentation

## Intent

PRD §16 lists the product metrics the system must emit. Some already exist as part of the E0-S6 observability baseline (`booking.attempt`, `booking.success`, `booking.conflict`, `booking.failure`, `otp.verification`). The rest need to be added at the call site and surfaced on `GET /metrics`.

This story closes the gap: every PRD §16 metric has a corresponding counter or histogram, the metric name is the source of truth (a TS literal type), and the Grafana dashboard definition is checked in.

### 1. PRD §16 metric inventory

| # | Metric | Type | Source location today |
|---|---|---|---|
| 1 | booking success rate | counter | `routes/bookings.ts` (already exists) |
| 2 | failed booking rate | counter | `routes/bookings.ts` (already exists) |
| 3 | slot conflict rate | counter | `routes/bookings.ts` (already exists) |
| 4 | average time to complete booking | histogram | NOT EMITTED — needs `availability.search → booking.success` lag |
| 5 | availability-query response time | histogram | NOT EMITTED — needs `routes/availability.ts` |
| 6 | % searches → booking | derived (1/2) | needs `availability.search_total` + ratio |
| 7 | cancellation rate | counter | NOT EMIT — `routes/patient-appointments/:id/cancel` + `routes/recurring-occurrence/:id/cancel` |
| 8 | reschedule rate | counter | NOT EMIT — `routes/patient-appointments/:id/reschedule` |
| 9 | no-show rate | counter | NOT EMIT — `routes/admin-appointments/:id/mark-no-show` |
| 10 | completed rate | counter | NOT EMIT — `routes/admin-appointments/:id/mark-completed` |
| 11 | recurring series success rate | counter | NOT EMIT — `routes/recurring/series.ts` |
| 12 | % recurring occurrences skipped | counter | NOT EMIT — `routes/recurring/series.ts` |
| 13 | double-booking incidents | counter | NOT EMIT — slot-conflict path with `code='23505'` |
| 14 | schedule-conflict incidents | counter | NOT EMIT — `routes/admin-doctor-schedule.ts` + `routes/admin-doctor-block.ts` |
| 15 | failed-transaction rate | counter | NOT EMIT — `db/pool.ts` connection-failure path |
| 16 | OTP verification success rate | counter | `routes/patient-otp.ts` (already exists) |

Eight counters/histograms need to be added; eight exist already.

### 2. New metrics module

**File:** `apps/api/src/metrics/product.ts` (NEW).

Each metric is a `prom-client` Counter or Histogram. The names are pinned as TS literal types so a mis-typed call site fails at compile time:

```ts
export const METRIC_NAMES = {
  BOOKING_TIME_AVAIL_TO_BOOK: 'booking_time_avail_to_book_seconds',
  AVAILABILITY_QUERY_DURATION: 'availability_query_duration_seconds',
  AVAILABILITY_SEARCH_TOTAL: 'availability_search_total',
  CANCELLATION_TOTAL: 'cancellation_total',
  CANCELLATION_PATIENT_TOTAL: 'cancellation_patient_total',
  CANCELLATION_DOCTOR_TOTAL: 'cancellation_doctor_total',
  CANCELLATION_RECEPTIONIST_TOTAL: 'cancellation_receptionist_total',
  CANCELLATION_RECURRING_TOTAL: 'cancellation_recurring_total',
  RESCHEDULE_TOTAL: 'reschedule_total',
  NO_SHOW_TOTAL: 'no_show_total',
  COMPLETED_TOTAL: 'completed_total',
  RECURRING_SERIES_SUCCESS_TOTAL: 'recurring_series_success_total',
  RECURRING_OCCURRENCES_SKIPPED_TOTAL: 'recurring_occurrences_skipped_total',
  DOUBLE_BOOKING_INCIDENTS_TOTAL: 'double_booking_incidents_total',
  SCHEDULE_CONFLICT_INCIDENTS_TOTAL: 'schedule_conflict_incidents_total',
  FAILED_TRANSACTION_TOTAL: 'failed_transaction_total',
} as const;

export type MetricName = typeof METRIC_NAMES[keyof typeof METRIC_NAMES];

export const productMetrics = {
  bookingTimeAvailToBook: new Histogram({ name: METRIC_NAMES.BOOKING_TIME_AVAIL_TO_BOOK, help: '…', buckets: [1, 5, 30, 60, 120, 300, 600] }),
  availabilityQueryDuration: new Histogram({ name: METRIC_NAMES.AVAILABILITY_QUERY_DURATION, help: '…', buckets: [0.05, 0.1, 0.25, 0.5, 1, 2] }),
  availabilitySearchTotal: new Counter({ name: METRIC_NAMES.AVAILABILITY_SEARCH_TOTAL, help: '…' }),
  cancellationTotal: new Counter({ name: METRIC_NAMES.CANCELLATION_TOTAL, help: '…', labelNames: ['source'] }),
  rescheduleTotal: new Counter({ name: METRIC_NAMES.RESCHEDULE_TOTAL, help: '…' }),
  noShowTotal: new Counter({ name: METRIC_NAMES.NO_SHOW_TOTAL, help: '…' }),
  completedTotal: new Counter({ name: METRIC_NAMES.COMPLETED_TOTAL, help: '…' }),
  recurringSeriesSuccessTotal: new Counter({ name: METRIC_NAMES.RECURRING_SERIES_SUCCESS_TOTAL, help: '…' }),
  recurringOccurrencesSkippedTotal: new Counter({ name: METRIC_NAMES.RECURRING_OCCURRENCES_SKIPPED_TOTAL, help: '…' }),
  doubleBookingIncidentsTotal: new Counter({ name: METRIC_NAMES.DOUBLE_BOOKING_INCIDENTS_TOTAL, help: '…' }),
  scheduleConflictIncidentsTotal: new Counter({ name: METRIC_NAMES.SCHEDULE_CONFLICT_INCIDENTS_TOTAL, help: '…' }),
  failedTransactionTotal: new Counter({ name: METRIC_NAMES.FAILED_TRANSACTION_TOTAL, help: '…' }),
};
```

### 3. Call-site wiring

| File | Metric |
|---|---|
| `routes/availability.ts` | `availabilityQueryDuration.observe(seconds)` per request |
| `routes/bookings.ts` | `availabilitySearchTotal.inc()` when `?source=availability` query; `bookingTimeAvailToBook.observe(seconds)` |
| `routes/patient-appointments/:id/cancel.ts` | `cancellationTotal.inc({source: 'patient'})` |
| `routes/admin-doctor-cancel.ts` | `cancellationTotal.inc({source: 'doctor'})` |
| `routes/admin-receptionist-cancel.ts` | `cancellationTotal.inc({source: 'receptionist'})` |
| `routes/recurring/series.ts` | `cancellationTotal.inc({source: 'recurring'})` |
| `routes/patient-appointments/:id/reschedule.ts` | `rescheduleTotal.inc()` |
| `routes/admin-appointments/:id/mark-no-show.ts` | `noShowTotal.inc()` |
| `routes/admin-appointments/:id/mark-completed.ts` | `completedTotal.inc()` |
| `routes/recurring/series.ts` | `recurringSeriesSuccessTotal.inc()` on 201; `recurringOccurrencesSkippedTotal.inc(N)` on partial success |
| `routes/bookings.ts` | `doubleBookingIncidentsTotal.inc()` when `err.code === '23505'` on `idx_appointment_doctor_scheduled` |
| `routes/admin-doctor-schedule.ts` + `routes/admin-doctor-block.ts` | `scheduleConflictIncidentsTotal.inc()` on 409 |
| `db/pool.ts` | `failedTransactionTotal.inc()` on `BEGIN` failure / serialization error |

### 4. Dashboard definition

**File:** `docs/observability/product-metrics-dashboard.json` (NEW).

Grafana dashboard JSON (committed in repo) with panels for every metric in §1. Panels:
- Single-stat: today's booking success rate (1) / total (booking.success) / total (booking.attempt).
- Time-series: availability-query p95 (5), booking_time_avail_to_book p95 (4).
- Time-series: cancellation rate (7) split by `source` label.
- Single-stat: recurring series success rate (11).
- Alert panels (no rules; just the metric): double-booking incidents (13), schedule-conflict incidents (14).

### 5. Tests

**File:** `apps/api/test/metrics-product.test.ts` (NEW).

After a scripted flow:
- Issue 3 availability queries → `availability_query_duration_seconds_count >= 3`.
- Issue 1 booking → `booking_success_total` increments by 1; `booking_time_avail_to_book_seconds_count` = 1.
- Issue 1 cancellation (patient) → `cancellation_total{source="patient"}` = 1.
- Issue 1 no-show → `no_show_total` = 1.
- Force a 23505 (double-booking) → `double_booking_incidents_total` = 1.

Each assertion reads `GET /metrics` and greps for the metric line + value.

### 6. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-9-product-metrics-instrumentation: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/api/src/metrics/product.ts` | NEW | Metric definitions + literal-type names |
| `apps/api/src/routes/availability.ts` | EDIT | Observe query duration |
| `apps/api/src/routes/bookings.ts` | EDIT | Observe booking duration; inc double-booking incidents |
| `apps/api/src/routes/patient-appointments/*.ts` | EDIT | Inc cancel/reschedule counters |
| `apps/api/src/routes/admin-doctor-cancel.ts` | EDIT | Inc cancellation |
| `apps/api/src/routes/admin-receptionist-cancel.ts` | EDIT | Inc cancellation |
| `apps/api/src/routes/recurring/series.ts` | EDIT | Inc series + skipped counters |
| `apps/api/src/routes/admin-appointments/*.ts` | EDIT | Inc no-show + completed |
| `apps/api/src/routes/admin-doctor-schedule.ts` + `admin-doctor-block.ts` | EDIT | Inc schedule-conflict incidents |
| `apps/api/src/db/pool.ts` | EDIT | Inc failed-transaction |
| `apps/api/src/app.ts` | EDIT | Mount `/metrics` to also expose product counters |
| `apps/api/test/metrics-product.test.ts` | NEW | End-to-end metric smoke |
| `docs/observability/product-metrics-dashboard.json` | NEW | Grafana dashboard JSON |
| `_bmad-output/implementation-artifacts/spec-7-9-product-metrics-instrumentation.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Trigger | Metric delta |
|---|---|
| 1 successful booking | `booking.success` +1, `booking_time_avail_to_book` observed |
| 1 booking 23505 | `booking.conflict` +1, `double_booking_incidents` +1 |
| 1 patient cancellation | `cancellation_total{source=patient}` +1 |
| 1 doctor cancellation | `cancellation_total{source=doctor}` +1 |
| 1 recurring series create | `recurring_series_success_total` +1; `recurring_occurrences_skipped_total` += N (skipped count from response) |
| 1 schedule conflict | `schedule_conflict_incidents_total` +1 |
| 1 BEGIN failure | `failed_transaction_total` +1 |

## Verification

1. `pnpm --filter @clinic/api test` — `metrics-product.test.ts` green.
2. `curl http://localhost:3001/metrics | grep -E 'booking_time_avail_to_book|availability_query_duration|cancellation_total|double_booking_incidents'` — every name from §1 appears at least once.
3. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline unchanged).
4. `pnpm --filter @clinic/api lint` — 0 new warnings (4 pre-existing baseline unchanged).
5. Dashboard JSON validates via Grafana's `dashboard-linter` (run separately in CI infra).
7. Testcontainers runtime unavailable in this env; suite cannot be re-run; status relies on spec audit trail.

## Deferrals (anticipated)

- **D1 — Alert rules.** PRD §16 lists the metrics; the alert thresholds (e.g., "page if `double_booking_incidents_total > 0` for 5 min") are infra-owned. Hand off to the deploy / SRE story.
- **D2 — Per-clinic labelling.** Today metrics are flat. When multi-clinic deploys start, add `clinic_id` label. Out of scope (architecture §3 ratifies the single-clinic anchor).
- **D3 — Web-client metrics.** Search-to-book funnel events on the client (e.g., "user saw the calendar but bounced") are a separate telemetry story.

## Spec Change Log

(none yet — first authoring)