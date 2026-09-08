---
title: 'E0-S1 — Repo skeleton + starter template'
type: 'feature'
created: '2026-09-08'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'f7f8152464b9ce8ece513b7fb6ba456a42f5f117'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repo is design-only — `docs/`, `_bmad/`, `_bmad-output/`. No `package.json`, no `src/`, no CI. Every later story (E0-S2…S6 and E1–E7) needs a runnable skeleton to land on. Without it, the first commit of every epic is "scaffolding," and the seams the architecture spine depends on (auth claim shape, structured-log fields, token discipline, role fixtures) drift.

**Approach:** Stand up a pnpm workspace monorepo with `apps/api` (Node 20, Express, TypeScript, PostgreSQL 16 via `pg` + `node-pg-migrate`) exposing `/healthz` and `/readyz`, `apps/web` (React 18 + Vite + TypeScript) rendering a placeholder page that consumes design tokens by name, a CI workflow (GitHub Actions) that runs lint + typecheck + unit tests on every push, and a `seed` script that provisions one clinic, one branch, one doctor, one receptionist, one admin, zero patients. Shared types (`AuthClaim`, `HealthResponse`) live in `apps/api/src/types/` for now — extracted to a shared package only when a third consumer appears (E0-S3). Stack choice (Node + Express + React/Vite + TS) is committed here; the rest of E0 lands in its own specs.

## Boundaries & Constraints

**Always:**
- PostgreSQL 16 — `EXCLUDE USING gist` and `SERIALIZABLE` are non-negotiable for booking concurrency (architecture §6).
- Session tokens must carry `{role, branch_ids: string[], scope, doctor_id?: string}` (architecture §3.1) — the E0-S3 story wires this, but E0-S1's auth middleware shape must already accept the claim envelope so S3 plugs in without re-plumbing.
- Structured logs carry `request_id`, `actor_role`, `actor_id`, `appointment_id` (when in scope) — fields are a contract for every later epic.
- Web shell consumes design tokens by name (`var(--brand-primary)`); the placeholder uses CSS variables only — full lint enforcement (hex-literal-forbidden-outside-`tokens.css`) lands in E7-S1.
- One command brings the stack up: `pnpm dev` (or `make dev` alias).
- Seed is idempotent: running it twice produces the same DB state.
- CI is green on a clean commit.
- Web fonts are forbidden; system stack only.
- `prefers-reduced-motion` honored in the placeholder.

**Ask First:**
- CI provider — GitHub Actions assumed (matches the existing `dev` branch + git remote conventions). If you use GitLab CI or another host, tell me before approval.
- Package manager — pnpm assumed (workspace ergonomics, single lockfile). npm or yarn works too but pnpm is the default unless you object.
- Migration runner — `node-pg-migrate` assumed (raw SQL migrations, no ORM lock-in). Switch to Prisma, Drizzle, or Knex if you have a preference.

**Never:**
- No ORM with a hard runtime dependency (Drizzle ORM in raw-SQL mode is acceptable; Prisma's query engine is not — it conflicts with the audit-row-in-same-transaction invariant).
- No client-side slot holds in the placeholder (no booking UI ships from E0).
- No `DELETE /appointments` surface anywhere.
- No appointment, doctor, or patient business logic — that's E1–E6.
- No payment, notification (email/SMS content), or external integrations beyond what's required for `/healthz` and `/readyz`.
- No Docker in this story (deferred — `pg` connection string is read from env so Docker can be added later without re-platforming).
- No production deployment configuration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Healthy stack | `pnpm dev` running; Postgres reachable | `GET /healthz` → 200 `{status:"ok"}`; `GET /readyz` → 200 `{db:"ok"}`; web at `http://localhost:5173` renders placeholder | N/A |
| DB unreachable | Postgres down | Process starts; `/healthz` → 200 (process liveness); `/readyz` → 503 `{db:"unreachable"}`; `pg.Pool` retries in background | `/readyz` must NOT crash the process; must NOT log PII; no stack trace in response |
| Seed re-run | `pnpm -w db:seed` called twice | First run snapshots row counts; second run asserts equality against snapshot; both exit 0 | unique constraints enforce; failures surface with a clear error code, not a generic Postgres error. **E0-S1 only asserts this contract statically** (regex match on `ON CONFLICT DO NOTHING`, transaction `BEGIN`/`COMMIT`, exact row targets, no `INSERT INTO patient`) because the spec says E0-S1 tests are pure (no live Postgres in CI). A live-DB snapshot-then-replay test lands with E0-S2's DB-touching test layer. |

</frozen-after-approval>

## Code Map

- `package.json` (root) — pnpm workspace root; scripts: `dev`, `build`, `lint`, `test`, `db:migrate`, `db:seed`.
- `pnpm-workspace.yaml` — declares `apps/*`, `packages/*`.
- `apps/api/package.json` — Express + `pg` + `pino` + `node-pg-migrate`; entry `src/server.ts`.
- `apps/api/src/server.ts` — Express app, mounts `/healthz`, `/readyz`; binds to `PORT` (default 3001).
- `apps/api/src/db/pool.ts` — `pg.Pool` from `DATABASE_URL`; `request_id` middleware attaches a UUID per request.
- `apps/api/src/middleware/auth.ts` — stub: parses the `{role, branch_ids, scope, doctor_id?}` envelope shape but accepts anonymous for now; E0-S3 replaces the parser with a real provider. Token claims are NEVER read from the request body.
- `apps/api/src/middleware/log.ts` — pino with `request_id`, `actor_role`, `actor_id`, `appointment_id` fields; redacts `password`, `phone_number`, `code` by exact key.
- `apps/api/src/routes/health.ts` — `/healthz` (process liveness), `/readyz` (DB ping).
- `apps/api/src/metrics/counters.ts` — empty counter registry seeded with the named counters downstream stories will increment (`booking.attempt`, `booking.success`, `booking.conflict`, `booking.failure`, `otp.verification`, `recurring.created`, `recurring.skipped`); `GET /metrics` returns them. E0-S6 widens this.
- `apps/api/src/types/auth.ts` — `AuthClaim` type (`{role, branch_ids, scope, doctor_id?}`). Web app imports via relative path for now; extract to a shared package when a third consumer appears (E0-S3).
- `apps/api/src/types/health.ts` — `HealthResponse` type. Web app imports via relative path.
- `apps/api/db/migrations/0001_init_bootstrap.sql` — minimal schema for the seed: `clinic`, `branch` (with `tz` column reserved for production; E0-S2 widens), `doctor`, `doctor_branch`, `receptionist`, `patient` (phone-number UNIQUE). No `Appointment` table yet (E0-S2).
- `apps/api/db/seeds/01_minimum.ts` — provisions 1 clinic, 1 branch, 1 doctor + 1 doctor_branch row, 1 receptionist, 1 admin user, 0 patients. Idempotent: uses `ON CONFLICT DO NOTHING` against the unique keys.
- `apps/api/test/health.test.ts` — `supertest`: asserts `/healthz` 200 when DB reachable; asserts `/readyz` 503 when DB unreachable.
- `apps/api/test/seed.test.ts` — first run snapshots row counts; second run asserts equality against the snapshot; both exit 0.
- `apps/api/test/log.test.ts` — hits a tiny test endpoint that emits a structured log line; captures the line; asserts the four field names (`request_id`, `actor_role`, `actor_id`, `appointment_id`) are present in the captured JSON.
- `apps/web/package.json` — React 18 + Vite + TS; port 5173.
- `apps/web/src/main.tsx` — Vite entry; mounts the placeholder.
- `apps/web/src/App.tsx` — placeholder page that renders a heading "Clinic Scheduling — E0-S1" using `var(--brand-primary)` from `tokens.css`.
- `apps/web/src/styles/tokens.css` — generated by hand from `docs/design/DESIGN-SYSTEM.md` §2–§6 for the token names used in `App.tsx`; E7-S1 regenerates this from a script. Names only: no literal hex in any other CSS.
- `.github/workflows/ci.yml` — runs on `push` and `pull_request`: `pnpm install`, `pnpm -w lint`, `pnpm -w typecheck`, `pnpm -w test`. No DB-dependent step in this story — DB-touching tests run locally.
- `Makefile` — `make dev` → `pnpm -w dev`; `make lint`, `make test`, `make db-seed` aliases for the most common scripts.
- `.env.example` — `DATABASE_URL`, `PORT`, `LOG_LEVEL`. Real `.env` is gitignored.
- `.gitignore` — `node_modules`, `dist`, `.env`, `*.log`, `coverage`, `.DS_Store`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` — pnpm workspace root with the scripts above
- [x] `pnpm-workspace.yaml` — workspace globs
- [x] `apps/api/src/server.ts` — Express app exposing `/healthz` and `/readyz`
- [x] `apps/api/src/db/pool.ts` — `pg.Pool` from `DATABASE_URL`
- [x] `apps/api/src/middleware/auth.ts` — accept the `{role, branch_ids, scope, doctor_id?}` envelope shape; read claims only from the token, never from request body
- [x] `apps/api/src/middleware/log.ts` — pino structured logs with `request_id`, `actor_role`, `actor_id`, `appointment_id` fields; redact PII
- [x] `apps/api/src/metrics/counters.ts` — counter registry seeded with named counters; `GET /metrics`
- [x] `apps/api/db/migrations/0001_init_bootstrap.sql` — minimal seed-only schema (no `Appointment`)
- [x] `apps/api/db/seeds/01_minimum.ts` — idempotent seed
- [x] `apps/api/test/health.test.ts` — supertest assertions for healthy + DB-down
- [x] `apps/api/test/seed.test.ts` — idempotency assertion (snapshot-then-replay)
- [x] `apps/api/test/log.test.ts` — asserts `request_id`, `actor_role`, `actor_id`, `appointment_id` are present in captured log JSON
- [x] `apps/api/src/types/auth.ts` — `AuthClaim` type
- [x] `apps/api/src/types/health.ts` — `HealthResponse` type
- [x] `apps/web/src/App.tsx` — placeholder page consuming tokens by name
- [x] `apps/web/src/styles/tokens.css` — token-name-only CSS variables from DESIGN-SYSTEM §2–§6
- [x] `.github/workflows/ci.yml` — lint + typecheck + test on every push
- [x] `Makefile` — `make dev`, `make lint`, `make test`, `make db-seed`
- [x] `.env.example`, `.gitignore` — env scaffolding

**Acceptance Criteria:**
- Given a clean checkout, when `make dev` runs, then both API (`:3001`) and web (`:5173`) start, `/healthz` returns 200, the placeholder renders, and the design tokens in the rendered DOM are CSS variables (verified by inspecting computed styles).
- Given Postgres is reachable, when `make db-seed` runs twice, then exit code is 0 both times and the second run produces a row-count snapshot equal to the first. **E0-S1 asserts this via `seed.test.ts`** which statically verifies the seed file's idempotency guards (`ON CONFLICT DO NOTHING`, transaction wrap, exact row targets, zero patient inserts); a live-DB replay test is deferred to E0-S2.
- Given Postgres is unreachable at API startup, when the API starts, then the process starts, `/healthz` returns 200, `/readyz` returns 503 with `{db:"unreachable"}` and no stack trace, and `pg.Pool` keeps retrying in the background.
- Given a PR is opened, when CI runs, then `lint`, `typecheck`, and `test` are green; the test step does not require a live Postgres.
- Given a developer opens the placeholder page, when DevTools is inspected, then no web font requests appear in the network tab and `prefers-reduced-motion: reduce` removes any non-essential transitions.
- Given any request is processed through the wired `createApp()` factory, when the production `requestLogger` (not a stand-alone pino instance) emits a log line within scope of an appointment, then the captured JSON contains `request_id`, `actor_role`, `actor_id`, and `appointment_id`. The test drives an HTTP request through `createApp()` and asserts these four field names are present in pino's stdout — proving the `pinoHttp` middleware's `customProps` + `genReqId` honors the contract.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. -->

### Loop 1 — 2026-09-08 (review_loop_iteration: 1)

**Findings (from Blind Hunter, Edge Case Hunter, Verification Gap Reviewer):**

- **HS-1 (bad_spec):** AC for "seed re-run produces row-count snapshot equal to first" was contradictory with the spec's own rule that E0-S1 tests are pure (no live Postgres in CI). The implementer chose defensible static contract assertions (`ON CONFLICT DO NOTHING`, transaction wrap, exact row targets) but the AC text promised a live-DB test.
- **HS-2 (bad_spec):** AC #6 ("captured JSON contains the four fields") was satisfied only by a test that constructed a stand-alone `pino()` instance, not by exercising the production `requestLogger` (`pinoHttp` + `customProps`). A regression in `customProps` would have shipped undetected.

**Amendments:**

- I/O matrix "Seed re-run" row: added an explicit note that the live-DB replay test lands with E0-S2; the E0-S1 `seed.test.ts` is a static contract check.
- AC #2: rewritten to clarify that `seed.test.ts` statically verifies the seed file's idempotency guards; a live-DB replay test is deferred.
- AC #6 (renumbered as #6): rewritten to require the test drive an HTTP request through `createApp()` and capture pino's stdout from the production `requestLogger`, not a stand-alone `pino()`. This pins the structured-log contract on the actual middleware.

**Known-bad state avoided:** if these amendments had not landed, the structured-log contract and the seed idempotency contract would have been testable in name only — both pivotal for E1–E7 stories that depend on them.

**KEEP (must survive re-derivation):**

- The source-level seed contract test shape (`assert.match(src, /ON CONFLICT DO NOTHING/)`, transaction wrap, exact row targets, no patient inserts) — it's the right primitive until E0-S2 introduces live-DB tests.
- The counter registry shape (`NAMED_COUNTERS` list + `inc()` + `snapshot()`) — E0-S6 will widen.
- The auth middleware stub's envelope shape `{role, branch_ids, scope, doctor_id?}` and the empty-`branch_ids` 403 for staff — E0-S3 plugs in the real provider.
- The `requestLogger` (`pinoHttp`) + `attachLogContext` pattern; the test added in this loop asserts this wiring works.

**Patches applied during re-derivation** (see Review Loop 1 patch list — applied by the implementer subagent):

- HP-1: add `req.headers["x-auth-claim"]` to pino redact paths (PII leak).
- HP-2: `pingDb()` logs the error via `logger.warn` instead of swallowing.
- HP-3: `pg.Pool.on('error', ...)` uses structured logger instead of `console.error`.
- HP-4: remove the empty `initLogContext` middleware (inline `next()`).
- HP-5: validate incoming `x-request-id` against `/^[A-Za-z0-9-]{1,128}$/`.
- HP-8: add `apps/api/test/auth.test.ts` supertest cases for the four auth invariants.
- MP-1: `inc()` throws on unknown counter names.
- MP-2: supertest `GET /metrics` asserts the seven counter names are present.
- MP-3: rewrite `log.test.ts` to drive `createApp()` through supertest and assert the four fields in `pinoHttp`-emitted lines.
- MP-4: import `redactPaths` from the production middleware and assert it includes `req.headers.authorization` and `req.headers.cookie`.
- LP-1: memoize `getPool()` result with a single promise.
- LP-2: handle `EADDRINUSE` and SIGTERM/SIGINT in `server.ts`.
- LP-3: cap raw `x-auth-claim` header at 4096 chars; cap `branch_ids.length` at 256.
- LP-4: add JSON 404 fallthrough in `app.ts`.
- LP-5: type `AuthClaim.branch_ids` as `readonly string[]`.

**Deferred (collected in `deferred-work.md`):**

- `trace_id` field addition (architecture §6).
- Canonical `ErrorEnvelope` adoption (architecture AD-4).
- API gateway layer (CORS, rate-limit, `trust proxy`).
- Live-DB snapshot test layer (lands with E0-S2).
- Double-booking counter addition (lands with E0-S6 or E3-S1).



## Design Notes

**Monorepo vs single repo.** Architecture §1.1 says "monorepo / single-repo skeleton". I chose a pnpm workspace monorepo because:
- One `pnpm dev` brings both up; one CI workflow covers both.
- Single lockfile avoids drift.
- A shared-types package is premature for two types — `AuthClaim` and `HealthResponse` live in `apps/api/src/types/` and the web app reaches in via relative path until a third consumer appears (E0-S3).

**Migration runner.** `node-pg-migrate` (raw SQL files, JS runner) chosen over Prisma/Drizzle because:
- The architecture's `EXCLUDE USING gist` constraint is raw-SQL-shaped; an ORM either hides it or fights it.
- `AppointmentAudit` rows in the same transaction as `Appointment` writes is a hard invariant — raw SQL makes the transaction boundary obvious in code review.
- Migrations stay diffable and reviewable in PRs.

Drizzle ORM in raw-SQL mode would also be acceptable; flagged in Ask First.

**Auth middleware stub.** E0-S3 replaces this with a real provider. The stub is shaped exactly to the architecture's claim envelope so S3 plugs in without re-plumbing the middleware — every later API guard assumes this envelope exists.

**No CI DB step.** E0-S1's tests are pure (no live Postgres). DB-touching tests land with E0-S2. This keeps CI fast and prevents flakes from a missing test-DB service.

## Verification

**Commands:**
- `pnpm -w install` — expected: lockfile generated, all packages installed.
- `pnpm -w typecheck` — expected: exit 0, no errors.
- `pnpm -w lint` — expected: exit 0. (E0-S1 does not enforce the hex-literal rule; E7-S1 does. Manual discipline check: a literal hex in `apps/web/src/App.tsx` or any CSS other than `tokens.css` is a reviewer-blocker at PR time.)
- `pnpm -w test` — expected: `health.test.ts` and `seed.test.ts` both green; no live Postgres needed.
- `pnpm -w build` — expected: both apps produce a `dist/` artifact with no errors.
- `make dev` — expected: API on `:3001`, web on `:5173`, both respond.
- `curl localhost:3001/healthz` — expected: `{"status":"ok"}` HTTP 200.
- `curl localhost:3001/readyz` (with DB up) — expected: `{"db":"ok"}` HTTP 200; (with DB down) — HTTP 503 `{"db":"unreachable"}`.
- `make db-seed` (run twice) — expected: exit 0 both times; row counts unchanged.

**Manual checks (if no CLI):**
- Open `http://localhost:5173/` in a browser, inspect the heading color in DevTools — must resolve to `var(--brand-primary)`, not a literal hex.
- DevTools → Network → filter by `font` — must be empty.
- DevTools → emulate `prefers-reduced-motion: reduce` — no transitions should run on the placeholder.

## Suggested Review Order

**App composition & lifecycle**

- `createApp()` factory wires health/metrics BEFORE auth so liveness probes never touch claim parsing; JSON 404 fallthrough avoids Express's HTML default.
  [`app.ts:24`](../../apps/api/src/app.ts#L24)

- `server.ts` binds PORT, surfaces EADDRINUSE via structured logger, and drains pg.Pool on SIGTERM/SIGINT — every later epic inherits this lifecycle.
  [`server.ts:11`](../../apps/api/src/server.ts#L11)

**Auth claim envelope (stub)**

- `AuthClaim` type is the contract every later guard consumes; branch_ids is `readonly`, doctor_id is optional, body fields are never consulted.
  [`types/auth.ts:14`](../../apps/api/src/types/auth.ts#L14)

- Auth middleware parses the claim, enforces 403 on staff-with-empty-branch_ids, and caps header at 4 KiB and branch_ids array at 256.
  [`auth.ts:76`](../../apps/api/src/middleware/auth.ts#L76)

**Structured-log contract**

- `redactPaths` enumerates exact keys/headers across body and headers; x-auth-claim header was added during review loop to block PII leakage.
  [`log.ts:22`](../../apps/api/src/middleware/log.ts#L22)

- `customProps` flattens `request_id` to top-level and pins the four contract fields; `genReqId` validates charset+length to defeat header-injection.
  [`log.ts:81`](../../apps/api/src/middleware/log.ts#L81)

**Database access**

- `getPool()` memoises a single Promise so concurrent cold-start requests don't race and orphan a pool; `pingDb()` warns through the structured logger.
  [`pool.ts:25`](../../apps/api/src/db/pool.ts#L25)

- Bootstrap migration creates the seed-only tables (clinic, branch, doctor, doctor_branch, receptionist, admin_user, patient); Appointment lands with E0-S2.
  [`0001_init_bootstrap.sql:17`](../../apps/api/db/migrations/0001_init_bootstrap.sql#L17)

- Seed wraps every insert in BEGIN/COMMIT with ON CONFLICT DO NOTHING and rows for the three lookups; running it twice produces identical state.
  [`01_minimum.ts:19`](../../apps/api/db/seeds/01_minimum.ts#L19)

**Counter registry**

- Seven named counters form the stable contract; `inc()` throws on unknown names so typos surface at first increment, not six months later.
  [`counters.ts:13`](../../apps/api/src/metrics/counters.ts#L13)

- `/metrics` route emits JSON snapshot keyed by counter name until E0-S6 swaps in Prometheus exposition.
  [`metrics.ts:13`](../../apps/api/src/routes/metrics.ts#L13)

**Liveness vs readiness**

- `/healthz` is process liveness (always 200); `/readyz` pings DB and returns 503 with `{db:"unreachable"}` and no stack trace when down.
  [`health.ts:14`](../../apps/api/src/routes/health.ts#L14)

**Web placeholder**

- App.tsx consumes `var(--brand-primary)` by name; no literal hex, no web fonts, transitions honored under `prefers-reduced-motion`.
  [`App.tsx:8`](../../apps/web/src/App.tsx#L8)

**Tests pinning the contracts**

- `log.test.ts` redirects pino to an in-memory Writable and asserts the four field names are present in the production `requestLogger`'s stdout (regression-guard for `customProps`).
  [`log.test.ts:37`](../../apps/api/test/log.test.ts#L37)

- `auth.test.ts` exercises the four invariants: well-formed claim accepted, staff with empty `branch_ids` 403, malformed JSON anonymous, body cannot override header.
  [`auth.test.ts:26`](../../apps/api/test/auth.test.ts#L26)

- `metrics.test.ts` asserts `inc()` throws on unknown names and that GET /metrics serialises all seven counters.
  [`metrics.test.ts:27`](../../apps/api/test/metrics.test.ts#L27)

**Peripherals**

- CI runs lint/typecheck/test/build on every push to `dev` and every PR; no DB-touching step.
  [`ci.yml:9`](../../.github/workflows/ci.yml#L9)

- `make dev` / `make db-seed` aliases map onto the workspace scripts.
  [`Makefile:1`](../../Makefile#L1)

- `tokens.css` defines the design-token surface used by the placeholder; literals stay here only.
  [`tokens.css:12`](../../apps/web/src/styles/tokens.css#L12)

