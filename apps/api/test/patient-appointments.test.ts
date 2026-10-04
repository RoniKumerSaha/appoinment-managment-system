/**
 * patient-appointments.test.ts — integration tests for GET /patient/appointments.
 *
 * Spec-4-1 (E4-S1) + FR-032: the verified patient's upcoming-appointments
 * list. Phone is bound from the JWT claim (E7-S3 privacy filter); only
 * status='Scheduled' AND start_datetime > now() rows are returned.
 *
 * Testcontainer runtime is not available in this environment, so the
 * integration suite is structurally validated but not executed.
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
  // Best-effort cleanup of any test-prefixed appointments + audits.
  const client = await db.pool.connect();
  try {
    await client.query(
      `DELETE FROM appointment_audit WHERE actor_id LIKE 'patient:+1555999%'`,
    );
    await client.query(
      `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
    );
  } finally {
    client.release();
  }
});

function adminApp() {
  return createApp();
}

function patientToken(phone = '+15550000001'): string {
  return signClaim({
    sub: phone,
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

function doctorToken(): string {
  return signClaim({
    sub: 'doctor-east-lead',
    role: 'doctor',
    branch_ids: ['branch-east'],
    scope: 'branch',
    doctor_id: 'doctor-east-lead',
  });
}

function adminToken(): string {
  return signClaim({
    sub: 'admin-main',
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
}

function receptionistToken(): string {
  return signClaim({
    sub: 'receptionist-east',
    role: 'receptionist',
    branch_ids: ['branch-east'],
    scope: 'branch',
  });
}

// ===========================================================================
// Auth
// ===========================================================================

test('GET /patient/appointments: no auth → 401', async () => {
  const res = await request(adminApp()).get('/patient/appointments');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /patient/appointments: doctor JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${doctorToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /patient/appointments: admin JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /patient/appointments: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${receptionistToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Happy path
// ===========================================================================

test('GET /patient/appointments: patient 0001 sees the seeded future appointment', async () => {
  // Seed provisions 1 future Scheduled appointment for +15550000001
  // (FR-032 scope). The response is sorted by start_datetime ASC.
  const res = await request(adminApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${patientToken('+15550000001')}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.appointments));
  assert.ok(res.body.appointments.length >= 1);
  // Every row must have the required shape.
  for (const a of res.body.appointments) {
    assert.equal(a.status, 'Scheduled');
    assert.ok(typeof a.id === 'string');
    assert.ok(typeof a.doctor_id === 'string');
    assert.ok(typeof a.branch_id === 'string');
    assert.ok(typeof a.appointment_type_id === 'string');
    assert.ok(typeof a.start_datetime === 'string');
    assert.ok(typeof a.end_datetime === 'string');
    assert.ok(typeof a.tz === 'string');
    assert.ok(new Date(a.start_datetime).getTime() > Date.now());
  }
  // start_datetime ASC ordering.
  for (let i = 1; i < res.body.appointments.length; i++) {
    assert.ok(
      new Date(res.body.appointments[i].start_datetime).getTime() >=
        new Date(res.body.appointments[i - 1]!.start_datetime).getTime(),
    );
  }
});

test('GET /patient/appointments: unknown phone → 200 empty array (privacy)', async () => {
  // E7-S3: a patient who has never booked (or whose phone is not on
  // file) gets 200 {appointments: []} — NEVER 404, which would leak
  // phone existence. Privacy: don't reveal whether a phone is on file.
  const res = await request(adminApp())
    .get('/patient/appointments')
    .set('Authorization', `Bearer ${patientToken('+15559998888')}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { appointments: [] });
});

// ===========================================================================
// FR-032 filter (Cancelled / past excluded)
// ===========================================================================

test('GET /patient/appointments: cancelled + past rows excluded (FR-032)', async () => {
  // Insert a Cancelled row, a past Scheduled row, a future Completed
  // row, and a future No-Show row for patient 0002, plus one future
  // Scheduled row. Only the future Scheduled row should appear in
  // the response (FR-032).
  const phone = '+15550000002'; // seeded patient; no scheduled future
  const doctor = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = 'Dr. East Lead'`,
  );
  const branch = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = 'East Branch'`,
  );
  const type = await db.pool.query<{ id: string; duration_minutes: number }>(
    `SELECT id, duration_minutes FROM appointment_type WHERE name = 'General Consultation'`,
  );
  const clinicId = await db.pool.query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`);
  const futureStart = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const pastStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const cancelledStart = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const completedStart = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000);
  const noShowStart = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000);
  const insertedIds: string[] = [];

  try {
    const insertRow = async (
      status: string,
      start: Date,
    ): Promise<string> => {
      const dur = type.rows[0]!.duration_minutes;
      const result = await db.pool.query<{ id: string }>(
        `INSERT INTO appointment
           (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
            start_datetime, end_datetime, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9)
         RETURNING id::text AS id`,
        [
          clinicId.rows[0]!.id,
          branch.rows[0]!.id,
          doctor.rows[0]!.id,
          phone,
          type.rows[0]!.id,
          start.toISOString(),
          new Date(start.getTime() + dur * 60_000).toISOString(),
          status,
          `patient:${phone}`,
        ],
      );
      return result.rows[0]!.id;
    };

    insertedIds.push(await insertRow('Scheduled', futureStart)); // visible
    insertedIds.push(await insertRow('Scheduled', pastStart)); // past, excluded
    insertedIds.push(await insertRow('Cancelled', cancelledStart)); // excluded (FR-032)
    insertedIds.push(await insertRow('Completed', completedStart)); // excluded (FR-032)
    insertedIds.push(await insertRow('No-Show', noShowStart)); // excluded (FR-032)

    const res = await request(adminApp())
      .get('/patient/appointments')
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointments.length, 1);
    // Only the future Scheduled row should appear.
    const only = res.body.appointments[0];
    assert.equal(only.status, 'Scheduled');
    assert.ok(
      new Date(only.start_datetime).getTime() === futureStart.getTime(),
      'returned row must be the future Scheduled one',
    );
  } finally {
    // Cleanup scoped by the exact inserted IDs (no risk of touching
    // sibling tests' rows).
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE actor_id = $1`,
      [`patient:${phone}`],
    );
  }
});