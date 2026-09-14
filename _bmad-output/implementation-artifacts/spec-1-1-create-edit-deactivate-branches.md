---
title: 'E1-S1 — Create / edit / deactivate branches'
type: 'feature'
created: '2026-09-14'
status: 'done'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-0-admin-clinic-api.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-2-data-model-migrations.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `branch` table exists with the minimum columns from `0001_init_bootstrap.sql` (id, clinic_id, name, tz, created_at — and `updated_at` from `0004_widen_seed_entities.sql`), but there is no `branch.active` column and no admin API to create, edit, deactivate, or list branches. The product's branch lifecycle (F-16, BR-001, BR-005, BR-059, FR-002, FR-003) is not exposed to admins; the acceptance that "deactivating a branch with future appointments is rejected" has no surface.

**Approach:** Add a forward migration `0014_branch_active.sql` that introduces `branch.active boolean NOT NULL DEFAULT true` (so existing seeded branches stay visible) plus `branch.address text` (1-500 chars; deferred from the original 0001 column list — see SC1) — wait, **no**; address is out of scope this story per the E1-S1 mockup-17 mapping in epic-1-context.md (address lands with the branch-hours edit form in E1-S2). Migration just adds `active` and lets existing branches default to active. Then add a new `routes/admin-branches.ts` exposing `POST /admin/branches` (create), `GET /admin/branches` (list with optional `?active=true|false` filter), `GET /admin/branches/:id` (single), `PATCH /admin/branches/:id` (edit name / deactivate), all gated by the existing `adminScope` middleware. PATCH to `active=false` runs a future-appointment conflict check (`SELECT 1 FROM appointment WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled' LIMIT 1`) and returns `409 {error: 'branch_has_future_appointments'}` if any exist.

**Boundaries & Constraints**

**Always:**
- `POST /admin/branches` accepts `{name: string}` only (1–120 chars, trimmed). Returns `201 {id, clinic_id, name, active: true, created_at, updated_at}`. Validates BEFORE any DB call.
- `GET /admin/branches` returns all branches for the singleton clinic (via `SELECT b.* FROM branch b WHERE b.clinic_id = (SELECT id FROM clinic LIMIT 1) ORDER BY b.created_at ASC`). Supports `?active=true` / `?active=false` query filter. Empty list returns `200 []`.
- `GET /admin/branches/:id` returns the branch row or `404 {error: 'branch_not_found'}`.
- `PATCH /admin/branches/:id` accepts optional `{name?, active?}`. Validates each field if present. PATCH with `active: false` runs the future-appointment conflict check INSIDE a transaction; if any conflict, returns `409 {error: 'branch_has_future_appointments'}` and rolls back the transaction.
- Branch scoping: the route reads `clinic_id` from the JWT claim's `clinic_id` is NOT used — it reads the singleton clinic_id at runtime via `SELECT id FROM clinic LIMIT 1`. The admin's scope is `scope: 'clinic'` (per AD-8); no per-branch scoping yet (per-branch scoping lands when receptionist scoping lands in E1-S4).
- Validation messages: `400 {error: 'invalid_name'}` for name issues (matches E1-S0b pattern), `400 {error: 'invalid_active'}` for active field issues (non-boolean), `404 {error: 'branch_not_found'}` for unknown id, `409 {error: 'branch_has_future_appointments'}` for the deactivate-with-future-appointments conflict.
- All routes use `pool.query` from `getPool()` (E0-S2 pattern). The deactivate transaction uses `pool.connect()` + `BEGIN` + `SELECT ... FOR UPDATE` on the branch row to prevent a TOCTOU race where a future appointment is scheduled between the conflict check and the `active=false` write.

**Ask First:**
- (none — all scope decisions resolved at plan-time via the E1-S0b deferred items and `epic-1-context.md`. The `branch.address` field was originally in scope per the mockup-17 design; deferred to E1-S2 to keep E1-S1 atomic. The `branch.tz` column already exists from 0001; not modified.)

**Never:**
- No DELETE `/admin/branches/:id`. PRD §BR-005 says deactivate, not delete.
- No branch-hours edits (multi-period per day). Belongs to E1-S2.
- No audit rows written (PRD §8 audit is E7; deferred-work.md confirms audit rows are deferred).
- No receptionist / doctor reassignment on deactivation. Out of scope.
- No `clinic_id` consultation from the JWT claim. Admin scope is `scope: 'clinic'` per AD-8.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `POST /admin/branches` happy path | admin JWT + `{name: 'East Branch'}` | `201 {id, clinic_id, name, active: true, created_at, updated_at}` | N/A |
| `POST /admin/branches` empty name | `{name: ''}` | `400 {error: 'invalid_name'}` | Route validation |
| `POST /admin/branches` over-length | `{name: <121 chars>}` | `400 {error: 'invalid_name'}` | Route validation |
| `POST /admin/branches` missing name | `{}` | `400 {error: 'invalid_name'}` | Route validation |
| `POST /admin/branches` non-string | `{name: 123}` | `400 {error: 'invalid_name'}` | Route validation |
| `POST /admin/branches` no auth | unauthenticated | `401 {error: 'unauthenticated'}` | auth middleware |
| `POST /admin/branches` patient JWT | patient role | `403 {error: 'forbidden_role'}` | adminScope |
| `GET /admin/branches` happy path | admin JWT | `200 [{id, clinic_id, name, active, created_at, updated_at}, ...]` (2 seeded branches) | N/A |
| `GET /admin/branches?active=true` | admin JWT | `200 [{...all with active=true}]` | N/A |
| `GET /admin/branches?active=false` | admin JWT | `200 [{...all with active=false}]` | N/A |
| `GET /admin/branches?active=invalid` | `?active=banana` | `400 {error: 'invalid_active_filter'}` | Route validation |
| `GET /admin/branches/:id` happy | admin JWT + valid UUID | `200 {id, clinic_id, name, active, created_at, updated_at}` | N/A |
| `GET /admin/branches/:id` unknown | unknown UUID | `404 {error: 'branch_not_found'}` | Route |
| `GET /admin/branches/:id` non-UUID id | `not-a-uuid` | `400 {error: 'invalid_branch_id'}` | UUID parse |
| `PATCH /admin/branches/:id` rename | `{name: 'New Name'}` | `200 {...updated row}`; `updated_at > pre-call` | N/A |
| `PATCH /admin/branches/:id` deactivate (clean) | `{active: false}` on branch with no future Scheduled appointments | `200 {..., active: false, updated_at advanced}` | N/A |
| `PATCH /admin/branches/:id` deactivate (conflict) | `{active: false}` on branch with ≥1 future Scheduled appointment | `409 {error: 'branch_has_future_appointments'}`; transaction rolls back | Conflict check inside tx |
| `PATCH /admin/branches/:id` reactivate | `{active: true}` | `200 {..., active: true}` | N/A |
| `PATCH /admin/branches/:id` no-op | `{}` | `400 {error: 'no_fields_to_update'}` | Route validation |
| `PATCH /admin/branches/:id` invalid active | `{active: 'maybe'}` | `400 {error: 'invalid_active'}` | Route validation |
| `PATCH /admin/branches/:id` unknown id | unknown UUID | `404 {error: 'branch_not_found'}` | Route |
| `PATCH /admin/branches/:id` no auth | unauthenticated | `401 {error: 'unauthenticated'}` | auth middleware |

</frozen-after-approval>

## Code Map

- `apps/api/db/migrations/0014_branch_active.sql` (NEW) — `ALTER TABLE branch ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`. Idempotent (matches the 0013 pattern). `branch.updated_at` is already covered by `trg_branch_set_updated_at` from `0004_widen_seed_entities.sql`; no new trigger. No down migration (per the codebase convention — `down/` directory contains down files for migrations that need rollbacks, but a column-add rollback is rare; if needed later, `0014_branch_active.down.sql` adds `ALTER TABLE branch DROP COLUMN active`).
- `apps/api/src/routes/admin-branches.ts` (NEW) — `POST /admin/branches`, `GET /admin/branches`, `GET /admin/branches/:id`, `PATCH /admin/branches/:id`. Mirror `adminClinicRouter` shape (`export const adminBranchesRouter: Router = Router();`) and the E0-S6 error envelope pattern. Validation helpers: `isValidName(name)` (mirrors `admin-clinic.ts:56-64`; trim-then-length-check, 1–120 chars), `isValidActive(value)` (typeof boolean), `isValidUuid(s)` (parse with regex `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`). SQL strings: `INSERT_BRANCH_SQL`, `SELECT_BRANCH_LIST_SQL` (parameterized for active filter), `SELECT_BRANCH_BY_ID_SQL`, `UPDATE_BRANCH_NAME_SQL`, `UPDATE_BRANCH_DEACTIVATE_SQL` (transactional: SELECT FOR UPDATE → conflict check → UPDATE).
- `apps/api/src/app.ts` (MODIFIED) — import `adminBranchesRouter` from `./routes/admin-branches.js`; mount `app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter)` AFTER the existing `app.use('/admin', adminScope, adminClinicRouter)` at line 82. Router-level middleware means `adminScope` fires once for the whole `/admin/*` path.
- `apps/api/test/admin-branches.test.ts` (NEW) — full I/O matrix. Uses `__makeAdminToken()` from `apps/api/test/__helpers__/admin-token.ts`, supertest + `createApp()`. Tests seed the DB once via `seedWith(client)` in a `before()` hook. Tests use the same pattern as `admin-clinic.test.ts` for the `updated_at` advance assertions.
- `apps/api/test/migrations.test.ts` (MODIFIED) — add 1 test: `0014 adds branch.active NOT NULL DEFAULT true; existing seeded branches default to active=true; column survives a migration re-run (idempotent)`. Mirror the E1-S0a test additions at `migrations.test.ts:147-200` (FK verification pattern).

**DB schema ground truth (re-read of `0001_init_bootstrap.sql`, `0004_widen_seed_entities.sql`, `0013_clinic_anchor.sql`):**

- `branch(id uuid PK, clinic_id uuid NOT NULL FK clinic ON DELETE RESTRICT, name text NOT NULL, tz text NOT NULL DEFAULT 'UTC', created_at timestamptz, updated_at timestamptz)` — current shape.
- FK inbound to `branch(id)`:
  - `doctor_branch.branch_id` — `ON DELETE CASCADE` (`0001_init_bootstrap.sql:40`). Deactivating a branch does NOT cascade; only an actual DELETE does.
  - `receptionist.branch_id` — `ON DELETE RESTRICT` (`0001_init_bootstrap.sql:46`).
  - `doctor_schedule.branch_id` — `ON DELETE RESTRICT` (`0006_doctor_schedule.sql:15`).
  - `doctor_block.branch_id` — `ON DELETE RESTRICT` (`0007_doctor_block.sql:13`).
  - `appointment.branch_id` — `ON DELETE RESTRICT` (`0008_appointment.sql:38`).
- `appointment.branch_id` is what the future-appointment conflict check queries (`SELECT 1 FROM appointment WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled'`).
- `branch.updated_at` advance on UPDATE is automatic via `trg_branch_set_updated_at` (`0004_widen_seed_entities.sql:31-38` — same trigger function `set_updated_at()`).

**Deactivate conflict-check SQL (transactional, prevents TOCTOU race):**

```sql
BEGIN;
  -- Lock the branch row so no concurrent transaction can change active
  -- between our check and our UPDATE.
  SELECT id, active FROM branch WHERE id = $1 FOR UPDATE;
  -- Conflict check: any future Scheduled appointment on this branch?
  SELECT 1 FROM appointment
   WHERE branch_id = $1
     AND start_datetime > now()
     AND status = 'Scheduled'
   LIMIT 1;
  -- If zero rows, UPDATE. If ≥1 row, rollback and return 409.
  UPDATE branch SET active = $2, updated_at = now() WHERE id = $1
    RETURNING id, clinic_id, name, active, created_at, updated_at;
COMMIT;
```

**Validation helpers (mirrors admin-clinic.ts patterns):**

```ts
const NAME_MIN = 1;
const NAME_MAX = 120;
function isValidName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}
function normalizeName(name: string): string { return name.trim(); }

function isValidActive(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}
```

**Mount order in `apps/api/src/app.ts` (line 82 → multi-router):**

```ts
app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter);
```

`adminScope` fires once for the whole `/admin/*` mount path; the two routers are siblings under it. Request that doesn't match `/admin/clinic*` falls through to `adminBranchesRouter`'s routes (`/admin/branches*`).

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/db/migrations/0014_branch_active.sql` -- `ALTER TABLE branch ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`. Idempotent. Comment header explains the rationale (E1-S1 introduces the branch lifecycle; existing seeded branches default to active=true).
- [x] `apps/api/src/routes/admin-branches.ts` -- `POST /admin/branches` (create, 1-120 char name, 201 with full row) + `GET /admin/branches` (list with `?active=true|false` filter) + `GET /admin/branches/:id` (single, 404 if unknown) + `PATCH /admin/branches/:id` (rename and/or deactivate; deactivate conflict-check inside a transaction with `SELECT ... FOR UPDATE` to prevent TOCTOU). Mirror `admin-clinic.ts` shape; import `getLogger` for error logging; raw `pool.query` for non-tx, `pool.connect()` + `BEGIN/COMMIT/ROLLBACK` for the deactivate path.
- [x] `apps/api/src/app.ts` -- import `adminBranchesRouter` from `./routes/admin-branches.js`; change `app.use('/admin', adminScope, adminClinicRouter)` at line 82 to `app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter)`.
- [x] `apps/api/test/admin-branches.test.ts` -- full I/O matrix (happy POST, 4×400-name POST, 401 POST, 403 POST, list GET, `?active=true` GET, `?active=false` GET, `?active=banana` 400 GET, single GET, 404 single GET, 400 invalid_uuid GET, rename PATCH, deactivate clean PATCH, deactivate conflict PATCH, reactivate PATCH, 400 no-op PATCH, 400 invalid_active PATCH, 404 PATCH, 401 PATCH). Restore DB state where needed (delete created branches, reactivate deactivated ones) to avoid bleed between tests.
- [x] `apps/api/test/migrations.test.ts` -- extend with 1 new test: `0014 adds branch.active NOT NULL DEFAULT true` — assert the column exists via `pg_attribute`, default is `true`, and the seeded branches all carry `active=true`. Verify idempotent by manually running the migration file's statements twice and asserting no error.

**Acceptance Criteria:**
- Given a valid admin JWT, when `POST /admin/branches {name: 'New Branch'}` is called, then response is `201` with `{id, clinic_id, name: 'New Branch', active: true, created_at, updated_at}` and the row is queryable via `SELECT * FROM branch WHERE name = 'New Branch'`.
- Given `POST /admin/branches` with empty / over-length / missing / non-string name, when validated, then response is `400 {error: 'invalid_name'}` and no DB write occurs.
- Given a valid admin JWT, when `GET /admin/branches` is called, then response is `200` with an array of all seeded branches (length 2 per `01_minimum.ts`), each carrying the full row shape.
- Given `?active=true` and `?active=false`, when `GET /admin/branches` is called, then only branches matching the filter are returned.
- Given `?active=banana`, when `GET /admin/branches` is called, then response is `400 {error: 'invalid_active_filter'}`.
- Given a valid branch id, when `GET /admin/branches/:id` is called, then response is `200 {id, clinic_id, name, active, created_at, updated_at}`.
- Given an unknown id, when `GET /admin/branches/:id` is called, then response is `404 {error: 'branch_not_found'}`.
- Given an invalid UUID, when `GET /admin/branches/:id` is called, then response is `400 {error: 'invalid_branch_id'}` (UUID parse before DB lookup).
- Given `PATCH /admin/branches/:id {name: 'Renamed'}`, when successful, then response is `200` with the updated row and `updated_at > pre-call`.
- Given `PATCH /admin/branches/:id {active: false}` on a branch with no future Scheduled appointments, when successful, then response is `200 {active: false, ...}`.
- Given `PATCH /admin/branches/:id {active: false}` on a branch with ≥1 future Scheduled appointment, when the conflict check fires, then response is `409 {error: 'branch_has_future_appointments'}` and `branch.active` remains unchanged (transaction rolls back).
- Given `PATCH /admin/branches/:id {}`, when validated, then response is `400 {error: 'no_fields_to_update'}` (refuse no-op to keep audit trail meaningful when E7 lands).
- Given `PATCH /admin/branches/:id {active: 'maybe'}`, when validated, then response is `400 {error: 'invalid_active'}`.
- Given the new code, when the existing test suites run, then no regression — pre-existing test counts preserved or improved (current baseline: 224/227).

## Spec Change Log

**SC1 — 2026-09-14, plan-step (no loopback). Decision recorded before spec approval.**
- **Trigger:** The E1-S1 mockup-17 design (linked in `epics-and-stories.md:149`) includes an "address" field on the branch row. The original 0001 schema did not include `branch.address`; it was deferred. The natural temptation in E1-S1 is to add `branch.address text` to the 0014 migration.
- **Amendment:** `branch.address` is NOT in scope for E1-S1. The branch edit form (mockup-17) ships the address field as a UI placeholder; the backend POST/PATCH routes ignore it until E1-S2 adds the column. Reasoning: E1-S2 (branch operating hours) shares the same edit surface (mockup-28), and bundling `address` + `tz` + weekly hours into the same migration keeps the column-set atomic. E1-S1 ships `branch.active` only; the routes ignore unknown fields (`address` arrives as a body field, route does not consult it, response does not echo it).
- **Avoided known-bad state:** Adding `branch.address` to 0014 would have made the E1-S2 migration either (a) a no-op (column already exists) or (b) a confusing "what changed in E1-S2" diff for downstream readers. Bundling is cheaper; defer it.
- **KEEP (must not regress):** The original human-owned intent (Problem/Approach/Boundaries/Ask-First/"Never") is preserved verbatim inside `<frozen-after-approval>...</frozen-after-approval>`. The migration scope (one column, idempotent), the route shape (POST + GET list + GET single + PATCH), the adminScope gate, and the deactivate conflict-check transaction are unchanged.

**SC2 — 2026-09-14, review-loop-1 (13 patches applied, 4 deferrals, no spec changes).**
- **Trigger:** Step-04 review (3 reviewers — verification-gap, blind-hunter, edge-case-hunter) returned ~50 findings collectively. After triage: 0 intent_gap, 0 bad_spec, 13 patch, 4 defer, remainder rejected as noise.
- **Patches:**
  - **P-A1 (admin-branches.ts) — Reject unknown top-level fields in PATCH with `400 unknown_field`:** Previously the route silently dropped unknown fields like `{role, clinic_id, branch_ids}`. A privilege-escalation attempt to set `role: 'superadmin'` would receive `200 OK` with the response carrying the original JWT-derived role. Fix: read `Object.keys(body)`, intersect with `new Set(['name', 'active'])`, reject any extra keys. New test pins both the error envelope and the DB-side unchanged state.
  - **P-A5 (app.ts) — Map `entity.parse.failed` to `400 invalid_json`:** The global error handler at `apps/api/src/app.ts:91-103` previously surfaced malformed JSON as `500 internal_error`. Fix: detect `err instanceof SyntaxError && err.type === 'entity.parse.failed'` and return `400 {error: 'invalid_json'}`. New test pins the envelope via `POST /admin/branches` with an unclosed brace.
  - **P-B2 (admin-branches.ts) — Refactor dynamic UPDATE placeholder indexing:** `$${idx++}` / `$${idx}` mixed post/pre-increment was correct but fragile. Fix: use `++placeholder` consistently with explicit `idPlaceholder` / `clinicPlaceholder` bindings. Comment explains the future-maintainer hazard.
  - **P-F1 (0014_branch_active.sql) — Adopt codebase's add-then-backfill-then-constrain pattern:** The 0013 / 0004 convention is to never combine `ADD COLUMN IF NOT EXISTS ... NOT NULL` in one statement (a silent no-op on partially-migrated DBs). Fix: split into 3 statements (ADD nullable → UPDATE backfill → SET NOT NULL).
  - **P9 (admin-branches.test.ts) — Scope `after()` cleanup to seeded branch names:** `UPDATE branch SET active = true WHERE active = false` would flatten any sibling test's intentionally-inactive branch. Fix: scope to `name IN ('East Branch', 'West Branch')`.
  - **P11 (migrations.test.ts) — Use UUID-based unique branch name in shared container:** `INSERT INTO branch (..., name = 'Active Test Branch')` with a hardcoded name could collide across sibling test files. Fix: `'Active Test ' || gen_random_uuid()::text` and capture `id` for targeted cleanup.
  - **P2, P4, P5, P6, P13 (admin-branches.test.ts) — DB-pinning for trim / rename / reactivate / combined atomicity:** Response-only assertions slip past a regression where the route hand-shapes a response that differs from the actual DB row. Fix: each test now queries the DB after the API call to confirm the persistence matches the response. P5 (combined rename + deactivate) confirms BOTH `name` AND `active` flipped atomically inside the transaction.
  - **P7 (admin-branches.test.ts) — Pin `updated_at` unchanged on conflict-rollback:** The conflict-409 test now snapshots `updated_at` pre + post and asserts they match — proves the rollback is full row-state, not a single-column write that happens to fail.
  - **P10 (seed.test.ts) — Assert seed inserts branches with `active=true`:** The seed's silent reliance on the column default would survive a regression that changed the default to `false`. New test queries both seeded branches and asserts `active=true`.
  - **P14 (admin-branches.test.ts) — Validation order pinning for combined invalid:** `{name: '', active: false}` must return `invalid_name` (validation order: name → active). A regression that reordered would silently flip the error code; the new test pins both the error envelope and the DB-side unchanged state.
  - **P-C3 (admin-branches.test.ts) — Uppercase UUID case-insensitivity end-to-end:** New test confirms `GET /admin/branches/<UPPER>` returns 200 with the normalized lowercase id in the response.
  - **P#2 (admin-branches.ts file-level comment) — Honest scope-of-lock note for W35:** The header comment previously claimed `SELECT ... FOR UPDATE` closes the TOCTOU race. Per Postgres MVCC, the lock prevents admin-vs-admin races but not booking-vs-deactivate (the booking tx takes only `ROW SHARE` on the parent FK). The comment is rewritten to acknowledge the scope and point at the future E3-S1 booking path.
- **Deferrals (deferred-work.md):**
  - **W35** — Booking-vs-deactivate TOCTOU race (see above). Booking path doesn't exist yet (E3-S1 is the next booking story); reopen when E3-S1 lands to verify the booking tx takes a branch-row lock.
  - **W36** — Cross-cutting JSON error envelope hardening (`413 payload_too_large`, `415 unsupported_media_type`). Out of scope for E1-S1; reopen when 3+ routes accumulate the same gap.
  - **W37** — `withTestDb` test-isolation hardening for `--test-concurrency > 1`. Spec mandates concurrency=1; reopen on first CI flake report.
  - **W38** — `unknown_field` 400 envelope consistency across POST / GET (only PATCH has it currently). Reopen when a future route needs the same guard.
- **Avoided known-bad state:** Without P-A1, an admin could attempt privilege escalation by sending `{role: 'superadmin'}` and receive `200 OK` with no error envelope. Without P-A5, a malformed JSON body would trigger a 500 page in monitoring (false alert). Without P-F1, a partially-migrated DB (where 0014 was applied to an existing nullable `active` column by an experimental change) would silently skip the NOT NULL constraint. Without the DB-pinning patches (P2/4/5/6/13/7), a route regression that returns a hand-shaped response different from the DB row would slip past the suite.
- **Verification post-patches:** `admin-branches.test.ts` 38/38 green (was 32; +6 net new tests for: deactivate-on-unknown-UUID tx branch, rename-on-East orthogonal, validation-order combined, unknown fields guard, malformed JSON 400, uppercase UUID case-insensitivity). `migrations.test.ts` 12/12 green (was 10; +2 new tests for 0014 column contract and idempotency). `seed.test.ts` 7/7 green (was 6; +1 new test for `branch.active=true` default backfill). Full suite 265/268 (+7 net new tests vs 258/261 E1-S0b baseline; the 3 pre-existing baseline failures in `auth.test.ts` × 2 + `log.test.ts` × 1 are unchanged). Typecheck: 0 new errors (3 pre-existing baseline errors unrelated to E1-S1). Lint: 0 new warnings (4 pre-existing baseline warnings unrelated to E1-S1).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/admin-branches.test.ts` -- expected: all green; full I/O matrix covered (POST happy + 4×400 + 401 + 403, GET list + active filter + invalid filter + single + 404 + invalid_uuid, PATCH rename + deactivate clean + deactivate conflict + reactivate + 400 no-op + 400 invalid_active + 404 + 401).
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/migrations.test.ts` -- expected: all green; the new 0014 migration test passes; existing 0013 tests unaffected.
- `pnpm --filter @clinic/api run typecheck` -- expected: 0 new errors attributable to this spec. Pre-existing baseline errors unchanged.
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/*.test.ts` -- expected: improvement on the 224/227 E1-S0b baseline; the 3 pre-existing baseline failures in `auth.test.ts` × 2 + `log.test.ts` × 1 are unchanged.
- `pnpm --filter @clinic/api run lint` -- expected: 0 new warnings/errors attributable to this spec.

**Manual checks (if no CLI):**
- After `PATCH /admin/branches/:id {active: false}` on a clean branch, query the DB: `SELECT active, updated_at FROM branch WHERE id = $1` — confirm `active = false` and `updated_at > pre-call`.
- After `PATCH /admin/branches/:id {active: false}` on a branch with a future Scheduled appointment, confirm `branch.active` is still `true` in the DB (the transaction rolled back).
- After `POST /admin/branches {name: 'Test'}` then deleting it manually, run `GET /admin/branches` and confirm the seeded branches (2) are still present (no seed bleed).

## Suggested Review Order

**Migration (start here — the schema change is the load-bearing piece)**

- 0014 introduces `branch.active` with the codebase's defensive add-then-backfill-then-constrain pattern (matches 0004 and 0013). NOT NULL is enforced as a separate `ALTER COLUMN` after the backfill UPDATE — closes the silent-no-op gap if the column already exists as nullable from a prior experimental change (P-F1).
  [`0014_branch_active.sql:1`](../../apps/api/db/migrations/0014_branch_active.sql#L1)
- Test pins column existence + default value + idempotency.
  [`migrations.test.ts:147`](../../apps/api/test/migrations.test.ts#L147)
- New test pins that the seed's silent reliance on the column default lands `active=true` on both seeded branches (P10).
  [`seed.test.ts:215`](../../apps/api/test/seed.test.ts#L215)

**Route layer (validation + transaction)**

- File-level comment now documents the **scope-of-lock caveat** for the deactivate transaction: `SELECT ... FOR UPDATE` blocks admin-vs-admin races but NOT booking-vs-deactivate — see W35 (P-#2).
  [`admin-branches.ts:15`](../../apps/api/src/routes/admin-branches.ts#L15)
- Unknown top-level fields in PATCH are now rejected with `400 unknown_field` + the offending key list (P-A1). Closes a privilege-escalation gap where `{role, clinic_id}` would have been silently dropped.
  [`admin-branches.ts:262`](../../apps/api/src/routes/admin-branches.ts#L262)
- Dynamic UPDATE placeholder indexing refactored to unambiguous `++placeholder` + named `idPlaceholder`/`clinicPlaceholder` bindings (P-B2).
  [`admin-branches.ts:`](../../apps/api/src/routes/admin-branches.ts) (search for `idPlaceholder`)

**Global error handler (cross-cutting fix from review)**

- Malformed JSON body now returns `400 invalid_json` instead of `500 internal_error` (P-A5). The other 4xx mappings (413, 415) are deferred to W36.
  [`app.ts:91`](../../apps/api/src/app.ts#L91)

**Mount order**

- New router is a sibling under the existing `adminScope` gate; `adminScope` fires once for the whole `/admin/*` path. Comment now cites the correct line.
  [`app.ts:83`](../../apps/api/src/app.ts#L83)

**Tests (matrix coverage)**

- Conflict-check pinning: insert a future Scheduled appointment, attempt deactivate, assert 409 + rollback + `updated_at` unchanged (P7).
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `deactivate CONFLICT`)
- Deactivate-on-unknown-UUID: exercises the `SELECT FOR UPDATE` 0-row branch INSIDE the transaction (P9 from verification-gap).
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `tx path`)
- Combined rename + deactivate: DB-pinned atomicity (name AND active both flipped).
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `both changes \(DB-pinned\)`)
- Validation order pinning: `{name: '', active: false}` → `invalid_name` (not `invalid_active`).
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `name validated BEFORE active`)
- Unknown fields privilege-escalation guard.
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `unknown_field`)
- Malformed JSON → 400 invalid_json envelope.
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `malformed JSON`)
- Uppercase UUID end-to-end case-insensitivity (Postgres `uuid` type normalizes; regex is `/.../i`).
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `uppercase UUID`)
- Rename on East Branch (which has a future Scheduled appointment) succeeds — rename is orthogonal to deactivate.
  [`admin-branches.test.ts:1`](../../apps/api/test/admin-branches.test.ts#L1) (search for `rename on a branch with future`)
- Idempotent migration: re-run 0014 statements, assert no error.
  [`migrations.test.ts:147`](../../apps/api/test/migrations.test.ts#L147)
