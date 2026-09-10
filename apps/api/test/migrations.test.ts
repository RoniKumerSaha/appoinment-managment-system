/**
 * migrations.test.ts — asserts every named object exists in the migrated DB.
 *
 * Covers AC-15 (extensions), AC-16 (GIST exclusion kind), AC-17 ([)-adjacent
 * Scheduled rows).
 *
 * Reads DATABASE_URL from the environment. In CI, the globalSetup boots a
 * Testcontainers Postgres and applies migrations. In local dev, point at any
 * Postgres 16 instance with the migrations already applied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb } from './db/withTestDb.js';

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
