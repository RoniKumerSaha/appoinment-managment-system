---
title: 'E1-S0b — Admin clinic API'
type: 'feature'
created: '2026-09-14'
status: 'done'
review_loop_iteration: 1
baseline_commit: '743a3cc5fc2dab96b7dbe77535a9ec7a3d8b4cfc'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-2-data-model-migrations.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-3-auth-provider-wiring.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-0-clinic-management-single-clinic-anchor.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** E1-S0a lands the singleton invariant at the DB layer, but there is no API surface for an admin to read or update the clinic. Without an admin route, the invariant exists only as a database curiosity; the story's "An admin scoped to clinic A cannot list branches of clinic B" acceptance has no API to test against.

**Approach:** Add `GET /admin/clinic` and `PATCH /admin/clinic` in a new `routes/admin-clinic.ts`, gated by a new `adminScope` middleware that enforces `req.auth.claim.role === 'admin' && req.auth.claim.scope === 'clinic'`. `GET` runs one SQL: the singleton row joined with 4 subqueries for active/inactive counts of branches, doctors, receptionists, plus a patient total. `PATCH` accepts `{name: string}` (1–120 chars) and returns the updated row. A new test helper `__makeAdminToken()` mints a signed admin JWT for dev/test only.

## Boundaries & Constraints

**Always:**
- `adminScope` middleware asserts both `role === 'admin'` and `scope === 'clinic'`. Failure paths: `403 {error: 'forbidden_role'}` for role mismatch; `403 {error: 'forbidden_scope'}` for scope mismatch. Both follow the E0-S6 error envelope shape.
- `GET /admin/clinic` runs ONE SQL: `SELECT … FROM clinic c, LATERAL (SELECT … active_branches) … WHERE c.id = $1`. No N+1. All 4 count subqueries carry `WHERE clinic_id = $1` (the singleton UUID).
- `PATCH /admin/clinic` accepts `name` only. Length 1–120. Empty string or longer strings return `400 {error: 'invalid_name'}`. The route validates BEFORE any DB call.
- The `clinic.id` returned in responses is the singleton UUID; clients should treat it as read-only.
- `__makeAdminToken(sub = 'admin-main', scope = 'clinic')` mirrors `apps/api/test/auth-jwt.test.ts:11-46`. Production guard: throws `admin_token_helper_disabled_in_production` when `NODE_ENV === 'production'`. The helper is dev/test-only — production path is the staff login (deferred W10).
- Router mounts AFTER `authMiddleware` (E0-S3) and AFTER `adminScope`. Mirror E0-S3 mount order at `apps/api/src/app.ts:40-96`.
- `updated_at` is managed by the existing `trg_clinic_set_updated_at` trigger from `0004_widen_seed_entities.sql:31-38`. No new trigger.

**Ask First:**
- **A1 — Counts granularity.** Two options: (i) return `active` only, omit inactive fields; (ii) return both `active` and `inactive` for branches/doctors/receptionists, and `patients_total` only (no active/inactive split for patients since patient `active` is not in the seed). (ii) is recommended — matches mockup 32's "X active · Y inactive" rendering. Costs nothing.

**Never:**
- No `clinic_id` JWT claim — admin scoping stays at `scope: 'clinic'` per AD-8.
- No DELETE `/admin/clinic` route. No `tagline` field. Out of scope (deferred-work.md).
- No new metric name beyond what E0-S6 already registered.
- No new `trg_*` triggers — `trg_clinic_set_updated_at` already covers `name` updates.
- No `req.body.role` / `req.body.branch_ids` / `req.body.clinic_id` consultation by the route — the JWT claim is the only authority.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `GET /admin/clinic` happy path | valid admin JWT (`role: 'admin'`, `scope: 'clinic'`) | `200 {id, name, created_at, updated_at, counts: {branches_active, branches_inactive, doctors_active, doctors_inactive, receptionists_active, receptionists_inactive, patients_total}}` | N/A |
| `GET /admin/clinic` no session | unauthenticated request | `401 {error: 'unauthenticated'}` | Auth middleware |
| `GET /admin/clinic` patient JWT | valid JWT but `role !== 'admin'` | `403 {error: 'forbidden_role'}` | `adminScope` |
| `GET /admin/clinic` admin scope=branch | valid admin JWT, `scope !== 'clinic'` | `403 {error: 'forbidden_scope'}` | `adminScope` |
| `PATCH /admin/clinic` happy path | `{name: 'New Clinic Name'}`, admin session | `200 {id, name, created_at, updated_at}`; `updated_at > pre-call` | N/A |
| `PATCH /admin/clinic` empty name | `{name: ''}` | `400 {error: 'invalid_name'}` | Route-level length check |
| `PATCH /admin/clinic` over-length name | `{name: <121 chars>}` | `400 {error: 'invalid_name'}` | Route-level length check |
| `PATCH /admin/clinic` missing name | `{}` or `{name: null}` | `400 {error: 'invalid_name'}` | Type check |
| `PATCH /admin/clinic` non-string name | `{name: 123}` | `400 {error: 'invalid_name'}` | Type check |
| `__makeAdminToken()` in production | `NODE_ENV === 'production'` | Throws `Error('admin_token_helper_disabled_in_production')` | Helper guard |
| `__makeAdminToken()` with custom sub | `{sub: 'admin-east', scope: 'clinic'}` | Returns a signed JWT for that sub | N/A |

</frozen-after-approval>

## Code Map

- `apps/api/src/middleware/admin-scope.ts` (NEW) — Express middleware asserting `req.auth.claim.role === 'admin' && req.auth.claim.scope === 'clinic'`. Mirrors `apps/api/src/middleware/auth.ts:1-128` shape; emits inline JSON envelopes `{error: 'forbidden_role'}` / `{error: 'forbidden_scope'}`. Reads `req.auth?.claim` (the field is optional per E0-S3 declare-merge at `auth.ts:82-86`); treat `undefined` as the no-claim path → 401 `{error: 'unauthenticated'}`. No shared `badRequest`/`forbidden` helper exists in `auth.ts` — keep error envelopes inline.
- `apps/api/src/routes/admin-clinic.ts` (NEW) — `GET /admin/clinic` + `PATCH /admin/clinic`. Router signature mirrors `apps/api/src/routes/patient-otp.ts:23,47` (`export const adminClinicRouter: Router = Router();` with `import { Router, type Request, type Response } from 'express';`). Handlers are synchronous arrows returning `void`; errors are early-returns (`res.status(4xx).json({error: '...'}); return;`). No `next(err)` / try-catch. One SQL for GET, one UPDATE for PATCH. SQL uses raw `pool.query(sql, params)` via `getPool()` from `apps/api/src/db/pool.ts`.
- `apps/api/src/app.ts` (MODIFIED, after line 73) — imports `adminClinicRouter` and `adminScope`; mounts `app.use('/admin', adminScope, adminClinicRouter)` **AFTER** `authMiddleware` (line 73). New mount block follows the E0-S3 mount-order convention but uses chained router-level middleware (not a global `app.use(adminScope)`) so it only gates the `/admin/*` path.
- `apps/api/test/__helpers__/admin-token.ts` (NEW) — `__makeAdminToken(sub?, scope?)` test helper. Defaults `sub = 'admin-main'`, `scope = 'clinic'`. Throws `Error('admin_token_helper_disabled_in_production')` when `process.env['NODE_ENV'] === 'production'`. Implementation calls `signClaim({sub, role: 'admin', branch_ids: [], scope}, NOW)` from `apps/api/src/auth/jwt.js`, mirroring `apps/api/test/auth-jwt.test.ts:11-46` pattern (set `process.env['AUTH_SECRET'] = 'a'.repeat(48)`; call `__resetAuthConfigForTests()` from `apps/api/src/auth/config.js` once per process — usually already set by `test/setup/globalSetup.cjs`).
- `apps/api/test/admin-clinic.test.ts` (NEW) — uses supertest (`import request from 'supertest';`) + `createApp()` from `apps/api/src/app.js` + `__makeAdminToken()` + `withTestDb` (if available — otherwise mount on the existing global-setup DB). Covers the full I/O matrix (happy / 401 / 403-role / 403-scope / 400-name-empty / 400-name-long / 400-name-missing / 400-name-non-string / counts assertion / updated_at advance). Plus a NODE_ENV-production test for `__makeAdminToken()`.

**DB schema ground truth (re-read of `apps/api/db/migrations/0001_init_bootstrap.sql`, `0004_widen_seed_entities.sql`, `0013_clinic_anchor.sql`):**

- `clinic(id uuid PK, name text NOT NULL, created_at, updated_at)` — singleton enforced by `idx_clinic_singleton` from 0013.
- `branch(id, clinic_id uuid NOT NULL FK clinic, name, tz, created_at, updated_at)` — **NO `active` column**.
- `doctor(id, full_name, created_at, updated_at)` + junction `doctor_branch(doctor_id, branch_id)`. No `clinic_id`, no `active`, no `branch_ids[]`.
- `receptionist(id, branch_id uuid NOT NULL FK branch, full_name, email citext UNIQUE, created_at, updated_at)` — scalar `branch_id`. No `clinic_id`, no `active`, no `branch_ids[]`.
- `patient(id, phone_number text UNIQUE, full_name, created_at, updated_at)` — **NO `clinic_id`, NO `active`**.
- `admin_user(id, full_name, email citext UNIQUE, clinic_id uuid NOT NULL FK clinic, created_at, updated_at)`.

**Counts SQL strategy (decided 2026-09-14, no spec-change loop required — see Spec Change Log entry SC1):**

- `branches_total` = `SELECT COUNT(*) FROM branch WHERE clinic_id = $1`.
- `doctors_total` = `SELECT COUNT(DISTINCT d.id) FROM doctor d JOIN doctor_branch db ON db.doctor_id = d.id JOIN branch b ON b.id = db.branch_id WHERE b.clinic_id = $1`.
- `receptionists_total` = `SELECT COUNT(*) FROM receptionist r JOIN branch b ON b.id = r.branch_id WHERE b.clinic_id = $1`.
- `patients_total` = `SELECT COUNT(*) FROM patient` (global; no per-clinic patient linkage exists — see Spec Change Log SC1 for the deferred split).

The `GET` SQL uses **4 correlated subqueries** (one per count) on a single `SELECT` against the singleton `clinic` row — no LATERAL needed, no N+1. `$1 = clinic.id` is fetched once at the top via `SELECT id, name, created_at, updated_at FROM clinic LIMIT 1` then passed to the count subqueries in the same statement. Equivalent shape:

```sql
SELECT c.id, c.name, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM branch      WHERE clinic_id = c.id) AS branches_total,
  (SELECT COUNT(DISTINCT d.id) FROM doctor d JOIN doctor_branch db ON db.doctor_id = d.id JOIN branch b ON b.id = db.branch_id WHERE b.clinic_id = c.id) AS doctors_total,
  (SELECT COUNT(*) FROM receptionist r JOIN branch b ON b.id = r.branch_id WHERE b.clinic_id = c.id) AS receptionists_total,
  (SELECT COUNT(*) FROM patient) AS patients_total
FROM clinic c
LIMIT 1;
```

`PATCH` SQL: `UPDATE clinic SET name = $1 WHERE id = (SELECT id FROM clinic LIMIT 1) RETURNING id, name, created_at, updated_at`. The `updated_at` advance is automatic via `trg_clinic_set_updated_at` (E0-S2 trigger from `0004_widen_seed_entities.sql:31-38`).

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/middleware/admin-scope.ts` -- Express middleware: `req.auth?.claim` missing → `401 {error: 'unauthenticated'}`; `claim.role !== 'admin'` → `403 {error: 'forbidden_role'}`; `claim.scope !== 'clinic'` → `403 {error: 'forbidden_scope'}`; otherwise `next()`. Inline envelopes (no shared helper exists).
- [x] `apps/api/src/routes/admin-clinic.ts` -- `GET /admin/clinic` (one SQL with 4 correlated subqueries returning totals: branches_total, doctors_total, receptionists_total, patients_total) + `PATCH /admin/clinic` (name length-validated 1-120 chars, type-checked string, returns 200 with the updated row).
- [x] `apps/api/src/app.ts` -- import `adminClinicRouter` from `./routes/admin-clinic.js` and `adminScope` from `./middleware/admin-scope.js`; mount `app.use('/admin', adminScope, adminClinicRouter)` AFTER the existing `app.use(authMiddleware)` at line 73.
- [x] `apps/api/test/__helpers__/admin-token.ts` -- `__makeAdminToken(sub = 'admin-main', scope = 'clinic')` helper. Throws `Error('admin_token_helper_disabled_in_production')` when `process.env['NODE_ENV'] === 'production'`. Wraps `signClaim(...)` from `apps/api/src/auth/jwt.js`.
- [x] `apps/api/test/admin-clinic.test.ts` -- full I/O matrix + NODE_ENV-production test for `__makeAdminToken()`. Use `request(app)` supertest pattern; mint admin token via `__makeAdminToken()`; mount `createApp()` once in a `before()`.

**Acceptance Criteria:**
- Given a valid admin JWT, when `GET /admin/clinic` is called, then response is `200` with the singleton row and `counts` reflecting the seeded totals: `branches_total === 2`, `doctors_total === 3`, `receptionists_total === 2`, `patients_total === 5` (per `apps/api/db/seeds/01_minimum.ts`).
- Given a patient JWT, when `GET /admin/clinic` is called, then response is `403 {error: 'forbidden_role'}`.
- Given an admin JWT with `scope: 'branch'`, when `GET /admin/clinic` is called, then response is `403 {error: 'forbidden_scope'}`.
- Given an unauthenticated request (no `x-auth-claim` header, no Bearer token), when `GET /admin/clinic` is called, then response is `401 {error: 'unauthenticated'}` (auth middleware fires before `adminScope`).
- Given an admin JWT and `PATCH /admin/clinic {name: ''}`, when the route validates, then response is `400 {error: 'invalid_name'}` and no DB write occurs.
- Given a valid admin JWT and a name within bounds, when `PATCH /admin/clinic` succeeds, then `clinic.updated_at > pre-call` value (via `trg_clinic_set_updated_at`).
- Given `__makeAdminToken()` is called with `process.env['NODE_ENV'] === 'production'`, when the helper guards, then it throws `Error('admin_token_helper_disabled_in_production')`.
- Given the new code, when the existing E0-S3 + E0-S4 + E0-S5 + E0-S6 test suites run, then no regression — pre-existing test counts preserved or improved (current baseline: 206/209).

## Spec Change Log

**SC1 — 2026-09-14, plan-step (no loopback). Decision recorded before spec approval.**
- **Trigger:** Codebase investigation revealed the draft's `branches_active`/`branches_inactive`/`doctors_active`/`doctors_inactive`/`receptionists_active`/`receptionists_inactive` counts require columns that do not exist in the schema (`branch.active`, `doctor.active`, `receptionist.active`). `patient` has no `clinic_id` and no `active`, so even a global active/inactive split on patients is not yet meaningful.
- **Amendment:** Replaced the per-entity `*_active` / `*_inactive` field set with **totals only** (`branches_total`, `doctors_total`, `receptionists_total`, `patients_total`). Patients total is global (no per-clinic linkage exists). The `active`/`inactive` split is now an E1-S1 concern (where the `branch.active` column lands) rather than an E1-S0b one.
- **Avoided known-bad state:** Writing the spec with active/inactive fields would have produced a route file with `WHERE active = true` predicates that fail at runtime — the `active` column does not exist.
- **KEEP (must not regress):** The original human-owned intent (Problem/Approach/Boundaries/Ask First A1/"Never*) is preserved verbatim inside `<frozen-after-approval>...</frozen-after-approval>`. The router shape (one GET + one PATCH, adminScope middleware, NODE_ENV guard on `__makeAdminToken`) is unchanged.

**SC2 — 2026-09-14, review-loop-1 (2 patches applied, 2 deferrals, no spec changes).**
- **Trigger:** Step-04 review (3 reviewers — verification-gap, blind-hunter, edge-case-hunter) returned ~190 findings collectively. After triage: 0 intent_gap, 0 bad_spec, 2 patch, 2 defer, remainder rejected as noise.
- **Patches:**
  - **P-A — Trim `name` before length check (PATCH route):** Without trimming, `name: '     '` (5 spaces) passes the `length >= 1` check and stores invisible whitespace. Fix: `isValidName` trims first then length-checks; `normalizeName` returns the trimmed string for storage. New tests pin the rejection of whitespace-only names and the trimming of leading/trailing whitespace on a valid name.
  - **P-B — `__makeAdminToken` fail-fast when `AUTH_SECRET` is unset:** Previously, the helper silently wrote `process.env.AUTH_SECRET` if it was missing, leaking global env state across test files and racing with `__resetAuthConfigForTests()`. Fix: throw `Error('admin_token_helper_requires_auth_secret: ...')` with a clear message pointing at `test/setup/globalSetup.cjs`. The `globalSetup.cjs` always sets the secret for the default suite; a misconfigured CI run now fails fast with a diagnostic instead of producing JWT-verification mismatches downstream.
- **Deferrals (deferred-work.md):**
  - **W33** — `GET /admin/clinic` snapshot consistency. The 4 correlated subqueries read across tables without a wrapping transaction; concurrent writes can produce internally inconsistent counts. Reopen if/when a future audit feature requires strict snapshot reads.
  - **W34** — `withTestDb` cleanup hardening on container/migration failure paths. Currently surfaces the underlying error but may leak a Docker container on certain failure modes; wrap with try/catch+try/finally if a CI flake report proves it worth the code.
- **Avoided known-bad state:** Without P-A, the admin UI could render an "edited" clinic whose name is visually indistinguishable from the previous one — a UX bug. Without P-B, a misconfigured test environment could silently mint JWTs with a secret not matching the runner's, producing downstream `verifyToken` failures with no diagnostic pointing at the cause.
- **Verification post-patches:** `admin-clinic.test.ts` 18/18 green (was 16; +2 new tests for whitespace trim and trim-then-store). Full suite 224/227 pass (+18 net new tests vs 206/209 E1-S0a baseline; the 3 pre-existing baseline failures in `auth.test.ts` × 2 + `log.test.ts` × 1 are unchanged).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/admin-clinic.test.ts` -- expected: all green; full I/O matrix covered (happy + 401 + 403-role + 403-scope + 400-name-empty/long/missing/non-string + counts + updated_at advance + NODE_ENV-production guard).
- `pnpm --filter @clinic/api run typecheck` -- expected: 0 new errors attributable to this spec. The 3 pre-existing typecheck errors (provider.ts `override` on `Error.cause`, service.ts AuthClaim re-export, twilio-provider.ts latent types) remain out of scope.
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/*.test.ts` -- expected: 207+/209 green (improvement on the 206/209 E1-S0a baseline; the 3 pre-existing baseline failures in `auth.test.ts` × 2 + `log.test.ts` × 1 are unchanged).
- `pnpm --filter @clinic/api run lint` -- expected: 0 new warnings/errors attributable to this spec.

**Manual checks (if no CLI):**
- After PATCH `/admin/clinic {name: 'Renamed'}`, query the DB: `SELECT updated_at FROM clinic LIMIT 1` and confirm the timestamp is later than the pre-call value (proves `trg_clinic_set_updated_at` is wired).

## Suggested Review Order

**Mounting & middleware**

- Start here — chained `adminScope` only fires for `/admin/*`; mount order is the auth boundary.
  [`app.ts:82`](../../apps/api/src/app.ts#L82)
- One read of the middleware body: 401 → 403 forbidden_role → 403 forbidden_scope, then `next()`.
  [`admin-scope.ts:23`](../../apps/api/src/middleware/admin-scope.ts#L23)

**Route handlers (GET then PATCH)**

- GET runs 4 counts via correlated subqueries on the singleton row; `LIMIT 1` is the invariant.
  [`admin-clinic.ts:64`](../../apps/api/src/routes/admin-clinic.ts#L64)
- Trim-before-length-check + trim-before-store fix from review-loop-1.
  [`admin-clinic.ts:56`](../../apps/api/src/routes/admin-clinic.ts#L56)
- PATCH: name validation runs BEFORE any DB call; trigger fires automatically.
  [`admin-clinic.ts:123`](../../apps/api/src/routes/admin-clinic.ts#L123)

**Test infrastructure**

- Sentinel `branch_ids: ['__clinic_anchor__']` satisfies E0-S3's empty-branch_ids guard.
  [`admin-token.ts:62`](../../apps/api/test/__helpers__/admin-token.ts#L62)
- Fail-fast when `AUTH_SECRET` is unset (P-B from review-loop-1).
  [`admin-token.ts:39`](../../apps/api/test/__helpers__/admin-token.ts#L39)
- Testcontainer URI plumbed into `process.env.DATABASE_URL` so production `getPool()` resolves it.
  [`withTestDb.ts:69`](../../apps/api/test/db/withTestDb.ts#L69)

**Tests (matrix coverage)**

- Happy-path counts assertion is the E2E correctness pin (2/3/2/5).
  [`admin-clinic.test.ts:83`](../../apps/api/test/admin-clinic.test.ts#L83)
- Whitespace-only name → 400 (post-trim length check, P-A).
  [`admin-clinic.test.ts:243`](../../apps/api/test/admin-clinic.test.ts#L243)
- Updated_at advance via trigger (PATCH happy path).
  [`admin-clinic.test.ts:124`](../../apps/api/test/admin-clinic.test.ts#L124)