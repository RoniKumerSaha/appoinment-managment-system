/**
 * 03-patient-self-service.test.ts — Patient's verified-self surface.
 *
 * Coverage:
 *   - GET   /patient/profile?phone=<E.164>
 *   - GET   /patient/appointments          (phone-bound, future-only, Scheduled-only)
 *   - POST  /patient/appointments/:id/cancel   (E7-S3 privacy filter)
 *   - POST  /patient/appointments/:id/reschedule
 *   - GET   /patient/appointments/:id/deep-link
 *
 * Test isolation strategy:
 *   - 5 patient phones × 3 doctors × 2 branches gives 30 distinct
 *     (patient, doctor) pairs. FR-027's partial unique constraint
 *     blocks two Scheduled rows for the same pair, so each test
 *     pins a unique combination.
 *   - The seed already inserts one Scheduled row for patient 0001 with
 *     Dr. East Lead @ branch-east; we reuse that row for the privacy
 *     filter tests instead of inserting duplicates.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signClaim } from '../src/auth/jwt.js';
import { __resetAuthConfigForTests } from '../src/auth/config.js';
import { createApp } from '../src/app.js';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { seedWith } from '../db/seeds/01_minimum.js';

const VALID_SECRET = 'a'.repeat(48);
let db: TestDb;

// Patient 0001 has a seeded future Scheduled appt (East Lead @ East).
// Patients 0002..0005 are clean.
const PATIENT_A = '+15550000001'; // has seeded appt with Dr. East Lead
const PATIENT_B = '+15550000002';
const PATIENT_C = '+15550000003';
const PATIENT_D = '+15550000004';
const PATIENT_E = '+15550000005';

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
  db = await getTestDb();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    // Insert doctor_schedule rows for East Lead (all 7 days, 09-17 local)
    // so reschedule tests don't trip `doctor_unavailable`. The seed does
    // not create schedules; the test setup does.
    await client.query(
      `INSERT INTO doctor_schedule
         (doctor_id, branch_id, day_of_week, start_time, end_time, effective_from, created_by)
       SELECT d.id, b.id, dow, '09:00:00'::time, '17:00:00'::time, '2020-01-01'::date, 'staff:test-setup'
         FROM doctor d, branch b, generate_series(0, 6) AS dow
        WHERE d.full_name = 'Dr. East Lead'
          AND b.name = 'East Branch'
        ON CONFLICT DO NOTHING`,
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

after(async () => {
  delete process.env['AUTH_SECRET'];
  __resetAuthConfigForTests();
  // No-op: appointment_audit is append-only and the FK from
  // appointment_audit to appointment blocks DELETE on appointment. Test
  // data accumulates across runs but each test uses distinct
  // (patient, doctor) pairs so FR-027 doesn't conflict.
});

function patientToken(phone: string): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
}

// Helper: insert a future Scheduled appointment for the given (patient, doctor)
// at the given branch, at a known future UTC time. Returns the appointment id.
async function insertFutureAppt(
  patientPhone: string,
  doctorName: string,
  branchName: string,
  daysOut: number,
  hourUtc: number,
): Promise<{ id: string; branchId: string; typeId: string }> {
  const ins = await db.pool.query<{ id: string; branch_id: string; appointment_type_id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, b.id, d.id, $1, t.id,
            (current_date + $2::int) + $3::time,
            (current_date + $2::int) + $3::time + interval '30 minutes',
            'Scheduled', 'patient:' || $1
       FROM clinic c, branch b, doctor d, appointment_type t, doctor_branch db
      WHERE b.name = $4
        AND d.full_name = $5
        AND t.name = 'General Consultation'
        AND db.doctor_id = d.id AND db.branch_id = b.id
      LIMIT 1
     RETURNING id, branch_id, appointment_type_id`,
    [patientPhone, daysOut, `${String(hourUtc).padStart(2, '0')}:00:00`, branchName, doctorName],
  );
  if (!ins.rows[0]) {
    throw new Error(`insertFutureAppt failed for ${patientPhone}/${doctorName}/${branchName}`);
  }
  return {
    id: ins.rows[0].id,
    branchId: ins.rows[0].branch_id,
    typeId: ins.rows[0].appointment_type_id,
  };
}

// ═══════════════════════════════════════════════════════════════════
// /patient/profile
// ═══════════════════════════════════════════════════════════════════
test('GET /patient/profile?phone=known → 200 with full_name', async () => {
  const res = await request(createApp())
    .get(`/patient/profile?phone=${encodeURIComponent(PATIENT_A)}`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_A)}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.patient, 'object');
  assert.equal(res.body.patient.phone_number, PATIENT_A);
  assert.equal(typeof res.body.patient.full_name, 'string');
});

test('GET /patient/profile?phone=unknown → 404 patient_not_found', async () => {
  const res = await request(createApp())
    .get(`/patient/profile?phone=${encodeURIComponent('+15559999999')}`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_A)}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'patient_not_found');
});

test('GET /patient/profile (no phone) → 400 missing_patient_phone', async () => {
  const res = await request(createApp())
    .get('/patient/profile')
    .set('Authorization', `Bearer ${patientToken(PATIENT_A)}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_patient_phone');
});

test('GET /patient/profile?phone=not-e164 → 400 invalid_patient_phone', async () => {
  const res = await request(createApp())
    .get('/patient/profile?phone=not-a-phone')
    .set('Authorization', `Bearer ${patientToken(PATIENT_A)}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_patient_phone');
});

test('GET /patient/profile without auth → 401 unauthenticated', async () => {
  const res = await request(createApp()).get(`/patient/profile?phone=${PATIENT_A}`);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

// ═══════════════════════════════════════════════════════════════════
// /patient/appointments — phone-bound, future-only, Scheduled-only
// ═══════════════════════════════════════════════════════════════════
test('GET /patient/appointments (patient A) → 200 with their future Scheduled rows', async () => {
  // Seed inserted one future appointment for patient A.
  const res = await request(createApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${patientToken(PATIENT_A)}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.appointments));
  for (const appt of res.body.appointments) {
    assert.equal(appt.status, 'Scheduled');
    assert.ok(new Date(appt.start_datetime).getTime() > Date.now());
  }
});

test('GET /patient/appointments (patient C, no appts) → 200 with empty list', async () => {
  const res = await request(createApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${patientToken(PATIENT_C)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.appointments, []);
});

test('GET /patient/appointments (non-patient role) → 403 forbidden_role', async () => {
  const adminToken = signClaim({
    sub: 'admin-main@clinic.local',
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
  const res = await request(createApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /patient/appointments without auth → 401', async () => {
  const res = await request(createApp()).get('/patient/appointments');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

// ═══════════════════════════════════════════════════════════════════
// /patient/appointments/:id/cancel
// ═══════════════════════════════════════════════════════════════════
test('POST /patient/appointments/:id/cancel (own) → 200, status=Cancelled', async () => {
  // Use patient B + Dr. East Support (different doctor to avoid FR-027)
  const appt = await insertFutureAppt(PATIENT_B, 'Dr. East Support', 'East Branch', 2, 14);
  const res = await request(createApp())
    .post(`/patient/appointments/${appt.id}/cancel`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_B)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'Cancelled');
});

test('POST /patient/appointments/:id/cancel (other patient) → 404 privacy filter', async () => {
  // Patient A has the seeded appt with East Lead. Patient C tries to cancel it.
  const seedRow = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment WHERE patient_phone = $1 LIMIT 1`,
    [PATIENT_A],
  );
  const apptId = seedRow.rows[0]!.id;

  const res = await request(createApp())
    .post(`/patient/appointments/${apptId}/cancel`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_C)}`);
  // Privacy filter: same envelope as a non-existent row.
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('POST /patient/appointments/:id/cancel (non-UUID id) → 404 not_found', async () => {
  const res = await request(createApp())
    .post('/patient/appointments/not-a-uuid/cancel')
    .set('Authorization', `Bearer ${patientToken(PATIENT_B)}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

// ═══════════════════════════════════════════════════════════════════
// /patient/appointments/:id/reschedule
// ═══════════════════════════════════════════════════════════════════
test('POST /patient/appointments/:id/reschedule (own) → 200 with new time', async () => {
  // Patient D + East Lead
  const appt = await insertFutureAppt(PATIENT_D, 'Dr. East Lead', 'East Branch', 3, 10);
  // Pick a new time on a different day (still within doctor's 09-17 schedule)
  const newStart = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  newStart.setUTCHours(15, 0, 0, 0);
  const newEnd = new Date(newStart.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post(`/patient/appointments/${appt.id}/reschedule`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_D)}`)
    .send({
      new_branch_id: appt.branchId,
      new_appointment_type_id: appt.typeId,
      new_start_datetime: newStart.toISOString(),
      new_end_datetime: newEnd.toISOString(),
      new_slot_duration_minutes: 30,
    });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment.status, 'Scheduled');
});

test('POST /patient/appointments/:id/reschedule rejects new_doctor_id (FR-040)', async () => {
  // Patient E + East Lead
  const appt = await insertFutureAppt(PATIENT_E, 'Dr. East Lead', 'East Branch', 5, 11);
  const newStart = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
  newStart.setUTCHours(15, 0, 0, 0);
  const newEnd = new Date(newStart.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post(`/patient/appointments/${appt.id}/reschedule`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_E)}`)
    .send({
      new_doctor_id: '00000000-0000-0000-0000-000000000000', // FORBIDDEN
      new_branch_id: appt.branchId,
      new_appointment_type_id: appt.typeId,
      new_start_datetime: newStart.toISOString(),
      new_end_datetime: newEnd.toISOString(),
      new_slot_duration_minutes: 30,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('POST /patient/appointments/:id/reschedule (other patient) → 404 privacy filter', async () => {
  // Patient D's appt (East Lead), patient C tries to reschedule
  const ownRow = await db.pool.query<{ id: string; branch_id: string; appointment_type_id: string }>(
    `SELECT id, branch_id, appointment_type_id FROM appointment WHERE patient_phone = $1 LIMIT 1`,
    [PATIENT_D],
  );
  const appt = ownRow.rows[0]!;
  const newStart = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  newStart.setUTCHours(15, 0, 0, 0);

  const res = await request(createApp())
    .post(`/patient/appointments/${appt.id}/reschedule`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_C)}`)
    .send({
      new_branch_id: appt.branch_id,
      new_appointment_type_id: appt.appointment_type_id,
      new_start_datetime: newStart.toISOString(),
      new_end_datetime: new Date(newStart.getTime() + 30 * 60 * 1000).toISOString(),
      new_slot_duration_minutes: 30,
    });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

// ═══════════════════════════════════════════════════════════════════
// /patient/appointments/:id/deep-link
// ═══════════════════════════════════════════════════════════════════
test('GET /patient/appointments/:id/deep-link (own) → 200 with can_cancel=true', async () => {
  // Patient A has the seeded appointment
  const seedRow = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment WHERE patient_phone = $1 LIMIT 1`,
    [PATIENT_A],
  );
  const apptId = seedRow.rows[0]!.id;
  const res = await request(createApp())
    .get(`/patient/appointments/${apptId}/deep-link`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_A)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment_id, apptId);
  assert.equal(res.body.can_cancel, true);
  assert.equal(res.body.can_reschedule, true);
  assert.ok(res.body.appointment);
});

test('GET /patient/appointments/:id/deep-link (other patient) → 404 privacy filter', async () => {
  // Patient E's appt, patient C tries to deep-link
  const ownRow = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment WHERE patient_phone = $1 LIMIT 1`,
    [PATIENT_E],
  );
  const apptId = ownRow.rows[0]!.id;
  const res = await request(createApp())
    .get(`/patient/appointments/${apptId}/deep-link`)
    .set('Authorization', `Bearer ${patientToken(PATIENT_C)}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

// ═══════════════════════════════════════════════════════════════════
// GET /availability — the reschedule preview
//
// The bug this pins: the availability preview applied FR-027 ("this
// patient already has a future appointment with this doctor → zero
// slots") WITHOUT excluding the appointment being moved. The row
// being rescheduled IS a future Scheduled row for that patient+doctor,
// so the preview returned zero slots to exactly the patient who was
// trying to reschedule — and the UI told them to cancel first.
//
// The commit-time recheck in routes/patient-reschedule.ts has always
// excluded it (`id <> $3`). The preview must agree, or the server
// contradicts itself.
// ═══════════════════════════════════════════════════════════════════

/** A date inside the 30-day window, as YYYY-MM-DD (UTC).
 *
 *  The seed closes every branch on Sundays (`is_closed` for DOW 0) and
 *  gives no doctor a Sunday schedule, so a Sunday date would come back
 *  `branch_closed` before the patient filters ever run. Walk forward
 *  until we land on an open day. */
function dateInWindow(daysOut: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOut);
  while (d.getUTCDay() === 0) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/** The same date helper, but as a `current_date + N` offset that the
 *  appointment insert can use — so the appointment lands on an OPEN
 *  day too. Keeps the fixture and the queried date in step. */
function openDayOffset(daysOut: number): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOut);
  let offset = daysOut;
  while (d.getUTCDay() === 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    offset += 1;
  }
  return offset;
}

/** Insert an appointment on an open (non-Sunday) day at a distinct
 *  hour, so the `appointment_no_overlap` constraint (doctor, branch,
 *  time) never collides with another fixture in this file. */
async function insertOpenDayAppt(
  patientPhone: string,
  doctorName: string,
  branchName: string,
  daysOut: number,
  hourUtc: number,
): Promise<{ id: string; branchId: string; typeId: string }> {
  return insertFutureAppt(
    patientPhone,
    doctorName,
    branchName,
    openDayOffset(daysOut),
    hourUtc,
  );
}

test('GET /availability for a patient who HOLDS the appointment → zero slots (FR-027, no exclusion)', async () => {
  // Patient B + East Lead. This is the plain availability lookup —
  // no exclude_appointment_id — so FR-027 correctly fires: the
  // patient may not book a second appointment with the same doctor.
  const appt = await insertOpenDayAppt(PATIENT_B, 'Dr. East Lead', 'East Branch', 6, 15);
  const doctor = await db.pool.query<{ id: string }>(
    `SELECT d.id FROM doctor d WHERE d.full_name = 'Dr. East Lead'`,
  );

  const res = await request(createApp())
    .get('/availability')
    .query({
      doctor_id: doctor.rows[0]!.id,
      branch_id: appt.branchId,
      date: dateInWindow(5),
      appointment_type_id: appt.typeId,
    })
    .set('Authorization', `Bearer ${patientToken(PATIENT_B)}`);

  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.slots.length, 0);
  assert.equal(res.body.reason, 'patient_has_future_with_doctor');
});

test('GET /availability with exclude_appointment_id → slots are offered (reschedule preview)', async () => {
  // The regression: the same patient, the same doctor, the same
  // request — but excluding the row being moved. The preview must
  // now offer slots, otherwise the patient can only cancel and
  // rebook.
  const appt = await insertOpenDayAppt(PATIENT_C, 'Dr. East Lead', 'East Branch', 3, 12);
  const doctor = await db.pool.query<{ id: string }>(
    `SELECT d.id FROM doctor d WHERE d.full_name = 'Dr. East Lead'`,
  );

  const res = await request(createApp())
    .get('/availability')
    .query({
      doctor_id: doctor.rows[0]!.id,
      branch_id: appt.branchId,
      date: dateInWindow(5),
      appointment_type_id: appt.typeId,
      exclude_appointment_id: appt.id,
    })
    .set('Authorization', `Bearer ${patientToken(PATIENT_C)}`);

  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.ok(
    res.body.slots.length > 0,
    `expected slots for the reschedule preview, got ${JSON.stringify(res.body)}`,
  );
  assert.equal(res.body.reason, undefined);
});

test('GET /availability with exclude_appointment_id does not clear FR-027 for OTHER patients', async () => {
  // The exclusion must be narrow: it removes exactly the row being
  // moved, not every row for this patient — and certainly not other
  // patients' rows. Patient D asks to exclude Patient C's
  // appointment; FR-027 must still fire on Patient D's OWN
  // appointment with the same doctor.
  const cAppt = await insertOpenDayAppt(PATIENT_C, 'Dr. East Support', 'East Branch', 3, 10);
  const dAppt = await insertOpenDayAppt(PATIENT_D, 'Dr. East Support', 'East Branch', 4, 13);
  const doctor = await db.pool.query<{ id: string }>(
    `SELECT d.id FROM doctor d WHERE d.full_name = 'Dr. East Support'`,
  );

  const res = await request(createApp())
    .get('/availability')
    .query({
      doctor_id: doctor.rows[0]!.id,
      branch_id: dAppt.branchId,
      date: dateInWindow(5),
      appointment_type_id: dAppt.typeId,
      // Excluding somebody ELSE's appointment must not help.
      exclude_appointment_id: cAppt.id,
    })
    .set('Authorization', `Bearer ${patientToken(PATIENT_D)}`);

  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.slots.length, 0);
  assert.equal(res.body.reason, 'patient_has_future_with_doctor');
});

test('GET /availability with a malformed exclude_appointment_id → 400', async () => {
  const res = await request(createApp())
    .get('/availability')
    .query({
      doctor_id: '00000000-0000-0000-0000-000000000001',
      branch_id: '00000000-0000-0000-0000-000000000002',
      date: dateInWindow(5),
      appointment_type_id: '00000000-0000-0000-0000-000000000003',
      exclude_appointment_id: 'not-a-uuid',
    })
    .set('Authorization', `Bearer ${patientToken(PATIENT_A)}`);

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_exclude_appointment_id');
});
