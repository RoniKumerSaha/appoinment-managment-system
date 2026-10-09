/**
 * verify-cancel-stale-handling.ts — exercise the
 * doctor-cancel 404 race end-to-end. The test:
 *
 *  1. Picks the 7890 row (phone +1231234567890).
 *  2. GET /doctor/affected as Dr. East Lead — confirms the
 *     row is in the queue.
 *  3. Cancels the row via the staff-doctor-cancel route
 *     (mimicking a parallel action).
 *  4. GET /doctor/affected again — confirms the row is gone
 *     (cancelled rows don't appear in the affected queue,
 *     which only surfaces Scheduled rows).
 *  5. Tries to cancel the (now Cancelled) row from the
 *     stale doctor's modal — confirms the API returns
 *     `already_in_terminal_state` (422) NOT `not_found`
 *     (404), because the row still exists in the DB.
 *
 * The web-side `onOpenCancel` re-validation now prevents
 * the modal from even opening for a non-Scheduled row.
 * This script just confirms the server-side envelope is
 * correct (so the post-submit safety net would also work).
 */
import './_load-env.js';
import { signClaim } from '../src/auth/jwt.js';
import { getPool, closePool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  let appointmentId: string;
  let doctorId: string;
  let branchId: string;
  try {
    const r = await c.query<{
      id: string;
      doctor_id: string;
      branch_id: string;
    }>(
      `SELECT id, doctor_id::text AS doctor_id, branch_id::text AS branch_id
         FROM appointment
        WHERE patient_phone = '+1231234567890'
        ORDER BY start_datetime ASC
        LIMIT 1`,
    );
    if (r.rows.length === 0) {
      throw new Error('No 7890 row found in DB; ensure seed ran.');
    }
    appointmentId = r.rows[0]!.id;
    doctorId = r.rows[0]!.doctor_id;
    branchId = r.rows[0]!.branch_id;
    // Make sure the row is Scheduled for this test.
    await c.query(
      `UPDATE appointment SET status = 'Scheduled' WHERE id = $1::uuid`,
      [appointmentId],
    );
  } finally {
    c.release();
  }

  const doctorToken = signClaim({
    role: 'doctor',
    sub: 'doctor-east-lead',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${doctorToken}`,
  };

  // 1. Initial affected-queue — should include the row.
  const a1 = await fetch('http://localhost:3001/doctor/affected', { headers });
  const body1 = (await a1.json()) as {
    count: number;
    appointments: Array<{ appointment_id: string; status: string }>;
  };
  const before = body1.appointments.find(
    (ap) => ap.appointment_id === appointmentId,
  );
  console.log(
    '1. affected-queue before:',
    a1.status,
    'count=' + body1.count,
    'row present=' + (before !== undefined),
    'status=' + before?.status,
  );
  if (before === undefined) {
    throw new Error('Row not in initial affected queue (seed/setup issue).');
  }

  // 2. Cancel the row via the staff-doctor-cancel route.
  const c2 = await fetch(
    `http://localhost:3001/appointments/${appointmentId}/cancel`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Stale-handling test cancel' }),
    },
  );
  console.log('2. cancel row:', c2.status, await c2.text());

  // 3. Affected-queue after — should NOT include the row.
  const a3 = await fetch('http://localhost:3001/doctor/affected', { headers });
  const body3 = (await a3.json()) as {
    count: number;
    appointments: Array<{ appointment_id: string }>;
  };
  const after = body3.appointments.find(
    (ap) => ap.appointment_id === appointmentId,
  );
  console.log(
    '3. affected-queue after:',
    a3.status,
    'count=' + body3.count,
    'row present=' + (after !== undefined),
  );
  if (after !== undefined) {
    throw new Error('Cancelled row still in affected queue (filter broken).');
  }

  // 4. Try the cancel again — should return 422
  //    already_in_terminal_state, NOT 404. (Web onStale
  //    only fires on 404, but this confirms the API contract
  //    for a row that exists in DB but is not Scheduled.)
  const c4 = await fetch(
    `http://localhost:3001/appointments/${appointmentId}/cancel`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Stale-handling re-cancel' }),
    },
  );
  const c4body = await c4.text();
  console.log('4. re-cancel cancelled row:', c4.status, c4body);
  if (c4.status !== 422) {
    throw new Error(
      `Expected 422 already_in_terminal_state for a re-cancel, got ${c4.status} ${c4body}`,
    );
  }
  if (!c4body.includes('already_in_terminal_state')) {
    throw new Error(`Expected error code already_in_terminal_state, got ${c4body}`);
  }

  // 5. Restore the row to Scheduled so the test is idempotent.
  const c5 = await pool.connect();
  try {
    await c5.query(
      `UPDATE appointment SET status = 'Scheduled' WHERE id = $1::uuid`,
      [appointmentId],
    );
  } finally {
    c5.release();
  }
  console.log('5. row restored to Scheduled for next test run.');

  await closePool();
  console.log('verify-cancel-stale-handling: OK');
}

main().catch((err: unknown) => {
  console.error('verify-cancel-stale-handling: FAIL', err);
  process.exit(1);
});
