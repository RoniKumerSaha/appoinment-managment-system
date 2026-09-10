---
id: SPEC-seed-data-role-fixtures
companions:
  - _bmad-output/implementation-artifacts/epic-0-context.md
  - _bmad-output/implementation-artifacts/deferred-work.md
sources:
  - _bmad-output/planning-artifacts/epics-and-stories.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate.

# E0-S5 — Seed Data + Role Fixtures

## Why

A greenfield platform cannot run any acceptance test, integration test, or local demo until a known, deterministic set of role fixtures exists in the database. Downstream epics (E1 clinic management, E3 booking, E4 patient self-service, E5 staff workflows) all assume a "minimum viable clinic" is present, and every test that exercises a branch/doctor/receptionist/admin role needs to resolve that role by path, not by re-typing the JSON. **This is a mandate to meet the testability contract inherited by every later epic.**

## Capabilities

- **CAP-1**
  - **intent:** Operator can run a single seed command and obtain a complete deterministic fixture set: 1 clinic, 2 branches in distinct time zones, 3 doctors each owning at least one appointment type, 2 receptionists (one per branch), 1 admin, and 5 patients of whom at least one carries an existing future appointment.
  - **success:** Running `pnpm db:seed` against a freshly migrated empty database produces exactly the row counts above (verified by direct SQL count); re-running it against the same database produces no new rows and no constraint violations.

- **CAP-2**
  - **intent:** Test code loads role fixtures by stable file path (one file per role fixture) via a typed helper, instead of inlining JSON in test bodies.
  - **success:** A test imports `loadDoctor('branch-east.lead')` (or equivalent path-based API), receives a typed doctor fixture with a stable `id`, and the helper resolves that fixture exclusively from a path under the fixtures directory — never from inline JSON.

- **CAP-3**
  - **intent:** The seed is idempotent across repeated runs — both against an empty database (full insertion) and against an already-seeded database (no-op).
  - **success:** Running `pnpm db:seed` twice in sequence leaves row counts identical and reports `seed_unchanged` on the second run.

## Constraints

- The seed MUST respect every invariant established by E0-S2 (data model): `EXCLUDE USING gist`, partial unique indexes, `app_now()`, append-only audit, `polymorphic created_by`. Inserting a row that violates any of these (e.g. duplicate `(clinic, branch)` key) is a seed bug, not a schema concern.
- Time zones MUST be distinct across the two seeded branches and MUST be valid IANA names (e.g. `America/New_York`, `America/Los_Angeles`) so E1 branch-tz testing has two genuinely different reference points.
- Test fixtures MUST be referenced by relative file path inside the repo — never by inline JSON in test bodies (epic-0-context.md). The seed command produces both the DB rows AND the on-disk fixture files; they refer to each other by stable `id`, not by phone or name.
- Idempotency is implemented via `INSERT ... ON CONFLICT DO NOTHING` (or equivalent) on natural keys — never via `TRUNCATE` first. Operator data must survive a re-run.
- The seed runs AFTER migration; it never owns schema creation.

## Non-goals

- Multi-clinic / multi-tenant seeding is OUT OF SCOPE — single-clinic deployment per PRD §14 MVP.
- Production data migration is OUT OF SCOPE — fixtures are for dev/test only. Production seeding is a separate concern owned by deployment tooling, not this story.
- Test fixture data MUST NOT include real patient PII. Synthetic phones (`+1555000…` range), synthetic names from a fixed wordlist — never reused outside this seed.
- No graphical/admin UI to trigger the seed — the `pnpm db:seed` command is the only surface.

## Success signal

- A fresh CI worker can run `pnpm db:migrate && pnpm db:seed && pnpm test` and every test that depends on a fixture sees the expected fixture by id, with zero setup steps beyond that command sequence.
- The 47 pre-existing test failures in the repo (introduced by E0-S3 / E0-S4) all resolve as a side effect of having role fixtures available — fixtures, not test code, are the missing piece.

## Assumptions

- Assumed: seed runs AFTER `db:migrate`, never before; seed trusts the schema is at HEAD.
- Assumed: the test harness (`withTestDb`) already seeds its baseline rows (e.g. a single clinic for migration FK satisfaction) — this story extends that baseline, not replaces it.
- Assumed: existing `apps/api/db/seeds/01_minimum.ts` is the starting stub; E0-S5 expands it, doesn't rewrite it.

## Open Questions

- **Q1:** Where do fixture files live? Candidate paths: `apps/api/test/fixtures/`, `apps/api/db/seeds/fixtures/`. Deferred to implementation phase.
- **Q2:** What is the exact phone-format pattern for synthetic patients? E.164 requires `+` prefix and 8-15 digits; the existing test suite already uses `+1555…`. Confirm the prefix to use.
- **Q3:** Does the admin fixture carry a `password_hash` (for the future E1 staff login)? Or is the admin a record-only fixture with no auth surface in E0-S5? E1 owns staff login so probably record-only, but worth pinning.
