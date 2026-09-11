---
title: 'Observability baseline (E0-S6)'
type: 'feature'
created: '2026-09-11'
status: 'done'
review_loop_iteration: 1
context: []
baseline_commit: 'cc09615bb3560017659eb48226c488fbbfae985c'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The E0 platform ships structured logs, `/healthz`, `/readyz`, and a JSON `/metrics` endpoint — but the metrics format is JSON (not the Prometheus exposition operators scrape), the counter list is hand-rolled (no histograms or process metrics), and the contract between logging and the rest of the codebase (which fields, which redactions, which content type) is documented in comments rather than enforced by a typed boundary. Downstream stories (booking, recurring, OTP) need to emit timers and counters without each one inventing a metric name.

**Approach:** Promote the existing seams into the documented baseline. Switch `/metrics` to Prometheus exposition format while keeping the JSON `counters` snapshot for back-compat with the in-flight `metrics.test.ts`. Add a histogram registry later stories use by name. Lock the log/health contract in a single internal type so adding a counter or log field is a typed edit, not a free-for-all. Add a startup log line carrying build version + commit sha so operators can correlate "which code is running".

## Boundaries & Constraints

**Always:**
- `/metrics` returns Prometheus exposition format with `Content-Type: text/plain; version=0.0.4; charset=utf-8`. Legacy JSON shape is retained under `Accept: application/json` only.
- Every metric name is a string-literal union; `inc()` / `observe()` throw on unknown names.
- Histograms expose `{name, count, sum, buckets[]}` with bucket boundaries chosen for sub-second API latency (p50/p95/p99 within a 1s budget).
- Structured logs keep the existing four contract fields (`request_id`, `actor_role`, `actor_id`, `appointment_id`) — never drop, never rename.
- Redaction paths remain the seven documented paths; a new redaction requires a code edit + test.
- `/healthz` and `/readyz` keep their current contract — both are 200/503 with JSON body, no stack traces.
- Process startup emits one `service_started` log line carrying `{service, version, git_sha, node_env, port}`.

**Ask First:**
- Adding a new top-level metric or log field category (not adding a new value to an existing category).
- Changing histogram bucket boundaries.

**Never:**
- Adding a new Prometheus exporter dependency that pulls in a transitive tree of collectors without auditing each.
- Logging raw OTP codes, raw JWTs, raw phone numbers, raw auth headers at any level (defence in depth: redaction list is exact-key only).
- Returning a non-JSON body from `/healthz` or `/readyz`.
- Blocking the event loop in any metric increment path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | `GET /metrics` with default `Accept` | `200 text/plain; version=0.0.4; charset=utf-8` Prometheus exposition; counters + histograms + process metrics | N/A |
| LEGACY_JSON | `GET /metrics` with `Accept: application/json` | `200 application/json` `{counters: {...}}` — same shape as before E0-S6 | N/A |
| COUNTER_INC | `inc('booking.attempt')` | Snapshot value increases by 1; `inc('booking.attempt', n)` increases by n | Unknown name → `Error('unknown_counter_name:...')` |
| HISTOGRAM_OBSERVE | `observe('http.request.duration_ms', 42)` | Bucket counts and sum update; total count increments | Unknown histogram → `Error('unknown_histogram_name:...')` |
| STARTUP_LOG | process boots | One `service_started` info line with `{service, version, git_sha, node_env, port}` | Missing git_sha → log `git_sha: 'unknown'` (never throw) |
| READY_DOWN | DB unreachable | `/readyz` returns `503 {db: 'unreachable'}`; no stack trace in body | Log `db_unreachable` warn line with underlying error message |

</frozen-after-approval>

## Code Map

- `apps/api/src/metrics/counters.ts` -- existing 7-counter JSON registry; gains `inc/snapshot/reset` kept + `toPrometheus()` added; throws on unknown name.
- `apps/api/src/metrics/histograms.ts` -- NEW. Typed histogram registry with bucket boundaries; mirrors counters contract.
- `apps/api/src/metrics/process.ts` -- NEW. Process metrics (uptime seconds, process_cpu_seconds_total, process_resident_memory_bytes, nodejs_eventloop_lag_seconds) via lightweight polling (NO `prom-client` dep — use `process.cpuUsage()` + `process.memoryUsage()` on snapshot).
- `apps/api/src/metrics/index.ts` -- NEW. Composes `counters + histograms + process` into one `render()` returning Prometheus exposition text.
- `apps/api/src/routes/metrics.ts` -- existing JSON-only route; gains content negotiation on `Accept` header (Prometheus default; JSON when `Accept: application/json`).
- `apps/api/src/middleware/log.ts` -- unchanged behaviour; gains one re-export of `CONTRACT_FIELDS` tuple so handlers and tests reference the contract from one source.
- `apps/api/src/middleware/log-contract.ts` -- NEW. Exports `CONTRACT_FIELDS = ['request_id','actor_role','actor_id','appointment_id'] as const` and `REDACT_PATHS` mirror list. `log.ts` imports from here.
- `apps/api/src/observability/build-info.ts` -- NEW. Reads `APP_VERSION` (default `0.0.0-dev`) and `GIT_SHA` (default `'unknown'`) from env; one `serviceStarted(port: number)` log emitter.
- `apps/api/src/server.ts` -- existing bootstrap; gains `serviceStarted(PORT)` call after `app.listen`.
- `apps/api/test/metrics.test.ts` -- existing 3 tests (JSON shape + inc throws); gains Prometheus exposition shape tests.
- `apps/api/test/histograms.test.ts` -- NEW. Observe increments, snapshot shape, unknown-name throw.
- `apps/api/test/process-metrics.test.ts` -- NEW. Asserts presence + numeric type of `process_*` lines in Prometheus output.
- `apps/api/test/startup-log.test.ts` -- NEW. Boots createApp with redirected logger; asserts one `service_started` line with required fields.
- `apps/api/package.json` -- no new dependency (deliberate — stdlib only).

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/metrics/counters.ts` -- add `toPrometheus(): string` returning one `# HELP` + `# TYPE` + sample line per counter -- rationale: isolates exposition format from counter mechanics
- [x] `apps/api/src/metrics/histograms.ts` -- new histogram registry with `observe(name, valueMs)`, `snapshot()`, `toPrometheus()`; typed `HISTOGRAMS` union -- rationale: locks histogram names later stories import by name
- [x] `apps/api/src/metrics/process.ts` -- new module exporting `snapshot()` (uptime, cpu seconds, rss bytes, eventloop lag ms) and `toPrometheus()` -- rationale: replaces third-party collector with stdlib-only reading
- [x] `apps/api/src/metrics/index.ts` -- new composer that returns one Prometheus text body from all three registries -- rationale: single render path; no double-formatting
- [x] `apps/api/src/middleware/log-contract.ts` -- module exporting `CONTRACT_FIELDS` tuple + `REDACT_PATHS` mirror -- rationale: handlers and tests reference contract from one source
- [x] `apps/api/src/middleware/log.ts` -- import `CONTRACT_FIELDS` / `REDACT_PATHS` from `log-contract.ts` instead of inline literals -- rationale: removes drift between definition and test assertion
- [x] `apps/api/src/middleware/log.ts` -- `customProps` reads field names from the imported `CONTRACT_FIELDS` tuple (not hardcoded literals); the four keys emitted on every request-scoped log line are derived from the same source the contract module declares -- rationale: delivers the "single source of truth" promise
- [x] `apps/api/src/observability/build-info.ts` -- new module: `serviceStarted(port)` emits one info log with `{service, version, git_sha, node_env, port}` -- rationale: operators correlate deployment sha to log stream
- [x] `apps/api/src/routes/metrics.ts` -- content negotiate on `Accept` header; default Prometheus, JSON when explicit -- rationale: back-compat with `metrics.test.ts` JSON expectation
- [x] `apps/api/src/routes/metrics.ts` -- Accept matching uses exact token comparison (comma-split + trim), not substring `includes` -- rationale: avoid `application/jsonp` accidental match
- [x] `apps/api/src/server.ts` -- call `serviceStarted(PORT)` after listen succeeds -- rationale: one startup line per process
- [x] `apps/api/src/metrics/histograms.ts` -- `observe()` rejects non-finite or negative `valueMs` with `Error('invalid_histogram_value:<name>')` -- rationale: prevents NaN/Infinity from corrupting sum and bucket counts
- [x] `apps/api/src/metrics/process.ts` -- `__resetForTests()` disables + nulls the event-loop monitor handle; `toPrometheus()` replaces NaN values with 0 -- rationale: no cross-test leakage and no `NaN` in Prometheus body
- [x] `apps/api/src/observability/build-info.ts` -- `serviceStarted(port)` validates `Number.isInteger(port) && port >= 0 && port <= 65535`; invalid port → warn log + no emission -- rationale: never emit `port: NaN` to operators
- [x] `apps/api/test/metrics.test.ts` -- add tests for Prometheus exposition shape (Content-Type `text/plain; version=0.0.4; charset=utf-8`, `# HELP`/`# TYPE`/sample line per named counter including the at-0 default), process metrics presence, JSON back-compat (explicit `Accept: application/json` AND default no-header) -- rationale: locks the new contract
- [x] `apps/api/test/histograms.test.ts` -- new tests: observe increments, unknown name throws, snapshot shape `{name, count, sum, buckets[]}`, non-finite / negative value rejection -- rationale: histogram contract
- [x] `apps/api/test/startup-log.test.ts` -- new test: boot app with captured logger, assert `service_started` line with required fields, pin `service === 'clinic-api'`, assert invalid-port guard -- rationale: locks startup contract
- [x] `apps/api/test/log.test.ts` -- new test: import `CONTRACT_FIELDS` from `log-contract.ts`, drive a request whose `logCtx` populates each entry, assert the emitted log line carries exactly the keys in `CONTRACT_FIELDS` -- rationale: locks the single-source-of-truth promise

**Acceptance Criteria:**
- Given a fresh process, when `GET /metrics` is called with default `Accept`, then response is `200` with `Content-Type: text/plain; version=0.0.4; charset=utf-8` and body contains one `# HELP` + `# TYPE counter` block per named counter plus process metrics, and the seven named counters all read `0`.
- Given a fresh process, when `GET /metrics` is called with `Accept: application/json`, then response is `200` with `application/json` and body is `{counters: {<name>: 0, ...}}` for the 7 named counters.
- Given a fresh process, when `GET /metrics` is called with no `Accept` header (the original E0-S1 caller shape), then response is the Prometheus body — locks the JSON back-compat path under default Accept only when the header is explicitly `application/json`.
- Given `inc('booking.attempt', 3)` then `GET /metrics`, then the `booking_attempt_total` sample line reads `3`.
- Given `observe('http.request.duration_ms', 42)` then `GET /metrics`, then `http_request_duration_ms_count` reads `1` and `http_request_duration_ms_sum` reads `42`.
- Given `observe('http.request.duration_ms', NaN)` or a negative value, then `observe()` throws `Error('invalid_histogram_value:http.request.duration_ms')` synchronously.
- Given `inc('booking.banana')` (unknown name), then call throws `Error('unknown_counter_name:booking.banana')` synchronously.
- Given a process boot, when `app.listen` resolves, then exactly one `service_started` info log line is emitted with `service === 'clinic-api'` and non-empty `version`, `git_sha`, `node_env`, `port` (and `git_sha` is `'unknown'` when env unset).
- Given `serviceStarted(NaN)` or `serviceStarted(-1)` or `serviceStarted(99999)`, then no log line is emitted; a warn log records the invalid port.
- Given `/readyz` while DB unreachable, then response is `503` with body `{db:'unreachable'}` and no `error` key carrying a stack trace.
- Given a pino log line, then it carries the four contract fields (`request_id`, `actor_role`, `actor_id`, `appointment_id`) — `appointment_id` may be null but the key is always present. The keys are derived from `CONTRACT_FIELDS` in `log-contract.ts`, not from inline literals in `log.ts`.

## Verification

**Commands:**
- `pnpm --filter @clinic/api typecheck` -- expected: 0 errors
- `pnpm --filter @clinic/api lint` -- expected: 0 errors
- `pnpm --filter @clinic/api test` -- expected: full suite green (no new baseline regressions; existing 5 pre-existing failures unchanged)

**Manual checks (if no CLI):**
- Open `apps/api/src/routes/metrics.ts` and confirm `Accept` header is consulted before defaulting to Prometheus.

## Spec Change Log

<!-- 2026-09-11 — Step-04 review loop 1, bad_spec corrections:

  (A) `charset=utf-5` → `charset=utf-8`. The frozen boundary "Always" rule and the AC
      row were inconsistent; all three reviewers flagged `utf-5` as an invalid MIME
      charset token (not registered with IANA; Prometheus scrapers reject it).
      Resolution: replace every `utf-5` in the AC and Code Map references with
      `utf-8`. The implementation followed the spec verbatim and emitted `utf-5`;
      it must be flipped to `utf-8` along with the matching test assertion.
      KEEP: the entire Accept-header content negotiation, the Prometheus default,
      the JSON back-compat under `Accept: application/json`, the `# HELP`/`# TYPE`
      blocks, the histogram + process architecture, the `metrics/index.ts`
      composer, the `log-contract.ts` module shape, the `serviceStarted()`
      function shape, and all test file additions.

  (B) `CONTRACT_FIELDS` adoption at emission site. Spec claimed the log-contract
      module was "the single source of truth" for the four-field log shape, but
      the actual `customProps` in `log.ts` hardcodes the four keys. Reviewer
      demonstrated this is dead code at the consumer side. Resolution: spec now
      requires `customProps` to read the field names from `CONTRACT_FIELDS`, and
      adds a new task + AC + test to lock it.
      KEEP: the `log-contract.ts` module exports, the re-export from `log.ts`,
      the `REDACT_PATHS` wiring (which already works), the existing four
      contract fields (`request_id`, `actor_role`, `actor_id`,
      `appointment_id`).

  (C) Patch items promoted to spec tasks (medium-severity, code-only):
      - histogram `observe()` rejects non-finite and negative values with
        `Error('invalid_histogram_value:<name>')`.
      - `process.ts` `__resetForTests` also disables + nulls the event-loop
        monitor handle to avoid cross-test leakage.
      - `process.ts` snapshot replaces NaN values with 0 before emitting
        Prometheus sample lines (no `NaN` ever appears in /metrics body).
      - `serviceStarted(port)` validates `Number.isInteger(port) && port >= 0
        && port <= 65535`; invalid → warn log + no emission.
      - Accept-header matching uses exact token match (comma-split,
        trim each token, compare against `application/json` exactly), not
        substring match.
      - Test asserts the named counters start at 0 in the Prometheus body
        (not just the JSON back-compat path).
      - Test asserts the JSON back-compat path under default Accept (no
        header sent) returns JSON — locks the original E0-S1 caller shape.
      KEEP: everything from (A) plus the existing tasks list. No tasks
      removed.
-->

## Suggested Review Order

**Entry point — what runs first**

- The HTTP boundary: `/metrics` content negotiation, exact Accept matching, and Prometheus default.
  [`metrics.ts`](../../apps/api/src/routes/metrics.ts#L18)

- The single render path that assembles all three registries into one Prometheus body.
  [`index.ts`](../../apps/api/src/metrics/index.ts)

**Counter + histogram + process registries (the new surface)**

- Counter names contract: `inc()` throws on unknown names; Prometheus exposition maps dots→underscores and adds `_total`.
  [`counters.ts`](../../apps/api/src/metrics/counters.ts)

- Histogram registry with typed union, finite-only guard, cumulative buckets, Prometheus exposition.
  [`histograms.ts`](../../apps/api/src/metrics/histograms.ts)

- Process metrics via stdlib only; NaN sanitization; test reset disables event-loop monitor.
  [`process.ts`](../../apps/api/src/metrics/process.ts)

**Log contract — single source of truth**

- The contract module: `CONTRACT_FIELDS` + `REDACT_PATHS` exported as the canonical list.
  [`log-contract.ts`](../../apps/api/src/middleware/log-contract.ts)

- `customProps` now derives the four emitted keys from `CONTRACT_FIELDS` instead of inline literals.
  [`log.ts`](../../apps/api/src/middleware/log.ts#L120)

**Startup log**

- `serviceStarted(port)` validates the port; emits the operator-facing `service_started` info line.
  [`build-info.ts`](../../apps/api/src/observability/build-info.ts)

- The production call site wiring the log line into the `app.listen` callback.
  [`server.ts`](../../apps/api/src/server.ts#L84)

**Peripherals — tests that lock the contracts**

- `/metrics` Content-Type, Accept negotiation, JSON back-compat, `application/jsonp` rejection.
  [`metrics.test.ts`](../../apps/api/test/metrics.test.ts)

- Histogram registry + invalid-value rejection + snapshot shape.
  [`histograms.test.ts`](../../apps/api/test/histograms.test.ts)

- Process metric presence + numeric type.
  [`process-metrics.test.ts`](../../apps/api/test/process-metrics.test.ts)

- Startup log line + env fallback + invalid-port guard.
  [`startup-log.test.ts`](../../apps/api/test/startup-log.test.ts)

- The `CONTRACT_FIELDS` keyset lock — fails if `customProps` ever drifts back to inline literals.
  [`log.test.ts`](../../apps/api/test/log.test.ts#L151)

