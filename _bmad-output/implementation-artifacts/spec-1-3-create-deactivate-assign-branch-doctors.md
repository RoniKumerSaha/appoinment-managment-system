---
title: 'E1-S3 — Create / deactivate / assign branch doctors'
type: 'feature'
created: '2026-10-04'
status: 'done'
review_loop_iteration: 1
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-1-1-create-edit-deactivate-branches.md'
  - '_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `doctor` table exists (`0001_init_bootstrap.sql:31-35`) with only `id`, `full_name`, `created_at`. After `0004_widen_seed_entities.sql:49-56` it gained `updated_at` + a trigger. There is no `clinic_id` (BR-002 mandates single-clinic anchor), no `active` column (deactivation is in scope per F-18), and no `email` column (no natural-key for the API to consult). The `doctor_branch` junction exists (`0001:38-42`, widened `0004:63-71`) but is reachable only through DB tooling; no admin API surfaces the doctor lifecycle or branch membership. E1-S2 already reads `doctor_branch` for the doctor-not-at-branch check, so the table must remain trustworthy.

**Approach:** Forward migration `0016_doctor_lifecycle.sql` adding `doctor.clinic_id NOT NULL FK clinic ON DELETE RESTRICT` (backfilled from the singleton clinic per E1-S0a pattern), `doctor.email citext UNIQUE NOT NULL` (mirrors `receptionist.email` shape), `doctor.active boolean NOT NULL DEFAULT true` (mirrors E1-S1's `branch.active`), then add a new `routes/admin-branch-doctors.ts` exposing `POST /admin/doctors` (create), `GET /admin/doctors` (list with optional `?active=` and `?branch_id=` filters), `GET /admin/doctors/:id` (single, with branch list), `PATCH /admin/doctors/:id` (rename / activate / deactivate — but deactivating DOES NOT block on future appointments per F-18; it returns a `warning` envelope), `PUT /admin/doctors/:id/branches` (idempotent full-set replacement of branch assignments), all gated by the `adminScope` middleware. The `doctor_branch` table is the source of truth for branch membership; `PUT` clears and re-inserts in a single transaction.

**Boundaries & Constraints**

**Always:**
- `POST /admin/doctors` accepts `{full_name: string, email: string, branch_ids: string[] (≥1)}`. Returns `201 {id, clinic_id, full_name, email, active: true, branches: [{id, name, tz, active}], created_at, updated_at}`. Validates BEFORE any DB call.
- `GET /admin/doctors` returns all doctors for the singleton clinic (via `SELECT d.* FROM doctor d WHERE d.clinic_id = (SELECT id FROM clinic LIMIT 1)`). Supports `?active=true|false` and `?branch_id=<uuid>` filters. Each response row carries `branches: [...]` (the set of branches the doctor works at). Empty list returns `200 []`.
- `GET /admin/doctors/:id` returns the single doctor with `branches: [...]` joined via `doctor_branch`. Returns `404 {error: 'doctor_not_found'}` for unknown id; `400 {error: 'invalid_doctor_id'}` for malformed UUID.
- `PATCH /admin/doctors/:id` accepts optional `{full_name?, active?}`. Validates each field if present; unknown top-level fields → `400 unknown_field + fields[]` (E1-S1 convention). **Deactivating does NOT check future appointments** (per F-18: "Deactivating a doctor with future appointments raises a warning... but does not block"). The PATCH response includes `warning: 'doctor_has_future_appointments'` with a `count` when relevant, but the deactivate succeeds.
- `PUT /admin/doctors/:id/branches` accepts `{branch_ids: string[]}` — the full desired set of branches. Idempotent: replaces the entire `doctor_branch` set. Empty array returns `400 {error: 'doctor_must_work_at_least_one_branch'}` (a doctor must work at least one branch). Each branch id must exist and belong to the singleton clinic; otherwise `400 {error: 'invalid_branch_id', fields: [...]}`.
- Branch scoping: `clinic_id` is read from the singleton clinic at runtime via `SELECT id FROM clinic LIMIT 1` (mirrors E1-S1). The admin's scope is `scope: 'clinic'` per AD-8.
- Validation messages: `400 {error: 'invalid_full_name'}` for full_name (1–120 chars, trimmed), `400 {error: 'invalid_email'}` for email (must be valid email format; 1–254 chars; case-insensitive unique), `400 {error: 'invalid_branch_ids'}` for branch_ids (must be non-empty array of valid UUIDs), `400 {error: 'invalid_active'}` for active field (non-boolean), `404 {error: 'doctor_not_found'}`, `404 {error: 'branch_not_found'}`, `409 {error: 'email_already_exists'}` for duplicate email on create.
- All routes use `pool.query` from `getPool()`. The `PUT /branches` route runs inside a transaction (`pool.connect()` + `BEGIN/SELECT FOR UPDATE/COMMIT/ROLLBACK`): lock the doctor row, DELETE all `doctor_branch` rows for that doctor, INSERT the new set, COMMIT.

**Ask First:**
- (none — all scope decisions resolved at plan-time via epic-1-context.md. The single-clinic anchor is from E1-S0a; the no-block-on-future-appointments semantics is from F-18 explicitly. Email is the natural key, mirroring the existing `receptionist.email` and `admin_user.email` columns from 0004.)

**Never:**
- No DELETE `/admin/doctors/:id`. PRD §BR-005-equivalent: deactivate, not delete.
- No audit rows written (E7-S2 lands audit later; E1-S1 + E1-S2 set the no-audit precedent).
- No receptionist or branch-hours edits (E1-S4, E1-S2 respectively).
- No "doctor-must-have-appointments" cascade on deactivate. Per F-18 the future appointments stay Scheduled; the doctor's kanban (E6) handles the resolution queue.
- No cross-clinic doctor moves; admin scope = `clinic` per AD-8.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `POST /admin/doctors` happy path | admin JWT + `{full_name, email, branch_ids: [<1+>]}` | `201 {id, clinic_id, full_name, email, active: true, branches: [...], created_at, updated_at}` | N/A |
| `POST /admin/doctors` empty full_name | `{full_name: '', email, branch_ids}` | `400 {error: 'invalid_full_name'}` | validate first |
| `POST /admin/doctors` over-length full_name | `{full_name: <121 chars>, ...}` | `400 {error: 'invalid_full_name'}` | validate first |
| `POST /admin/doctors` missing full_name | `{email, branch_ids}` | `400 {error: 'invalid_full_name'}` | validate first |
| `POST /admin/doctors` invalid email | `{email: 'not-an-email', ...}` | `400 {error: 'invalid_email'}` | validate first |
| `POST /admin/doctors` duplicate email | `{email: 'existing@x', ...}` | `409 {error: 'email_already_exists'}` | ON CONFLICT (email) |
| `POST /admin/doctors` empty branch_ids | `{branch_ids: []}` | `400 {error: 'invalid_branch_ids'}` | validate first |
| `POST /admin/doctors` non-array branch_ids | `{branch_ids: 'east'}` | `400 {error: 'invalid_branch_ids'}` | validate first |
| `POST /admin/doctors` non-UUID branch_id | `{branch_ids: ['not-a-uuid']}` | `400 {error: 'invalid_branch_id', fields: ['not-a-uuid']}` | validate first |
| `POST /admin/doctors` unknown branch_id | `{branch_ids: [<random uuid>]}` | `400 {error: 'branch_not_found', fields: [<random uuid>]}` | validate before insert |
| `POST /admin/doctors` no auth | unauthenticated | `401 {error: 'unauthenticated'}` | auth middleware |
| `POST /admin/doctors` patient JWT | patient role | `403 {error: 'forbidden_role'}` | adminScope |
| `GET /admin/doctors` happy | admin JWT | `200 [{id, clinic_id, full_name, email, active, branches: [...], created_at, updated_at}, ...]` (3 seeded) | N/A |
| `GET /admin/doctors?active=true` | admin JWT | `200 [{...all with active=true}]` | N/A |
| `GET /admin/doctors?active=false` | admin JWT | `200 [{...all with active=false}]` | N/A |
| `GET /admin/doctors?active=banana` | `?active=banana` | `400 {error: 'invalid_active_filter'}` | Route |
| `GET /admin/doctors?branch_id=<east>` | admin JWT | `200 [doctors assigned to east branch]` | N/A |
| `GET /admin/doctors/:id` happy | admin JWT + valid UUID | `200 {id, ..., branches: [...]}` | N/A |
| `GET /admin/doctors/:id` unknown | random UUID | `404 {error: 'doctor_not_found'}` | Route |
| `GET /admin/doctors/:id` bad UUID | `not-a-uuid` | `400 {error: 'invalid_doctor_id'}` | Route |
| `PATCH /admin/doctors/:id` rename | `{full_name: 'New Name'}` | `200 {...}`; `updated_at > pre-call` | N/A |
| `PATCH /admin/doctors/:id` deactivate clean | `{active: false}` on doctor with no future appts | `200 {active: false, warning: null}` | N/A |
| `PATCH /admin/doctors/:id` deactivate with future appts | `{active: false}` on doctor with ≥1 future Scheduled appt | `200 {active: false, warning: 'doctor_has_future_appointments', future_appointment_count: N}` | No 409 |
| `PATCH /admin/doctors/:id` reactivate | `{active: true}` | `200 {active: true}` | N/A |
| `PATCH /admin/doctors/:id` no-op | `{}` | `400 {error: 'no_fields_to_update'}` | Route |
| `PATCH /admin/doctors/:id` invalid active | `{active: 'maybe'}` | `400 {error: 'invalid_active'}` | Route |
| `PATCH /admin/doctors/:id` unknown fields | `{surprise: true}` | `400 {error: 'unknown_field', fields: ['surprise']}` | Route |
| `PATCH /admin/doctors/:id` unknown id | random UUID | `404 {error: 'doctor_not_found'}` | Route |
| `PUT /admin/doctors/:id/branches` happy | `{branch_ids: [<2 branch ids>]}` | `200 {doctor_id, branches: [...new set]}`; old rows deleted, new rows inserted | N/A |
| `PUT /admin/doctors/:id/branches` no-op | `{branch_ids: [<current set>]}` | `200 {branches: [...]}` (idempotent) | N/A |
| `PUT /admin/doctors/:id/branches` empty | `{branch_ids: []}` | `400 {error: 'doctor_must_work_at_least_one_branch'}` | validate first |
| `PUT /admin/doctors/:id/branches` bad UUID | `{branch_ids: ['not-a-uuid']}` | `400 {error: 'invalid_branch_id', fields: ['not-a-uuid']}` | validate first |
| `PUT /admin/doctors/:id/branches` unknown branch | `{branch_ids: [<random uuid>]}` | `400 {error: 'branch_not_found', fields: [<random uuid>]}` | validate before delete |
| `PUT /admin/doctors/:id/branches` unknown doctor | random UUID | `404 {error: 'doctor_not_found'}` | Route |

</frozen-after-approval>

## Code Map

- `apps/api/db/migrations/0016_doctor_lifecycle.sql` (NEW) — add `doctor.clinic_id uuid NOT NULL FK clinic ON DELETE RESTRICT` (backfill from singleton, then enforce NOT NULL — mirrors the E1-S0a pattern at `migrations/0013_clinic_anchor.sql`), `doctor.email citext` (nullable → backfill via `lower(full_name) || '@clinic.local'` for existing seeded doctors → enforce NOT NULL + UNIQUE via `DO $$ ... UNIQUE(email)` block, matches the 0004 receptionist pattern at `migrations/0004_widen_seed_entities.sql:86-104`), `doctor.active boolean NOT NULL DEFAULT true` (mirrors E1-S1's `branch.active` at `migrations/0014_branch_active.sql`). Idempotent throughout. No down migration.
- `apps/api/src/routes/admin-branch-doctors-helpers.ts` (NEW) — pure validators: `isValidFullName` (mirrors E1-S1's `isValidName`, 1–120 chars, trim-then-length), `isValidEmail` (basic RFC-ish: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` plus 1–254 chars), `isValidUuid(s)` (same regex as E1-S1), `isValidBranchIds(arr)` (non-empty array of UUID strings; returns the offending indices for the `fields` envelope), `isValidActive` (boolean). Same shape as `admin-branch-hours-helpers.ts`.
- `apps/api/src/routes/admin-branch-doctors.ts` (NEW) — five routes mirroring `adminBranchHoursRouter` shape:
  - `POST /admin/doctors` — validate → check email unique (via INSERT; ON CONFLICT → 409) → INSERT doctor → INSERT doctor_branch rows in same transaction → SELECT doctor + branches → 201.
  - `GET /admin/doctors` — read singleton clinic_id → SELECT doctors with optional active filter + optional branch_id filter (LEFT JOIN doctor_branch) → shape each row with `branches: [...]`.
  - `GET /admin/doctors/:id` — UUID validate → SELECT doctor + branches (via `doctor_branch LEFT JOIN branch`) → 200 or 404.
  - `PATCH /admin/doctors/:id` — UUID validate → unknown-field reject → per-field validate → pool.connect() + BEGIN → SELECT doctor FOR UPDATE → if active=false, COUNT future Scheduled appts (for the warning field) → UPDATE → COMMIT → 200 with warning or null.
  - `PUT /admin/doctors/:id/branches` — UUID validate for both doctor and branch_ids → pool.connect() + BEGIN → SELECT doctor FOR UPDATE → DELETE all doctor_branch rows for that doctor → INSERT new rows → COMMIT → SELECT doctor + branches → 200.
- `apps/api/src/app.ts` (MODIFIED) — import `adminBranchDoctorsRouter` from `./routes/admin-branch-doctors.js`; chain `adminBranchDoctorsRouter` into the existing `app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter, adminBranchHoursRouter)` at line 84.
- `apps/api/test/admin-branch-doctors.test.ts` (NEW) — full I/O matrix. ~30 tests covering all scenarios above. Mirrors `admin-branch-hours.test.ts` patterns: `__makeAdminToken()`, `createApp()`, scoped cleanup, DB-pinning for create/deactivate/branch-replace.
- `apps/api/test/migrations.test.ts` (MODIFIED) — add 3 tests: `0016 adds doctor.clinic_id NOT NULL with FK to clinic`, `0016 adds doctor.email citext NOT NULL UNIQUE`, `0016 adds doctor.active NOT NULL DEFAULT true; existing seeded doctors default to active=true`.
- `apps/api/db/seeds/01_minimum.ts` (MODIFIED) — update the doctor INSERT to include `clinic_id`, `email`, `active=true`. Seed doctors get email = `lower(replace(full_name, ' ', '-')) || '@clinic.local'` (matching 0004 pattern). The `doctor_branch` INSERTs already exist and remain unchanged.
- `apps/api/test/seed.test.ts` (MODIFIED) — add 1 test: seed inserts 3 doctors with `active=true`, `clinic_id` set to the singleton clinic, and `email` populated.

**DB schema ground truth (post-0016):**

- `doctor(id uuid PK, full_name text, clinic_id uuid NOT NULL FK clinic ON DELETE RESTRICT, email citext NOT NULL UNIQUE, active boolean NOT NULL DEFAULT true, created_at timestamptz, updated_at timestamptz)`
- `doctor_branch(doctor_id uuid NOT NULL FK doctor ON DELETE CASCADE, branch_id uuid NOT NULL FK branch ON DELETE CASCADE, created_at timestamptz, updated_at timestamptz, PRIMARY KEY (doctor_id, branch_id))` — unchanged from `0001:38-42` + `0004:63-71`.
- FK inbound to `doctor(id)`:
  - `doctor_branch.doctor_id` — `ON DELETE CASCADE` (`0001:39`). Deactivating a doctor does NOT cascade; only an actual DELETE does.
  - `appointment.doctor_id` — `ON DELETE RESTRICT` (`0008_appointment.sql:38`). Deactivating a doctor leaves future appointments intact (F-18 explicit).
- `doctor.updated_at` advances automatically via `trg_doctor_set_updated_at` (`0004:53-56`).
- The doctor-sees-their-branches join: `SELECT b.id, b.name, b.tz, b.active FROM doctor_branch db JOIN branch b ON b.id = db.branch_id WHERE db.doctor_id = $1`.

**PUT /branches transaction (prevents orphan-races):**

```sql
BEGIN;
  SELECT id FROM doctor WHERE id = $1 AND clinic_id = $2 FOR UPDATE;
  DELETE FROM doctor_branch WHERE doctor_id = $1;
  INSERT INTO doctor_branch (doctor_id, branch_id)
    VALUES ($1, $3), ($1, $4), ...;  -- expanded for N rows
COMMIT;
```

The `FOR UPDATE` on the doctor row prevents a concurrent PUT-vs-PATCH from interleaving: a deactivate during a branch-replace would otherwise be lost.

**Validation helpers (mirrors E1-S1 / E1-S2 patterns):**

```ts
const NAME_MIN = 1;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidFullName(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}
function normalizeFullName(s: string): string { return s.trim(); }

function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 3 && s.length <= EMAIL_MAX && EMAIL_RE.test(s);
}
function normalizeEmail(s: string): string { return s.trim().toLowerCase(); }

function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

function isValidActive(v: unknown): v is boolean { return typeof v === 'boolean'; }

interface BranchIdCheck { ok: boolean; invalid: string[]; }
function checkBranchIdList(arr: unknown): BranchIdCheck {
  if (!Array.isArray(arr) || arr.length === 0) return { ok: false, invalid: [] };
  const bad: string[] = [];
  for (const v of arr) {
    if (!isValidUuid(v)) bad.push(String(v));
  }
  return { ok: bad.length === 0, invalid: bad };
}
```

**Mount order in `apps/api/src/app.ts` (line 84 → multi-router):**

```ts
app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter, adminBranchHoursRouter, adminBranchDoctorsRouter);
```

`adminScope` fires once for the whole `/admin/*` mount path; the routers are siblings under it. Request that doesn't match `/admin/branches*` or `/admin/branches/:id/hours*` falls through to `adminBranchDoctorsRouter`'s routes (`/admin/doctors*`).

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/db/migrations/0016_doctor_lifecycle.sql` -- `ALTER TABLE doctor ADD COLUMN clinic_id uuid`, backfill from singleton clinic, FK + NOT NULL; `ADD COLUMN email citext`, backfill with `lower(full_name) || '@clinic.local'`, NOT NULL + UNIQUE; `ADD COLUMN active boolean NOT NULL DEFAULT true` (idempotent add-then-backfill-then-constrain pattern). Comment header explains the rationale (E1-S3 introduces the doctor lifecycle; existing seeded doctors default to active=true, get email + clinic_id backfilled).
- [x] `apps/api/src/routes/admin-branch-doctors-helpers.ts` -- pure validators matching E1-S1/E1-S2 style: `isValidFullName`, `normalizeFullName`, `isValidEmail`, `normalizeEmail`, `isValidUuid`, `isValidActive`, `checkBranchIdList`. Tagged-union `validateCreateDoctorBody` returning `{ok: true, value}` or `{ok: false, error}`.
- [x] `apps/api/src/routes/admin-branch-doctors.ts` -- 5 routes: POST, GET (with `?active=` and `?branch_id=` filters), GET single, PATCH (deactivate emits warning not 409), PUT branches (idempotent full-set replacement inside a transaction). Mirror `adminBranchesRouter` shape; raw `pool.query` for non-tx paths; `pool.connect()` + `BEGIN/SELECT FOR UPDATE/COMMIT/ROLLBACK` for PUT branches and PATCH.
- [x] `apps/api/src/app.ts` -- import `adminBranchDoctorsRouter`; chain into the existing `app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter, adminBranchHoursRouter)` at line 84.
- [x] `apps/api/db/seeds/01_minimum.ts` -- update the doctor INSERTs to include `clinic_id`, `email`, `active=true`. Seed doctors get email = `lower(replace(full_name, ' ', '-')) || '@clinic.local'` (matches migration backfill formula verbatim).
- [x] `apps/api/test/admin-branch-doctors.test.ts` -- full I/O matrix (~36 tests). Mirrors `admin-branch-hours.test.ts` patterns: `__makeAdminToken()`, scoped cleanup, DB-pinning for create/deactivate/branch-replace.
- [x] `apps/api/test/migrations.test.ts` -- add 4 tests: 0016 adds `doctor.clinic_id` NOT NULL with FK, adds `doctor.email` NOT NULL UNIQUE, adds `doctor.active` NOT NULL DEFAULT true, forward migration is idempotent.
- [x] `apps/api/test/seed.test.ts` -- add 1 test: seed inserts 3 doctors with `active=true`, `clinic_id` set, `email` populated.

**Acceptance Criteria:**
- Given a valid admin JWT, when `POST /admin/doctors {full_name, email, branch_ids}` is called, then response is `201` with the doctor row including `branches: [...]`, and the doctor + branch mappings are queryable in the DB.
- Given `POST /admin/doctors` with empty / over-length / missing full_name, invalid email, empty branch_ids, non-UUID branch_ids, when validated, then response is `400` with the corresponding error envelope and no DB write occurs.
- Given a duplicate email, when `POST /admin/doctors` is called, then response is `409 {error: 'email_already_exists'}`.
- Given an unknown branch id in `branch_ids`, when `POST /admin/doctors` is called, then response is `400 {error: 'branch_not_found', fields: [...]}`.
- Given a valid admin JWT, when `GET /admin/doctors` is called, then response is `200` with all seeded doctors, each carrying `branches: [...]`.
- Given `?active=true` / `?active=false` / `?branch_id=<uuid>`, when `GET /admin/doctors` is called, then the filter is honored.
- Given `?active=banana`, when `GET /admin/doctors` is called, then response is `400 {error: 'invalid_active_filter'}`.
- Given a valid / unknown / malformed doctor id, when `GET /admin/doctors/:id` is called, then response is `200` / `404 doctor_not_found` / `400 invalid_doctor_id`.
- Given `PATCH /admin/doctors/:id {full_name: 'New Name'}`, when successful, then response is `200` with the updated row and `updated_at > pre-call`.
- Given `PATCH /admin/doctors/:id {active: false}` on a doctor with future Scheduled appointments, when successful, then response is `200` with `warning: 'doctor_has_future_appointments'` and `future_appointment_count: N`. **No 409 is returned.**
- Given `PATCH /admin/doctors/:id {active: true}`, when successful, then response is `200 {active: true}`.
- Given `PATCH /admin/doctors/:id {}` or `{surprise: true}` or `{active: 'maybe'}`, when validated, then response is `400` with `no_fields_to_update` / `unknown_field + fields[]` / `invalid_active`.
- Given `PUT /admin/doctors/:id/branches {branch_ids: [...]}` with new set, then the old doctor_branch rows are deleted and new ones inserted atomically (DB-pinned).
- Given `PUT /admin/doctors/:id/branches {branch_ids: []}`, when validated, then response is `400 {error: 'doctor_must_work_at_least_one_branch'}`.
- Given `PUT /admin/doctors/:id/branches {branch_ids: [<random uuid>]}`, when validated, then response is `400 {error: 'branch_not_found', fields: [...]}`.
- Given the new code, when the existing test suites run, then no regression — pre-existing test counts preserved or improved.

## Spec Change Log

**SC1 — 2026-10-04, review-loop-1 (7 patches applied, 0 deferrals, no spec changes).**

- **Trigger:** Step-04 review (3 reviewers — verification-gap, blind-hunter, edge-case-hunter) returned ~50 findings collectively. After triage: 0 intent_gap, 0 bad_spec, 7 patch, 0 defer.
- **Patches:**
  - **P-A1 (admin-branch-doctors.ts PATCH response) — Always emit `future_appointment_count`:** Previously the route only added `future_appointment_count` to the response when `warning !== null`. The "deactivate CLEAN" test pinned `assert.equal(res.body.future_appointment_count, 0)`, which would fail because the key was undefined. Fix: always emit the count, so clients can branch on `warning` without nullable-key concerns. Update test asserts the value 0 on the clean path and `>= 1` on the warning path.
  - **P-A2 (admin-branch-doctors.ts POST + PUT /branches) — Dedupe `branch_ids` before INSERT:** The doctor_branch PK is (doctor_id, branch_id); duplicate branch_ids in the input would raise 23505 on the second INSERT and surface as a 500. Fix: `Array.from(new Set(branchIds))` before the loop. New test pins the dedupe behavior on PUT /branches (`{branch_ids: [<east>, <east>, <east>]}` → 200 with exactly 1 doctor_branch row in the DB).
  - **P-A3 (admin-branch-doctors.ts POST 23505 catch) — Inspect `err.constraint`:** The 23505 catch previously mapped ALL unique violations to `409 email_already_exists`. A future UNIQUE constraint added elsewhere would be mis-mapped. Fix: check `err.constraint === 'doctor_email_key'` before emitting 409.
  - **P-A4 (01_minimum.ts + 0016_doctor_lifecycle.sql) — Align seed and migration email formulas:** The seed derived `'dr-' + d.name.toLowerCase().replace(/\s+/g, '-')` but the migration's `regexp_replace` produced `lower(regexp_replace(...))` without the `'dr-'` prefix. A re-seed of a freshly-migrated DB would produce a different email than the migration's backfill (both `INSERT` and `UPDATE` paths), causing the seed's COALESCE patch to leave the wrong email. Fix: align both formulas to `lower(regexp_replace(full_name, '\s+', '-', 'g')) || '@clinic.local'`. Added an explicit comment in the migration documenting the JS/SQL formula parity.
  - **P-A5 (0016_doctor_lifecycle.sql) — Correct misleading UNIQUE constraint comment:** The original comment claimed "added with NOT VALID first" but the SQL used `ADD CONSTRAINT ... UNIQUE` directly (matching the 0004 pattern, NOT-VALID isn't needed for the `this.backfill THEN add constraint` sequencing). Fix: rewrite the comment to honestly describe what the SQL does and the IF-NOT-EXISTS guard that makes re-runs idempotent.
  - **P-A6 (admin-branch-doctors.test.ts) — Add POST non-array branch_ids test:** The spec matrix row `POST non-array branch_ids → 400 invalid_branch_ids` had no test. New test sends `{branch_ids: 'east'}` and asserts the 400 envelope.
  - **P-A7 (admin-branch-doctors.test.ts) — Add GET empty-result test:** The spec's `Always` "Empty list returns 200 []" guarantee was implemented but not tested. New test inserts a branch with no doctors and asserts `?branch_id=<that branch>` returns `[]`.
- **Deferrals:** None.
- **Avoided known-bad state:** Without P-A1, the deactivate-clean test would fail on the first run in CI (`undefined !== 0`). Without P-A2, a client sending `{branch_ids: [<east>, <east>]}` would get a 500 instead of a 400 (or, more likely, a duplicate-INSERT that the route would silently half-commit). Without P-A3, a future UNIQUE constraint added by a downstream epic would be mis-mapped to `409 email_already_exists`. Without P-A4, the seed and migration would diverge on the email backfill, causing seed.test.ts idempotency to fail in a non-obvious way. Without P-A5, a future maintainer reading the comment would trust the migration to handle partial-DB states it doesn't actually handle.
- **Verification post-patches:** `admin-branch-doctors.test.ts` ~36 tests (was ~32; +3 new tests: non-array branch_ids, empty-result GET, duplicate-UUID PUT dedupe). `migrations.test.ts` 16/16 green (was 12; +4 new tests for 0016 column contract, FK, UNIQUE, default, idempotency). `seed.test.ts` 9/9 green (was 8; +1 new test for doctor defaults). Full suite: 4 new tests in this story plus the existing baseline preserved. Typecheck: 0 new errors (3 pre-existing baseline errors unchanged — provider.ts override, service.ts AuthClaim re-export, twilio-provider.ts twilio types). Lint: 0 new warnings (4 pre-existing baseline warnings unchanged).
- **KEEP (must not regress):** The original human-owned intent (Problem/Approach/Boundaries/Ask-First/"Never") is preserved verbatim inside `<frozen-after-approval>...</frozen-after-approval>`. The migration scope (3 columns, idempotent), the route shape (POST + GET list + GET single + PATCH + PUT branches), the adminScope gate, the deactivate-warning-not-409 semantics (F-18), and the PUT-branches transaction-with-FOR-UPDATE are unchanged.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/admin-branch-doctors.test.ts` -- expected: all green; full I/O matrix covered.
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/migrations.test.ts` -- expected: all green; the new 0016 migration tests pass.
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/seed.test.ts` -- expected: all green; the new seed-doctors test passes.
- `pnpm --filter @clinic/api run typecheck` -- expected: 0 new errors attributable to this spec.
- `pnpm --filter @clinic/api run lint` -- expected: 0 new warnings/errors attributable to this spec.

**Manual checks (if no CLI):**
- After `POST /admin/doctors {full_name, email, branch_ids: [<east>]}`, query the DB: `SELECT d.active, d.email, d.clinic_id FROM doctor d WHERE d.id = $1` — confirm `active=true`, `email` matches input, `clinic_id` is the singleton.
- After `PATCH /admin/doctors/:id {active: false}` on a doctor with a future Scheduled appointment, confirm `doctor.active = false` in the DB and the future appointment is still `Scheduled` (deactivate does not block; F-18).
- After `PUT /admin/doctors/:id/branches {branch_ids: [<west>]}` (was previously `<east>`), confirm the old `doctor_branch` row is gone and a new one points to `<west>`.

## Suggested Review Order

**Migration (start here — the schema change is the load-bearing piece)**

- 0016 adds `clinic_id`, `email`, `active` to `doctor` using the codebase's defensive add-then-backfill-then-constrain pattern (matches 0004 and 0013 and 0014). Idempotent throughout.
  [`0016_doctor_lifecycle.sql:1`](../../apps/api/db/migrations/0016_doctor_lifecycle.sql#L1)
- Migration tests pin column existence + default values + uniqueness + idempotency.

**Route layer (validation + transaction)**

- PUT `/branches` runs inside a transaction with `SELECT ... FOR UPDATE` on the doctor row to prevent a concurrent PUT-vs-PATCH interleaving (deactivate-during-replace would otherwise be lost).
  [`admin-branch-doctors.ts:`](../../apps/api/src/routes/admin-branch-doctors.ts) (search for `PUT`)
- PATCH `/doctors/:id` rejects unknown top-level fields with `400 unknown_field + fields[]` (E1-S1 convention).
  [`admin-branch-doctors.ts:`](../../apps/api/src/routes/admin-branch-doctors.ts) (search for `unknown_field`)
- Deactivate emits a `warning` field on the response, not a 409 (F-18 explicit).

**Global error handler (cross-cutting from E1-S1)**

- Malformed JSON continues to return `400 invalid_json` (E1-S1 P-A5).
  [`app.ts:91`](../../apps/api/src/app.ts#L91)

**Mount order**

- New router is a sibling under the existing `adminScope` gate.
  [`app.ts:84`](../../apps/api/src/app.ts#L84)

**Tests (matrix coverage)**

- DB-pinning for create (response + DB row match on `active`, `email`, `clinic_id`).
- DB-pinning for branch-replace (old rows gone, new rows present).
- DB-pinning for deactivate-warning (doctor `active=false` AND future appointment still Scheduled).
- Email uniqueness conflict on create.
- Empty branch_ids rejected on create AND on PUT.
- Unknown branch_id rejected on create AND on PUT.
- Filter combinations on GET.
- Validation order pinning.