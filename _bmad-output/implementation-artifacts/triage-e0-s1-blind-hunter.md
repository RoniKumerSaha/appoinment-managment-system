# E0-S1 Blind-Hunter Triage — 2026-09-10

Triage of findings from `_bmad-output/implementation-artifacts/.blind-hunter-result.json`
(now archived by this triage doc — the raw artifact was an LLM review run after E0-S1
shipped). Findings grouped into three buckets: **(A) absorb into E0-S2**, **(B) absorb
into E0-S3 / E0-S5**, **(C) defer**.

Source artifacts:
- `apps/api/db/migrations/0001_init_bootstrap.sql` (E0-S1 schema, narrow seed-only)
- `apps/api/db/seeds/01_minimum.ts` (E0-S1 seed)
- `apps/api/src/db/pool.ts` (pg pool)
- `apps/api/test/seed.test.ts` (static seed idempotency contract)

---

## (A) Absorb into E0-S2 — Data model & migrations

These items are data-model concerns and land in E0-S2's scope (entities from PRD §8 +
invariants from Architecture §4). They are **NOT** retrofits to E0-S1; E0-S1 is closed.

### A1. Postgres extensions not created in 0001_init_bootstrap.sql
- **Finding:** migration uses `gen_random_uuid()` but never creates `pgcrypto` /
  `uuid-ossp`. First-run against a fresh DB will fail with
  `function gen_random_uuid() does not exist`.
- **Resolution:** E0-S2's `0002_extensions.sql` (or first migration) MUST `CREATE EXTENSION
  IF NOT EXISTS pgcrypto`. E0-S1's narrow seed schema can be kept as-is since it ships
  alongside a comment-only "would fail without extension" doc note, but the practical
  fix is the first E0-S2 migration.

### A2. No `updated_at` column / trigger on entities
- **Finding:** entities are immutable by accident; future mutations have no
  `updated_at` for audit / cache invalidation.
- **Resolution:** E0-S2 adds `updated_at timestamptz NOT NULL DEFAULT now()` on every
  mutable entity (`clinic`, `branch`, `doctor`, `doctor_branch`, `receptionist`,
  `admin_user`, `patient`, `appointment_type`, `doctor_schedule`, `doctor_block`,
  `appointment`) plus a shared `set_updated_at()` trigger function. `created_at`
  stays as-is.

### A3. Missing indexes for hot read paths
- **Finding:**
  - `branch(clinic_id)` — every branch lookup joins on clinic_id.
  - `doctor_branch(branch_id)` — receptionist at branch X needs to enumerate doctors.
  - `patient(phone_number)` — implicit UNIQUE alone is not enough; server-side phone
    filtering is hot.
- **Resolution:** E0-S2 adds explicit B-tree indexes:
  - `CREATE INDEX idx_branch_clinic_id ON branch(clinic_id);`
  - `CREATE INDEX idx_doctor_branch_branch_id ON doctor_branch(branch_id);`
  - `CREATE INDEX idx_patient_phone_number ON patient(phone_number);`

### A4. No partial GIST exclusion constraint on Appointment
- **Finding:** Architecture §4 mandates
  `EXCLUDE USING gist (doctor_id WITH =, branch_id WITH =, tstzrange(start_datetime, end_datetime, '[)') WITH &&) WHERE (status = 'Scheduled')`.
  E0-S1 doesn't ship Appointment at all — this lands with E0-S2.

### A5. No `tstzrange` / `now()` discipline documented
- **Finding:** Architecture §6 expects UTC at rest; E0-S1 schema uses `timestamptz` but
  no shared helper.
- **Resolution:** E0-S2 introduces `db/migrations/0002_functions.sql` with
  `CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz LANGUAGE sql STABLE AS
  $$ SELECT now() AT TIME ZONE 'UTC' $$;` so all entities can default to UTC explicitly.

### A6. Seed idempotency uses string-name uniqueness
- **Finding:** `receptionist` and `admin_user` have no stable scoping column; rename a
  row and the seed silently duplicates it. `WHERE NOT EXISTS (… full_name = …)` is a
  smell.
- **Resolution:** E0-S2 adds `email citext UNIQUE` (or stable `external_id text UNIQUE`)
  to `receptionist` and `admin_user`. E0-S5 re-keys the seed on those columns.

---

## (B) Absorb into E0-S3 / E0-S5

### B1. Pool lacks Postgres-16 knobs
- **Finding:** `pg.Pool` config doesn't set `application_name`, `statement_timeout`,
  `idle_in_transaction_session_timeout`. Architecture §6 promises booking-time
  transactions will be tolerated.
- **Resolution:** E0-S3 adds a `withPoolDefaults(opts)` wrapper that applies
  `application_name = 'clinic-api'`, `statement_timeout = '5s'`,
  `idle_in_transaction_session_timeout = '10s'`. E0-S1's pool is fine for /healthz +
  /readyz; tightening happens when real write traffic lands in E0-S3.

### B2. `seed.test.ts` is source-level only
- **Finding:** spec promises live snapshot-then-replay; E0-S1's test only regex-checks
  the source. Deferred-work already records this — confirmed.
- **Resolution:** E0-S5 introduces a Testcontainers / docker-compose Postgres in CI
  (or local dev) and converts `seed.test.ts` into a true snapshot equality test.

---

## (C) Defer

### C1. Blind-hunter noted "diff has no test for X" for many small files
- **Finding:** dozens of items like `no test for apps/web/index.html title`,
  `no test for apps/api/.eslintrc.cjs rule config`, `no test for pnpm-workspace.yaml
  workspace globs`, etc.
- **Resolution:** these are noise — a config file existing is not a behaviour that
  needs a test. The acceptance for E0-S1 was structural (CI green, lint/typecheck/test
  pass), not "every file has a unit test." Closed by triage.

### C2. Suggests CI lint for hex literals outside `tokens.css`
- **Finding:** currently a discipline, not a lint.
- **Resolution:** owned by E7-S1 (design system token wiring) per the planning
  artifacts. No action here.

### C3. Suggests `trace_id` log field, `ErrorEnvelope`, CORS, rate-limit
- **Finding:** all already in `deferred-work.md` (lines 1–14).
- **Resolution:** no new action — those items are owned by E0-S3 / E0-S6 / E1+.

---

## Summary

- **E0-S1 retroactively changed:** none. The spec is closed; scope discipline held.
- **E0-S2 must own:** A1, A2, A3, A4, A5, A6 (six items, all data-model).
- **E0-S3 / E0-S5 must own:** B1 (pool knobs), B2 (real seed test).
- **Closed as noise / already-tracked:** C1, C2, C3.

E0-S2 spec (next artifact to author) must include the six (A) items in its
"Boundaries & Constraints" and the A4 GIST exclusion constraint in its
"Code Map / migrations" section.
