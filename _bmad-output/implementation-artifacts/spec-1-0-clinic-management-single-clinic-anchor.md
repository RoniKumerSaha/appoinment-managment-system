---
title: 'E1-S0a — Clinic singleton enforcement (DB-layer)'
type: 'feature'
created: '2026-09-14'
status: 'done'
review_loop_iteration: 1
baseline_commit: '3f746c1d6a951136bdc0a8b9c07297e51034fa0e'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-2-data-model-migrations.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-5-seed-data-role-fixtures.md'
---

## Re-approved after 2026-09-14 code review (review_loop_iteration=1)

0 intent_gaps, 0 bad_spec findings, 3 patches applied, 4 deferrals, 0 rejected-as-noise.

Patches:
- P1 — `migrations.test.ts:147-200` now also asserts `confdeltype='r'` on the FK (was
  previously only checking `contype='f'`; an ON DELETE RESTRICT regression would
  silently fall back to NO ACTION `'a'` with no test failure). Code change is the
  one query parameter (`confdeltype`) plus the new `assert.equal(rows[0]!.confdeltype, 'r', ...)`
  call, with a 7-line comment explaining the code table.
- P2 — New test `'E1-S0a: backfill UPDATE populates clinic_id on a pre-existing
  NULL admin row'` exercises the backfill `UPDATE admin_user SET clinic_id =
  (SELECT id FROM clinic LIMIT 1) WHERE clinic_id IS NULL` on a row whose
  `clinic_id` is genuinely NULL. The shared Testcontainers DB has already been
  migrated by 0013, so the test temporarily drops NOT NULL, inserts a NULL row,
  runs the backfill + SET NOT NULL, asserts the row was anchored to the
  singleton clinic, deletes the row, and confirms NOT NULL is restored.
- P3 — Migration comment updated to disambiguate "partial unique index" vs
  "expression unique index". `idx_clinic_singleton` is an expression unique
  index (no WHERE clause; index expression is the constant `(true)`). Contrast
  `idx_appointment_patient_doctor_scheduled` (migration 0008) which IS partial.

Deferrals (deferred-work.md):
- W29 — Explicit FK constraint naming on `admin_user.clinic_id`
- W30 — Concurrent second `INSERT INTO clinic` race
- W31 — Pre-migration state with zero clinic rows
- W32 — `idx_clinic_singleton` is unique but not partial (terminology drift)

Verification: `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/migrations.test.ts` → 10/10 green. Full suite 206/209 (3 pre-existing baseline failures in `auth.test.ts` × 2 + `log.test.ts` × 1, unchanged from `baseline_commit` `3f746c1d`).

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 0 shipped a `clinic` table at the root of the multi-tenant-ready data model (`apps/api/db/migrations/0001_init_bootstrap.sql:17-21`), but the single-clinic-per-deployment invariant the product ships under is enforced nowhere. A second `clinic` row with a different name would silently `INSERT`. The admin entity has no FK link to `clinic`, so even an admin-row-only deployment couldn't answer "which clinic is this admin scoped to?".

**Approach:** Add migration `0013_clinic_anchor.sql` that (a) creates a partial unique index `idx_clinic_singleton ON clinic((true))` so a second `INSERT` raises `23505` at the DB layer, and (b) adds `admin_user.clinic_id uuid REFERENCES clinic(id)` (NOT NULL ON DELETE RESTRICT) so every admin row is anchored to the singleton clinic. Existing admin rows (the seed provisions `admin-main`) get backfilled from the singleton before the NOT NULL constraint is set.

## Boundaries & Constraints

**Always:**
- Singleton enforcement is the partial unique index `((true))`. No app-layer check, no trigger. First such pattern in the migration set.
- `admin_user.clinic_id` matches the `branch.clinic_id` convention: NOT NULL ON DELETE RESTRICT.
- Index is created AFTER the backfill UPDATE so re-running the forward migration doesn't violate the index on the singleton row.
- Backfill query targets only rows where `clinic_id IS NULL` (defensive — seed shouldn't insert NULLs, but the migration must succeed if a pre-existing admin row slipped through some other path).
- Migration is paired with `down/0013_clinic_anchor.down.sql`. Drop order: index → FK constraint → column.
- The forward migration is one multi-statement file (`pool.query(sql)` runner per W14 in deferred-work.md). `BEGIN/COMMIT` is NOT used — the runner manages the implicit transaction.
- The seed (`01_minimum.ts`) and fixtures are unchanged in this story — they already create exactly one clinic row.

**Ask First:** _None — the schema choice (partial unique index) was decided in planning on 2026-09-14._**

**Never:**
- No `clinic_id` JWT claim — admin scoping lives at `scope: 'clinic'` per AD-8. The `admin_user.clinic_id` column is a DB-link only; it surfaces in API responses but is not a JWT field.
- No app-layer COUNT(*) backstop. The index is the source of truth.
- No new grants, extensions, or triggers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Migration applies to fresh DB | empty `clinic` and `admin_user` tables | `0013_clinic_anchor.sql` exits 0; `admin_user.clinic_id` column exists (nullable at first); index does not yet exist | Subsequent ALTER COLUMN SET NOT NULL triggers backfill UPDATE then NOT NULL constraint |
| Migration applies to seeded DB | one clinic row + one admin row (from `01_minimum.ts`) | Backfill UPDATE sets `admin_user.clinic_id = <singleton>`; ALTER COLUMN SET NOT NULL succeeds; index then created | All in one transaction |
| Second `INSERT INTO clinic` after migration | `INSERT INTO clinic (name) VALUES ('a'); INSERT INTO clinic (name) VALUES ('b');` | First succeeds; second raises `23505` (unique_violation) via `idx_clinic_singleton` | Caller surfaces the error to the operator |
| Migration rerun on already-migrated DB | `0013_clinic_anchor.sql` runs again | Idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, the UPDATE is a no-op when all rows have `clinic_id IS NOT NULL` | Migration runner exits 0 |
| Down + forward round-trip | `down` then `db:migrate` again | State matches pre-down: `admin_user.clinic_id` exists, NOT NULL; index exists | Forward path recomputes backfill + index |

## Code Map

- `apps/api/db/migrations/0013_clinic_anchor.sql` (NEW) — adds `admin_user.clinic_id`, backfills, NOT NULL, index.
- `apps/api/db/migrations/down/0013_clinic_anchor.down.sql` (NEW) — drops index, FK, column.
- `apps/api/test/migrations.test.ts` (MODIFIED) — adds one test case: after `applyMigrations`, a second `INSERT INTO clinic (name) VALUES ('clinic-2')` raises a `23505` pg error. Mirrors the existing `pgcrypto-grants.test.ts` style at `apps/api/test/pgcrypto-grants.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/db/migrations/0013_clinic_anchor.sql` -- `ALTER TABLE admin_user ADD COLUMN clinic_id uuid REFERENCES clinic(id) ON DELETE RESTRICT;` then `UPDATE admin_user SET clinic_id = (SELECT id FROM clinic LIMIT 1) WHERE clinic_id IS NULL;` then `ALTER TABLE admin_user ALTER COLUMN clinic_id SET NOT NULL;` then `CREATE UNIQUE INDEX idx_clinic_singleton ON clinic((true));`. Use `ADD COLUMN IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` for idempotency.
- [x] `apps/api/db/migrations/down/0013_clinic_anchor.down.sql` -- `DROP INDEX IF EXISTS idx_clinic_singleton; ALTER TABLE admin_user DROP COLUMN IF EXISTS clinic_id;` (FK drops automatically with the column).
- [x] `apps/api/test/migrations.test.ts` -- append one test: with the full migration set applied, attempting `INSERT INTO clinic (name) VALUES ('clinic-2')` rejects with pg code `23505`.

**Acceptance Criteria:**
- Given a fresh DB, when migration `0013_clinic_anchor.sql` applies, then `\d admin_user` shows `clinic_id | uuid | not null` with the FK to `clinic(id)`.
- Given a fresh DB, when `INSERT INTO clinic (name) VALUES ('a'), ('b');` runs after migration, then the second insert raises `23505`.
- Given the seeded DB (one clinic row, one admin row), when the migration runs, then `SELECT clinic_id FROM admin_user WHERE sub = 'admin-main'` returns the singleton clinic id.
- Given the migration's down path runs, when re-applied forward, then `admin_user.clinic_id` is restored to NOT NULL and `idx_clinic_singleton` exists.
- Given `pnpm --filter @clinic/api run db:migrate` runs twice on a fresh DB, the second invocation exits 0 (idempotency).

## Spec Change Log

<!-- Empty until first bad_spec loopback. -->

## Verification

**Commands:**
- `pnpm --filter @clinic/api run db:migrate` -- expected: exit 0; psql `\d admin_user` shows `clinic_id` as `not null`.
- `psql … -c "INSERT INTO clinic (name) VALUES ('clinic-2');"` after migration -- expected: `ERROR: duplicate key value violates unique constraint "idx_clinic_singleton"`.
- `pnpm --filter @clinic/api run db:migrate down` then `db:migrate` -- expected: round-trip OK.
- `pnpm --filter @clinic/api test migrations.test.ts` -- expected: green; the new `23505` test case included.
</content>
</invoke>