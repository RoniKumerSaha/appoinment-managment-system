/**
 * db-clear-duplicates.ts — Cancel any duplicate future Scheduled
 * appointments for the same (patient_phone, doctor_id) pair, keeping
 * the EARLIEST start_datetime row and cancelling the rest.
 *
 * The DB enforces this via the partial unique index
 * `idx_appointment_patient_doctor_scheduled` (see 0008_appointment.sql)
 * — but the index was added AFTER some early demo data was already
 * in the table, OR the duplicate was introduced by an in-flight test
 * booking that raced the engine (e.g. a dev cancelled a row mid-test
 * and then re-booked, or ran `seed-demo` twice without a DB reset).
 *
 * The result: the patient's reschedule flow hits
 * `patient_has_future_with_doctor` even though only ONE of the rows
 * is the one they want to move. This script cancels the extra rows
 * so the patient can move the one they care about.
 *
 * Run with:
 *   pnpm exec --filter @clinic/api tsx scripts/db-clear-duplicates.ts
 *
 * Idempotent: if there are no duplicates, prints "nothing to do" and
 * exits 0. Always uses a transaction so a half-cancelled state is
 * impossible. Writes one row to `appointment_audit` per cancelled
 * appointment, so the cancellation is preserved in the audit trail
 * (matching the E4-S2 / E4-S4 / E5-S2 cancel flows).
 */
import './_load-env.js';
import { getPool, closePool } from '../src/db/pool.js';

interface DupRow {
  id: string;
  patient_phone: string;
  doctor_id: string;
  start_datetime: Date;
}

const UPDATE_CANCEL_SQL = `
  UPDATE appointment SET status = 'Cancelled' WHERE id = $1::uuid;
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO appointment_audit
    (appointment_id, actor_role, actor_id, event, payload, created_at)
  VALUES (
    $1::uuid,
    'system',
    'system:duplicate_cleanup',
    'cancelled',
    jsonb_build_object('reason', 'duplicate_cleanup'),
    now()
  );
`;

async function main(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // Find (patient_phone, doctor_id) groups that have MORE THAN ONE
    // future Scheduled appointment, plus the ids of the rows we'd
    // want to cancel (everything except the earliest start_datetime).
    const { rows } = await c.query<DupRow>(`
      WITH ranked AS (
        SELECT id,
               patient_phone,
               doctor_id,
               start_datetime,
               ROW_NUMBER() OVER (
                 PARTITION BY patient_phone, doctor_id
                 ORDER BY start_datetime ASC, id ASC
               ) AS rn
          FROM appointment
         WHERE status = 'Scheduled'
           AND start_datetime > now()
      )
      SELECT id, patient_phone, doctor_id, start_datetime
        FROM ranked
       WHERE (patient_phone, doctor_id) IN (
         SELECT patient_phone, doctor_id
           FROM ranked
          WHERE rn > 1
       )
         AND rn > 1
       ORDER BY patient_phone, doctor_id, start_datetime;
    `);

    if (rows.length === 0) {
      console.log('db-clear-duplicates: nothing to do');
      await c.query('COMMIT');
      return;
    }

    console.log(
      `db-clear-duplicates: cancelling ${rows.length} duplicate future Scheduled row(s)`,
    );
    for (const r of rows) {
      // Match the cancel-route pattern: UPDATE status + INSERT audit.
      // We do NOT call the route itself — this is a data-cleanup
      // operation, not a user action, so we bypass the route's
      // actor checks. `actor_role='system'` makes the origin
      // obvious in the audit trail.
      await c.query(UPDATE_CANCEL_SQL, [r.id]);
      await c.query(INSERT_AUDIT_SQL, [r.id]);
      console.log(
        `  ✓ cancelled ${r.id.slice(0, 8)}… patient=${r.patient_phone} doctor=${r.doctor_id.slice(0, 8)}… start=${r.start_datetime.toISOString()}`,
      );
    }

    await c.query('COMMIT');
    console.log(
      `db-clear-duplicates: done. ${rows.length} row(s) cancelled.`,
    );
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('db-clear-duplicates: fatal', err);
    await closePool();
    process.exit(1);
  });