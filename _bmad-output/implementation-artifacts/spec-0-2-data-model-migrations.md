---
title: 'E0-S2 — Data model & migrations'
type: 'feature'
created: '2026-09-10'
status: 'in-progress'
review_loop_iteration: 1
baseline_commit: '881f5b8'  # E0-S1 done
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/triage-e0-s1-blind-hunter.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates. Re-approved after 2026-09-10 code review (5 decisions resolved, 16 patches applied).">

## Intent

**Problem:** E0-S1 shipped a narrow seed-only schema (`clinic`, `branch`, `doctor`,
`doctor_branch`, `receptionist`, `admin_user`, `patient`) sufficient only for the
E0-S1 minimum seed. The architecture spine (Architecture §4) and PRD §8 describe the
**full** entity set the platform depends on — `AppointmentType`, `DoctorSchedule`,
`DoctorBlock`, `Appointment`, `AppointmentAudit`, `OTPVerification` — with invariants
the booking and recurring epics cannot negotiate around at write time. Without the
full schema landed with the right indexes, triggers, and Postgres-16 primitives,
every later epic's first commit will be a schema migration, and the seams
(`EXCLUDE USING gist`, `tstzrange`, partial unique indexes, append-only audit) will
drift from spec to implementation.

**Approach:** Add a forward-only migration set under `apps/api/db/migrations/` that:

1. Creates the `pgcrypto`, `citext`, and `btree_gist` extensions so `gen_random_uuid()`,
   case-insensitive unique emails, and GIST equality-on-uuid columns all work.
2. Defines an `app_now()` function (returns `timestamptz` in UTC) and a shared
   `set_updated_at()` trigger function (must `RETURN NEW`).
3. Widens the E0-S1 entities with `updated_at` columns and shared trigger; adds
   stable unique keys (`email citext UNIQUE` on staff tables, `phone_number` stays
   UNIQUE on patient) so the E0-S5 seed no longer relies on string-name uniqueness.
4. Adds the explicit B-tree indexes for hot read paths
   (`branch(clinic_id)`, `doctor_branch(branch_id)`, `patient(phone_number)`,
   `(patient_phone, status, start_datetime)`, `(doctor_id, branch_id, start_datetime)`).
5. Creates the new entities (`AppointmentType`, `DoctorSchedule`, `DoctorBlock`,
   `Appointment`, `AppointmentAudit`, `OTPVerification`) with status enums, FK
   integrity (`ON DELETE RESTRICT` on all parent FKs, `NO ACTION DEFERRABLE INITIALLY
   DEFERRED` on `appointment_audit.appointment_id`), polymorphic `created_by` with
   explicit column shape + CHECK, and the Postgres-16 `EXCLUDE USING gist` constraint
   from Architecture §4.
6. Ships a DB-touching test layer (Testcontainers) so the seed snapshot-then-replay
   test the E0-S1 spec promised can finally run as a live assertion (closes
   deferred-work item B2). Container is stopped on every callback exit (normal or
   thrown); CI asserts no orphans.

The migration runner is `node-pg-migrate` (raw SQL, no ORM). Each migration has a
matching `down` step in `apps/api/db/migrations/down/<NNNN>_<name>.down.sql` (manual
application path — `node-pg-migrate` runs forward by default; the spec asserts
down-migrations are written, not that they run automatically). Down-order is fixed:
constraints → indexes → columns → enums → tables.

## Boundaries & Constraints

**Always:**
- `pgcrypto`, `citext`, and `btree_gist` extensions created in the first E0-S2
  migration. `gen_random_uuid()` is the only ID generator; no app-side UUID v4.
- All timestamps stored UTC. `app_now()` is `LANGUAGE sql STABLE RETURNS timestamptz`
  with body `SELECT now()` (already timestamptz in UTC — `now() AT TIME ZONE 'UTC'`
  is rejected because it returns `timestamp without time zone` and re-interprets
  wrongly when stored back into a `timestamptz` column).
- `updated_at timestamptz NOT NULL DEFAULT app_now()` is added to every mutable
  entity. `set_updated_at()` trigger fires `BEFORE UPDATE` and must `RETURN NEW`.
  Existing E0-S1 rows are backfilled with `updated_at = created_at` in the same
  migration before the trigger attaches.
- `created_by` is `text NOT NULL CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]{1,256}$')`
  on `appointment`, `appointment_type`, `doctor_schedule`, `doctor_block`. (Not
  FK-enforced to staff/patient — cross-table integrity is app-layer.)
- `Appointment.status` enum is exactly `{Scheduled, Completed, Cancelled, No-show}`.
  No other values. Enforced at the DB layer.
- `Appointment` rows are NEVER deleted — `Cancelled` is the terminal state.
  `appointment_audit` is append-only: a `BEFORE UPDATE OR DELETE` trigger that
  `RAISE EXCEPTION 'appointment_audit_is_append_only'` is the primary guard
  (REVOKE is insufficient because superuser bypasses it). Both UPDATE and DELETE
  are blocked.
- Postgres-16 booking concurrency primitives land here even though app-level writers
  ship in E2/E3/E6:
  - `EXCLUDE USING gist (doctor_id WITH =, branch_id WITH =, tstzrange(start_datetime, end_datetime, '[)') WITH &&) WHERE (status = 'Scheduled')`
  - Partial unique index `(patient_phone, doctor_id) WHERE status='Scheduled'` —
    per-doctor (Architecture §4 invariant 3; honors FR-028 "patient may have future
    appointments with multiple doctors"). Cross-doctor time-overlap is app-layer
    (E3-S2).
  - Indexes `(patient_phone, status, start_datetime)` and
    `(doctor_id, branch_id, start_datetime)` per Architecture §6.
- `branch` table exists from E0-S1 `0001_init_bootstrap.sql`; E0-S2 widens with
  `updated_at` + trigger. `branch.tz` stays `text NOT NULL` — IANA-validity is
  app-layer (E1) because Postgres has no built-in IANA-tz validator.
- A DB-touching test layer: `apps/api/test/db/` exposes a `withTestDb(fn)` helper
  that spins up a Postgres 16 container (Testcontainers, committed — `docker-compose`
  was considered and rejected), runs migrations, yields `{ pool, close }`. The
  container is always stopped on callback exit (try/finally inside `withTestDb`).
  CI uses a single shared container per worker via a `globalSetup` shim so
  `migrations.test.ts`, `invariants.test.ts`, and `seed.test.ts` do not each
  re-boot Postgres.
- Migrations are forward-only by default but every `up` migration has a corresponding
  `down.sql` written and reviewed (deferring down-application is acceptable, but
  the SQL must exist for emergencies). Down-order is fixed: drop constraints →
  drop indexes → drop columns → drop enums → drop tables.

**Ask First:**
- Migration filename convention — **one migration per concern** is committed:
  `0002_extensions`, `0003_functions_triggers`, `0004_widen_seed_entities`,
  `0005_appointment_type`, `0006_doctor_schedule`, `0007_doctor_block`,
  `0008_appointment`, `0009_appointment_audit`, `0010_otp_verification`. (9
  migrations, files numbered 0002 through 0010 — the previous two `0002_*` collision
  was the highest-priority review finding and is fixed by renumbering.)

**Never:**
- No ORM runtime (Drizzle raw-SQL is allowed; Prisma query engine is not — see E0-S1
  spec).
- No deletion of `Appointment` rows (no `DELETE` policy at all, including cascade).
  All FKs to clinic/branch/doctor/patient use `ON DELETE RESTRICT` to make this
  fail-loud if violated.
- No appointment write logic — that's E3 (booking core).
- No auth writes — that's E0-S3 (and `0010_grants.sql` is removed entirely; E0-S3
  owns the full grant model).
- No seed widening — that's E0-S5 (just provisions new entities; the schema lands here).
- No `EXCLUDE USING gist` on tables other than `Appointment` for now — KISS.
- No `ALTER TABLE … ADD CONSTRAINT … NOT VALID` shortcuts — every constraint is
  validated at migration time.
- No volatile expressions (`now()`, etc.) in partial-index predicates — Postgres
  rejects them. The `otp_verification` "only one outstanding OTP" invariant is
  enforced by `UNIQUE (phone_e164)` plus an E0-S4 cleanup job (not a partial
  index).

## I/O & Edge-Case Matrix

| # | Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|----------|--------------|---------------------------|----------------|
| AC-1 | Fresh DB | `pnpm db:migrate` against empty Postgres | All 9 E0-S2 migrations apply; E0-S1 schema is widened, new tables created, indexes built, constraint created without error | Migration runner exits 0; `.applied.json` records applied migrations |
| AC-2 | Two `Scheduled` same doctor+branch+window | Second `INSERT INTO appointment` (sequential) | DB rejects with `23P01` (exclusion_violation) | `invariants.test.ts` asserts the violation |
| AC-3 | Two `Scheduled` same patient+doctor+window | Second `INSERT INTO appointment` for same `(patient_phone, doctor_id)` | DB rejects via partial unique `(patient_phone, doctor_id) WHERE status='Scheduled'` | `invariants.test.ts` asserts the violation |
| AC-4 | Two `Scheduled` same patient across DIFFERENT doctors | Two `INSERT`s for same `patient_phone`, different `doctor_id` | Both succeed (per-doctor invariant; honors FR-028) | `invariants.test.ts` asserts both insert cleanly |
| AC-5 | Cancelled + rebook same slot | First row status='Cancelled'; new row same window | New row inserts cleanly — exclusion + partial unique are both `WHERE status='Scheduled'` | `invariants.test.ts` asserts rebooking |
| AC-6 | Concurrent inserts same slot | Two parallel connections, each `BEGIN; INSERT; COMMIT` | Exactly one succeeds; the other rejects with `23P01` or serialization failure | `invariants.test.ts` asserts under `SERIALIZABLE` isolation |
| AC-7 | `updated_at` mutation | `UPDATE` any mutable entity after a sleep | `updated_at > created_at`; trigger fired | `invariants.test.ts` asserts trigger fires |
| AC-8 | `updated_at` set on INSERT | `INSERT` row with no `updated_at` value | `updated_at = created_at` (DEFAULT applies) | `invariants.test.ts` asserts default |
| AC-9 | Seed run twice | `withTestDb()` boots Postgres; `seed()` called twice | `(table, pk, email/phone)` set identical between runs (row-count alone is insufficient — see P12) | `seed.test.ts` (rewritten) compares sets, not counts |
| AC-10 | `created_by` bad prefix | `INSERT` with `created_by = 'foo:bar'` | DB rejects via CHECK violation | `invariants.test.ts` asserts |
| AC-11 | `created_by` null | `INSERT` with `created_by = NULL` | DB rejects via NOT NULL | `invariants.test.ts` asserts |
| AC-12 | Status outside enum | `INSERT` with `status='Rescheduled'` | DB rejects (enum violation, 22P02) | `invariants.test.ts` asserts |
| AC-13 | UPDATE on `appointment_audit` | `UPDATE appointment_audit SET payload='{}'` | DB rejects via `BEFORE UPDATE OR DELETE` trigger (RAISE EXCEPTION) | `invariants.test.ts` asserts |
| AC-14 | DELETE on `appointment_audit` | `DELETE FROM appointment_audit WHERE id=...` | DB rejects via same trigger | `invariants.test.ts` asserts |
| AC-15 | Extensions present | Query `pg_extension` | Rows include `pgcrypto`, `citext`, `btree_gist` | `migrations.test.ts` asserts |
| AC-16 | GIST exclusion index kind | Query `pg_constraint` for the exclusion | `contype='x'` AND `amname='gist'` (NOT a B-tree unique) | `migrations.test.ts` asserts |
| AC-17 | `[)`-adjacent Scheduled rows | Two `[10:00,10:30)` and `[10:30,11:00)` Scheduled for same doctor+branch | Both commit — half-open ranges don't overlap | `migrations.test.ts` inserts and asserts |
| AC-18 | `withTestDb` cleanup | Run `withTestDb`, throw inside callback | Postgres container is stopped (no orphan) | CI asserts via `docker ps` count before/after |

## Code Map

- `apps/api/db/migrations/0002_extensions.sql` — `pgcrypto`, `citext`, `btree_gist`.
- `apps/api/db/migrations/0003_functions_triggers.sql` — `app_now()` (LANGUAGE sql
  STABLE RETURNS timestamptz, body `SELECT now()`), `set_updated_at()` trigger
  function (BEFORE UPDATE, must RETURN NEW). Backfill `updated_at = created_at`
  for existing E0-S1 rows happens here too (in `0004_widen_seed_entities.sql`,
  not here — see that file).
- `apps/api/db/migrations/0004_widen_seed_entities.sql` — adds `updated_at timestamptz
  NOT NULL DEFAULT app_now()` to `clinic`, `branch`, `doctor`, `doctor_branch`,
  `receptionist`, `admin_user`, `patient`. Backfills `updated_at = created_at` for
  existing rows before attaching `set_updated_at` trigger. Adds `email citext NOT
  NULL UNIQUE` to `receptionist` and `admin_user` (requires `citext` from
  `0002_extensions.sql`). Adds B-tree indexes: `idx_branch_clinic_id`,
  `idx_doctor_branch_branch_id`, `idx_patient_phone_number`.
- `apps/api/db/migrations/0005_appointment_type.sql` — `appointment_type` table:
  `id`, `clinic_id` (FK ON DELETE RESTRICT), `name`, `duration_minutes int CHECK
  (duration_minutes BETWEEN 5 AND 480)`, `is_active bool DEFAULT true`, `created_at`,
  `updated_at`, `created_by` (text NOT NULL, polymorphic CHECK).
- `apps/api/db/migrations/0006_doctor_schedule.sql` — `doctor_schedule` table:
  `id`, `doctor_id` (FK ON DELETE RESTRICT), `branch_id` (FK ON DELETE RESTRICT),
  `day_of_week smallint CHECK (day_of_week BETWEEN 0 AND 6)`, `start_time time`,
  `end_time time CHECK (end_time > start_time)`, `effective_from date`, `effective_to
  date NULL CHECK (effective_to IS NULL OR effective_to >= effective_from)`,
  `created_at`, `updated_at`, `created_by`. (No exclusion constraint — overlap
  enforcement is app-layer per W4 deferred.)
- `apps/api/db/migrations/0007_doctor_block.sql` — `doctor_block` table: `id`,
  `doctor_id` (FK ON DELETE RESTRICT), `branch_id` (FK ON DELETE RESTRICT),
  `start_datetime timestamptz`, `end_datetime timestamptz CHECK (end_datetime >
  start_datetime)`, `reason text`, `created_at`, `updated_at`, `created_by`. (No
  block-vs-appointment overlap constraint — that is E2-S2's concern per W5
  deferred.)
- `apps/api/db/migrations/0008_appointment.sql` — `appointment` table: `id`,
  `clinic_id` (FK ON DELETE RESTRICT), `branch_id` (FK ON DELETE RESTRICT),
  `doctor_id` (FK ON DELETE RESTRICT), `patient_phone text NOT NULL`,
  `appointment_type_id` (FK NULL — backfilled by E3, future migration flips to
  NOT NULL after E3 backfills), `start_datetime timestamptz`, `end_datetime
  timestamptz CHECK (end_datetime > start_datetime)`, `status appointment_status
  NOT NULL DEFAULT 'Scheduled'`, `created_by text NOT NULL` (polymorphic, CHECKed
  prefix), `created_at`, `updated_at`. Plus the `appointment_status` enum type
  (`CREATE TYPE appointment_status AS ENUM ('Scheduled','Completed','Cancelled','No-show')`),
  the partial unique index `(patient_phone, doctor_id) WHERE status='Scheduled'`,
  the GIST exclusion constraint (requires `btree_gist` from 0002), and the two
  read-path B-tree indexes `(patient_phone, status, start_datetime)` and
  `(doctor_id, branch_id, start_datetime)`.
- `apps/api/db/migrations/0009_appointment_audit.sql` — `appointment_audit` table:
  `id`, `appointment_id` (FK NULL, `ON DELETE NO ACTION DEFERRABLE INITIALLY
  DEFERRED`), `actor_role text NOT NULL`, `actor_id text NOT NULL`, `event text
  NOT NULL`, `payload jsonb`, `created_at`. Append-only: NO `updated_at` column,
  trigger `reject_audit_mutation` fires `BEFORE UPDATE OR DELETE` and RAISE
  EXCEPTION 'appointment_audit_is_append_only'. (REVOKE alone is insufficient
  because superuser bypasses it; the trigger is the primary guard.)
- `apps/api/db/migrations/0010_otp_verification.sql` — `otp_verification` table:
  `id`, `phone_e164 text NOT NULL`, `code_hash text NOT NULL CHECK (length(code_hash)
  BETWEEN 32 AND 256)`, `expires_at timestamptz NOT NULL`, `attempts int NOT NULL
  DEFAULT 0 CHECK (attempts >= 0)`, `locked_until timestamptz NULL`, `created_at`.
  `UNIQUE (phone_e164)` (one row per phone ever; "only one outstanding" is enforced
  by an E0-S4 cleanup job — partial-index `WHERE expires_at > now()` is rejected
  by Postgres because `now()` is volatile, so we use plain UNIQUE instead). Index
  on `(phone_e164, created_at DESC)`.
- `apps/api/db/migrations/down/` — paired `down.sql` for every numbered migration.
  Drop-order is fixed: constraints → indexes → columns → enums → tables.
- `apps/api/test/db/withTestDb.ts` — Testcontainers helper. `withTestDb(fn)` boots
  `postgres:16-alpine`, runs migrations, yields `{ pool, close }`. Container is
  stopped via try/finally on every callback exit (normal or thrown). Uses a single
  shared container per worker via `globalSetup` shim so multiple test files don't
  each re-boot Postgres.
- `apps/api/test/setup/globalSetup.ts` — boots one Postgres container for the
  worker, applies migrations, hands the pool to test files via env var.
- `apps/api/test/seed.test.ts` — **rewritten** to use `withTestDb` + globalSetup.
  Runs `seed()` twice; asserts the `(table, pk, email_or_phone)` set is identical
  between runs (not just row counts — see P12; row counts alone let a
  TRUNCATE-and-reinsert seed pass).
- `apps/api/test/migrations.test.ts` — asserts every named object exists: extensions
  (`pgcrypto`, `citext`, `btree_gist` rows in `pg_extension`), `app_now` function,
  every named index/constraint/enum type, GIST exclusion `contype='x'` AND
  `amname='gist'`, plus the `[)`-adjacent Scheduled insert (AC-17).
- `apps/api/test/invariants.test.ts` — DB-touching test that exercises every row
  in the I/O & Edge-Case Matrix (AC-2 through AC-14, AC-16, AC-17).

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/db/migrations/0002_extensions.sql` — `pgcrypto`, `citext`, `btree_gist`
- [ ] `apps/api/db/migrations/0003_functions_triggers.sql` — `app_now()`, `set_updated_at()`
- [ ] `apps/api/db/migrations/0004_widen_seed_entities.sql` — `updated_at` + backfill + `email citext` + B-tree indexes
- [ ] `apps/api/db/migrations/0005_appointment_type.sql`
- [ ] `apps/api/db/migrations/0006_doctor_schedule.sql`
- [ ] `apps/api/db/migrations/0007_doctor_block.sql`
- [ ] `apps/api/db/migrations/0008_appointment.sql` — table, enum, GIST exclusion, partial unique, indexes
- [ ] `apps/api/db/migrations/0009_appointment_audit.sql` — append-only trigger
- [ ] `apps/api/db/migrations/0010_otp_verification.sql` — plain UNIQUE (no partial)
- [ ] `apps/api/db/migrations/down/<NNNN>_<name>.down.sql` — paired down for every numbered migration
- [ ] `apps/api/test/db/withTestDb.ts` — Testcontainers helper with cleanup contract
- [ ] `apps/api/test/setup/globalSetup.ts` — shared container per worker
- [ ] `apps/api/test/migrations.test.ts` — asserts every named object exists
- [ ] `apps/api/test/invariants.test.ts` — DB-touching Architecture §4 invariants
- [ ] `apps/api/test/seed.test.ts` — rewritten as live set-equality test
- [ ] CI: add a `db:test` job that runs `migrations.test.ts` + `invariants.test.ts` + `seed.test.ts` against Testcontainers; assert `docker ps` count unchanged after suite

**Acceptance** (every row in the I/O matrix is a hard pass/fail bullet):

- **AC-1** — `pnpm db:migrate` against empty Postgres succeeds; all 9 migrations
  apply cleanly; runner exits 0.
- **AC-2** — Two sequential `INSERT`s into `appointment` with same `(doctor_id,
  branch_id, time window, status='Scheduled')` → second rejects with `23P01`
  (exclusion_violation).
- **AC-3** — Two sequential `INSERT`s with same `(patient_phone, doctor_id,
  status='Scheduled')` → second rejects via partial unique.
- **AC-4** — Two `INSERT`s for same `patient_phone`, different `doctor_id`, both
  `Scheduled` → both succeed.
- **AC-5** — Cancelled + rebook same slot → new row inserts cleanly.
- **AC-6** — Two parallel connections, each `BEGIN; INSERT; COMMIT` for same slot
  under `SERIALIZABLE` isolation → exactly one succeeds.
- **AC-7** — `UPDATE` any mutable entity after sleep → `updated_at > created_at`.
- **AC-8** — `INSERT` row with no `updated_at` value → `updated_at = created_at`.
- **AC-9** — `seed.test.ts` boots Postgres, runs `seed()` twice, asserts
  `(table, pk, email_or_phone)` set identical between runs.
- **AC-10** — `INSERT` with `created_by = 'foo:bar'` → rejects via CHECK.
- **AC-11** — `INSERT` with `created_by = NULL` → rejects via NOT NULL.
- **AC-12** — `INSERT` with `status='Rescheduled'` → rejects (enum, 22P02).
- **AC-13** — `UPDATE appointment_audit SET payload='{}'` → rejects via trigger.
- **AC-14** — `DELETE FROM appointment_audit` → rejects via same trigger.
- **AC-15** — `migrations.test.ts` asserts `pg_extension` includes `pgcrypto`,
  `citext`, `btree_gist`.
- **AC-16** — `migrations.test.ts` asserts the Appointment exclusion `contype='x'`
  AND `amname='gist'` (not a B-tree unique).
- **AC-17** — `migrations.test.ts` inserts two `[)`-adjacent Scheduled rows for
  same doctor+branch → both commit.
- **AC-18** — `withTestDb` cleanup: container stopped on callback exit; CI asserts
  `docker ps` count unchanged after suite.
- **AC-19** — `pnpm -w test` runs all 3 DB-touching suites + the 5 E0-S1 suites;
  all green.
- **AC-20** — Triage items A1–A6 from
  `_bmad-output/implementation-artifacts/triage-e0-s1-blind-hunter.md` are all
  closed by the migrations listed above.

## Out of Scope (deferred to later stories)

- App-level write paths (booking, OTP send, recurring) — E0-S3 / E0-S4 / E2 / E3 / E4.
- Full RBAC grant model — removed from this spec; E0-S3 owns it (was
  `0010_grants.sql`, now deferred).
- Audit retention / cold-storage (Architecture §9.1) — schema is ready; ops policy
  ships later. Audit tamper-evidence (prev_hash / hash chain) deferred.
- Patient phone E.164 normalization — the column is `text` for now; E4-S1 enforces
  the format at write time.
- Branch tz IANA-validity — DB stores the string; app-level validation lands in E1
  (branch management). Postgres has no built-in IANA-tz validator.
- `DoctorSchedule` overlap — app-layer (E2-S2).
- `DoctorBlock` vs `Appointment` overlap — E2-S2 (block creation) owns the
  constraint.
- `DoctorPatientLink` entity — E3 (booking core) creates the row on first booking.
- Testcontainers in CI cost (~5s per build) — accepted for E0-S2; revisit if CI
  budget tightens.

</frozen-after-approval>

### Review Findings (2026-09-10 code review)

#### decision-needed (5) — RESOLVED

- [x] [Review][Decision] D1 — Wrong patient-uniqueness invariant. **Resolved:** per-doctor `(patient_phone, doctor_id) WHERE status='Scheduled'`. Spec patch pending.
- [x] [Review][Decision] D2 — I/O matrix rows promoted to Acceptance bullets. **Resolved:** all 8 promoted. Spec patch pending.
- [x] [Review][Decision] D3 — `0010_grants.sql` content. **Resolved:** removed from Code Map + Tasks; deferred to E0-S3. Spec patch pending.
- [x] [Review][Decision] D4 — OTP partial unique volatile predicate. **Resolved:** replaced with plain `UNIQUE (phone_e164)` + cleanup job. Spec patch pending.
- [x] [Review][Decision] D5 — Testcontainers vs docker-compose. **Resolved:** Testcontainers committed. Spec patch pending.

#### patch (16) — APPLIED

- [x] [Review][Patch] P1 — Duplicate migration number: `0002_extensions.sql` and `0002_functions.sql`. Renumbered second to `0003_functions_triggers.sql`.
- [x] [Review][Patch] P2 — Spec says "9 migrations" but Code Map listed 10 files. Count corrected to 9.
- [x] [Review][Patch] P3 — E0-S1 baseline pinned: Code Map notes `branch` table exists from `0001_init_bootstrap.sql`.
- [x] [Review][Patch] P4 — `btree_gist` added to `0002_extensions.sql`.
- [x] [Review][Patch] P5 — `AppointmentAudit` BEFORE UPDATE OR DELETE trigger added to `0009_appointment_audit.sql`.
- [x] [Review][Patch] P6 — AC-14 (DELETE bullet) added to Acceptance.
- [x] [Review][Patch] P7 — `ON DELETE RESTRICT` specified for all parent FKs; `NO ACTION DEFERRABLE INITIALLY DEFERRED` on `appointment_audit.appointment_id`.
- [x] [Review][Patch] P8 — `created_by` shape: `text NOT NULL CHECK (created_by ~ '^(staff|patient):...')`. Tables carrying it enumerated.
- [x] [Review][Patch] P9 — `updated_at` semantics: `DEFAULT app_now()` on INSERT, `set_updated_at` trigger on UPDATE (returns NEW).
- [x] [Review][Patch] P10 — `Branch` table existence + widening enumerated in Code Map; IANA-validity removed from spec (deferred).
- [x] [Review][Patch] P11 — `app_now()` body changed to `SELECT now()`; STABLE volatility; correct timestamptz return.
- [x] [Review][Patch] P12 — `seed.test.ts` rewritten to compare `(table, pk, email/phone)` sets, not row counts.
- [x] [Review][Patch] P13 — AC-15 added: `migrations.test.ts` asserts extensions present.
- [x] [Review][Patch] P14 — AC-6 added: concurrent INSERTs under SERIALIZABLE.
- [x] [Review][Patch] P15 — AC-16/AC-17 added: GIST exclusion kind + `[)`-adjacent test.
- [x] [Review][Patch] P16 — AC-18 added: `withTestDb` cleanup + CI orphan assertion.

#### defer (7) — pre-existing or downstream-story concerns

- [x] [Review][Defer] W1 — `AppointmentAudit` tamper-evidence (`prev_hash` / hash chain) — defer to a future audit-hardening story. Pre-existing concern.
- [x] [Review][Defer] W2 — `DoctorPatientLink` entity missing — belongs in E3 (booking core). Pre-existing.
- [x] [Review][Defer] W3 — `AppointmentAudit.changed_by` mutator column — existing `actor_role`/`actor_id` cover this. Pre-existing.
- [x] [Review][Defer] W4 — `DoctorSchedule` overlap not DB-enforced — KISS, app-layer (E2-S2). Pre-existing.
- [x] [Review][Defer] W5 — `DoctorBlock` vs `Appointment` overlap not DB-enforced — E2-S2 owns block-creation constraint. Pre-existing.
- [x] [Review][Defer] W6 — `Branch.tz` IANA-validity cannot be expressed in pure SQL — E1 owns app-level validation. Pre-existing.
- [x] [Review][Defer] W7 — `pgcrypto` USAGE grant scope — E0-S3 grant model. Pre-existing.

#### dismiss (1)

- R1 — "No test for `apps/web/index.html` title" etc. — config-file existence is not a behavior. Closed.

#### Review metadata

- Layers run: blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor.
- Failed layers: 0.
- Raw findings: 69. After dedup: 30. After triage: 5 decision-needed + 16 patch + 7 defer + 1 dismiss.
- Critical finding: **D1** (wrong patient-uniqueness invariant — breaks FR-028 if implemented as written).
- Full report: `_bmad-output/implementation-artifacts/review-e0-s2-spec.md`.
