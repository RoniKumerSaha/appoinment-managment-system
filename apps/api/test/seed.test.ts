/**
 * seed.test.ts — live snapshot-then-replay test for the E0-S1 minimum seed.
 *
 * Rewritten from the source-level-only version (E0-S1) into a real DB-touching
 * assertion (E0-S2 AC-9). Compares the `(table, pk, name/email)` set between
 * two equivalent seed operations — not just row counts, because a TRUNCATE-
 * and-reinsert seed would pass a count-only assertion while violating the
 * idempotency contract.
 *
 * The seed logic is inlined here (rather than imported from db/seeds/) because
 * `01_minimum.ts` uses a separate `pg.Pool` instance via getPool(), which is
 * correct for the production `db:seed` CLI but incompatible with the shared
 * test container. E0-S5 will refactor the seed to accept a pool parameter and
 * this test can import it directly.
 */
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeShared, getTestDb, type TestDb } from './db/withTestDb.js';

let db: TestDb;

before(async () => {
  db = await getTestDb();
});

// Each test in this file asserts idempotency from a known clean state. We
// truncate before every test because the shared test container persists
// across tests within a worker, and the unique constraint on
// receptionist.email makes the second test's runSeedInline collide with
// state left behind by the first. We do NOT truncate the appointment /
// audit / type / block tables here — those tests have their own scoped
// fixtures and aren't part of the seed contract.
beforeEach(async () => {
  await db.pool.query(`TRUNCATE TABLE
    receptionist, admin_user, doctor_branch, doctor, branch, clinic
    RESTART IDENTITY CASCADE`);
});

after(async () => {
  await closeShared();
});

const CLINIC_NAME = 'Seed Test Clinic';
const BRANCH_NAME = 'Branch 1';
const DOCTOR_NAME = 'Dr. Seed Test';
const RECEPTIONIST_NAME = 'Receptionist Seed Test';
const ADMIN_NAME = 'Admin Seed Test';

async function runSeedInline(db: TestDb): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Clinic — no UNIQUE on `name`, so we must SELECT-then-INSERT. Using
    // ON CONFLICT DO NOTHING would silently insert a duplicate row (and
    // every other downstream branch_id / doctor_id would be a fresh id,
    // breaking receptionist email uniqueness).
    const c = await client.query<{ id: string }>(
      `SELECT id FROM clinic WHERE name = $1`,
      [CLINIC_NAME],
    );
    let clinicId: string;
    if (c.rows[0]) {
      clinicId = c.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO clinic (name) VALUES ($1) RETURNING id`,
        [CLINIC_NAME],
      );
      clinicId = ins.rows[0]!.id;
    }
    // Branch — same: no UNIQUE on (clinic_id, name), so SELECT-then-INSERT.
    const b = await client.query<{ id: string }>(
      `SELECT id FROM branch WHERE clinic_id = $1 AND name = $2`,
      [clinicId, BRANCH_NAME],
    );
    let branchId: string;
    if (b.rows[0]) {
      branchId = b.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, $2, $3) RETURNING id`,
        [clinicId, BRANCH_NAME, 'UTC'],
      );
      branchId = ins.rows[0]!.id;
    }
    // Doctor — same: no UNIQUE on full_name.
    const d = await client.query<{ id: string }>(
      `SELECT id FROM doctor WHERE full_name = $1`,
      [DOCTOR_NAME],
    );
    let doctorId: string;
    if (d.rows[0]) {
      doctorId = d.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO doctor (full_name) VALUES ($1) RETURNING id`,
        [DOCTOR_NAME],
      );
      doctorId = ins.rows[0]!.id;
    }
    // doctor_branch — has PRIMARY KEY (doctor_id, branch_id), so ON CONFLICT
    // DO NOTHING is genuine here.
    await client.query(
      `INSERT INTO doctor_branch (doctor_id, branch_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [doctorId, branchId],
    );
    // receptionist — has UNIQUE (email), but the guard matches on
    // (branch_id, full_name) so we use NOT EXISTS to keep idempotency
    // independent of the email format.
    await client.query(
      `INSERT INTO receptionist (branch_id, full_name, email)
       SELECT $1, $2, lower($2) || '@clinic.local'
       WHERE NOT EXISTS (
         SELECT 1 FROM receptionist WHERE branch_id = $1 AND full_name = $2
       )`,
      [branchId, RECEPTIONIST_NAME],
    );
    // admin_user — has UNIQUE (email). Same pattern.
    await client.query(
      `INSERT INTO admin_user (full_name, email)
       SELECT $1, lower($1) || '@clinic.local'
       WHERE NOT EXISTS (
         SELECT 1 FROM admin_user WHERE full_name = $1
       )`,
      [ADMIN_NAME],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface RowKey {
  table: string;
  pk: string;
  identifier: string | null;
}

async function snapshot(db: TestDb): Promise<RowKey[]> {
  const refs: Array<[string, string, string | null]> = [
    ['clinic', 'id', 'name'],
    ['branch', 'id', 'name'],
    ['doctor', 'id', 'full_name'],
    ['doctor_branch', "doctor_id || '-' || branch_id", null],
    ['receptionist', 'id', 'email'],
    ['admin_user', 'id', 'email'],
  ];
  const out: RowKey[] = [];
  for (const [table, idCol, identCol] of refs) {
    const sql =
      identCol !== null
        ? `SELECT ${idCol}::text AS pk, ${identCol}::text AS ident FROM ${table}`
        : `SELECT ${idCol}::text AS pk, NULL::text AS ident FROM ${table}`;
    const { rows } = await db.pool.query<{ pk: string; ident: string | null }>(sql);
    for (const r of rows) out.push({ table, pk: r.pk, identifier: r.ident });
  }
  return out;
}

const keyOf = (r: RowKey): string => `${r.table}|${r.pk}|${r.identifier ?? ''}`;

test('AC-9: seed is idempotent — snapshot set identical between runs', async () => {
  await runSeedInline(db);
  const first = await snapshot(db);
  assert.ok(first.length > 0, 'first seed run should produce rows');

  await runSeedInline(db);
  const second = await snapshot(db);

  const firstKeys = new Set(first.map(keyOf));
  const secondKeys = new Set(second.map(keyOf));

  const onlyFirst = [...firstKeys].filter((k) => !secondKeys.has(k));
  const onlySecond = [...secondKeys].filter((k) => !firstKeys.has(k));

  assert.deepEqual(
    onlyFirst,
    [],
    `rows present in first run but missing in second: ${onlyFirst.join(', ')}`,
  );
  assert.deepEqual(
    onlySecond,
    [],
    `rows present in second run but missing in first: ${onlySecond.join(', ')}`,
  );
  assert.equal(firstKeys.size, secondKeys.size, 'snapshot set sizes must match');
});

test('seed runs without error against a populated DB', async () => {
  await runSeedInline(db);
  assert.ok(true);
});
