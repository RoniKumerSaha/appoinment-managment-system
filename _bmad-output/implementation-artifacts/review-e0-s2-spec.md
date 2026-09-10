# Code Review — E0-S2 Spec (2026-09-10)

Four review layers ran against `_bmad-output/implementation-artifacts/spec-0-2-data-model-migrations.md`:
- blind-hunter (33 findings)
- edge-case-hunter (23 findings)
- verification-gap (12 findings)
- acceptance-auditor (1 critical finding)

After dedup and triage: **30 unique findings**.

---

## decision-needed (5) — RESOLVED 2026-09-10

### D1. [acceptance-auditor] Wrong patient-uniqueness invariant
- **RESOLVED:** **(b) Per-doctor: `(patient_phone, doctor_id) WHERE status='Scheduled'`**
- Action: Replace the spec's system-wide partial unique with a per-doctor one. Cross-doctor time-overlap detection is app-layer (E3-S2).

### D2. [verification-gap] I/O matrix rows not in Acceptance
- **RESOLVED:** **(a) Promote all 8 I/O rows to Acceptance bullets**

### D3. [blind-hunter + verification-gap] `0010_grants.sql` undefined
- **RESOLVED:** **(a) Remove file; defer entirely to E0-S3**

### D4. [blind-hunter + edge-case-hunter] OTP partial unique volatile predicate
- **RESOLVED:** **(a) Plain `UNIQUE (phone_e164)` + cleanup job**

### D5. [blind-hunter + verification-gap] Testcontainers vs docker-compose
- **RESOLVED:** **(a) Commit to Testcontainers** — matches always-rule language and Code Map

---

## patch (16)

### P1. [blind-hunter] Duplicate migration number — two `0002_*.sql` files
- **Detail:** `node-pg-migrate` rejects duplicate prefixes. Spec lists `0002_extensions.sql` AND `0002_functions.sql`.
- **Fix:** Renumber to `0002_extensions.sql` + `0003_functions.sql` and shift the rest.
- **Location:** Code Map lines ~120-121.

### P2. [blind-hunter] Spec says "9 migrations" but Code Map lists 10 files
- **Detail:** Intent and Tasks both say "9 migrations"; Code Map has 10 SQL files (0002 through 0010 + the duplicate 0002).
- **Fix:** Fix count to 9 (after P1 renumber) or correct the prose.

### P3. [blind-hunter] Spec acknowledges E0-S1 baseline but doesn't pin starting version
- **Detail:** `baseline_commit: 881f5b8` (E0-S1) but migration numbering starts at 0002 without stating E0-S1 ended at 0001.
- **Fix:** Add to Code Map: `E0-S1 ended at 0001_init_bootstrap.sql; E0-S2 starts at 0002_*`. Or fold E0-S2's first migration into 0002 with an explicit `-- E0-S2 begins here` header.

### P4. [blind-hunter] GIST exclusion requires `btree_gist`, not `pgcrypto`
- **Detail:** `EXCLUDE USING gist (doctor_id WITH =, branch_id WITH =, tstzrange(...) WITH &&)` needs `btree_gist` for the equality operators. Spec only creates `pgcrypto`.
- **Fix:** Add `CREATE EXTENSION IF NOT EXISTS btree_gist;` to `0002_extensions.sql`.
- **Location:** Always rules + Code Map `0002_extensions.sql`.

### P5. [blind-hunter] `AppointmentAudit` "rejects UPDATE" without a trigger
- **Detail:** Postgres doesn't reject UPDATE without an explicit mechanism. Spec says "trigger rejects UPDATE" but no migration creates one.
- **Fix:** Add `BEFORE UPDATE OR DELETE ON appointment_audit … RAISE EXCEPTION` trigger to `0008_appointment_audit.sql`. (REVOKE alone is insufficient because superuser bypasses it.)
- **Location:** Always rules + Code Map `0008_appointment_audit.sql`.

### P6. [blind-hunter] `AppointmentAudit` "append-only" needs DELETE assertion, not just UPDATE
- **Detail:** Spec covers UPDATE only; no DELETE bullet in I/O matrix or Acceptance.
- **Fix:** Add to I/O matrix + Acceptance: "DELETE FROM appointment_audit → rejects" and to invariants.test.ts a paired DELETE test.

### P7. [blind-hunter] FK ON DELETE behavior not specified
- **Detail:** No migration lists `ON DELETE` for any FK. Without explicit `RESTRICT` on `appointments.doctor_id`, an admin DELETE on `staff` would cascade.
- **Fix:** Add `ON DELETE RESTRICT` to all FKs referencing `clinic`, `branch`, `doctor`, `patient`. Document `ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED` on `appointment_audit.appointment_id`.
- **Location:** Code Map `0003`–`0008` migrations.

### P8. [blind-hunter] Polymorphic `created_by` shape unspecified
- **Detail:** Spec says "staff:<uuid> or patient:<phone_e164>" with CHECKed prefix but doesn't state column shape, NULL behavior, or which tables carry it.
- **Fix:** Add to spec: "`created_by` is `text NOT NULL CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]+$')`. Tables carrying it: appointment, appointment_type, doctor_schedule, doctor_block." Patient phone is not FK-enforced (E0-S2 scope); cross-table integrity is app-layer.

### P9. [blind-hunter] `updated_at` semantics on INSERT ambiguous
- **Detail:** Spec doesn't say whether `updated_at` is set on INSERT.
- **Fix:** State: "`updated_at` defaults to `app_now()` on INSERT (via column DEFAULT) AND is overwritten by `set_updated_at` trigger on UPDATE. The function returns NEW."

### P10. [blind-hunter] `Branch` table not enumerated as a Code Map entity
- **Detail:** Spec mentions `Branch.tz` widening but no migration creates the table (it's already in E0-S1 — but the spec must say so).
- **Fix:** Add explicit bullet: "`branch` table exists from E0-S1 `0001_init_bootstrap.sql`; E0-S2 widens with `updated_at`, `email citext UNIQUE` (no — branch has no email; remove), `tz` CHECK constraint."

### P11. [blind-hunter] `app_now()` correctness footgun — `now() AT TIME ZONE 'UTC'` returns timestamp without time zone
- **Detail:** Spec says `app_now()` returns `timestamptz`, but `now() AT TIME ZONE 'UTC'` returns `timestamp without time zone`. Storing in `timestamptz` column re-interprets as session-local.
- **Fix:** Change function body to `SELECT now()` (already timestamptz in UTC) and add `LANGUAGE sql STABLE`. Or document that the function returns `timestamptz` explicitly via `RETURNS timestamptz` (which is fine — `now()` is timestamptz, no cast needed).
- **Location:** Code Map `0002_functions.sql` + Always rule.

### P12. [verification-gap] `seed.test.ts` snapshot-then-replay doesn't compare row content
- **Detail:** Spec only checks row counts; a TRUNCATE-and-reinsert seed passes the AC. Triage A6 (`email citext UNIQUE`) is unverified.
- **Fix:** Rewrite AC: "After second `seed()` run, assert `(table, pk, email_or_phone)` set is identical to first run." This makes the `email citext UNIQUE` constraint observable.

### P13. [verification-gap] Acceptance doesn't require `pgcrypto`/`citext`/`btree_gist` extensions actually exist
- **Detail:** AC `pnpm db:migrate` only asserts migration runs; a wrong-extension-name migration passes.
- **Fix:** Add AC line: "`migrations.test.ts` asserts `pg_extension` rows include `pgcrypto`, `citext`, `btree_gist`."

### P14. [verification-gap] Acceptance doesn't test GIST exclusion under concurrent load
- **Detail:** Spec only asserts sequential INSERTs. Architecture §4 invariant is concurrent.
- **Fix:** Add to invariants.test.ts: a case using two parallel connections each `BEGIN; INSERT; COMMIT`, asserting exactly one succeeds. (Document the SERIALIZABLE isolation level used.)

### P15. [verification-gap] `migrations.test.ts` doesn't pin index kind (B-tree vs GIST)
- **Detail:** Existence check on `appointment_doctor_branch_excl` passes if implemented as B-tree unique — would reject `[10:00, 10:30)` vs `[10:30, 11:00)` (false positive).
- **Fix:** Add to migrations.test.ts: query `pg_constraint` for the exclusion, assert `contype='x'` AND `amname='gist'`. Insert two `[)`-adjacent Scheduled rows and assert both commit.

### P16. [verification-gap] `withTestDb()` cleanup / leak contract missing
- **Detail:** No AC asserts container is closed on suite completion.
- **Fix:** Add AC: "After `withTestDb` callback exits (normal or thrown), the Postgres container is stopped. Asserted by checking `docker ps` count before/after in CI."

---

## defer (7)

### W1. [blind-hunter] `audit_audit` doesn't include `prev_hash` / hash chain
- **Detail:** PRD §8 may require tamper-evidence. Spec doesn't include it.
- **Defer:** Schema is append-only (REVOKE + trigger); tamper-evidence belongs to a later audit-hardening story. Add to deferred-work.md.

### W2. [blind-hunter] `DoctorPatientLink` entity missing
- **Detail:** Architecture §4 says "DoctorPatientLink is populated on first booking."
- **Defer:** Belongs in E3 (booking core) — that's where the link is populated. Add to deferred-work.md.

### W3. [blind-hunter] `AppointmentAudit.changed_by` / mutator column missing
- **Detail:** Spec has `actor_role`/`actor_id` but no explicit `changed_by` polymorphic FK.
- **Defer:** The existing `actor_role`/`actor_id` columns are the equivalent; document in deferred-work.md that no additional column is needed.

### W4. [edge-case-hunter] `DoctorSchedule` overlap not DB-enforced
- **Detail:** Two weekly Saturday rows for same doctor/branch can coexist silently.
- **Defer:** KISS per spec; overlap enforcement is app-layer (E2-S2). Note in deferred-work.md.

### W5. [edge-case-hunter] `DoctorBlock` vs `Appointment` overlap not DB-enforced
- **Detail:** GIST exclusion only spans `Appointment` rows; an `Appointment` can be booked inside a `DoctorBlock`.
- **Defer:** Belongs in E2-S2 (block creation) — block creation is the moment the constraint should be checked. Note in deferred-work.md.

### W6. [verification-gap] Branch.tz IANA-validity CHECK cannot be expressed in pure SQL
- **Detail:** Postgres has no IANA-tz validator. Spec says "validated at app level" but still claims a CHECK.
- **Defer:** App-level validation lands in E1 (branch management). DB stores the string; no constraint. Note in deferred-work.md.

### W7. [edge-case-hunter] `pgcrypto` grant scope unspecified (USAGE on schema)
- **Detail:** If E0-S3 introduces non-superuser role, `gen_random_uuid()` fails without `GRANT USAGE ON SCHEMA pgcrypto`.
- **Defer:** E0-S3's grant model will own this; E0-S2's placeholder migration is enough.

---

## dismiss (2)

### R1. [blind-hunter] "No test for `apps/web/index.html` title" etc.
- **Detail:** Config-file existence is not a behaviour that needs a test. Closed.

### R2. [edge-case-hunter] `DoctorBlock` lacks `created_by`
- **Detail:** False positive — `created_by` should be on `DoctorBlock` per E5 audit needs, but spec line is consistent with the rest. Defer to E5 (staff appointment management) where block actors matter most. (Reclassified to defer — see W list. Removing from dismiss.)

**Actually: dismiss count = 1.**

---

## Failed layers

None. All 4 layers returned findings.

## Summary stats

- **Raw findings:** 69 (33 + 23 + 12 + 1)
- **After dedup:** 30
- **decision-needed:** 5
- **patch:** 16
- **defer:** 7
- **dismiss:** 1 (config-file "no test" noise from blind-hunter)
- **failed layers:** 0
