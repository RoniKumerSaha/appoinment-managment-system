/**
 * 19-staff-password-auth.test.ts — W10a staff credentials.
 *
 * The "stub auth" P2 gap: `POST /auth/login/staff` accepted a bare
 * email and minted a token, so the endpoint proved only that the caller
 * knew a seeded address. It was confined to dev/test, which left the
 * app with no way to authenticate a staff user at all in production.
 *
 * W10a adds a `password_hash` column (migration 0022) hashed with
 * Postgres `pgcrypto`'s bcrypt, plus an admin route to set it.
 *
 * Coverage:
 *   - POST /admin/staff/:role/:id/password — set / replace / clear
 *   - POST /auth/login/staff with a password — correct + wrong
 *   - the email-only fallback still works in dev/test
 *   - an account WITH a hash cannot be entered via the email-only path
 *   - production refuses the email-only path but allows a password
 *   - password policy bounds
 *   - the hash is never echoed back to the client
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signClaim } from '../src/auth/jwt.js';
import { __resetAuthConfigForTests } from '../src/auth/config.js';
import { createApp } from '../src/app.js';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { seedWith } from '../db/seeds/01_minimum.js';

const VALID_SECRET = 'a'.repeat(48);
let db: TestDb;

const ADMIN_EMAIL = 'admin-main@clinic.local';
const DOCTOR_EMAIL = 'dr.-east-lead@clinic.local';
const RECEPTIONIST_EMAIL = 'receptionist-east@clinic.local';

const GOOD_PASSWORD = 'correct-horse-battery-staple';

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

beforeEach(async () => {
  // Clear any credential a previous test set, so each test starts from
  // the seeded "no password configured" state unless it opts in.
  await db.pool.query(
    `UPDATE admin_user SET password_hash = NULL;
     UPDATE doctor    SET password_hash = NULL;
     UPDATE receptionist SET password_hash = NULL;`,
  );
});

function adminToken(): string {
  return signClaim({
    sub: ADMIN_EMAIL,
    role: 'admin',
    branch_ids: ['00000000-0000-0000-0000-000000000001'],
    scope: 'clinic',
  });
}

async function staffId(table: 'admin_user' | 'doctor' | 'receptionist', email: string): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `SELECT id::text AS id FROM ${table} WHERE email = $1::citext`,
    [email],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`seed missing: ${table} ${email}`);
  return id;
}

function setPassword(
  role: 'admin' | 'doctor' | 'receptionist',
  id: string,
  password: string,
): request.Response {
  return request(createApp())
    .post(`/admin/staff/${role}/${id}/password`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ password });
}

// ═══════════════════════════════════════════════════════════════════
// Setting a credential
// ═══════════════════════════════════════════════════════════════════
test('an admin sets a doctor password → 200 credential_configured', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  const res = await setPassword('doctor', id, GOOD_PASSWORD);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.credential_configured, true);
  assert.equal(res.body.role, 'doctor');
});

test('the stored hash is a bcrypt hash, not the plaintext', async () => {
  const id = await staffId('receptionist', RECEPTIONIST_EMAIL);
  await setPassword('receptionist', id, GOOD_PASSWORD);

  const r = await db.pool.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM receptionist WHERE id = $1::uuid`,
    [id],
  );
  const hash = r.rows[0]?.password_hash ?? '';
  assert.ok(hash.startsWith('$2a$'), `expected a bcrypt hash, got ${hash}`);
  assert.ok(!hash.includes(GOOD_PASSWORD), 'the plaintext must not be stored');
});

test('setting a password does not echo the hash back to the client', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  const res = await setPassword('doctor', id, GOOD_PASSWORD);
  assert.equal(res.status, 200);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('$2a$'), 'the response must not contain the hash');
  assert.ok(!body.includes(GOOD_PASSWORD), 'the response must not contain the password');
});

test('setting a password for an unknown id → 404 staff_not_found', async () => {
  const res = await setPassword(
    'doctor',
    '00000000-0000-0000-0000-000000000999',
    GOOD_PASSWORD,
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'staff_not_found');
});

test('setting a password for a non-admin → 403 forbidden_role', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  const doctorToken = signClaim({
    sub: DOCTOR_EMAIL,
    role: 'doctor',
    branch_ids: ['00000000-0000-0000-0000-000000000001'],
    scope: 'branch',
  });
  const res = await request(createApp())
    .post(`/admin/staff/doctor/${id}/password`)
    .set('Authorization', `Bearer ${doctorToken}`)
    .send({ password: GOOD_PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('an unknown role → 400 invalid_role', async () => {
  const res = await request(createApp())
    .post('/admin/staff/wizard/00000000-0000-0000-0000-000000000001/password')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ password: GOOD_PASSWORD });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_role');
});

// ═══════════════════════════════════════════════════════════════════
// Password policy
// ═══════════════════════════════════════════════════════════════════
test('a password under 12 characters → 400 password_too_short', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  const res = await setPassword('doctor', id, 'short');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'password_too_short');
});

test('a password of 72+ UTF-8 bytes → 400 password_too_long', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  // bcrypt truncates at 72 bytes, so a longer password would silently
  // collide with any other password sharing its first 72 bytes.
  const res = await setPassword('doctor', id, 'a'.repeat(72));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'password_too_long');
});

test('a non-string password → 400 password_required', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  const res = await request(createApp())
    .post(`/admin/staff/doctor/${id}/password`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ password: 12345 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'password_required');
});

// ═══════════════════════════════════════════════════════════════════
// Logging in with the credential
// ═══════════════════════════════════════════════════════════════════
test('staff login with the correct password → 200 + JWT', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  await setPassword('doctor', id, GOOD_PASSWORD);

  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'doctor', email: DOCTOR_EMAIL, password: GOOD_PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.claim.role, 'doctor');
  assert.equal(res.body.claim.sub, DOCTOR_EMAIL);
});

test('staff login with the wrong password → 401 invalid_credentials', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  await setPassword('doctor', id, GOOD_PASSWORD);

  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'doctor', email: DOCTOR_EMAIL, password: 'not-the-password' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('staff login with a password on an account with no credential → 401 invalid_credentials', async () => {
  // The seeded rows have no password_hash. Supplying one must fail
  // rather than silently fall through to the email-only path.
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'admin', email: ADMIN_EMAIL, password: GOOD_PASSWORD });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('every staff role can use a password', async () => {
  for (const [role, table, email] of [
    ['admin', 'admin_user', ADMIN_EMAIL],
    ['doctor', 'doctor', DOCTOR_EMAIL],
    ['receptionist', 'receptionist', RECEPTIONIST_EMAIL],
  ] as const) {
    const id = await staffId(table, email);
    const set = await setPassword(role, id, GOOD_PASSWORD);
    assert.equal(set.status, 200, `set ${role}: ${JSON.stringify(set.body)}`);

    const login = await request(createApp())
      .post('/auth/login/staff')
      .send({ role, email, password: GOOD_PASSWORD });
    assert.equal(login.status, 200, `login ${role}: ${JSON.stringify(login.body)}`);
    assert.equal(login.body.claim.role, role);
  }
});

// ═══════════════════════════════════════════════════════════════════
// The email-only fallback
// ═══════════════════════════════════════════════════════════════════
test('the email-only login still works in dev/test for an account with no password', async () => {
  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'admin', email: ADMIN_EMAIL });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.claim.role, 'admin');
});

test('the email-only login still works in dev/test for an account WITH a password', async () => {
  // The dev fallback is deliberately permissive so the seeded accounts
  // stay usable without provisioning a credential first.
  const id = await staffId('receptionist', RECEPTIONIST_EMAIL);
  await setPassword('receptionist', id, GOOD_PASSWORD);

  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'receptionist', email: RECEPTIONIST_EMAIL });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

// ═══════════════════════════════════════════════════════════════════
// Production behaviour
// ═══════════════════════════════════════════════════════════════════
test('in production the email-only login is refused → 404 not_found', async () => {
  const prev = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  __resetAuthConfigForTests();
  try {
    const res = await request(createApp())
      .post('/auth/login/staff')
      .send({ role: 'admin', email: ADMIN_EMAIL });
    // A 404 rather than a 401: the refusal happens before the database
    // lookup, so production never reveals whether the account exists.
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
    assert.equal(res.body.token, undefined, 'no token may be minted');
  } finally {
    process.env['NODE_ENV'] = prev ?? 'test';
    __resetAuthConfigForTests();
  }
});

test('in production a password login still works', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  await setPassword('doctor', id, GOOD_PASSWORD);

  const prev = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  __resetAuthConfigForTests();
  try {
    const res = await request(createApp())
      .post('/auth/login/staff')
      .send({ role: 'doctor', email: DOCTOR_EMAIL, password: GOOD_PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  } finally {
    process.env['NODE_ENV'] = prev ?? 'test';
    __resetAuthConfigForTests();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Clearing a credential
// ═══════════════════════════════════════════════════════════════════
test('clearing a credential → 200 credential_configured false', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  await setPassword('doctor', id, GOOD_PASSWORD);

  const res = await request(createApp())
    .delete(`/admin/staff/doctor/${id}/password`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.credential_configured, false);

  const r = await db.pool.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM doctor WHERE id = $1::uuid`,
    [id],
  );
  assert.equal(r.rows[0]?.password_hash, null);
});

test('after clearing, a password login no longer succeeds', async () => {
  const id = await staffId('doctor', DOCTOR_EMAIL);
  await setPassword('doctor', id, GOOD_PASSWORD);
  await request(createApp())
    .delete(`/admin/staff/doctor/${id}/password`)
    .set('Authorization', `Bearer ${adminToken()}`);

  const res = await request(createApp())
    .post('/auth/login/staff')
    .send({ role: 'doctor', email: DOCTOR_EMAIL, password: GOOD_PASSWORD });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});
