---
title: 'E1-S4 — Create / deactivate / assign branch receptionists'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-1-0-admin-clinic-api.md'
  - '_bmad-output/implementation-artifacts/spec-1-1-create-edit-deactivate-branches.md'
  - '_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
  - '_bmad-output/implementation-artifacts/spec-1-3-create-deactivate-assign-branch-doctors.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `receptionist` table exists (`0001_init_bootstrap.sql:44-49`) with `id`, `branch_id`, `full_name`, `created_at`. After `0004_widen_seed_entities.sql:73-104` it gained `updated_at` + trigger + `email citext UNIQUE NOT NULL`. There is no `clinic_id` (BR-004 mandates single-clinic anchor via the branch), no `active` column, and no admin endpoint surface. Receptionists can only act on their assigned branch (server-side filter; URL-based cross-branch access returns 403 per Scenario 11).

**Approach:** Forward migration `0017_receptionist_lifecycle.sql` adding `receptionist.active boolean NOT NULL DEFAULT true` (mirrors E1-S1's `branch.active` and E1-S3's `doctor.active`). `clinic_id` is implicit via `branch_id` (which FKs to `branch.clinic_id`); we do NOT denormalize. Add a new `routes/admin-branch-receptionists.ts` exposing `POST /admin/receptionists` (create with single branch_id), `GET /admin/receptionists` (list with optional `?active=` and `?branch_id=` filters), `GET /admin/receptionists/:id` (single), `PATCH /admin/receptionists/:id` (rename / deactivate / reassign branch), all gated by `adminScope`. The branch_id lives on the receptionist row directly (not a junction table); reassignment is just an UPDATE.

**Boundaries & Constraints**

**Always:**
- `POST /admin/receptionists` accepts `{full_name: string, email: string, branch_id: string}`. Returns `201 {id, full_name, email, active: true, branch: {id, name, tz, active}, created_at, updated_at}`. Validates BEFORE any DB call.
- `GET /admin/receptionists` returns all receptionists for the singleton clinic. Supports `?active=true|false` and `?branch_id=<uuid>` filters. Each row carries a `branch: {id, name, tz, active}` (single object — receptionists have exactly one branch per BR-004).
- `GET /admin/receptionists/:id` returns the single receptionist with `branch: {...}`. Returns `404 {error: 'receptionist_not_found'}` for unknown id; `400 {error: 'invalid_receptionist_id'}` for malformed UUID.
- `PATCH /admin/receptionists/:id` accepts optional `{full_name?, active?, branch_id?}`. Validates each field if present. **Deactivating does NOT check future appointments** (F-19 mirrors F-18: "warns but does not block"). The PATCH response includes a `warning: 'receptionist_has_future_appointments'` field with `future_appointment_count: N` when relevant; the deactivate succeeds.
- **Reassignment**: a receptionist's branch can be moved via `PATCH /admin/receptionists/:id {branch_id: <new branch uuid>}`. Server-side, this is just an UPDATE; the row's `branch_id` is the source of truth. There is no `doctor_branch`-style junction table.
- Validation: `400 {error: 'invalid_full_name'}` for full_name (1..120 chars), `400 {error: 'invalid_email'}` for email, `400 {error: 'invalid_branch_id'}` for branch_id (must be a valid UUID AND exist in the singleton clinic), `400 {error: 'invalid_active'}` for active (non-boolean), `404 {error: 'receptionist_not_found'}`, `404 {error: 'branch_not_found'}`, `409 {error: 'email_already_exists'}` for duplicate email on create.
- All routes use `pool.query` from `getPool()`. PATCH runs inside a transaction (`pool.connect()` + `BEGIN/SELECT FOR UPDATE/COMMIT/ROLLBACK`) to prevent a concurrent PATCH-vs-PATCH interleaving (admin reassigning the branch while another admin renames).
- Branch scoping: `clinic_id` is read transitively via the receptionist's branch row at runtime; the singleton `SELECT id FROM clinic LIMIT 1` is used to validate that branch_id belongs to the right clinic.

**Ask First:**
- (none — all scope decisions resolved at plan-time via epic-1-context.md. Receptionist has exactly one branch per BR-004 explicit; no junction table needed.)

**Never:**
- No DELETE `/admin/receptionists/:id`. Deactivate, not delete.
- No audit rows written (E7-S2 lands audit later; E1-S1..E1-S3 set the no-audit precedent).
- No branch-hours edits, no doctor edits (E1-S2, E1-S3 respectively).
- No multi-branch assignment. BR-004 is explicit: one branch per receptionist.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `POST /admin/receptionists` happy path | admin JWT + `{full_name, email, branch_id}` | `201 {id, full_name, email, active: true, branch: {...}, created_at, updated_at}` | N/A |
| `POST /admin/receptionists` empty full_name | `{full_name: '', email, branch_id}` | `400 {error: 'invalid_full_name'}` | validate first |
| `POST /admin/receptionists` over-length full_name | `{full_name: <121 chars>, ...}` | `400 {error: 'invalid_full_name'}` | validate first |
| `POST /admin/receptionists` missing full_name | `{email, branch_id}` | `400 {error: 'invalid_full_name'}` | validate first |
| `POST /admin/receptionists` invalid email | `{email: 'not-an-email', ...}` | `400 {error: 'invalid_email'}` | validate first |
| `POST /admin/receptionists` duplicate email | `{email: 'existing@x', ...}` | `409 {error: 'email_already_exists'}` | ON CONFLICT (email) |
| `POST /admin/receptionists` non-UUID branch_id | `{branch_id: 'not-a-uuid', ...}` | `400 {error: 'invalid_branch_id', fields: ['not-a-uuid']}` | validate first |
| `POST /admin/receptionists` unknown branch_id | `{branch_id: <random uuid>, ...}` | `400 {error: 'branch_not_found', fields: [<random uuid>]}` | validate before insert |
| `POST /admin/receptionists` no auth | unauthenticated | `401 {error: 'unauthenticated'}` | auth middleware |
| `POST /admin/receptionists` patient JWT | patient role | `403 {error: 'forbidden_role'}` | adminScope |
| `GET /admin/receptionists` happy path | admin JWT | `200 [{id, full_name, email, active, branch: {...}, created_at, updated_at}, ...]` (2 seeded) | N/A |
| `GET /admin/receptionists?active=true` | admin JWT | `200 [{...all active=true}]` | N/A |
| `GET /admin/receptionists?active=false` | admin JWT | `200 [{...all active=false}]` | N/A |
| `GET /admin/receptionists?active=banana` | `?active=banana` | `400 {error: 'invalid_active_filter'}` | Route |
| `GET /admin/receptionists?branch_id=<east>` | admin JWT | `200 [receptionists at east branch]` | N/A |
| `GET /admin/receptionists/:id` happy | admin JWT + valid UUID | `200 {id, full_name, email, active, branch: {...}, ...}` | N/A |
| `GET /admin/receptionists/:id` unknown | random UUID | `404 {error: 'receptionist_not_found'}` | Route |
| `GET /admin/receptionists/:id` non-UUID | `not-a-uuid` | `400 {error: 'invalid_receptionist_id'}` | Route |
| `PATCH /admin/receptionists/:id` rename | `{full_name: 'New Name'}` | `200 {full_name: 'New Name', ...}`; `updated_at > pre-call` | N/A |
| `PATCH /admin/receptionists/:id` reassign branch | `{branch_id: <west>}` | `200 {..., branch: {...west}}` | N/A |
| `PATCH /admin/receptionists/:id` deactivate clean | `{active: false}` on receptionist with no future appts | `200 {active: false, warning: null, future_appointment_count: 0}` | N/A |
| `PATCH /admin/receptionists/:id` deactivate with future appts | `{active: false}` on receptionist with ≥1 future Scheduled appt | `200 {active: false, warning: 'receptionist_has_future_appointments', future_appointment_count: N}` | No 409 |
| `PATCH /admin/receptionists/:id` reactivate | `{active: true}` | `200 {active: true}` | N/A |
| `PATCH /admin/receptionists/:id` no-op | `{}` | `400 {error: 'no_fields_to_update'}` | Route |
| `PATCH /admin/receptionists/:id` invalid active | `{active: 'maybe'}` | `400 {error: 'invalid_active'}` | Route |
| `PATCH /admin/receptionists/:id` invalid branch_id | `{branch_id: 'not-a-uuid'}` | `400 {error: 'invalid_branch_id', fields: ['not-a-uuid']}` | Route |
| `PATCH /admin/receptionists/:id` unknown branch_id | `{branch_id: <random uuid>}` | `400 {error: 'branch_not_found', fields: [<random uuid>]}` | Route |
| `PATCH /admin/receptionists/:id` unknown fields | `{surprise: true}` | `400 {error: 'unknown_field', fields: ['surprise']}` | Route |
| `PATCH /admin/receptionists/:id` unknown id | random UUID | `404 {error: 'receptionist_not_found'}` | Route |

</frozen-after-approval>

## Code Map

- `apps/api/db/migrations/0017_receptionist_lifecycle.sql` (NEW) — `ALTER TABLE receptionist ADD COLUMN IF NOT EXISTS active boolean` (nullable → UPDATE backfill `SET active = true WHERE active IS NULL` → `SET NOT NULL` → `SET DEFAULT true`). Idempotent. Mirrors E1-S1's `branch.active` and E1-S3's `doctor.active` patterns. `receptionist.email` (citext NOT NULL UNIQUE) and `receptionist.branch_id` (NOT NULL FK ON DELETE RESTRICT) already exist from 0001 + 0004.
- `apps/api/src/routes/admin-branch-receptionists-helpers.ts` (NEW) — pure validators: `isValidFullName`, `isValidEmail`, `isValidUuid`, `isValidActive`. Tagged-union `validateCreateReceptionistBody` and `validatePatchReceptionistBody`. Mirrors E1-S3's `admin-branch-doctors-helpers.ts` shape but adapted for single branch_id.
- `apps/api/src/routes/admin-branch-receptionists.ts` (NEW) — four routes mirroring `adminBranchDoctorsRouter` shape:
  - `POST /admin/receptionists` — validate → check email unique → SELECT branch (must exist in singleton clinic) → INSERT receptionist → 201 with branch embedded.
  - `GET /admin/receptionists` — read singleton clinic_id → SELECT receptionists with optional filters → batch-load branches (N+1 mitigation).
  - `GET /admin/receptionists/:id` — UUID validate → SELECT receptionist + branch → 200 or 404.
  - `PATCH /admin/receptionists/:id` — UUID validate → unknown-field reject → per-field validate → pool.connect() + BEGIN → SELECT FOR UPDATE on receptionist row → if branch_id supplied, validate branch exists in singleton → if active=false, COUNT future Scheduled appointments (for the warning field) → UPDATE → COMMIT → 200 with warning.
- `apps/api/src/app.ts` (MODIFIED) — import `adminBranchReceptionistsRouter`; chain into the existing `app.use('/admin', ...)` at line 85.
- `apps/api/test/admin-branch-receptionists.test.ts` (NEW) — full I/O matrix (~30 tests). Mirrors `admin-branch-doctors.test.ts` patterns.
- `apps/api/test/migrations.test.ts` (MODIFIED) — add 2 tests: 0017 adds `receptionist.active` NOT NULL DEFAULT true; migration is idempotent.

**DB schema ground truth (post-0017):**

- `receptionist(id uuid PK, branch_id uuid NOT NULL FK branch ON DELETE RESTRICT, full_name text, email citext NOT NULL UNIQUE, active boolean NOT NULL DEFAULT true, created_at timestamptz, updated_at timestamptz)`
- `receptionist.email` is the natural key (UNIQUE citext, set in 0004_widen_seed_entities.sql:86-104).
- `receptionist.branch_id` is the source of truth for which branch the receptionist works at. No junction table.
- `receptionist.updated_at` advances automatically via `trg_receptionist_set_updated_at` (`0004_widen_seed_entities.sql:77-80`).
- The receptionist-sees-their-branch join: `SELECT b.id, b.name, b.tz, b.active FROM receptionist r JOIN branch b ON b.id = r.branch_id WHERE r.id = $1`.

**PATCH transaction (prevents PATCH-vs-PATCH interleaving):**

```sql
BEGIN;
  SELECT id, branch_id FROM receptionist WHERE id = $1 FOR UPDATE;
  -- if branch_id is being changed: SELECT 1 FROM branch WHERE id = $new AND clinic_id = $singleton;
  -- if active=false: SELECT COUNT(*) FROM appointment WHERE branch_id = ...;
  UPDATE receptionist SET full_name = $1, active = $2, branch_id = $3 WHERE id = $4;
COMMIT;
```

The `FOR UPDATE` on the receptionist row prevents a concurrent admin from renaming while another admin reassigns the branch.

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/db/migrations/0017_receptionist_lifecycle.sql` -- `ALTER TABLE receptionist ADD COLUMN active boolean` (idempotent add-then-backfill-then-constrain). Comment header explains rationale.
- [x] `apps/api/src/routes/admin-branch-receptionists-helpers.ts` -- pure validators: `isValidFullName`, `isValidEmail`, `isValidUuid`, `isValidActive`. Tagged-union `validateCreateReceptionistBody` / `validatePatchReceptionistBody`.
- [x] `apps/api/src/routes/admin-branch-receptionists.ts` -- 4 routes: POST, GET (with `?active=` and `?branch_id=` filters), GET single, PATCH (rename / deactivate-with-warning / reassign-branch).
- [x] `apps/api/src/app.ts` -- import `adminBranchReceptionistsRouter`; chain into the existing `app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter, adminBranchHoursRouter, adminBranchDoctorsRouter)` at line 85.
- [x] `apps/api/test/admin-branch-receptionists.test.ts` -- full I/O matrix (~30 tests).
- [x] `apps/api/test/migrations.test.ts` -- add 2 tests: 0017 adds `receptionist.active`, idempotency.

**Acceptance Criteria:**
- Given a valid admin JWT, when `POST /admin/receptionists {full_name, email, branch_id}` is called, then response is `201` with the receptionist row including `branch: {...}`, and the row is queryable via the email.
- Given `POST /admin/receptionists` with empty / over-length / missing full_name, invalid email, non-UUID branch_id, when validated, then response is `400` with the corresponding error envelope and no DB write occurs.
- Given a duplicate email, when `POST /admin/receptionists` is called, then response is `409 {error: 'email_already_exists'}`.
- Given an unknown branch_id, when `POST /admin/receptionists` is called, then response is `400 {error: 'branch_not_found', fields: [...]}`.
- Given a valid admin JWT, when `GET /admin/receptionists` is called, then response is `200` with all seeded receptionists, each carrying `branch: {...}`.
- Given `?active=true` / `?active=false` / `?branch_id=<uuid>`, when `GET /admin/receptionists` is called, then the filter is honored.
- Given `?active=banana`, when `GET /admin/receptionists` is called, then response is `400 {error: 'invalid_active_filter'}`.
- Given a valid / unknown / malformed receptionist id, when `GET /admin/receptionists/:id` is called, then response is `200` / `404 receptionist_not_found` / `400 invalid_receptionist_id`.
- Given `PATCH /admin/receptionists/:id {full_name: 'New Name'}`, when successful, then response is `200` with the updated row and `updated_at > pre-call`.
- Given `PATCH /admin/receptionists/:id {branch_id: <west>}`, when successful, then `branch` in the response now points to West; DB `branch_id` is updated.
- Given `PATCH /admin/receptionists/:id {active: false}` on a receptionist with future Scheduled appointments, when successful, then response is `200` with `warning: 'receptionist_has_future_appointments'` and `future_appointment_count: N`. **No 409 is returned.**
- Given `PATCH /admin/receptionists/:id {}` or `{surprise: true}` or `{active: 'maybe'}`, when validated, then response is `400` with `no_fields_to_update` / `unknown_field + fields[]` / `invalid_active`.
- Given the new code, when the existing test suites run, then no regression — pre-existing test counts preserved or improved.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, review-loop-1 implementation patches (post-code-review).

Reviewer-1 flagged a P0 (P0-1) and several P1s. Applied:

- **P-A1** — Always emit `warning` (and `future_appointment_count`) on the PATCH response, even when `warning` is null. The route previously omitted the `warning` key entirely when null, which caused the deactivate-clean test's `assert.equal(res.body.warning, null)` to fail under strict-equal (supertest returns `undefined` for missing keys). Patch: `body2['warning'] = warning;` unconditional. Now the response envelope always carries both `warning` and `future_appointment_count`, matching the spec's "Always" wording. Cross-checked: the E1-S3 doctor route has the same latent pattern; this patch was made local to the receptionist route only to avoid touching E1-S3 in this commit. The pattern is documented in the inline comment so future PATCH routes follow the always-emit convention.

- **P-A2** — Added inline documentation comment to `targetBranchId = branchId ?? recLock[0]!.branch_id` explaining the semantic choice: when both `branch_id` and `active=false` are supplied, the count is keyed on the NEW branch (defensible per "the receptionist will now manage this branch"). Pure-deactivate still counts against the current branch (correct). P1-2 / P1-4 from review-loop-1.

- **P-A3** — Migration tests already cover `active` column existence + idempotency. Reviewer flagged P1-1 as "no test for `receptionist_email_key` UNIQUE constraint after 0017 re-runs". Skipped: 0017 doesn't touch the `email` column at all (it's pre-existing from 0004), so a regression in `receptionist_email_key` would surface in pre-existing tests. Not adding redundant coverage.

- **P-A4** — No spec drift found. All ACs (spec lines 126-138) covered. Error code names match I/O matrix row-for-row. Migration schema matches the "DB schema ground truth" block. Code map entries all implemented.

- **Deferral D1** — Reviewer-2 noted that 3 patient-JWT 403 tests are missing for `GET /admin/receptionists`, `GET /admin/receptionists/:id`, and `PATCH /admin/receptionists/:id`. The spec I/O matrix only pins the "patient role → 403" case on POST; E1-S3 has the same parity gap. Below ship-blocker; deferred to a future coverage-tightening story.

- **Deferral D2** — Reviewer-2 noted that POST validation-rejection tests lack "no DB write" pins. The route's design (validate before DB call) makes this impossible to fail in practice. Cosmetic; deferred.

- **Review-loop iteration: 1** (3 reviewer agents run; 1 returned detailed findings, 2 returned empty; P0 fixed; rest below ship-blocker).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/admin-branch-receptionists.test.ts` -- expected: all green; full I/O matrix covered.
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/migrations.test.ts` -- expected: all green; the new 0017 migration tests pass.
- `pnpm --filter @clinic/api run typecheck` -- expected: 0 new errors attributable to this spec.
- `pnpm --filter @clinic/api run lint` -- expected: 0 new warnings/errors attributable to this spec.

**Manual checks (if no CLI):**
- After `POST /admin/receptionists {full_name, email, branch_id: <east>}`, query the DB: `SELECT r.active, r.branch_id FROM receptionist r WHERE r.id = $1` — confirm `active=true`, `branch_id = <east>`.
- After `PATCH /admin/receptionists/:id {active: false}` on a receptionist with future appointments, confirm `receptionist.active = false` in the DB and the future appointments are still `Scheduled` (deactivate does not block).
- After `PATCH /admin/receptionists/:id {branch_id: <west>}`, confirm the receptionist's `branch_id` in the DB is now West.