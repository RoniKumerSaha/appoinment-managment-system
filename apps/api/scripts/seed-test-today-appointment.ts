/**
 * scripts/seed-test-today-appointment.ts — seed ONE appointment for
 * TODAY so the receptionist's Cancel screen has something to pick.
 *
 * WHY THIS EXISTS
 * ───────────────
 *
 * The receptionist's Cancel screen (`ReceptionistCancel.tsx`) loads
 * `GET /reception/branch/today` with ONLY a status filter — no date.
 * The API therefore returns TODAY's scheduled appointments, and the
 * screen renders "No scheduled appointments today at <branch>" when
 * there are none.
 *
 * That is correct in production: a receptionist cancels the day's
 * bookings, and by the time a booking is CANCELLED it was created on
 * an EARLIER day (FR-018 / FR-019 forbid same-day booking, so a
 * same-day appointment can only exist if it was booked yesterday).
 *
 * It is a problem for an E2E spec: on a freshly seeded dev database
 * there are no appointments for today at all (the seeds place
 * appointments ~7 days out), so the Cancel screen's picker is empty
 * and the screen cannot be exercised. Waiting until "tomorrow" to
 * run the spec is not a test strategy.
 *
 * This script writes the row directly, bypassing the booking API's
 * same-day guard — the same fixture-policy exception the E0-S5
 * `reset-test-appointments.ts` script makes for DELETING rows
 * (FR-038 forbids DELETE on appointments via the API).
 *
 * FIXTURE POLICY
 * ──────────────
 *
 *   - The patient phone uses the test prefix `+1555000%`, so
 *     `reset-test-appointments.ts` wipes it between runs and it can
 *     never collide with a real patient's data.
 *   - The appointment is dated inside the branch's local TODAY, at
 *     09:00 branch time, so it lands on the branch's "today" board
 *     regardless of the runner's own timezone.
 *   - The row is INSERTed as `Scheduled` with `created_by =
 *     'staff:e2e-seed'` — the `created_by` column is CHECK-constrained
 *     to `^(staff|patient):...`, so the prefix must be present.
 *   - Re-running the script is idempotent: it removes any previous
 *     row for the same phone+slot before inserting.
 *
 * Run with:
 *   pnpm exec tsx scripts/seed-test-today-appointment.ts
 */
import { getPool, closePool } from '../src/db/pool.js';

/** The test-prefixed phone the seeded row belongs to. */
const TEST_PHONE = '+15550000007';

/** The branch the receptionist owns. */
const BRANCH_NAME = 'East Branch';

/** The doctor the row is booked with. */
const DOCTOR_NAME = 'Dr. East Support';

async function main(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const branchRes = await client.query<{ id: string; tz: string }>(
      `SELECT id, tz FROM branch WHERE name = $1 AND active`,
      [BRANCH_NAME],
    );
    const branch = branchRes.rows[0];
    if (branch === undefined) {
      throw new Error(`branch "${BRANCH_NAME}" not found — run the seed first`);
    }

    // A doctor assigned to the branch (doctor_branch is the join
    // table). Prefer the seeded support doctor, but fall back to any
    // active doctor on the branch so the script survives a seed
    // change.
    const doctorRes = await client.query<{ id: string; full_name: string }>(
      `SELECT d.id, d.full_name
         FROM doctor d
         JOIN doctor_branch db ON db.doctor_id = d.id
        WHERE db.branch_id = $1 AND d.active
        ORDER BY (d.full_name = $2) DESC, d.full_name
        LIMIT 1`,
      [branch.id, DOCTOR_NAME],
    );
    const doctor = doctorRes.rows[0];
    if (doctor === undefined) {
      throw new Error(`no active doctor assigned to branch "${BRANCH_NAME}"`);
    }

    const typeRes = await client.query<{ id: string }>(
      `SELECT id FROM appointment_type
        WHERE clinic_id = (SELECT clinic_id FROM branch WHERE id = $1)
          AND is_active
        ORDER BY name
        LIMIT 1`,
      [branch.id],
    );
    const type = typeRes.rows[0];
    if (type === undefined) {
      throw new Error('no active appointment type found');
    }

    // 09:00 branch-local time on the branch's calendar day.
    //
    // The arithmetic happens on a NAIVE timestamp (the branch-local
    // wall clock), and the final `AT TIME ZONE` converts that wall
    // clock back into the UTC instant. Doing it the other way round
    // — letting Postgres cast the naive value to `timestamptz` on
    // its own — would interpret it in the DATABASE's timezone (UTC),
    // not the branch's, and land the row on the wrong day.
    const startRes = await client.query<{ start: Date; end: Date }>(
      `SELECT
         (((now() AT TIME ZONE $1::text)::date + INTERVAL '9 hours')
            AT TIME ZONE $1::text) AS start,
         (((now() AT TIME ZONE $1::text)::date + INTERVAL '9 hours 30 minutes')
            AT TIME ZONE $1::text) AS end`,
      [branch.tz],
    );
    const { start, end } = startRes.rows[0]!;

    // Idempotent: drop any previous row for this fixture phone, and
    // free the slot if something else already holds it.
    await client.query(
      `DELETE FROM appointment_audit
        WHERE appointment_id IN (
          SELECT id FROM appointment WHERE patient_phone = $1
        )`,
      [TEST_PHONE],
    );
    await client.query(`DELETE FROM appointment WHERE patient_phone = $1`, [
      TEST_PHONE,
    ]);

    const inserted = await client.query<{ id: string; start_datetime: Date }>(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone,
          appointment_type_id, start_datetime, end_datetime,
          status, created_by)
       VALUES
         ((SELECT clinic_id FROM branch WHERE id = $1), $1, $2, $3, $4, $5, $6,
          'Scheduled', 'staff:e2e-seed')
       RETURNING id, start_datetime`,
      [branch.id, doctor.id, TEST_PHONE, type.id, start, end],
    );

    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log(
      `seed_test_today_appointment_complete id=${inserted.rows[0]!.id} phone=${TEST_PHONE} start=${inserted.rows[0]!.start_datetime.toISOString()}`,
    );
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
  console.error('seed_test_today_appointment_failed', err);
  process.exitCode = 1;
});
