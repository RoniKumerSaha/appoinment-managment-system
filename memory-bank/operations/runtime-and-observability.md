# Runtime & Observability

## Overview

How the application runs locally, what it exposes for monitoring, and
what the CI pipeline actually verifies. This file records the operating
context for the project — deployment is currently local-development
only, and the production story is deferred.

## Local runtime

| Service | Port | Command |
|---|---|---|
| API | `:3001` | `pnpm --filter @clinic/api run dev` |
| Web (Vite dev server) | `:5173` | `pnpm --filter @clinic/web run dev` |
| PostgreSQL | `:5432` | database `medislot`, user/pass `medislot`/`medislot` |

The Vite dev server proxies the API path prefixes to `:3001`. **A
prefix missing from that proxy map is not proxied** — Vite answers from
the SPA fallback with a 404 HTML body, which the client surfaces as
`api_404:unknown_error`. When adding a route family, add its prefix to
`apps/web/vite.config.ts` in the same change.

### Environment

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | API | **Required.** `getPool()` throws `'DATABASE_URL is not set'` when missing. |
| `JWT_SECRET` | API | Signing key for the hand-rolled HS256 JWT. |
| `NODE_ENV` | API | `development` enables the email-only staff login fallback and the mock OTP route. |
| `SMS_PROVIDER_*` | API | OTP delivery. `503` / `sms_send_failed` when unavailable. |

### Seeding

`pnpm --filter @clinic/api run db:reset` runs the baseline seed **and**
the rich operational seed. Three seeds exist:

| Seed | What it provides |
|---|---|
| `01_minimum.ts` | The baseline: clinic, branches, doctors, receptionists, an admin, appointment types, schedules, five patients. |
| `02_role_ids.ts` | Role id constants shared by the other seeds. |
| `03_rich_operations.ts` | Staff `password_hash` credentials, doctor blocks, full-status appointment history, a recurring series, an audit trail. |

**The baseline alone leaves `password_hash` NULL on every staff
account**, which keeps the dev-only email-only login path reachable.
Running only `01_minimum.ts` means staff sign-in works without a
password in dev only.

## Health and readiness

| Endpoint | Meaning | 200 body | Failure body |
|---|---|---|---|
| `GET /healthz` | Process liveness. Returns 200 as long as the process is up. | `{ status: 'ok' }` | — |
| `GET /readyz` | Readiness. Pings the database. | `{ db: 'ok' }` | `503` `{ db: 'unreachable' }` |

**The 503 body never includes a stack trace.** Both endpoints are
mounted **before** `authMiddleware`, so they are unauthenticated.

## Metrics

`GET /metrics` is also mounted before authentication.

**Content negotiation is exact-token, not substring.** The `Accept`
header is comma-split, each token trimmed, and compared for equality
against `application/json` only:

| Request | Response |
|---|---|
| `Accept: application/json` (exact token) | `200` `{ counters: {…} }` — the legacy JSON shape |
| Anything else (including `application/jsonp`, `application/json; charset=utf-8`) | `200` Prometheus text exposition v0.0.4, `Content-Type: text/plain; version=0.0.4; charset=utf-8` |

The Prometheus body is written with `res.end()`, not `res.send()` —
`res.send()` re-derives Content-Type from the argument and would
rewrite the Prometheus content type into a generic `text/plain`.

### Named counters

Seven integer-only counters. **The names are a contract** — downstream
route code imports them by string. An unknown name throws
`unknown_counter_name:<name>` at the first increment rather than
silently disappearing from the metrics output.

| Dotted name | Prometheus name |
|---|---|
| `booking.attempt` | `booking_attempt_total` |
| `booking.success` | `booking_success_total` |
| `booking.conflict` | `booking_conflict_total` |
| `booking.failure` | `booking_failure_total` |
| `otp.verification` | `otp_verification_total` |
| `recurring.created` | `recurring_created_total` |
| `recurring.skipped` | `recurring_skipped_total` |

Values never decrease within a process lifetime.

### Histograms

One histogram: `http.request.duration_ms`.

Bucket boundaries (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500,
+Inf. Chosen for sub-second API latency — p50/p95/p99 within a 1s
budget.

`observe()` throws on an unknown name, and on a non-finite or negative
value (`invalid_histogram_value:<name>`). A NaN would silently corrupt
`sum` (NaN + 1 === NaN); Infinity would produce a body Prometheus
scrapers reject.

### Process metrics

Emitted by `apps/api/src/metrics/process.ts`, stdlib-only:

| Metric | Type | Source |
|---|---|---|
| `uptime_seconds` | gauge | `process.uptime()` |
| `process_cpu_seconds_total` | counter | accumulated `process.cpuUsage()` against a module-load baseline |
| `process_resident_memory_bytes` | gauge | `process.memoryUsage().rss` |
| `nodejs_eventloop_lag_seconds` | gauge | `node:perf_hooks.monitorEventLoopDelay`, lazily enabled |

Non-finite values are replaced with `0` before exposition — Prometheus
forbids literal `NaN` / `Infinity` in sample values and rejects the
body. The underlying snapshot is unchanged.

## Logging

pino 9.5 + pino-http 10.3, structured JSON. Full conventions are in
`standards/coding-standards.md` § Logging.

Operationally:

- Every line carries a top-level `request_id`, emitted by pino-http and
  echoed as the `x-request-id` response header.
- `customLogLevel` maps HTTP status to level: ≥500 → error, ≥400 →
  warn, else info.
- Authorization headers, cookies, passwords, phone numbers and OTP
  codes are redacted centrally by `REDACT_PATHS`
  (`middleware/log-contract.ts:35-43`), with phone numbers and emails
  additionally redacted at the call site.

## CI

`.github/workflows/ci.yml` — `name: ci`, triggered on **push to
`dev`** and on **every pull request**.

| Step | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile=false` |
| Lint | `pnpm -w lint` |
| Typecheck | `pnpm -w typecheck` |
| Test | `pnpm -w test` |
| Build | `pnpm -w build` |

Runner: `ubuntu-latest`, Node 20, pnpm 12, 10-minute timeout.

**CI does not run the web test suites.** The web package's aggregate
`test` script is a no-op placeholder (`echo 'no web tests in E0-S1'`)
kept for backward compatibility; the real web suites are invoked by
name (`test:e7-s1`, `test:e7-s4`, `test:e7-s5-focus`, `test:e7-s5-pills`,
`test:e7-s5-touch`, `test:e7-s7`). If you add a web suite, wire it into
the workflow — otherwise it will only ever run locally.

**There is no browser-level E2E suite.** The Playwright journey specs were
removed from this repository, so there is no E2E story to wire into CI.

## The API test suite needs Docker

`apps/api/test/db/withTestDb.ts` starts a `postgres:16-alpine`
container through testcontainers, or reuses an existing `DATABASE_URL`
when one is set.

**With the Docker daemon down, the suite fails immediately** with
`Could not find a working container runtime strategy`, before a single
test executes. This is not a test failure — it is an environment
prerequisite.

Run the API suite with:

```bash
pnpm --filter @clinic/api run test
# node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs \
#      --test-concurrency=1 test/*.test.ts
```

`--test-concurrency=1` is required — the suite seeds a real database
and the files must not interleave.

## Deployment

**Local development only.** There is no Dockerfile, no compose file, no
IaC and no deployment pipeline.

The database is **self-hosted in development**; a managed instance is
the intent for any real deployment. The API would run behind a reverse
proxy that terminates TLS; the web client is a static bundle served by
any static host or CDN.

**Not yet decided**, and recorded as deferrals in the README:

- TLS termination and proxy configuration.
- Database hosting and migration execution on deploy (migrations are
  forward-only and currently run by hand).
- Secret management for `JWT_SECRET` and `DATABASE_URL`.
- The refresh-token mechanism (there is none — see
  `standards/tech-stack.md` § Authentication).
- Rate limiting beyond the OTP cooldown/lock.
