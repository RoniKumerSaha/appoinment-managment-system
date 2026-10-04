/**
 * patient-profile.test.ts — integration tests for GET /patient/profile.
 *
 * Spec-3-3 + FR-023: the server-side probe that returns the patient's
 * stored `full_name` when a phone number is already on file. Clients
 * call this when the patient tabs off the phone field on the booking
 * form to switch into "returning patient" mode.
 *
 * Testcontainer runtime is not available in this environment, so the
 * integration suite is structurally validated but not executed. The
 * pure unit tests in bookings-helpers.test.ts cover the E.164 format
 * check exhaustively.
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

// ===========================================================================
// Auth
// ===========================================================================

test('GET /patient/profile: no auth → 401', async () => {
  const res = await request(adminApp()).get(
    `/patient/profile?phone=${encodeURIComponent('+15550000001')}`,
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /patient/profile: patient JWT → 200 for known phone', async () => {
  const res = await request(adminApp())
    .get(`/patient/profile?phone=${encodeURIComponent('+15550000001')}`)
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.patient.phone_number, '+15550000001');
  assert.equal(res.body.patient.full_name, 'Patient One');
});

// ===========================================================================
// Validation
// ===========================================================================

test('GET /patient/profile: missing phone → 400 missing_patient_phone', async () => {
  const res = await request(adminApp())
    .get('/patient/profile?phone=')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'missing_patient_phone' });
});

test('GET /patient/profile: no phone query param → 400 missing_patient_phone', async () => {
  const res = await request(adminApp())
    .get('/patient/profile')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'missing_patient_phone' });
});

test('GET /patient/profile: invalid phone format → 400 invalid_patient_phone', async () => {
  const res = await request(adminApp())
    .get(`/patient/profile?phone=${encodeURIComponent('555-0000')}`)
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_patient_phone' });
});

// ===========================================================================
// Lookup
// ===========================================================================

test('GET /patient/profile: unknown phone → 404 patient_not_found', async () => {
  const res = await request(adminApp())
    .get(`/patient/profile?phone=${encodeURIComponent('+15559999999')}`)
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'patient_not_found' });
});