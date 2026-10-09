/**
 * as-user-doctor-walkthrough.ts
 *
 * Drives the API the way a doctor would in the browser:
 *
 *   1. POST /auth/login (or a dev shortcut that mints a JWT — we
 *      use signClaim to simulate the same JWT the auth middleware
 *      would see).
 *   2. GET /doctor/affected (the dashboard load).
 *   3. GET /public/branches (the dashboard's branch-name lookup,
 *      so masked branches become "East Branch" / "West Branch").
 *   4. Open the cancel modal for the 7890 row (post-open
 *      re-validation, the new code path).
 *   5. POST /appointments/:id/cancel with a real reason.
 *   6. GET /doctor/affected (post-cancel refresh, confirms the
 *      row is gone).
 *   7. Try to cancel the same row again from a stale "modal" — the
 *      new onStale code path would catch this; the API contract
 *      returns 422 already_in_terminal_state.
 *
 * The script prints "OK" + a final summary line. If any step
 * diverges from what the React components would see, the script
 * exits non-zero.
 */
import './_load-env.js';
import { signClaim } from '../src/auth/jwt.js';
import { getPool, closePool } from '../src/db/pool.js';

const API = 'http://localhost:3001';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // ---- Setup: find the doctor, branch, and the 7890 row.
  const pool = await getPool();
  const c = await pool.connect();
  let doctorId: string;
  let branchId: string;
  let patientPhone: string;
  let appointmentId: string;
  try {
    const dr = await c.query<{ id: string }>(
      `SELECT id::text AS id FROM doctor WHERE full_name = 'Dr. East Lead' LIMIT 1`,
    );
    doctorId = dr.rows[0]!.id;
    const br = await c.query<{ id: string }>(
      `SELECT id::text AS id FROM branch WHERE name = 'East Branch' LIMIT 1`,
    );
    branchId = br.rows[0]!.id;
    const ar = await c.query<{ id: string; patient_phone: string }>(
      `SELECT id, patient_phone
         FROM appointment
        WHERE patient_phone = '+1231234567890'
        ORDER BY start_datetime ASC
        LIMIT 1`,
    );
    assert(ar.rows.length > 0, 'expected a 7890 row in the seed');
    appointmentId = ar.rows[0]!.id;
    patientPhone = ar.rows[0]!.patient_phone;
    // Make sure the row is Scheduled for a clean test.
    await c.query(
      `UPDATE appointment SET status = 'Scheduled' WHERE id = $1::uuid`,
      [appointmentId],
    );
  } finally {
    c.release();
  }

  // ---- Step 1: mint a doctor JWT (same shape the auth middleware
  // expects from the Authorization: Bearer header).
  const token = signClaim({
    role: 'doctor',
    sub: 'doctor-east-lead',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
  const auth = { authorization: `Bearer ${token}` };

  // ---- Step 2: GET /doctor/affected (dashboard load).
  const a1 = await fetch(`${API}/doctor/affected`, { headers: auth });
  assert(a1.status === 200, `expected 200 from /doctor/affected, got ${a1.status}`);
  const a1body = (await a1.json()) as {
    count: number;
    appointments: Array<{
      appointment_id: string;
      patient_phone: string;
      start_datetime: string;
      status: string;
    }>;
  };
  const target = a1body.appointments.find(
    (ap) => ap.appointment_id === appointmentId,
  );
  assert(
    target !== undefined,
    `expected the 7890 row (${appointmentId}) in the affected queue, got ${a1body.appointments.length} other rows`,
  );
  assert(
    target!.status === 'Scheduled',
    `expected Scheduled, got ${target!.status}`,
  );
  console.log(
    `STEP 2 OK  /doctor/affected  count=${a1body.count}  target.status=${target!.status}  target.patient_phone=${target!.patient_phone}`,
  );

  // ---- Step 3: GET /public/branches (dashboard's branch lookup).
  const b1 = await fetch(`${API}/public/branches?doctor_id=${doctorId}`, {
    headers: auth,
  });
  assert(b1.status === 200, `expected 200 from /public/branches, got ${b1.status}`);
  const b1body = (await b1.json()) as {
    branches: Array<{ id: string; name: string }>;
  };
  const branch = b1body.branches.find((br) => br.id === branchId);
  assert(
    branch !== undefined,
    `expected East Branch in branch list, got ${JSON.stringify(b1body.branches)}`,
  );
  console.log(
    `STEP 3 OK  /public/branches  count=${b1body.branches.length}  branch=${branch!.name}`,
  );

  // ---- Step 4: open the cancel modal (re-validation).
  // The new onOpenCancel re-fetches /doctor/affected; we
  // simulate that exact call and confirm the row is still
  // Scheduled (i.e. the modal WILL open).
  const a2 = await fetch(`${API}/doctor/affected`, { headers: auth });
  const a2body = (await a2.json()) as {
    appointments: Array<{ appointment_id: string; status: string }>;
  };
  const fresh = a2body.appointments.find(
    (ap) => ap.appointment_id === appointmentId,
  );
  assert(
    fresh !== undefined && fresh.status === 'Scheduled',
    `re-validation: expected row to be Scheduled, got ${JSON.stringify(fresh)}`,
  );
  console.log(
    `STEP 4 OK  re-validation  fresh.status=${fresh!.status}  -> modal opens`,
  );

  // ---- Step 5: POST /appointments/:id/cancel.
  const reason = 'as-user-doctor-walkthrough: doctor unavailable';
  const c1 = await fetch(`${API}/appointments/${appointmentId}/cancel`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  const c1text = await c1.text();
  assert(
    c1.status === 200,
    `expected 200 from cancel, got ${c1.status} ${c1text}`,
  );
  const c1body = JSON.parse(c1text) as {
    appointment: { id: string; status: string };
  };
  assert(
    c1body.appointment.status === 'Cancelled',
    `expected Cancelled, got ${c1body.appointment.status}`,
  );
  console.log(
    `STEP 5 OK  POST /appointments/:id/cancel  status=${c1body.appointment.status}  reason="${reason}"`,
  );

  // ---- Step 6: GET /doctor/affected (post-cancel refresh).
  const a3 = await fetch(`${API}/doctor/affected`, { headers: auth });
  const a3body = (await a3.json()) as {
    count: number;
    appointments: Array<{ appointment_id: string }>;
  };
  const stillThere = a3body.appointments.find(
    (ap) => ap.appointment_id === appointmentId,
  );
  assert(
    stillThere === undefined,
    `cancelled row should be gone from affected queue, but it is still there`,
  );
  console.log(
    `STEP 6 OK  /doctor/affected (post-cancel)  count=${a3body.count}  row-gone=true`,
  );

  // ---- Step 7: simulate the user trying to cancel the same row
  // from a stale modal (the new onStale safety net). The API
  // returns 422 already_in_terminal_state, NOT 404 — the safety
  // net only fires on 404 (a different, more-rare case).
  const c2 = await fetch(`${API}/appointments/${appointmentId}/cancel`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'stale-modal repro' }),
  });
  const c2text = await c2.text();
  assert(
    c2.status === 422,
    `expected 422 from re-cancel, got ${c2.status} ${c2text}`,
  );
  const c2body = JSON.parse(c2text) as { error: string };
  assert(
    c2body.error === 'already_in_terminal_state',
    `expected already_in_terminal_state, got ${c2body.error}`,
  );
  console.log(
    `STEP 7 OK  re-cancel (stale modal)  status=422  error=${c2body.error}`,
  );

  // ---- Restore the row so the script is idempotent.
  const c3 = await pool.connect();
  try {
    await c3.query(
      `UPDATE appointment SET status = 'Scheduled' WHERE id = $1::uuid`,
      [appointmentId],
    );
  } finally {
    c3.release();
  }
  console.log('CLEANUP  row restored to Scheduled for next test run.');

  await closePool();
  console.log('---');
  console.log(
    'as-user-doctor-walkthrough: ALL STEPS PASSED  (patient=' +
      patientPhone +
      '  doctor=' +
      doctorId.slice(0, 8) +
      '  branch=' +
      branch.name +
      ')',
  );
}

main().catch((err: unknown) => {
  console.error('as-user-doctor-walkthrough: FATAL', err);
  process.exit(1);
});
