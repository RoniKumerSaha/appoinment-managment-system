/**
 * Minimum seed: 1 clinic, 1 branch, 1 doctor + 1 doctor_branch row,
 * 1 receptionist, 1 admin, 0 patients.
 *
 * Idempotency: every write is ON CONFLICT DO NOTHING keyed by the unique
 * identifiers (phone_number for patients, name+branch_id for receptionist,
 * etc.). Running this twice produces identical row counts; the seed test
 * asserts equality.
 */
import { getPool, closePool } from '../../src/db/pool.js';

const CLINIC_NAME = 'Test Clinic';
const BRANCH_NAME = 'Branch 1';
const BRANCH_TZ = 'UTC';
const DOCTOR_NAME = 'Dr. Test';
const RECEPTIONIST_NAME = 'Receptionist Test';
const ADMIN_NAME = 'Admin Test';

async function seed(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clinic + branch (idempotent by name).
    const clinicRes = await client.query<{ id: string }>(
      `INSERT INTO clinic (name) VALUES ($1)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [CLINIC_NAME],
    );
    let clinicId: string;
    if (clinicRes.rows[0]) {
      clinicId = clinicRes.rows[0].id;
    } else {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM clinic WHERE name = $1`,
        [CLINIC_NAME],
      );
      const row = found.rows[0];
      if (!row) throw new Error('seed_clinic_lookup_failed');
      clinicId = row.id;
    }

    const branchRes = await client.query<{ id: string }>(
      `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [clinicId, BRANCH_NAME, BRANCH_TZ],
    );
    let branchId: string;
    if (branchRes.rows[0]) {
      branchId = branchRes.rows[0].id;
    } else {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM branch WHERE clinic_id = $1 AND name = $2`,
        [clinicId, BRANCH_NAME],
      );
      const row = found.rows[0];
      if (!row) throw new Error('seed_branch_lookup_failed');
      branchId = row.id;
    }

    // Doctor + doctor_branch.
    const doctorRes = await client.query<{ id: string }>(
      `INSERT INTO doctor (full_name) VALUES ($1)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [DOCTOR_NAME],
    );
    let doctorId: string;
    if (doctorRes.rows[0]) {
      doctorId = doctorRes.rows[0].id;
    } else {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM doctor WHERE full_name = $1`,
        [DOCTOR_NAME],
      );
      const row = found.rows[0];
      if (!row) throw new Error('seed_doctor_lookup_failed');
      doctorId = row.id;
    }

    await client.query(
      `INSERT INTO doctor_branch (doctor_id, branch_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [doctorId, branchId],
    );

    // Receptionist (one per branch — E0-S5 widens to two branches).
    await client.query(
      `INSERT INTO receptionist (branch_id, full_name)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM receptionist WHERE branch_id = $1 AND full_name = $2
       )`,
      [branchId, RECEPTIONIST_NAME],
    );

    // Admin.
    await client.query(
      `INSERT INTO admin_user (full_name)
       SELECT $1
       WHERE NOT EXISTS (
         SELECT 1 FROM admin_user WHERE full_name = $1
       )`,
      [ADMIN_NAME],
    );

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

export { seed };
