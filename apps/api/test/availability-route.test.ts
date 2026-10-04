/**
 * availability-route.test.ts — integration tests for GET /availability
 * against the seeded DB.
 *
 * Spec-3-1 + architecture §3.2:
 *   - GET /availability returns slot list honoring branch_hours,
 *     doctor_schedule, doctor_block, existing appointments, type
 *     duration, 30-day window, patient filters.
 *
 * Seed note: 01_minimum provisions:
 *   - 2 branches (East 'America/New_York', West 'America/Los_Angeles'),
 *     each with branch_weekly_hours (the seed configures them).
 *   - 3 doctors (East Lead / East Support / West Lead), each with
 *     doctor_schedule rows for DOWs 0..6.
 *   - 3 appointment_types (General 30, Follow-up 15, Specialist Consult 45).
 *   - 1 future Scheduled appointment referencing East Lead + General.
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

async function fetchDoctorByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchBranchByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
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

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysFromNowIso(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ===========================================================================
// Auth
// ===========================================================================

test('GET /availability: no auth → 401', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp()).get(
    `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=${type.id}`,
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /availability: patient JWT → 200 (any role may read)', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.slots));
});

// ===========================================================================
// Validation
// ===========================================================================

test('GET /availability: invalid doctor_id → 400', async () => {
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=not-a-uuid&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('GET /availability: invalid date format → 400 invalid_date', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=not-a-date&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_date' });
});

test('GET /availability: today (same-day) → 400 past_date', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${todayIso()}&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'past_date' });
});

test('GET /availability: today+31 (outside window) → 400 outside_30d_window', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${daysFromNowIso(31)}&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'outside_30d_window' });
});

test('GET /availability: invalid patient_phone → 400 invalid_patient_phone', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=${type.id}&patient_phone=not-e164`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_patient_phone' });
});

// ===========================================================================
// Lookup failures
// ===========================================================================

test('GET /availability: unknown doctor → 404 doctor_not_found', async () => {
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=00000000-0000-4000-8000-000000004000&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('GET /availability: unknown appointment type → 404', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=00000000-0000-4000-8000-000000004001`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'appointment_type_not_found' });
});

test('GET /availability: doctor not at branch → 400 doctor_not_at_branch', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('West Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'doctor_not_at_branch' });
});

// ===========================================================================
// Happy path
// ===========================================================================

test('GET /availability: happy path returns valid slot list', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .get(
      `/availability?doctor_id=${doctor.id}&branch_id=${branch.id}&date=${tomorrowIso()}&appointment_type_id=${type.id}`,
    )
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.slots));
  assert.ok(res.body.slots.length > 0);
  // Each slot has start/end ISO timestamps.
  for (const s of res.body.slots) {
    assert.ok(typeof s.start_datetime === 'string');
    assert.ok(typeof s.end_datetime === 'string');
    assert.ok(s.end_datetime > s.start_datetime);
  }
});