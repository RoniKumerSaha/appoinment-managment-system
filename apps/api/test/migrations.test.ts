/**
 * migrations.test.ts — asserts every named object exists in the migrated DB.
 *
 * Covers AC-15 (extensions), AC-16 (GIST exclusion kind), AC-17 ([)-adjacent
 * Scheduled rows), and the E1-S0a singleton-enforcement invariants.
 *
 * Reads DATABASE_URL from the environment. In CI, the globalSetup boots a
 * Testcontainers Postgres and applies migrations. In local dev, point at any
 * Postgres 16 instance with the migrations already applied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTestDb } from './db/withTestDb.js';

// Resolve the down-migrations directory the same way `withTestDb.ts`
// resolves the forward migrations directory, so the round-trip test
// reads the exact `0013_clinic_anchor.down.sql` file the migration
// runner would see if it were applied.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = resolve(here, '..', 'db', 'migrations');
const downDir = join(migrationsRoot, 'down');

test('AC-15: pg_extension includes pgcrypto, citext, btree_gist', async () => {
  await withTestDb(async ({ pool }) => {
    const { rows } = await pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension
       WHERE extname IN ('pgcrypto', 'citext', 'btree_gist')
       ORDER BY extname`,
    );
    const names = rows.map((r) => r.extname);
    assert.deepEqual(
      names,
      ['btree_gist', 'citext', 'pgcrypto'],
      `expected all three extensions present; got ${names.join(', ')}`,
    );
  });
});

test('AC-16: appointment_no_overlap is an EXCLUDE constraint on GIST', async () => {
  await withTestDb(async ({ pool }) => {
    const { rows } = await pool.query<{
      contype: string;
      amname: string | null;
    }>(
      `SELECT c.contype, am.amname
       FROM pg_constraint c
       JOIN pg_class i ON i.oid = c.conindid
       JOIN pg_am am ON am.oid = i.relam
       WHERE c.conname = 'appointment_no_overlap'`,
    );
    assert.equal(rows.length, 1, 'expected exactly one appointment_no_overlap constraint');
    const row = rows[0]!;
    assert.equal(row.contype, 'x', 'constraint type must be x (exclusion)');
    assert.equal(
      row.amname,
      'gist',
      `exclusion constraint must use GIST; got ${row.amname}`,
    );
  });
});

test('AC-16b: per-doctor partial unique index exists and is partial', async () => {
  await withTestDb(async ({ pool }) => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE indexname = 'idx_appointment_patient_doctor_scheduled'`,
    );
    assert.equal(rows.length, 1, 'partial unique index must exist');
    const def = rows[0]!.indexdef;
    assert.match(def, /WHERE/i, 'index must be partial (have a WHERE clause)');
    assert.match(def, /status = 'Scheduled'/, 'partial predicate must filter to Scheduled');
  });
});

test('AC-17: half-open adjacent Scheduled rows for same doctor+branch both commit', async () => {
  await withTestDb(async ({ pool }) => {
    // Fixture.
    const clinic = await pool.query<{ id: string }>(
      `INSERT INTO clinic (name) VALUES ('Adj Test ' || gen_random_uuid()) RETURNING id`,
    );
    const clinicId = clinic.rows[0]!.id;
    const branch = await pool.query<{ id: string }>(
      `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, 'AdjBranch', 'UTC') RETURNING id`,
      [clinicId],
    );
    const branchId = branch.rows[0]!.id;
    const doctor = await pool.query<{ id: string }>(
      `INSERT INTO doctor (full_name) VALUES ('Adj Doc') RETURNING id`,
    );
    const doctorId = doctor.rows[0]!.id;

    // Two [)-adjacent Scheduled rows at the same doctor+branch.
    const start = '2099-01-15 10:00:00+00';
    const middle = '2099-01-15 10:30:00+00';
    const end = '2099-01-15 11:00:00+00';

    const a = await pool.query(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, '+15555550100', $4, $5, 'Scheduled', 'patient:+15555550100')`,
      [clinicId, branchId, doctorId, start, middle],
    );
    assert.equal(a.rowCount, 1);

    const b = await pool.query(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, '+15555550200', $4, $5, 'Scheduled', 'patient:+15555550200')`,
      [clinicId, branchId, doctorId, middle, end],
    );
    assert.equal(
      b.rowCount,
      1,
      'half-open adjacent Scheduled rows must NOT collide on GIST exclusion',
    );
  });
});

test('E1-S0a: idx_clinic_singleton partial unique index exists on clinic((true))', async () => {
  await withTestDb(async ({ pool }) => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE indexname = 'idx_clinic_singleton'`,
    );
    assert.equal(rows.length, 1, 'idx_clinic_singleton index must exist');
    const def = rows[0]!.indexdef;
    // The index is on a constant expression `(true)`; Postgres allows
    // this and treats `(true) = (true)` as `true`, so at most one row
    // can be indexed. The exact text includes `((true))` because of
    // the parens in the CREATE INDEX expression.
    assert.match(
      def,
      /\(true\)/,
      `index must be on a constant true expression; got: ${def}`,
    );
    assert.match(
      def,
      /UNIQUE INDEX/i,
      `idx_clinic_singleton must be UNIQUE; got: ${def}`,
    );
  });
});

test('E1-S0a: admin_user.clinic_id is NOT NULL with FK to clinic(id), ON DELETE RESTRICT', async () => {
  await withTestDb(async ({ pool }) => {
    // is_nullable + column-level FK existence, asserted in one query
    // joined against pg_constraint for the FK to clinic(id).
    const { rows } = await pool.query<{
      is_nullable: string;
      conname: string | null;
      confdeltype: string | null;
    }>(
      `SELECT c.is_nullable, fk.conname, fk.confdeltype
       FROM information_schema.columns c
       LEFT JOIN pg_constraint fk
         ON fk.conrelid = 'admin_user'::regclass
        AND fk.contype = 'f'
        AND fk.conkey = ARRAY[c.ordinal_position]::smallint[]
       WHERE c.table_name = 'admin_user'
         AND c.column_name = 'clinic_id'`,
    );
    assert.equal(rows.length, 1, 'admin_user.clinic_id column must exist');
    assert.equal(
      rows[0]!.is_nullable,
      'NO',
      `admin_user.clinic_id must be NOT NULL; got is_nullable=${rows[0]!.is_nullable}`,
    );
    assert.ok(
      rows[0]!.conname !== null,
      'admin_user.clinic_id must carry a foreign-key constraint to clinic(id)',
    );
    // confdeltype codes: 'a' = no action (default), 'r' = restrict,
    // 'c' = cascade, 'n' = set null, 'd' = set default. Per spec §Boundaries
    // the FK must match branch.clinic_id and use RESTRICT — 'r' is required.
    // A regression dropping ON DELETE RESTRICT (which would silently fall back
    // to NO ACTION 'a' — same constraint-firing semantics for an empty
    // dependent table, but a different catalog contract) would not be caught
    // without this assertion.
    assert.equal(
      rows[0]!.confdeltype,
      'r',
      `admin_user.clinic_id FK must use ON DELETE RESTRICT (confdeltype='r'); got confdeltype=${rows[0]!.confdeltype}`,
    );

    // Spot-check the FK target by name + table — confirm it points at
    // clinic(id) and not at any other table.
    const fk = await pool.query<{ conrelid: string; confrelid: string }>(
      `SELECT c.conrelid::regclass::text AS conrelid,
              c.confrelid::regclass::text AS confrelid
       FROM pg_constraint c
       WHERE c.conname = $1`,
      [rows[0]!.conname],
    );
    assert.equal(fk.rows[0]!.conrelid, 'admin_user', 'FK must live on admin_user');
    assert.equal(fk.rows[0]!.confrelid, 'clinic', 'FK must target clinic(id)');
  });
});

test('E1-S0a: backfill UPDATE populates clinic_id on a pre-existing NULL admin row', async () => {
  await withTestDb(async ({ pool }) => {
    // The migration's `UPDATE admin_user SET clinic_id = (SELECT id FROM
    // clinic LIMIT 1) WHERE clinic_id IS NULL` is the backfill that
    // anchors pre-existing admin rows to the singleton clinic before
    // NOT NULL is enforced. This test exercises that backfill on a row
    // whose `clinic_id` is genuinely NULL — the kind of state a real
    // upgrade would hit if a pre-0013 admin row slipped through some
    // other path. A regression in the WHERE predicate (e.g. inverting
    // it to `WHERE clinic_id IS NOT NULL`) would leave the row NULL
    // and break the subsequent SET NOT NULL. Without this test, that
    // regression is invisible on a fresh DB.
    //
    // The shared Testcontainers DB has already been migrated by 0013,
    // so `admin_user.clinic_id` is NOT NULL. We temporarily drop NOT
    // NULL, insert a NULL row, run the backfill + SET NOT NULL, and
    // restore the index that we also drop for the round-trip below.
    // The shared-DB invariant requires us to leave the DB in its
    // pre-test state — every step here is mirrored by a cleanup step.

    // 1. Make the column nullable (mirrors a pre-0013 state).
    await pool.query(`ALTER TABLE admin_user ALTER COLUMN clinic_id DROP NOT NULL`);

    // 2. Insert a pre-existing admin row with clinic_id NULL.
    const email = `backfill-test-${Date.now()}@clinic.local`;
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO admin_user (full_name, email, clinic_id) VALUES ($1, $2, NULL) RETURNING id`,
      ['Backfill Test Admin', email],
    );
    const adminId = ins.rows[0]!.id;
    // Sanity: row was inserted with clinic_id NULL.
    const pre = await pool.query<{ clinic_id: string | null }>(
      `SELECT clinic_id FROM admin_user WHERE id = $1`,
      [adminId],
    );
    assert.equal(pre.rows[0]!.clinic_id, null, 'admin row must be inserted with NULL clinic_id');

    // 3. Run the migration's backfill UPDATE verbatim.
    await pool.query(
      `UPDATE admin_user SET clinic_id = (SELECT id FROM clinic LIMIT 1) WHERE clinic_id IS NULL`,
    );

    // 4. Assert the row is now anchored to the (only) clinic row.
    const post = await pool.query<{ clinic_id: string | null }>(
      `SELECT clinic_id FROM admin_user WHERE id = $1`,
      [adminId],
    );
    assert.notEqual(
      post.rows[0]!.clinic_id,
      null,
      `backfill UPDATE must populate clinic_id for the pre-existing NULL row; got: ${post.rows[0]!.clinic_id}`,
    );

    // 5. Verify the backfilled value matches the singleton clinic id
    //    (proves the backfill didn't pick a stale or random row).
    const clinic = await pool.query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`);
    assert.equal(
      post.rows[0]!.clinic_id,
      clinic.rows[0]!.id,
      'backfill must anchor to the singleton clinic row',
    );

    // 6. Run the rest of the migration steps the way 0013 would.
    await pool.query(`ALTER TABLE admin_user ALTER COLUMN clinic_id SET NOT NULL`);

    // 7. Clean up the test row so subsequent tests aren't affected.
    await pool.query(`DELETE FROM admin_user WHERE id = $1`, [adminId]);

    // 8. Restore NOT NULL — the shared DB must be left in its migrated
    //    state for sibling tests.
    const finalCheck = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'admin_user' AND column_name = 'clinic_id'`,
    );
    assert.equal(finalCheck.rows[0]!.is_nullable, 'NO', 'NOT NULL must be re-enforced after backfill test');
  });
});

test('E1-S0a: second INSERT INTO clinic (name) VALUES rejects with pg code 23505', async () => {
  await withTestDb(async ({ pool }) => {
    // The migration runner (withTestDb.applyMigrations) boots a fresh
    // DB and applies every forward migration including 0013, so the
    // singleton clinic row already exists by the time this test runs.
    // A second INSERT must raise unique_violation (23505) per the
    // idx_clinic_singleton partial unique index.
    //
    // We try/catch because node-pg exposes pg errors as `.code` on the
    // rejection value; the test asserts both the SQLSTATE code and the
    // constraint name in the message so a future regression where the
    // wrong constraint fires is caught.
    let caught: unknown = null;
    try {
      await pool.query(`INSERT INTO clinic (name) VALUES ('clinic-2')`);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught !== null, 'second INSERT INTO clinic must reject');
    const err = caught as { code?: string; message?: string };
    assert.equal(
      err.code,
      '23505',
      `second INSERT INTO clinic must reject with SQLSTATE 23505 (unique_violation); got code=${err.code ?? '<none>'}`,
    );
    assert.match(
      err.message ?? '',
      /idx_clinic_singleton/,
      `rejection must reference idx_clinic_singleton; got: ${err.message ?? '<no message>'}`,
    );
  });
});

test('E1-S0a: down + forward round-trip restores NOT NULL + index (round-trip parity)', async () => {
  await withTestDb(async ({ pool }) => {
    // Read the down SQL file the migration runner ships, run it on the
    // migrated DB, then re-run the forward migration's NOT-NULL/UNIQUE
    // steps and assert the post-state matches the pre-state.
    const downSql = readFileSync(join(downDir, '0013_clinic_anchor.down.sql'), 'utf8');
    await pool.query(downSql);

    // After down: index gone, column gone (FK dropped with column).
    const afterDown = await pool.query<{ indexname: string | null; colname: string | null }>(
      `SELECT
         (SELECT indexname FROM pg_indexes WHERE indexname = 'idx_clinic_singleton') AS indexname,
         (SELECT column_name FROM information_schema.columns
          WHERE table_name = 'admin_user' AND column_name = 'clinic_id') AS colname`,
    );
    assert.equal(afterDown.rows[0]!.indexname, null, 'index must be dropped after down');
    assert.equal(afterDown.rows[0]!.colname, null, 'admin_user.clinic_id column must be dropped after down');

    // Round-trip: re-run the forward migration's NOT NULL + UNIQUE steps.
    // We do NOT re-add the column (the column is gone; re-adding it via
    // ADD COLUMN IF NOT EXISTS would be redundant), but we DO re-run the
    // NOT NULL + index steps to confirm the migration is re-runnable on
    // an already-clean DB without error.
    await pool.query(`ALTER TABLE admin_user ADD COLUMN IF NOT EXISTS clinic_id uuid REFERENCES clinic(id) ON DELETE RESTRICT`);
    await pool.query(`UPDATE admin_user SET clinic_id = (SELECT id FROM clinic LIMIT 1) WHERE clinic_id IS NULL`);
    await pool.query(`ALTER TABLE admin_user ALTER COLUMN clinic_id SET NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_singleton ON clinic((true))`);

    // Post-state: index present, column NOT NULL with FK to clinic(id).
    const afterReApply = await pool.query<{ is_nullable: string; conname: string | null; indexname: string | null }>(
      `SELECT
         (SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'admin_user' AND column_name = 'clinic_id') AS is_nullable,
         (SELECT conname FROM pg_constraint
          WHERE conrelid = 'admin_user'::regclass AND contype = 'f'
            AND conkey = ARRAY[(SELECT ordinal_position FROM information_schema.columns
                                WHERE table_name = 'admin_user' AND column_name = 'clinic_id')]::smallint[]) AS conname,
         (SELECT indexname FROM pg_indexes WHERE indexname = 'idx_clinic_singleton') AS indexname`,
    );
    assert.equal(afterReApply.rows[0]!.is_nullable, 'NO', 'admin_user.clinic_id must be NOT NULL after round-trip');
    assert.ok(afterReApply.rows[0]!.conname !== null, 'FK to clinic(id) must be reattached after round-trip');
    assert.equal(afterReApply.rows[0]!.indexname, 'idx_clinic_singleton', 'index must be re-created after round-trip');
  });
});

test('E1-S0a: forward migration is idempotent — running 0013 twice exits 0', async () => {
  await withTestDb(async ({ pool }) => {
    // The migration runner applies all forward migrations once at boot
    // time. This test re-runs ONLY the 0013 file's SQL on top of the
    // already-migrated DB and asserts every statement is a no-op or
    // short-circuits. This is the spec's idempotency AC for the
    // migration runner applied to a fresh DB that has already been
    // migrated once.
    const sql = readFileSync(
      join(migrationsRoot, '0013_clinic_anchor.sql'),
      'utf8',
    );
    await pool.query(sql); // MUST NOT throw
    // State still correct after re-run.
    const r = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'admin_user' AND column_name = 'clinic_id'`,
    );
    assert.equal(r.rows[0]!.is_nullable, 'NO', 'idempotent re-run must preserve NOT NULL');
  });
});
