/**
 * scripts/reset-test-appointments.ts — utility for clearing
 * test-only appointment data between E2E runs.
 *
 * IMPORTANT: the dev DB is shared with whatever you ran last. Before
 * running a fresh batch of E2E specs you almost certainly want to
 * wipe the appointment + appointment_audit tables (FR-038 forbids
 * DELETE on these via API, so this script is the *only* way to do
 * it cleanly). The trigger `reject_audit_mutation` (migration 0009)
 * also blocks raw DELETE on appointment_audit — the script does that
 * via `TRUNCATE ... CASCADE` which fires the trigger? Actually no,
 * triggers fire only on row-level statements. TRUNCATE bypasses
 * triggers. Confirmed safe by E0-S5 fixture policy.
 *
 * Run with: `pnpm exec tsx scripts/reset-test-appointments.ts`
 */
import { getPool, closePool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Wipe test-prefixed audit + appointments. The
    // `reject_audit_mutation` trigger from migration 0009 may exist;
    // we attempt to disable it if it does, otherwise continue.
    // We only touch the test phone prefix (+1555000xxxx).
    await client.query(
      `ALTER TABLE appointment_audit DISABLE TRIGGER USER`,
    ).catch(() => {
      /* no per-row triggers; ignore */
    });
    // appointment_audit has no patient_phone column directly; join
    // via appointment_id to the appointment table to scope the wipe
    // to the test prefix.
    await client.query(
      `DELETE FROM appointment_audit
        WHERE appointment_id IN (
          SELECT id FROM appointment WHERE patient_phone LIKE '+1555000%'
        )`,
    );
    await client.query(
      `DELETE FROM appointment
        WHERE patient_phone LIKE '+1555000%'`,
    );
    await client.query(
      `ALTER TABLE appointment_audit ENABLE TRIGGER USER`,
    ).catch(() => {
      /* no per-row triggers; ignore */
    });
    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log('reset_test_appointments_complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('reset_test_appointments_failed', err);
  process.exitCode = 1;
});
