/**
 * bookings.test.ts — integration tests for POST /bookings against the
 * seeded DB.
 *
 * Spec-3-2 + architecture §5 (POST /bookings is atomic + GIST-protected):
 *   - Happy path inserts an appointment + writes an audit row.
 *   - Every spec-matrix error envelope is asserted.
 *   - The GIST race-safety path is hard to test deterministically without
 *     spawning concurrent requests against a real Postgres — we exercise
 *     the "slot already booked" case by pre-inserting an appointment row
 *     before the request and asserting 409 slot_raced.
 *
 * Cleanup deletes every test-prefixed appointment row + audit row in
 * `after()` so the seeded DB is left clean for sibling tests.
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

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  __resetAuthConfigForTests();
  db = await getTestDb();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

after(async () => {
  delete process.env['AUTH_SECRET'];
  __resetAuthConfigForTests();
  // Best-effort cleanup of any test-prefixed rows.
  const client = await db.pool.connect();
  try {
    await client.query(
      `DELETE FROM appointment_audit WHERE actor_id LIKE 'patient:%test%' OR payload::text LIKE '%test%'`,
    );
    await client.query(
      `DELETE FROM appointment WHERE created_by = 'patient:+15550009999' OR patient_phone LIKE '+1555999%'`,
    );
  } finally {
    client.release();
  }
});

function adminApp() {
  return createApp();
}

function patientToken(): string {
  return signClaim({
    sub: '+15550000099',
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

// E3-S4: receptionist JWT factory. `sub` is the receptionist's user
// identifier (matches the seeded receptionist.email), `branchIds` is the
// receptionist's assigned branch (BR-004: exactly one branch).
function receptionistToken(sub: string, branchIds: readonly string[]): string {
  return signClaim({
    sub,
    role: 'receptionist',
    branch_ids: branchIds,
    scope: 'branch',
  });
}

async function fetchDoctorByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchBranchByName(name: string): Promise<{ id: string; tz: string }> {
  const { rows } = await db.pool.query<{ id: string; tz: string }>(
    `SELECT id, tz FROM branch WHERE name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchTypeByName(name: string): Promise<{
  id: string;
  duration_minutes: number;
}> {
  const { rows } = await db.pool.query<{ id: string; duration_minutes: number }>(
    `SELECT id, duration_minutes FROM appointment_type WHERE name = $1`,
    [name],
  );
  return rows[0]!;
}

/** Build an ISO timestamp for a slot at HH:MM on the date returned by
 *  `tomorrowIso()`. The slot's date is the same calendar day; we
 *  exercise the UTC-as-working-plane path. */
function slotIso(date: string, hh: number, mm: number): string {
  return `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
}

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function daysFromNowIso(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const PATIENT_PHONE_NEW = '+15559990001';

// ===========================================================================
// Auth
// ===========================================================================

test('POST /bookings: no auth → 401', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /bookings: patient JWT → 201', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.appointment.status, 'Scheduled');
  assert.equal(res.body.appointment.doctor_id, doctor.id);
  assert.equal(res.body.appointment.branch_id, branch.id);
  assert.equal(res.body.appointment.appointment_type_id, type.id);
  assert.equal(res.body.appointment.tz, branch.tz);

  // DB-side pins: row + audit row.
  const apptId = res.body.appointment.id;
  const appt = await db.pool.query<{
    id: string;
    status: string;
    created_by: string;
  }>(`SELECT id, status, created_by FROM appointment WHERE id = $1`, [apptId]);
  assert.equal(appt.rows[0]!.status, 'Scheduled');
  assert.equal(appt.rows[0]!.created_by, `patient:${PATIENT_PHONE_NEW}`);

  const audit = await db.pool.query<{
    actor_role: string;
    actor_id: string;
    event: string;
  }>(
    `SELECT actor_role, actor_id, event FROM appointment_audit WHERE appointment_id = $1`,
    [apptId],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.actor_role, 'patient');
  assert.equal(audit.rows[0]!.actor_id, `patient:${PATIENT_PHONE_NEW}`);
  assert.equal(audit.rows[0]!.event, 'created');
});

// ===========================================================================
// Validation
// ===========================================================================

test('POST /bookings: unknown JSON field → 400 unknown_field', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
      foo: 'bar',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'unknown_field' });
});

test('POST /bookings: invalid doctor_id → 400 invalid_doctor_id', async () => {
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: 'not-a-uuid',
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('POST /bookings: invalid start_datetime (no TZ) → 400 invalid_start_datetime', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: `${date}T14:00:00`, // no Z / no offset
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_start_datetime' });
});

test('POST /bookings: invalid patient_phone → 400 invalid_patient_phone', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: '555-0000',
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_patient_phone' });
});

test('POST /bookings: invalid patient_name (blank) → 400 invalid_patient_name', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: '   ',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_patient_name' });
});

test('POST /bookings: invalid slot_duration_minutes (4) → 400', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 4, // below the 0005 CHECK minimum of 5
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_slot_duration_minutes' });
});

// ===========================================================================
// Window
// ===========================================================================

test('POST /bookings: today (same-day) → 409 slot_in_past', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = todayIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'slot_in_past' });
});

test('POST /bookings: today+31 (outside window) → 409 outside_30d_window', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = daysFromNowIso(31);
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'outside_30d_window' });
});

// ===========================================================================
// Lookup failures
// ===========================================================================

test('POST /bookings: unknown doctor → 404 doctor_not_found', async () => {
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: '00000000-0000-4000-8000-000000004000',
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('POST /bookings: unknown branch → 404 branch_not_found', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: '00000000-0000-4000-8000-000000004002',
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'branch_not_found' });
});

test('POST /bookings: duration_mismatch → 409', async () => {
  // General Consultation is 30min; submitting slot_duration_minutes=45
  // and (start, end) spanning 45 minutes triggers 409 duration_mismatch.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 45),
      slot_duration_minutes: 45, // does not match type.duration_minutes=30
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'duration_mismatch' });
});

test('POST /bookings: end_datetime != start+duration → 400 invalid_time_range', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 45), // 45 min, not 30
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_time_range' });
});

test('POST /bookings: doctor not at branch → 400 doctor_not_at_branch', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('West Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'doctor_not_at_branch' });
});

test('POST /bookings: unknown appointment type → 404 appointment_type_not_found', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: '00000000-0000-4000-8000-000000004001',
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'appointment_type_not_found' });
});

// ===========================================================================
// Conflicts
// ===========================================================================

test('POST /bookings: slot_raced → 409 slot_raced (terminal envelope)', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startIso = slotIso(date, 15, 0);
  const endIso = slotIso(date, 15, 30);

  // Pre-insert a Scheduled appointment at the same slot to simulate the
  // race winner.
  const patientPhoneExisting = '+15550000002';
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: clinicRows } = await client.query<{ id: string }>(
      `SELECT id FROM clinic LIMIT 1`,
    );
    await client.query(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
          start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'Scheduled', $8)`,
      [
        clinicRows[0]!.id,
        branch.id,
        doctor.id,
        patientPhoneExisting,
        type.id,
        startIso,
        endIso,
        `patient:${patientPhoneExisting}`,
      ],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: startIso,
      end_datetime: endIso,
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'slot_raced');
  assert.equal(res.body.code, 'SLOT_RACED');
  assert.ok(Array.isArray(res.body.can_do));
  assert.equal(res.body.can_do[0].action, 'refresh_availability');

  // Cleanup.
  const cleanup = await db.pool.connect();
  try {
    await cleanup.query(
      `DELETE FROM appointment WHERE patient_phone = $1 AND start_datetime = $2::timestamptz`,
      [patientPhoneExisting, startIso],
    );
  } finally {
    cleanup.release();
  }
});

test('POST /bookings: FR-027 patient_has_future_with_doctor → 409', async () => {
  // patient 0001 has a future Scheduled appointment with East Lead (seeded).
  // We try to book another slot on the SAME doctor tomorrow.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: '+15550000001', // patient 0001
      patient_name: 'Patient One',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'patient_has_future_with_doctor' });
});

test('POST /bookings: slot outside branch hours (18:00) → 409 outside_branch_hours', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 18, 0),
      end_datetime: slotIso(date, 18, 30),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'outside_branch_hours' });
});

test('POST /bookings: slot inside doctor_block → 409 inside_doctor_block', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startIso = slotIso(date, 10, 0);
  const endIso = slotIso(date, 11, 0);

  // Pre-insert a doctor_block at 10:00-11:00 tomorrow.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO doctor_block (doctor_id, branch_id, start_datetime, end_datetime, reason, created_by)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 'test block', $6)`,
      [
        doctor.id,
        branch.id,
        startIso,
        endIso,
        // extra param index 5: created_by
        'staff:admin-main',
      ],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 10, 30),
      end_datetime: slotIso(date, 11, 0),
      slot_duration_minutes: 30,
      patient_phone: PATIENT_PHONE_NEW,
      patient_name: 'Test Patient',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'inside_doctor_block' });

  // Cleanup.
  const cleanup = await db.pool.connect();
  try {
    await cleanup.query(
      `DELETE FROM doctor_block WHERE doctor_id = $1 AND start_datetime = $2::timestamptz AND reason = 'test block'`,
      [doctor.id, startIso],
    );
  } finally {
    cleanup.release();
  }
});

test('POST /bookings: FR-029 patient_time_conflict → 409', async () => {
  // patient 0001 has a future Scheduled appointment at +7d 09:00–09:30 with
  // East Lead. The seed places it at `app_now() + 7 days` 09:00. We can't
  // rely on the exact minute, so we'll insert a parallel row at 14:00 and
  // try to book the same slot.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startIso = slotIso(date, 16, 0);
  const endIso = slotIso(date, 16, 30);
  const conflictPhone = '+15550000004'; // patient 0004 — no seeded future

  // Pre-insert a Scheduled appointment for patient 0004 at 16:00–16:30.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: clinicRows } = await client.query<{ id: string }>(
      `SELECT id FROM clinic LIMIT 1`,
    );
    await client.query(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
          start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'Scheduled', $8)`,
      [
        clinicRows[0]!.id,
        branch.id,
        doctor.id,
        conflictPhone,
        type.id,
        startIso,
        endIso,
        `patient:${conflictPhone}`,
      ],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  // Now patient 0004 tries to book the same slot on a different doctor.
  const otherDoctor = await fetchDoctorByName('Dr. East Support');
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: otherDoctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: startIso,
      end_datetime: endIso,
      slot_duration_minutes: 30,
      patient_phone: conflictPhone,
      patient_name: 'Patient Four',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'patient_time_conflict' });

  // Cleanup.
  const cleanup = await db.pool.connect();
  try {
    await cleanup.query(
      `DELETE FROM appointment WHERE patient_phone = $1 AND start_datetime = $2::timestamptz`,
      [conflictPhone, startIso],
    );
  } finally {
    cleanup.release();
  }
});

// ===========================================================================
// FR-022: patient reuse
// ===========================================================================

test('POST /bookings: existing patient phone reuses row → 201', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const phone = '+15550000003'; // patient 0003 — already seeded

  // patient 0003 has no future with East Lead (the seed only gives a
  // future to patient 0001).
  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 11, 0),
      end_datetime: slotIso(date, 11, 30),
      slot_duration_minutes: 30,
      patient_phone: phone,
      patient_name: 'Patient Three Updated',
    });
  assert.equal(res.status, 201);
  // The patient row was reused, not duplicated.
  const count = await db.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM patient WHERE phone_number = $1`,
    [phone],
  );
  assert.equal(count.rows[0]!.n, '1');

  // Cleanup.
  const cleanup = await db.pool.connect();
  try {
    await cleanup.query(
      `DELETE FROM appointment WHERE patient_phone = $1 AND start_datetime = $2::timestamptz`,
      [phone, slotIso(date, 11, 0)],
    );
    await cleanup.query(
      `DELETE FROM appointment_audit WHERE actor_id = $1 AND event = 'created'`,
      [`patient:${phone}`],
    );
  } finally {
    cleanup.release();
  }
});

test('POST /bookings: returning patient with CHANGED name updates patient.full_name', async () => {
  // E3-S3 / FR-023: "Editing the name updates the patient's stored name."
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const phone = '+15550000005'; // patient 0005 — seeded as 'Patient Five'

  try {
    const res = await request(adminApp())
      .post('/bookings')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        doctor_id: doctor.id,
        branch_id: branch.id,
        appointment_type_id: type.id,
        start_datetime: slotIso(date, 12, 0),
        end_datetime: slotIso(date, 12, 30),
        slot_duration_minutes: 30,
        patient_phone: phone,
        patient_name: 'Patient Five Renamed',
      });
    assert.equal(res.status, 201);

    // DB pin: patient.full_name was updated to the submitted value.
    const updated = await db.pool.query<{ full_name: string }>(
      `SELECT full_name FROM patient WHERE phone_number = $1`,
      [phone],
    );
    assert.equal(updated.rows[0]!.full_name, 'Patient Five Renamed');

    // Audit payload carries the post-update name.
    const audit = await db.pool.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM appointment_audit
         WHERE actor_id = $1 AND event = 'created'
         ORDER BY created_at DESC LIMIT 1`,
      [`patient:${phone}`],
    );
    const payload = JSON.parse(audit.rows[0]!.payload) as Record<string, unknown>;
    assert.equal(payload['patient_name_after'], 'Patient Five Renamed');
  } finally {
    // Always restore so a failed assertion mid-test still leaves the seeded
    // name intact for sibling tests.
    const restore = await db.pool.connect();
    try {
      await restore.query(
        `UPDATE patient SET full_name = 'Patient Five' WHERE phone_number = $1`,
        [phone],
      );
      await restore.query(
        `DELETE FROM appointment WHERE patient_phone = $1 AND start_datetime = $2::timestamptz`,
        [phone, slotIso(date, 12, 0)],
      );
      await restore.query(
        `DELETE FROM appointment_audit WHERE actor_id = $1 AND event = 'created'`,
        [`patient:${phone}`],
      );
    } finally {
      restore.release();
    }
  }
});

test('POST /bookings: returning patient with SAME name leaves it unchanged', async () => {
  // Same-name path: the UPDATE_PATIENT_NAME_SQL has the
  // `IS DISTINCT FROM` predicate that turns this into a 0-row write.
  // Direct DB pin: verify the UPDATE did NOT happen.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const phone = '+15550000002'; // patient 0002 — seeded as 'Patient Two'

  try {
    // Snapshot the row's identity (we don't have updated_at on patient, so
    // we verify via the post-condition that the name is exactly 'Patient Two').
    const res = await request(adminApp())
      .post('/bookings')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({
        doctor_id: doctor.id,
        branch_id: branch.id,
        appointment_type_id: type.id,
        start_datetime: slotIso(date, 13, 0),
        end_datetime: slotIso(date, 13, 30),
        slot_duration_minutes: 30,
        patient_phone: phone,
        patient_name: 'Patient Two', // matches seeded name
      });
    assert.equal(res.status, 201);

    const stillSame = await db.pool.query<{ full_name: string }>(
      `SELECT full_name FROM patient WHERE phone_number = $1`,
      [phone],
    );
    assert.equal(stillSame.rows[0]!.full_name, 'Patient Two');
  } finally {
    const cleanup = await db.pool.connect();
    try {
      await cleanup.query(
        `DELETE FROM appointment WHERE patient_phone = $1 AND start_datetime = $2::timestamptz`,
        [phone, slotIso(date, 13, 0)],
      );
      await cleanup.query(
        `DELETE FROM appointment_audit WHERE actor_id = $1 AND event = 'created'`,
        [`patient:${phone}`],
      );
    } finally {
      cleanup.release();
    }
  }
});

// ===========================================================================
// E3-S4 — Receptionist booking on behalf of patient
// ===========================================================================

async function fetchBranchIdByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [name],
  );
  return rows[0]!;
}

test('POST /bookings: receptionist at branch-east books at branch-east → 201', async () => {
  // E3-S4 / F-13 happy path. Receptionist JWT with branch_ids=[east]
  // submits branch_id=east, gets 201 + receptionist-attributed audit.
  const sub = 'receptionist-east-happy';
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const phone = '+15559990004'; // new phone for this test

  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${receptionistToken(sub, [branch.id])}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 9, 30),
      end_datetime: slotIso(date, 10, 0),
      slot_duration_minutes: 30,
      patient_phone: phone,
      patient_name: 'Walkin Four',
    });
  assert.equal(res.status, 201);
  const appointmentId = res.body['appointment']['id'] as string;

  // Audit row column-level pin (covers SC acceptance criterion: actor_role
  // + actor_id on the audit row, plus payload.source/actor_sub).
  const audit = await db.pool.query<{ actor_role: string; actor_id: string; payload: string }>(
    `SELECT actor_role, actor_id, payload::text AS payload FROM appointment_audit
       WHERE appointment_id = $1 AND event = 'created'`,
    [appointmentId],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.actor_role, 'receptionist');
  assert.equal(audit.rows[0]!.actor_id, `staff:${sub}`);
  const payload = JSON.parse(audit.rows[0]!.payload) as Record<string, unknown>;
  assert.equal(payload['source'], 'receptionist_book');
  assert.equal(payload['actor_sub'], sub);
  assert.equal(payload['patient_name_after'], 'Walkin Four');

  // appointment.created_by is the staff: token.
  const createdBy = await db.pool.query<{ created_by: string }>(
    `SELECT created_by FROM appointment WHERE id = $1`,
    [appointmentId],
  );
  assert.equal(createdBy.rows[0]!.created_by, `staff:${sub}`);

  // Cleanup — scoped by appointment_id (test-order independent).
  const cleanup = await db.pool.connect();
  try {
    await cleanup.query(`DELETE FROM appointment WHERE id = $1`, [appointmentId]);
    await cleanup.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1`,
      [appointmentId],
    );
    await cleanup.query(
      `DELETE FROM patient WHERE phone_number = $1`,
      [phone],
    );
  } finally {
    cleanup.release();
  }
});

test('POST /bookings: receptionist at branch-east cannot book at branch-west → 403', async () => {
  // E3-S4 branch-scope gate: BR-004 says a receptionist is assigned to
  // exactly one branch. Submitting the wrong branch must 403, not silently
  // retarget, and must NOT write any rows.
  const sub = 'receptionist-east-403';
  const doctor = await fetchDoctorByName('Dr. West Lead');
  const branchWest = await fetchBranchIdByName('West Branch');
  const branchEast = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();

  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${receptionistToken(sub, [branchEast.id])}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branchWest.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 11, 0),
      end_datetime: slotIso(date, 11, 30),
      slot_duration_minutes: 30,
      patient_phone: '+15559990005',
      patient_name: 'Should Not Exist',
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'outside_branch_scope' });

  // No appointment or audit row created.
  const appts = await db.pool.query<{ exists: boolean }>(
    `SELECT 1 AS exists FROM appointment WHERE patient_phone = $1`,
    ['+15559990005'],
  );
  assert.equal(appts.rows.length, 0);
  const audits = await db.pool.query<{ exists: boolean }>(
    `SELECT 1 AS exists FROM appointment_audit
       WHERE actor_id = $1 AND event = 'created'`,
    [`staff:${sub}`],
  );
  assert.equal(audits.rows.length, 0);
});

test('POST /bookings: patient JWT bypasses branch-scope gate → 201', async () => {
  // Control test for E3-S4: the branch gate only fires for role='receptionist'.
  // A patient JWT with empty branch_ids can submit any branch.
  const doctor = await fetchDoctorByName('Dr. West Lead');
  const branchWest = await fetchBranchIdByName('West Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();

  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branchWest.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(date, 14, 0),
      end_datetime: slotIso(date, 14, 30),
      slot_duration_minutes: 30,
      patient_phone: '+15559990006',
      patient_name: 'Patient West',
    });
  assert.equal(res.status, 201);

  // Cleanup.
  const cleanup = await db.pool.connect();
  try {
    await cleanup.query(
      `DELETE FROM appointment WHERE patient_phone = $1`,
      ['+15559990006'],
    );
    await cleanup.query(
      `DELETE FROM appointment_audit WHERE actor_id = $1 AND event = 'created'`,
      ['patient:+15550000099'],
    );
  } finally {
    cleanup.release();
  }
});

test('POST /bookings: receptionist booking a RETURNING patient updates full_name and audit source', async () => {
  // E3-S4 + E3-S3 interplay: receptionist books an existing seeded patient
  // with a different name. The UPDATE fires; the audit payload's
  // `source` is `receptionist_book` (not `self_book`).
  const sub = 'receptionist-east-returning';
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const phone = '+15550000001'; // seeded as 'Patient One'
  let appointmentId: string | null = null;

  try {
    const res = await request(adminApp())
      .post('/bookings')
      .set('Authorization', `Bearer ${receptionistToken(sub, [branch.id])}`)
      .send({
        doctor_id: doctor.id,
        branch_id: branch.id,
        appointment_type_id: type.id,
        start_datetime: slotIso(date, 10, 0),
        end_datetime: slotIso(date, 10, 30),
        slot_duration_minutes: 30,
        patient_phone: phone,
        patient_name: 'Patient One Receptionist Rename',
      });
    assert.equal(res.status, 201);
    appointmentId = res.body['appointment']['id'] as string;

    const updated = await db.pool.query<{ full_name: string }>(
      `SELECT full_name FROM patient WHERE phone_number = $1`,
      [phone],
    );
    assert.equal(updated.rows[0]!.full_name, 'Patient One Receptionist Rename');

    const audit = await db.pool.query<{ actor_role: string; payload: string }>(
      `SELECT actor_role, payload::text AS payload FROM appointment_audit
         WHERE appointment_id = $1 AND event = 'created'`,
      [appointmentId],
    );
    assert.equal(audit.rows[0]!.actor_role, 'receptionist');
    const payload = JSON.parse(audit.rows[0]!.payload) as Record<string, unknown>;
    assert.equal(payload['source'], 'receptionist_book');
    assert.equal(payload['patient_name_after'], 'Patient One Receptionist Rename');
  } finally {
    const cleanup = await db.pool.connect();
    try {
      await cleanup.query(
        `UPDATE patient SET full_name = 'Patient One' WHERE phone_number = $1`,
        [phone],
      );
      if (appointmentId) {
        await cleanup.query(`DELETE FROM appointment WHERE id = $1`, [appointmentId]);
        await cleanup.query(
          `DELETE FROM appointment_audit WHERE appointment_id = $1`,
          [appointmentId],
        );
      }
    } finally {
      cleanup.release();
    }
  }
});

test('POST /bookings: receptionist same-day booking → 409 slot_in_past', async () => {
  // E3-S4: FR-019 same-day rule still applies to the receptionist flow.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');

  const res = await request(adminApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${receptionistToken('receptionist-east', [branch.id])}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      start_datetime: slotIso(todayIso(), 12, 0),
      end_datetime: slotIso(todayIso(), 12, 30),
      slot_duration_minutes: 30,
      patient_phone: '+15559990007',
      patient_name: 'Should Fail Same Day',
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'slot_in_past' });
});