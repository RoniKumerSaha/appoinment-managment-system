/**
 * Minimum seed: 1 clinic, 1 branch, 1 doctor + 1 doctor_branch row,
 * 1 receptionist, 1 admin, 0 patients.
 *
 * Idempotency: every write is ON CONFLICT DO NOTHING keyed by the unique
 * identifiers (phone_number for patients, name+branch_id for receptionist,
 * etc.). Running this twice produces identical row counts; the seed test
 * asserts equality.
 *
 * `seedWith(client)` accepts a `pg.PoolClient` and is the canonical seed
 * routine — both the production CLI (`db:seed`) and the live test
 * (`seed.test.ts`) call this with their own client. Keeping the test on
 * the same code path as production is the whole point of the E0-S2
 * contract ("the seed is the only sanctioned way tests load fixtures").
 */
import type { PoolClient } from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';

const CLINIC_NAME = 'Test Clinic';
const BRANCH_NAME = 'Branch 1';
const BRANCH_TZ = 'UTC';
const DOCTOR_NAME = 'Dr. Test';
const RECEPTIONIST_NAME = 'Receptionist Test';
const ADMIN_NAME = 'Admin Test';

/**
 * Apply the minimum seed against an open transaction on `client`.
 *
 * The caller owns the transaction lifecycle: BEGIN before, COMMIT or
 * ROLLBACK after. The seed routine only issues INSERT/SELECT statements;
 * it does NOT call client.query('BEGIN' | 'COMMIT' | 'ROLLBACK') itself.
 * This lets the test runner wrap the call in its own transaction if it
 * wants to roll back after assertions, without fighting the seed.
 */
export async function seedWith(client: PoolClient): Promise<void> {
  // Clinic — `clinic.name` has no UNIQUE constraint, so ON CONFLICT DO NOTHING
  // is a no-op (nothing to conflict on). Use SELECT-then-INSERT to make the
  // seed genuinely idempotent. Without this, repeated seedWith() calls would
  // insert fresh clinic/branch/doctor rows each time, and downstream tables
  // gated on (branch_id, full_name) would collide on email uniqueness.
  const clinicRes = await client.query<{ id: string }>(
    `SELECT id FROM clinic WHERE name = $1`,
    [CLINIC_NAME],
  );
  let clinicId: string;
  if (clinicRes.rows[0]) {
    clinicId = clinicRes.rows[0].id;
  } else {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO clinic (name) VALUES ($1) RETURNING id`,
      [CLINIC_NAME],
    );
    clinicId = ins.rows[0]!.id;
  }

  // Branch — same: no UNIQUE on (clinic_id, name), SELECT-then-INSERT.
  const branchRes = await client.query<{ id: string }>(
    `SELECT id FROM branch WHERE clinic_id = $1 AND name = $2`,
    [clinicId, BRANCH_NAME],
  );
  let branchId: string;
  if (branchRes.rows[0]) {
    branchId = branchRes.rows[0].id;
  } else {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, $2, $3) RETURNING id`,
      [clinicId, BRANCH_NAME, BRANCH_TZ],
    );
    branchId = ins.rows[0]!.id;
  }

  // Doctor — same: no UNIQUE on full_name.
  const doctorRes = await client.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [DOCTOR_NAME],
  );
  let doctorId: string;
  if (doctorRes.rows[0]) {
    doctorId = doctorRes.rows[0].id;
  } else {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO doctor (full_name) VALUES ($1) RETURNING id`,
      [DOCTOR_NAME],
    );
    doctorId = ins.rows[0]!.id;
  }

  // doctor_branch — has PRIMARY KEY (doctor_id, branch_id), so the unique
  // constraint DOES fire on duplicate and ON CONFLICT DO NOTHING is genuine.
  await client.query(
    `INSERT INTO doctor_branch (doctor_id, branch_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [doctorId, branchId],
  );

  // Receptionist (one per branch — E0-S5 widens to two branches).
  // Email is NOT NULL UNIQUE (citext) since migration 0004; deterministic
  // lowercase-of-full_name pattern matches the migration's backfill rule.
  await client.query(
    `INSERT INTO receptionist (branch_id, full_name, email)
     SELECT $1, $2, lower($2) || '@clinic.local'
     WHERE NOT EXISTS (
       SELECT 1 FROM receptionist WHERE branch_id = $1 AND full_name = $2
     )`,
    [branchId, RECEPTIONIST_NAME],
  );

  // Admin.
  await client.query(
    `INSERT INTO admin_user (full_name, email)
     SELECT $1, lower($1) || '@clinic.local'
     WHERE NOT EXISTS (
       SELECT 1 FROM admin_user WHERE full_name = $1
     )`,
    [ADMIN_NAME],
  );
}

/**
 * Production entry point: open a pool, run `seedWith` inside a transaction,
 * close the pool. CLI usage: `pnpm db:seed`.
 */
export async function seed(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log('seed_complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('01_minimum.ts');

if (invokedDirectly) {
  seed()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('seed_failed', err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
