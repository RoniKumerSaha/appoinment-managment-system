---
title: 'E1-S0b — Admin clinic API'
type: 'feature'
created: '2026-09-14'
status: 'draft'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
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

## Code Map

- `apps/api/src/middleware/admin-scope.ts` (NEW) — Express middleware asserting `req.auth.claim.role === 'admin' && req.auth.claim.scope === 'clinic'`. Mirrors `apps/api/src/middleware/auth.ts:94-128` shape. Emits `FORBIDDEN_SCOPE` envelope per AD-4.
- `apps/api/src/routes/admin-clinic.ts` (NEW) — `GET /admin/clinic` + `PATCH /admin/clinic`. One SQL for GET (singleton + 4 subqueries via `LATERAL` or 4 LEFT JOIN subqueries). `PATCH` runs `UPDATE clinic SET name = $1 WHERE id = (SELECT id FROM clinic LIMIT 1) RETURNING …`.
- `apps/api/src/app.ts` (MODIFIED, line ~70 region) — imports `adminClinicRouter` and `adminScope`; mounts both AFTER `authMiddleware`. Reuses E0-S3 mount-order convention.
- `apps/api/test/__helpers__/admin-token.ts` (NEW) — `__makeAdminToken(sub?, scope?)` helper; NODE_ENV guard; mirrors `apps/api/test/auth-jwt.test.ts:11-46`.
- `apps/api/test/admin-clinic.test.ts` (NEW) — uses `withTestDb` + supertest + `__makeAdminToken()`. Covers the full I/O matrix (happy / 401 / 403-role / 403-scope / 400-name-empty / 400-name-long / 400-name-missing / 400-name-non-string / counts assertion / updated_at advance). Plus a NODE_ENV-production test for `__makeAdminToken()`.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/middleware/admin-scope.ts` -- middleware asserting `role === 'admin' && scope === 'clinic'`; emit `forbidden_role` or `forbidden_scope` envelope.
- [ ] `apps/api/src/routes/admin-clinic.ts` -- `GET /admin/clinic` (one SQL with 4 subqueries: branches active/inactive, doctors active/inactive, receptionists active/inactive, patients total) + `PATCH /admin/clinic` (name length-validated 1-120).
- [ ] `apps/api/src/app.ts` -- mount `adminClinicRouter` AFTER `authMiddleware` and AFTER `adminScope`.
- [ ] `apps/api/test/__helpers__/admin-token.ts` -- `__makeAdminToken()` test helper with NODE_ENV guard.
- [ ] `apps/api/test/admin-clinic.test.ts` -- full I/O matrix + NODE_ENV-production test for `__makeAdminToken()`.

**Acceptance Criteria:**
- Given a valid admin JWT, when `GET /admin/clinic` is called, then response is `200` with the singleton row and `counts` reflecting the seeded branches/doctors/receptionists/patients (2/3/2/5 per `02_role_ids.ts`).
- Given the seeded DB has 2 active branches and 0 inactive, when `GET /admin/clinic` is called, then `counts.branches_active === 2` and `counts.branches_inactive === 0`.
- Given a patient JWT, when `GET /admin/clinic` is called, then response is `403 {error: 'forbidden_role'}`.
- Given an admin JWT with `scope: 'branch'`, when `GET /admin/clinic` is called, then response is `403 {error: 'forbidden_scope'}`.
- Given an admin JWT and `PATCH /admin/clinic {name: ''}`, when the route validates, then response is `400 {error: 'invalid_name'}` and no DB write occurs.
- Given a valid admin JWT and a name within bounds, when `PATCH /admin/clinic` succeeds, then `clinic.updated_at` is later than the pre-call value (via existing trigger).
- Given `__makeAdminToken()` is called with `NODE_ENV === 'production'`, when the helper guards, then it throws `admin_token_helper_disabled_in_production`.
- Given the new code, when the existing E0-S3 + E0-S4 + E0-S5 + E0-S6 tests run, then no regression — all pre-existing tests stay green.

## Spec Change Log

<!-- Empty until first bad_spec loopback. -->

## Verification

**Commands:**
- `pnpm --filter @clinic/api test admin-clinic.test.ts` -- expected: all green; full I/O matrix covered.
- `pnpm -w typecheck` -- expected: 0 new errors. The 3 pre-existing typecheck errors from E0-S4 (`provider.ts`, `service.ts`, `twilio-provider.ts`) remain out of scope.
- `pnpm -w test` -- expected: no regression in the E0 suite (200/203 baseline preserved or improved).
</content>
</invoke>