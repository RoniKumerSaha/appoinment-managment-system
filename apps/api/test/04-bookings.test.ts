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
  const d = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000);
  d.setUTCHours(14, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return d;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function nextWeekdayIso(): string {
  return nextWeekdayAt14Utc(1).toISOString().slice(0, 10);
}
