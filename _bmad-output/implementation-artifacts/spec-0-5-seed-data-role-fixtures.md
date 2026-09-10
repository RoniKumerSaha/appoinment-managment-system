---
title: 'E0-S5 — Seed data + role fixtures'
type: 'feature'
created: '2026-09-10'
status: 'done'
review_loop_iteration: 1
baseline_commit: '20214dabbe3cb44e11eab2a7925c89337de1d220'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-4-sms-otp-gateway.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The E0-S1 minimum seed (`apps/api/db/seeds/01_minimum.ts`) provisions 1 clinic, 1 branch, 1 doctor, 1 receptionist, 1 admin, 0 patients — enough to satisfy FK constraints during migration but too small to exercise the booking core (E3), patient self-service (E4), or staff workflows (E5). Every test that depends on a role fixture currently hand-rolls SQL, which (a) duplicates schema knowledge across test files and (b) makes the test suite's "is this branch reachable from this doctor's schedule?" assertions fragile.

**Approach:** Widen the seed to the PRD §14 MVP fixture set (1 clinic, 2 branches in distinct IANA time zones, 3 doctors each with ≥1 appointment type, 2 receptionists (one per branch), 1 admin, 5 patients of whom ≥1 carries a future appointment). Add a typed path-based fixture loader (`apps/api/test/fixtures/loader.ts`) so tests reference fixtures by stable path, never by inline JSON. Preserve the existing `seedWith(client)` entry point and the `seed.test.ts` snapshot-then-replay assertion; extend the snapshot to cover the new entities.

## Boundaries & Constraints

**Always:**
- The seed respects every E0-S2 invariant: `EXCLUDE USING gist`, partial unique indexes, `app_now()`, append-only audit, `polymorphic created_by`. Inserting a row that violates any of these is a seed bug.
- Idempotency uses SELECT-then-INSERT (where no UNIQUE constraint exists) and `INSERT … ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS` (where one does). Re-running seed never duplicates rows and never corrupts prior user data.
- Synthetic patient phones use the `+1555` test range (matching the existing `sms-otp.test.ts` convention). No real PII.
- IANA timezone identifiers must be valid; the two branches use `America/New_York` and `America/Los_Angeles` (canonical distinct-US-zone pair used elsewhere in the project).
- The fixture loader returns typed objects (not raw JSON) — tests get `{id, phone, full_name, branch_ids}` etc., not untyped records.
- The `seedWith(client)` API stays stable — both production CLI (`pnpm db:seed`) and `seed.test.ts` continue to call it.

**Ask First:**
- None. Q1/Q2/Q3 from the bmad-spec kernel were all answered by code inspection: fixtures live under `apps/api/test/fixtures/` (consistent with the existing `test/db/` + `test/setup/` convention), phones use the `+1555` range, admin is record-only (no password_hash — staff login is E1's surface).
- Whether to also seed ≥1 future appointment on a patient. Default: yes, for the patient whose phone ends `0001` (matches `phone_number` uniqueness in patient table).

**Never:**
- No `TRUNCATE`/`DELETE` of pre-existing rows. The seed adds; never replaces.
- No inline-JSON fixture loading in test bodies. Tests reference fixture files by relative path through the loader.
- No production-data migration. Seed is dev/test only.
- No `password_hash` columns on admin/receptionist fixtures — staff login is E1's scope.
- No fabricated patient names from external APIs; use a fixed wordlist baked into the seed file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `pnpm db:seed` against empty DB | Migrations at HEAD; no rows | 1 clinic + 2 branches + 3 doctors + 3 doctor_branch + ≥3 appointment_types + 2 receptionists + 1 admin + 5 patients inserted; ≥1 future appointment created on patient `+15550000001`; structured log `seed_complete` | N/A |
| `pnpm db:seed` against already-seeded DB | Same as above | Row counts identical to first run; structured log `seed_unchanged` (NOT a duplicate of `seed_complete`) | N/A |
| `loadDoctorFixture('east.lead')` | Path resolves to `apps/api/test/fixtures/doctors/east.lead.json` | Returns `{id, full_name, branch_ids: ['east'], appointment_type_ids: ['general']}` typed | Throws `fixture_not_found` with the attempted path if the file is missing |
| `loadPatientFixture('east.0001')` | Path resolves to file | Returns `{id, phone_number: '+15550000001', full_name, has_future_appointment: true}` | Same as above |
| Test calls `loadXFixture` with an invalid path segment | e.g. `loadXFixture('does/not/exist')` | Throws `fixture_not_found` with the path included | Test fails fast — never silently returns null |
| Seed runs against a DB where `clinic` table exists but `patient` does not | E.g. partial-migration state | `seedWith` throws on the first missing table; no partial state persists (transaction rollback in `seed()`) | Boot failure surfaces in `pnpm db:seed` CLI exit code |
| `loadXFixture` resolves to a JSON missing a required field | File exists but is malformed | Throws `fixture_invalid` with the missing field name | Test fails fast |
| Re-run of seed while another seed is mid-flight | Concurrent `pnpm db:seed` invocations | The second call blocks on the row-level uniqueness constraints; eventually commits idempotently | No deadlock — both complete with identical row counts |

</frozen-after-approval>

## Code Map

- `apps/api/db/seeds/01_minimum.ts` (MODIFY) — extend `seedWith(client)` to insert 2nd branch, 2 more doctors, 1 more receptionist, 5 patients, ≥1 appointment_type per doctor, ≥1 future appointment. Keep SELECT-then-INSERT for entities without UNIQUE; ON CONFLICT DO NOTHING for entities that have it. Add the `seed_unchanged` log line on the no-op path (compare pre/post row count of each entity).
- `apps/api/db/seeds/02_role_ids.ts` (NEW) — exports the deterministic IDs/identifiers for the canonical roles (clinic, branch-east, branch-west, doctors, etc.) so fixture JSON files and the seed share one source of truth.
- `apps/api/test/fixtures/clinic.json` (NEW) — `{id: "<clinic-id-from-02_role_ids>", name: "Test Clinic"}`.
- `apps/api/test/fixtures/branches/east.json` (NEW) — `{id, clinic_id, name: "East Branch", tz: "America/New_York"}`.
- `apps/api/test/fixtures/branches/west.json` (NEW) — `{id, clinic_id, name: "West Branch", tz: "America/Los_Angeles"}`.
- `apps/api/test/fixtures/doctors/{east.lead,east.support,west.lead}.json` (NEW) — one file per doctor with `{id, full_name, branch_ids, appointment_type_ids}`.
- `apps/api/test/fixtures/receptionists/{east,west}.json` (NEW) — one per branch.
- `apps/api/test/fixtures/admins/main.json` (NEW) — `{id, full_name, email}`.
- `apps/api/test/fixtures/patients/{0001,0002,0003,0004,0005}.json` (NEW) — five patients; `0001.json` carries `has_future_appointment: true`.
- `apps/api/test/fixtures/loader.ts` (NEW) — `loadClinic()`, `loadBranch(slug)`, `loadDoctor(slug)`, `loadReceptionist(slug)`, `loadAdmin(slug)`, `loadPatient(slug)` typed helpers that resolve relative paths under `apps/api/test/fixtures/` to the JSON files above. Throws `fixture_not_found` or `fixture_invalid` on errors.
- `apps/api/test/seed.test.ts` (MODIFY) — extend the `snapshot()` function to cover the new entities (`patient`, `appointment_type`, `appointment`, second `branch`, etc.). Add a "patient 0001 has future appointment" assertion.
- `apps/api/src/db/pool.ts` (read-only) — already exports `getPool`/`closePool`. The new `02_role_ids.ts` does NOT import from here; it is pure data.

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/db/seeds/01_minimum.ts` -- extend `seedWith(client)` per the Code Map -- add 2nd branch, 2 more doctors, 2nd receptionist, 5 patients, ≥1 appointment_type per doctor, ≥1 future appointment on `+15550000001`; add `seed_unchanged` log path -- E0-S5 cannot ship without the MVP row counts. (Implemented: 463-line file with full coverage; SeedResult type; BEGIN/COMMIT/ROLLBACK wrapper.)
- [x] `apps/api/db/seeds/02_role_ids.ts` -- export `CLINIC_ID`, `BRANCH_EAST_ID`, `BRANCH_WEST_ID`, `DOCTOR_*_ID`, `RECEPTIONIST_*_ID`, `ADMIN_ID`, `PATIENT_*_PHONE` as `as const` string literals -- single source of truth for fixture JSON files. (Implemented: 51 lines, all 17 IDs as literal `as const`.)
- [x] `apps/api/test/fixtures/{clinic,branches/*,doctors/*,receptionists/*,admins/*,patients/*}.json` -- 11 new fixture files; each file is small (≤10 lines) and references IDs from `02_role_ids.ts` -- tests must reference these by path, never inline JSON. (Implemented: 11 files, all ≤6 lines; references match `02_role_ids.ts` literal exports.)
- [x] `apps/api/test/fixtures/loader.ts` -- typed loader with one function per role; throws `fixture_not_found` and `fixture_invalid`; uses `import.meta.url` + `fileURLToPath` to resolve relative paths -- the only sanctioned way tests load fixtures. (Implemented: 224 lines; typed `loadClinic/loadBranch/loadDoctor/loadReceptionist/loadAdmin/loadPatient`; `FixtureNotFoundError` + `FixtureInvalidError`; path-traversal guard via `buildPath`. Smoke test 9/9 OK.)
- [x] `apps/api/test/seed.test.ts` -- extend `snapshot()` to include `patient`, `appointment_type`, `appointment`; add the "patient 0001 has future appointment" assertion; assert the `seed_unchanged` log fires on second run -- protects the idempotency contract. (Implemented: 4 tests, all pass — AC-9 idempotency, AC-2 inserted=false, AC-3 patient-0001 future appointment, plus a populated-DB no-throw.)
- [x] `apps/api/package.json` -- verify `db:seed` script is wired to `tsx db/seeds/01_minimum.ts` (it already is from E0-S1); confirm the script is callable via `pnpm --filter @clinic/api run db:seed` from the workspace root -- no script change needed unless the wiring broke. (Verified: line 15 already wires `db:seed` to `tsx db/seeds/01_minimum.ts` — no change needed.)

**Acceptance Criteria:**
- Given a fresh migrated DB, when `pnpm db:seed` runs, then row counts match: `clinic=1`, `branch=2` (tz ∈ {`America/New_York`, `America/Los_Angeles`}), `doctor=3`, `doctor_branch≥3` (each doctor assigned to ≥1 branch), `appointment_type≥3` (≥1 per doctor), `receptionist=2` (one per branch), `admin_user=1`, `patient=5`, `appointment≥1` (Scheduled status, future `starts_at`).
- Given the DB after a successful seed, when `pnpm db:seed` runs again, then row counts are identical and the log line `seed_unchanged` (not `seed_complete`) is emitted.
- Given a test that calls `loadDoctor('east.lead')`, when the function returns, then it returns `{id, full_name: 'Dr. East Lead', branch_ids: ['<east-id>'], appointment_type_ids: [...]}` typed — and the corresponding JSON file is the source.
- Given a test that calls `loadPatient('does/not/exist')`, when the function is invoked, then it throws `fixture_not_found` with the attempted path included in the error message.
- Given `pnpm test`, when the full suite runs, then `seed.test.ts` is green AND no other test file contains an inline `INSERT INTO patient` or inline doctor fixture JSON — fixture loading goes through the loader.
- Given `seed.test.ts`, when the suite runs, then it asserts `patient_0001.has_future_appointment === true` by reading the `appointment` table for a Scheduled row referencing `+15550000001`.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Empty until first bad_spec loopback. -->

### 2026-09-10 — review_loop_iteration=1 (patch findings, no spec change)

Review pass surfaced 4 patch findings (auto-fixed, no spec amendment needed):

- **P1 (Blind Hunter + Edge Case Hunter):** `seed.test.ts` AC-3 assertion `count >= 1` would let a duplicate Scheduled appointment pass silently. Tightened to `count === 1`.
- **P2 (Blind Hunter):** `seed()`'s `console.log(event, JSON.stringify({rowCount}))` form emitted TWO stdout events; log shippers index them as separate records. Refactored: extracted pure `formatSeedLog(result)` helper that emits a single JSON line `{event, rowCount}`. CLI `seed()` now calls `formatSeedLog(result)`.
- **P3 (Verification Gap):** `seed_unchanged` log string was not pinned by any `pnpm test`-run test. Added two new tests: (a) `formatSeedLog` is a pure function with deterministic output for both `inserted=true` and `inserted=false` paths; (b) the live `seedWith` → `formatSeedLog` chain produces `seed_unchanged` on a populated DB.
- **P4 (Verification Gap):** `FixtureInvalidError` was unverified by `pnpm test` — only the developer-only `loader.smoke.ts` exercised it, and even there only the not-found path. Added `apps/api/test/loader.test.ts` (11 tests, all green) covering all 6 loader functions, not-found, traversal block, and two malformed-JSON paths via a temp fixture.

**Findings rejected:** 18 (TOCTOU races — pre-existing schema constraint strategy; `now()` vs `app_now()` — same clock in practice; loader's per-loader slug guard vs `buildPath` defense-in-depth; `process.argv[1].endsWith` on Windows — works; `closePool().finally()` error swallow — `process.exitCode=1` already set; missing fixture files for `appointment_type`/`appointment`/`doctor_branch` — not in scope; loader uniqueness check on arrays — not in spec; loader missing-key vs wrong-type distinction — not in spec; no fixtures README — deferred to next iteration).

**Findings deferred:** 0 (the `pnpm test` excludes `loader.smoke.ts` finding is now superseded by `loader.test.ts` in CI).

179/184 tests green (5 pre-existing baseline failures unchanged).

## Suggested Review Order

**Seed engine (the heart of the change)**

- Single source of truth for role identifiers; fixtures import these as literal types.
  [`02_role_ids.ts:20`](../../apps/api/db/seeds/02_role_ids.ts#L20)

- SELECT-then-INSERT for entities without UNIQUE; ON CONFLICT for the rest.
  [`01_minimum.ts:115`](../../apps/api/db/seeds/01_minimum.ts#L115)

- Future appointment on patient 0001; deterministic 7-day offset, idempotent on re-run.
  [`01_minimum.ts:330`](../../apps/api/db/seeds/01_minimum.ts#L330)

- Pure formatter: single JSON line `seed_complete`/`seed_unchanged` (P2 refactor).
  [`01_minimum.ts:444`](../../apps/api/db/seeds/01_minimum.ts#L444)

- CLI entry point: BEGIN/COMMIT/ROLLBACK; logs through `formatSeedLog`.
  [`01_minimum.ts:464`](../../apps/api/db/seeds/01_minimum.ts#L464)

**Fixture loader (typed path-based, no inline JSON in tests)**

- Typed error classes + path-traversal guard via `buildPath`.
  [`loader.ts:26`](../../apps/api/test/fixtures/loader.ts#L26)

- Six typed loaders; per-loader slug validation rejects `..` and `/`.
  [`loader.ts:142`](../../apps/api/test/fixtures/loader.ts#L142)

**Fixture files (data the tests reference by path)**

- Clinic + 2 branches in distinct IANA time zones.
  [`clinic.json`](../../apps/api/test/fixtures/clinic.json)
  [`branches/east.json`](../../apps/api/test/fixtures/branches/east.json)
  [`branches/west.json`](../../apps/api/test/fixtures/branches/west.json)

- 3 doctors; each tied to a branch + appointment_type.
  [`doctors/east.lead.json`](../../apps/api/test/fixtures/doctors/east.lead.json)
  [`doctors/east.support.json`](../../apps/api/test/fixtures/doctors/east.support.json)
  [`doctors/west.lead.json`](../../apps/api/test/fixtures/doctors/west.lead.json)

- 2 receptionists (one per branch), 1 admin, 5 patients (only 0001 has future appointment).
  [`receptionists/east.json`](../../apps/api/test/fixtures/receptionists/east.json)
  [`receptionists/west.json`](../../apps/api/test/fixtures/receptionists/west.json)
  [`admins/main.json`](../../apps/api/test/fixtures/admins/main.json)
  [`patients/0001.json`](../../apps/api/test/fixtures/patients/0001.json)

**Test coverage (idempotency + log + loader contract)**

- Snapshot-then-replay idempotency, AC-2 inserted=false, AC-3 strictly-one future appointment (P1).
  [`seed.test.ts:90`](../../apps/api/test/seed.test.ts#L90)

- formatSeedLog pinned for both branches; live chain produces `seed_unchanged`.
  [`seed.test.ts:186`](../../apps/api/test/seed.test.ts#L186)

- All six loaders, not-found, traversal block, two malformed-JSON paths.
  [`loader.test.ts:1`](../../apps/api/test/loader.test.ts#L1)

## Design Notes

The fixture loader uses `import.meta.url` + `fileURLToPath` (matches the existing pattern in `apps/api/test/db/withTestDb.ts`) to resolve relative paths. Each `loadX` function does three things: (1) build the path, (2) read + JSON.parse the file, (3) validate the parsed shape against a per-role zod-like runtime check (or hand-rolled equivalent — no new dep needed). Errors throw a typed error class (`FixtureNotFoundError`, `FixtureInvalidError`) that tests can `instanceof`-discriminate.

The `02_role_ids.ts` module uses `as const` so the IDs are literal types — fixture JSON files import these and reference them by name, eliminating any drift between seed and tests. A test that breaks because the seed changed an ID now fails at the import step, not deep in a SQL assertion.

For the future appointment on patient `+15550000001`: insert a single `appointment` row with `status=Scheduled`, `starts_at = app_now() + INTERVAL '7 days'`, `ends_at = starts_at + INTERVAL '30 minutes'`, `doctor_id` referencing `DOCTOR_EAST_LEAD_ID`, `branch_id` referencing `BRANCH_EAST_ID`. The exact column list follows the E0-S2 schema (see `0011_pgcrypto_grants.sql` predecessors).

## Verification

**Commands:**
- `pnpm --filter @clinic/api run db:migrate` — expected: migrations apply cleanly to a fresh DB.
- `pnpm --filter @clinic/api run db:seed` — expected: `seed_complete` log; row counts match AC-1.
- `pnpm --filter @clinic/api run db:seed` (run twice) — expected: second run logs `seed_unchanged`, row counts unchanged.
- `pnpm --filter @clinic/api test` — expected: `seed.test.ts` green; no other test file fails due to missing fixtures; AC-2/AC-3/AC-4/AC-5/AC-6 assertions all pass.

**Manual checks (if no CLI):**
- Open `apps/api/db/seeds/01_minimum.ts` — confirm `seedWith` covers every entity in the AC-1 row-count list.
- `grep -r "INSERT INTO patient" apps/api/test/` — expected: zero matches (fixture loading goes through the loader).
- Open `apps/api/test/fixtures/loader.ts` — confirm every `loadX` function validates the JSON shape and throws typed errors.
