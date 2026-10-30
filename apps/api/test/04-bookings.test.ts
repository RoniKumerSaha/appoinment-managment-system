/**
 * 04-bookings.test.ts — POST /bookings + GET /availability.
 *
 * Coverage:
 *   - GET   /availability  (patient, with all valid query params)
 *   - POST  /bookings      (happy path + all 409 conflict codes)
 *
 * Notes:
 *   - The route is open to any authenticated role; patients self-book,
 *     receptionists book on behalf of patients.
 *   - The atomic + GIST-protected guarantee is covered by
 *     `no-tentative-holds-concurrent.test.ts`; this file focuses on the
 *     user-facing contract.
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

const PATIENT = '+15550000003'; // clean — no existing appts

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
  db = await getTestDb();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
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
});

function patientToken(phone: string): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
}

async function lookupIds() {
  const { rows: drows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = 'Dr. East Lead'`,
  );
  const { rows: brows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = 'East Branch'`,
  );
  const { rows: trows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (!drows[0] || !brows[0] || !trows[0]) throw new Error('seed missing');
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

// ═══════════════════════════════════════════════════════════════════
// GET /availability
// ═══════════════════════════════════════════════════════════════════
test('GET /availability → 401 without auth', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const res = await request(createApp())
    .get(`/availability?doctor_id=${doctorId}&branch_id=${branchId}&date=${tomorrowIso()}&appointment_type_id=${typeId}`);
  assert.equal(res.status, 401);
});

test('GET /availability → 200 with slots for valid params', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  // Pick the next weekday so the branch isn't closed.
  const date = nextWeekdayIso();
  const res = await request(createApp())
    .get(`/availability?doctor_id=${doctorId}&branch_id=${branchId}&date=${date}&appointment_type_id=${typeId}`)
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body.slots), 'slots array expected');
});

test('GET /availability → 400 invalid_doctor_id for non-UUID', async () => {
  const res = await request(createApp())
    .get('/availability?doctor_id=not-a-uuid&branch_id=00000000-0000-0000-0000-000000000000&date=2099-01-01&appointment_type_id=00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

// ═══════════════════════════════════════════════════════════════════
// POST /bookings — happy path + error matrix
// ═══════════════════════════════════════════════════════════════════
test('POST /bookings happy path → 201 with appointment', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  // 14:00 UTC = 10:00 EDT, within the doctor's 09-17 schedule. The
  // helper lands on a weekday so the branch isn't closed.
  const start = nextWeekdayAt14Utc(2);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: PATIENT,
      patient_name: 'Bookings Test Patient',
    });
  assert.equal(res.status, 201, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment.status, 'Scheduled');
  // Audit row must record the patient as actor (body-claim invariant:
  // role is taken from the JWT, not the body).
  const apptId = res.body.appointment.id;
  const audit = await db.pool.query<{ actor_id: string; actor_role: string }>(
    `SELECT actor_id, actor_role FROM appointment_audit
       WHERE appointment_id = $1 AND event = 'created'`,
    [apptId],
  );
  assert.equal(audit.rows[0]!.actor_id, `patient:${PATIENT}`);
  assert.equal(audit.rows[0]!.actor_role, 'patient');
});

test('POST /bookings (FR-027) a second non-recurring booking with the same patient+doctor → 409 patient_has_future_with_doctor', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  // A dedicated patient so the assertion does not depend on rows left
  // behind by other test files.
  const phone = '+15550000991';

  // Pick slots via the availability route so the assertions are not
  // racing other tests for the same 14:00 slot. Two different days,
  // so nothing but FR-027 can cause the second booking to fail.
  const firstSlot = await firstFreeSlot(doctorId, branchId, typeId, 2);
  const secondSlot = await firstFreeSlot(doctorId, branchId, typeId, 3);

  const firstRes = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(phone)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: firstSlot.start_datetime,
      end_datetime: firstSlot.end_datetime,
      slot_duration_minutes: 30,
      patient_phone: phone,
      patient_name: 'FR-027 Patient',
    });
  assert.equal(firstRes.status, 201, `body=${JSON.stringify(firstRes.body)}`);

  const secondRes = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(phone)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: secondSlot.start_datetime,
      end_datetime: secondSlot.end_datetime,
      slot_duration_minutes: 30,
      patient_phone: phone,
      patient_name: 'FR-027 Patient',
    });
  assert.equal(secondRes.status, 409, `body=${JSON.stringify(secondRes.body)}`);
  assert.equal(secondRes.body.error, 'patient_has_future_with_doctor');
});

test('POST /bookings slot_in_past → 409 slot_in_past', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: PATIENT,
      patient_name: 'Past Test',
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'slot_in_past');
});

test('POST /bookings outside_30d_window → 409', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const start = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60d
  start.setUTCHours(14, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: PATIENT,
      patient_name: 'Future Test',
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'outside_30d_window');
});

test('POST /bookings duration_mismatch → 409', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const start = nextWeekdayAt14Utc(3);
  // 60min slot but type is 30min
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 60,
      patient_phone: PATIENT,
      patient_name: 'Mismatch Test',
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'duration_mismatch');
});

test('POST /bookings unknown_field (e.g. role) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const start = nextWeekdayAt14Utc(4);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: PATIENT,
      patient_name: 'Unknown Field',
      role: 'admin', // not allowed in body — rejected by whitelist
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('POST /bookings invalid_patient_phone → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const start = nextWeekdayAt14Utc(5);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: 'not-a-phone',
      patient_name: 'Bad Phone',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_patient_phone');
});

test('POST /bookings doctor_not_found → 404', async () => {
  const { branchId, typeId } = await lookupIds();
  const start = nextWeekdayAt14Utc(6);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({
      doctor_id: '00000000-0000-0000-0000-000000000000', // not in seed
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: PATIENT,
      patient_name: 'Ghost Doctor',
    });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'doctor_not_found');
});

// ═══════════════════════════════════════════════════════════════════
// POST /bookings — the phone comes from the session, the name is
// optional for a patient self-booking.
// ═══════════════════════════════════════════════════════════════════

test('POST /bookings: a patient books WITHOUT a name → 201, patient row has NULL name', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const phone = '+15550000077';
  // A slot of its own — the whole suite shares one database, so this
  // must not collide with any other test's booking.
  const start = nextWeekdayAt(16, 8);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(phone)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: phone,
      patient_name: '',
    });
  assert.equal(res.status, 201, `body=${JSON.stringify(res.body)}`);

  const row = await db.pool.query<{ full_name: string | null }>(
    `SELECT full_name FROM patient WHERE phone_number = $1`,
    [phone],
  );
  assert.equal(row.rows[0]!.full_name, null, 'empty name is stored as NULL');
});

test('POST /bookings: an empty name does NOT wipe the stored name', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const phone = '+15550000078';
  // Seed the patient with a name on file.
  await db.pool.query(
    `INSERT INTO patient (phone_number, full_name) VALUES ($1, $2)`,
    [phone, 'Original Name'],
  );
  const start = nextWeekdayAt(17, 9);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(phone)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: phone,
      patient_name: '   ',
    });
  assert.equal(res.status, 201, `body=${JSON.stringify(res.body)}`);

  const row = await db.pool.query<{ full_name: string | null }>(
    `SELECT full_name FROM patient WHERE phone_number = $1`,
    [phone],
  );
  assert.equal(
    row.rows[0]!.full_name,
    'Original Name',
    'a nameless booking must not erase the name on file',
  );
});

test('POST /bookings: the appointment phone comes from the SESSION, not the body', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const sessionPhone = '+15550000079';
  const otherPhone = '+15550000080';
  const start = nextWeekdayAt(18, 10);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken(sessionPhone)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      // A patient cannot book under somebody else's number.
      patient_phone: otherPhone,
      patient_name: 'Someone Else',
    });
  assert.equal(res.status, 201, `body=${JSON.stringify(res.body)}`);

  const appt = await db.pool.query<{ patient_phone: string }>(
    `SELECT patient_phone FROM appointment WHERE id = $1`,
    [res.body.appointment.id],
  );
  assert.equal(
    appt.rows[0]!.patient_phone,
    sessionPhone,
    'the appointment is filed under the signed-in phone',
  );

  const other = await db.pool.query<{ id: string }>(
    `SELECT id FROM patient WHERE phone_number = $1`,
    [otherPhone],
  );
  assert.equal(
    other.rows.length,
    0,
    'no patient row is created for the phone in the body',
  );
});

test('POST /bookings: a RECEPTIONIST booking without a name → 400 invalid_patient_name', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const start = nextWeekdayAt(19, 11);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const token = signClaim({
    sub: 'receptionist-east@clinic.local',
    role: 'receptionist',
    branch_ids: [branchId],
    scope: 'branch',
  });

  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      slot_duration_minutes: 30,
      patient_phone: '+15550000081',
      patient_name: '',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_patient_name');
});

// ── helpers ──
function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Returns a Date set to 14:00 UTC on the first weekday (Mon..Fri) on
 *  or after `daysOut` calendar days from now. The doctor schedule is
 *  09-17 ET (Mon-Sat), so 14:00 UTC = 10:00 EDT always lands inside
 *  the working window, and the branch is open (Sun is closed). */
function nextWeekdayAt14Utc(daysOut: number): Date {
  return nextWeekdayAt(14, daysOut);
}

/** The same, but at an arbitrary UTC hour — used to give a test its
 *  OWN slot so it cannot collide with a 14:00 booking on the same
 *  doctor.
 *
 *  Two constraints, both learned the hard way:
 *
 *  1. HOURS, not days, make a slot private. Every test in the suite
 *     shares ONE database, and `nextWeekdayAt` can slide two
 *     different `daysOut` values onto the same weekday (a Saturday is
 *     skipped to the Monday after) — so two tests on the same weekday
 *     and the same hour collide with a 409 slot_raced. Distinct hours
 *     never collide.
 *
 *  2. The hour must land inside the branch's opening hours, which
 *     are 09:00–17:00 BRANCH-LOCAL (America/New_York). In EDT that
 *     is 13:00–21:00 UTC; outside the window the route rejects the
 *     booking with `outside_branch_hours`. 14:00 and 15:00 UTC are
 *     already taken by other test files. */
function nextWeekdayAt(hourUtc: number, daysOut: number): Date {
  const d = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return d;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function nextWeekdayIso(): string {
  return nextWeekdayAt14Utc(1).toISOString().slice(0, 10);
}

/** Returns the first slot the availability route offers on the first
 *  weekday at or after `daysOut` days from now. Using the route (rather
 *  than a hard-coded instant) keeps the test from racing other test
 *  files for the same slot.
 *
 *  The query is made on behalf of a patient with NO existing appointment
 *  with this doctor — otherwise FR-027 filters every slot out. */
async function firstFreeSlot(
  doctorId: string,
  branchId: string,
  typeId: string,
  daysOut: number,
): Promise<{ start_datetime: string; end_datetime: string }> {
  const date = nextWeekdayAt14Utc(daysOut).toISOString().slice(0, 10);
  const res = await request(createApp())
    .get(
      `/availability?doctor_id=${doctorId}&branch_id=${branchId}&date=${date}&appointment_type_id=${typeId}`,
    )
    .set('Authorization', `Bearer ${patientToken('+15550000990')}`);
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  const slot = res.body.slots[0] as
    | { start_datetime: string; end_datetime: string }
    | undefined;
  assert.ok(slot, `no slot available on ${date}`);
  return slot;
}
