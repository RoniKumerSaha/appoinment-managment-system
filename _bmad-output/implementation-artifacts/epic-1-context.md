# Epic 1 Context: Clinic structure & admin

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

The platform ships as a multi-tenant-ready schema with exactly one clinic per deployment (the "singleton" invariant). Epic 1 gives the admin user the API and UI surface to inspect and edit that clinic, then to manage its branches, doctors, and receptionists. E1-S0 lands the singleton anchor (DB-layer + admin read/update API). E1-S1–S4 cover branch / doctor / receptionist CRUD with role × branch scoping. Admin never touches individual appointments (PRD §2.4).

## Stories

- E1-S0a: Clinic singleton enforcement (DB-layer) — DONE
- E1-S0b: Admin clinic API (`GET /admin/clinic`, `PATCH /admin/clinic`) — IN PROGRESS
- E1-S0-ui: Clinic settings UI (web) — DEFERRED (deferred-work.md)
- E1-S1: Create / edit / deactivate branches
- E1-S2: Change branch operating hours (saves + flags affected appointments)
- E1-S3: Create / deactivate / assign-branch doctors
- E1-S4: Create / deactivate / assign-branch receptionists

## Requirements & Constraints

- Singleton clinic per deployment. A second `INSERT INTO clinic` must fail at the DB layer (E1-S0a delivered this as `idx_clinic_singleton` partial unique index on `(true)`).
- Admin auth scope is `scope: 'clinic'` (not `clinic_id` JWT claim). The DB column `admin_user.clinic_id` is a DB-link only — it surfaces in API responses but is **not** a JWT field.
- Admin endpoints must enforce `role === 'admin' && scope === 'clinic'`. Failures: 403 `forbidden_role` (role mismatch) vs 403 `forbidden_scope` (scope mismatch).
- Input validation happens BEFORE any DB call.
- No DELETE endpoint for clinic (out of scope).
- Audit by default — admin writes that touch clinic/branch/doctor/receptionist entities must write one audit row.

## Technical Decisions

- **Auth claim shape** (E0-S3): `{sub, role: 'patient'|'receptionist'|'doctor'|'admin', branch_ids: string[], scope: 'self'|'branch'|'clinic'|'global', doctor_id?: string, expires_at, jti}`. Server reads `branch_ids` from the claim, never the request body.
- **Mounting convention** (`apps/api/src/app.ts`): public routers (health, metrics, OTP) mount BEFORE `authMiddleware`. Authenticated routers mount AFTER. `adminClinicRouter` follows the authenticated pattern.
- **Test auth pattern**: supertest with `createApp()` from `src/app.ts`. For admin JWTs in tests, a `__makeAdminToken()` helper mints via `signClaim({sub, role: 'admin', branch_ids: [], scope: 'clinic'}, NOW)` and is **dev/test-only** (throws `admin_token_helper_disabled_in_production` when `NODE_ENV === 'production'`). The debug header path (`x-auth-claim`) is also used in tests but is `@deprecated`.
- **SQL convention**: raw `pool.query(sql, params)` via `getPool()` from `src/db/pool.ts`. No ORM. Use `LATERAL` subqueries or one CTE per count to avoid N+1.
- **Response envelope**: lowercase snake_case keys. Errors: `{error: '<code>'}`. Successes: typed objects.
- **DB schema (ground truth from migrations 0001–0013)**:
  - `clinic(id uuid PK, name text, created_at, updated_at)` — singleton enforced by `idx_clinic_singleton` partial unique index.
  - `branch(id, clinic_id uuid NOT NULL FK clinic, name, tz, created_at, updated_at)` — **NO `active` column**.
  - `doctor(id, full_name, created_at, updated_at)` + junction `doctor_branch(doctor_id, branch_id)`.
  - `receptionist(id, branch_id uuid NOT NULL FK branch, full_name, email citext UNIQUE, created_at, updated_at)` — scalar `branch_id`, NOT array.
  - `patient(id, phone_number text UNIQUE, full_name, created_at, updated_at)` — **NO clinic linkage, NO active flag**.
  - `admin_user(id, full_name, email citext UNIQUE, clinic_id uuid NOT NULL FK clinic, created_at, updated_at)`.
  - `updated_at` is maintained by `trg_*_set_updated_at` triggers (BEFORE UPDATE). PATCH /admin/clinic relies on `trg_clinic_set_updated_at` for `updated_at` advance.
- **Migrations runner**: `node-pg-migrate -m db/migrations -j sql --env DATABASE_URL -f dist/db/migrations/.applied.json up`. Migrations are forward-only at runtime; `.down.sql` files exist for round-trip tests.
- **Test runner**: `node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/*.test.ts` (per-file in `apps/api/package.json`).

## UX & Interaction Patterns

- Admin clinic settings mockup (Mockup 32): renders clinic name editable + "X active · Y inactive" counts for branches/doctors/receptionists/patients. **Reality check: there is no `active` flag in the schema today** — E1-S0b must decide between (a) drop the active/inactive split and just render totals, or (b) defer the split until E1-S1 adds an `active` column on branch (and possibly doctor/receptionist).
- `updated_at` is the optimistic concurrency hint the UI will use (no separate `version` column).

## Cross-Story Dependencies

- **E1-S0a (done)** → E1-S0b: DB-layer invariant exists; now the admin needs an API to read/update the singleton.
- **E1-S0b** → E1-S0-ui: Web form on the admin settings page reads from `GET /admin/clinic` and writes via `PATCH /admin/clinic`.
- **E1-S0b** → E1-S1: The same `adminClinicRouter` (or a sibling) needs to mount branch CRUD. E1-S0b should not pre-build branch routes — that's E1-S1.
- **E1-S1** may require adding `branch.active` (and possibly `doctor.active` / `receptionist.active`) so the "active/inactive" counts shown in the clinic dashboard can be populated. **This is a planned schema delta, not a contradiction** — but E1-S0b must not assume the column exists today.
- **E7 (cross-cutting)** audit, design-system tokens, ConflictModal — all apply to E1 but are stories of their own. E1-S0b does not introduce new audit/metric names.
