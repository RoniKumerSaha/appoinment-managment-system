/**
 * 02-auth.test.ts — Authentication surface.
 *
 * Coverage:
 *   - POST /patient/otp/verify-now   (mock, dev/test only)
 *   - POST /auth/login/staff         (email-based stub login for admin/doctor/receptionist)
 *   - GET  /auth/me                  (rehydrate session from existing JWT)
 *
 * Notes:
 *   - The mock-OTP route is registered when `NODE_ENV ∈ {development, test}`
 *     (per `loadAuthConfig().mockOtpAllowed`).
 *   - The real SMS OTP routes (`/patient/otp/send`, `/patient/otp/verify`)
 *     require an injected SmsOtpService; the body-claim invariant and the
 *     service-level behaviors are covered by SmsOtpService unit tests; we
 *     omit them here to keep this file focused on the user-facing auth
 *     contract.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signClaim, verifyToken } from '../src/auth/jwt.js';
import { __resetAuthConfigForTests } from '../src/auth/config.js';
import { createApp } from '../src/app.js';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { seedWith } from '../db/seeds/01_minimum.js';

const VALID_SECRET = 'a'.repeat(48);
let db: TestDb;

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
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

// ═══════════════════════════════════════════════════════════════════
// /patient/otp/verify-now — mock OTP (dev/test only)
// ═══════════════════════════════════════════════════════════════════
test('POST /patient/otp/verify-now with correct code → 200 + JWT', async () => {
  const res = await request(createApp())
    .post('/patient/otp/verify-now')
    .send({ phone: '+15550000002', code: '123456' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.claim.role, 'patient');
  assert.equal(res.body.claim.sub, '+15550000002');
  assert.equal(res.body.claim.scope, 'self');
  assert.deepEqual(res.body.claim.branch_ids, []);
  // JWT must be a verifiable token (single source of truth)
  assert.ok(verifyToken(res.body.token), 'minted token must verify');
});

test('POST /patient/otp/verify-now with wrong code → 401 invalid_otp_code', async () => {
  const res = await request(createApp())
    .post('/patient/otp/verify-now')
    .send({ phone: '+15550000002', code: '000000' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_otp_code');
});

test('POST /patient/otp/verify-now with invalid phone format → 400 invalid_phone', async () => {
  const res = await request(createApp())
    .post('/patient/otp/verify-now')
    .send({ phone: '5550000002', code: '123456' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_phone');
});

test('POST /patient/otp/verify-now ignores body role/branch_ids (body-claim invariant)', async () => {
  // Even if the body tries to inject role=admin, the claim must remain patient.
  const res = await request(createApp())
    .post('/patient/otp/verify-now')
    .send({
      phone: '+15550000002',
      code: '123456',
      role: 'admin',
      branch_ids: ['some-branch'],
      scope: 'clinic',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.claim.role, 'patient', 'role must NOT be sourced from body');
  assert.equal(res.body.claim.scope, 'self', 'scope must NOT be sourced from body');
  assert.deepEqual(res.body.claim.branch_ids, [], 'branch_ids must NOT be sourced from body');
});

test('POST /patient/otp/verify-now with non-string code → 400 invalid_phone (defensive)', async () => {
  const res = await request(createApp())
    .post('/patient/otp/verify-now')
    .send({ phone: '+15550000002', code: 123456 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_phone');
});

test('POST /patient/otp/verify-now with empty body → 400 invalid_phone', async () => {
  const res = await request(createApp())
    .post('/patient/otp/verify-now')
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_phone');
});

// ═══════════════════════════════════════════════════════════════════
// /auth/login/staff — email-based stub login
// ═══════════════════════════════════════════════════════════════════
test('POST /auth/login/staff (admin) → 200 + JWT + profile', async () => {
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'admin', email: 'admin-main@clinic.local' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.claim.role, 'admin');
  assert.equal(res.body.claim.scope, 'clinic');
  assert.equal(res.body.profile.email, 'admin-main@clinic.local');
  assert.equal(typeof res.body.profile.branch_id, 'string');
});

test('POST /auth/login/staff (doctor) → 200 with doctor_id in claim', async () => {
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'doctor', email: 'dr.-east-lead@clinic.local' });
  assert.equal(res.status, 200);
  assert.equal(res.body.claim.role, 'doctor');
  assert.equal(res.body.claim.scope, 'branch');
  assert.equal(typeof res.body.claim.doctor_id, 'string');
  assert.equal(res.body.profile.full_name, 'Dr. East Lead');
});

test('POST /auth/login/staff (receptionist) → 200 with branch scope', async () => {
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'receptionist', email: 'receptionist-east@clinic.local' });
  assert.equal(res.status, 200);
  assert.equal(res.body.claim.role, 'receptionist');
  assert.equal(res.body.claim.scope, 'branch');
  assert.equal(res.body.claim.branch_ids.length, 1, 'receptionist is single-branch');
});

test('POST /auth/login/staff with unknown email → 401 staff_not_found', async () => {
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'admin', email: 'nobody@clinic.local' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'staff_not_found');
});

test('POST /auth/login/staff with invalid role → 400 invalid_role', async () => {
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'superuser', email: 'admin-main@clinic.local' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_role');
});

test('POST /auth/login/staff with invalid email → 400 invalid_email', async () => {
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'admin', email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_email');
});

test('POST /auth/login/staff ignores body branch_ids/doctor_id (body-claim invariant)', async () => {
  // Try to inject branch_ids into the claim via the body. The route reads
  // from the DB only.
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({
      role: 'admin',
      email: 'admin-main@clinic.local',
      branch_ids: ['malicious-branch'],
      doctor_id: 'malicious-doctor',
      scope: 'global',
    });
  assert.equal(res.status, 200);
  // The DB-anchored branch_id for the admin user comes from the seed; the
  // body's `branch_ids` must be ignored.
  assert.notEqual(
    res.body.claim.branch_ids[0],
    'malicious-branch',
    'body branch_ids must be ignored',
  );
  assert.equal(res.body.claim.doctor_id, undefined, 'admin should not have doctor_id');
});

// ═══════════════════════════════════════════════════════════════════
// /auth/me — rehydrate
// ═══════════════════════════════════════════════════════════════════
test('GET /auth/me (admin) → 200 + claim + profile', async () => {
  const token = signClaim({
    sub: 'admin-main@clinic.local',
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
  const res = await request(createApp())
    .get('/auth/me')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.claim.role, 'admin');
  assert.equal(res.body.profile.email, 'admin-main@clinic.local');
});

test('GET /auth/me (patient) → 200 with minimal profile', async () => {
  const token = signClaim({
    sub: '+15550000002',
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
  const res = await request(createApp())
    .get('/auth/me')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.claim.role, 'patient');
  assert.equal(res.body.profile.full_name, null);
  assert.equal(res.body.profile.email, '+15550000002');
});

test('GET /auth/me without auth → 401 unauthenticated', async () => {
  const res = await request(createApp()).get('/auth/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

test('GET /auth/me with invalid token → 401 unauthenticated', async () => {
  const res = await request(createApp())
    .get('/auth/me')
    .set('Authorization', 'Bearer not-a-real-jwt');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

test('GET /auth/me with token whose sub no longer matches → 401 staff_not_found', async () => {
  const token = signClaim({
    sub: 'ghost@clinic.local', // no such staff in the seed
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
  const res = await request(createApp())
    .get('/auth/me')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'staff_not_found');
});
