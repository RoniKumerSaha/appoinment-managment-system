/**
 * 01-public.test.ts — Public catalog + observability endpoints.
 *
 * Coverage:
 *   - GET /healthz            (process liveness, public, no auth)
 *   - GET /readyz             (DB ping, public, no auth)
 *   - GET /metrics            (Prometheus + JSON, public, no auth)
 *   - GET /public/doctors     (Bearer, returns only active doctors)
 *   - GET /public/branches    (Bearer, optionally filtered by doctor_id)
 *   - GET /public/appointment-types (Bearer, returns only active types)
 *
 * Conventions:
 *   - All seeded data comes from apps/api/db/seeds/01_minimum.ts (applied
 *     in globalSetup via withTestDb).
 *   - All API tests reuse `signClaim` from src/auth/jwt.ts to mint JWTs.
 *   - Auth is required for /public/* (per app.ts mount order).
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
  // Wipe any appointment rows created by these tests so the rest of the
  // suite starts clean. (No insert in this file today; defensive.)
  const client = await db.pool.connect();
  try {
    await client.query(`DELETE FROM appointment_audit`);
    await client.query(`DELETE FROM appointment`);
  } finally {
    client.release();
  }
});

// ───────────────────────────────────────────────────────────────────
// Token helpers — one per role. Reused across all 12 API test files.
// ───────────────────────────────────────────────────────────────────
function patientToken(phone = '+15550000002'): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
}
function doctorToken(doctorId: string, branchId: string, email: string): string {
  return signClaim({
    sub: email,
    role: 'doctor',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
}
function receptionistToken(branchId: string, email: string): string {
  return signClaim({
    sub: email,
    role: 'receptionist',
    branch_ids: [branchId],
    scope: 'branch',
  });
}
function adminToken(email = 'admin-main@clinic.local'): string {
  return signClaim({
    sub: email,
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
}

async function lookupIds(): Promise<{
  doctorId: string;
  branchId: string;
  typeId: string;
}> {
  const { rows: drows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = 'Dr. East Lead'`,
  );
  const { rows: brows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = 'East Branch'`,
  );
  const { rows: trows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (!drows[0] || !brows[0] || !trows[0]) {
    throw new Error('seed missing — globalSetup did not run seedWith');
  }
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

// ───────────────────────────────────────────────────────────────────
// /healthz — public, no auth, always 200 { status: "ok" }
// ───────────────────────────────────────────────────────────────────
test('GET /healthz → 200 { status: "ok" } (no auth required)', async () => {
  const res = await request(createApp()).get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

// ───────────────────────────────────────────────────────────────────
// /readyz — public, no auth, 200 if DB reachable, 503 if not
// ───────────────────────────────────────────────────────────────────
test('GET /readyz → 200 { db: "ok" } when DB is reachable', async () => {
  const res = await request(createApp()).get('/readyz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { db: 'ok' });
});

// ───────────────────────────────────────────────────────────────────
// /metrics — public, no auth, Prometheus text or JSON
// ───────────────────────────────────────────────────────────────────
test('GET /metrics → 200 text/plain Prometheus by default', async () => {
  const res = await request(createApp()).get('/metrics');
  assert.equal(res.status, 200);
  // Prometheus content-type begins with text/plain
  assert.ok(
    typeof res.headers['content-type'] === 'string' &&
      (res.headers['content-type'] as string).startsWith('text/plain'),
    `expected Prometheus content-type, got ${res.headers['content-type']}`,
  );
  // Body should contain at least one metric line (e.g. process or counters)
  assert.ok(typeof res.text === 'string' && res.text.length > 0, 'body should be non-empty');
});

test('GET /metrics Accept: application/json → 200 { counters: {...} }', async () => {
  const res = await request(createApp())
    .get('/metrics')
    .set('Accept', 'application/json');
  assert.equal(res.status, 200);
  assert.ok(
    typeof res.body === 'object' && res.body !== null,
    'expected JSON object',
  );
  assert.ok('counters' in res.body, 'expected counters field');
  assert.equal(typeof res.body.counters, 'object');
});

// ───────────────────────────────────────────────────────────────────
// /public/doctors — requires Bearer; returns only active doctors
// ───────────────────────────────────────────────────────────────────
test('GET /public/doctors → 401 when no Bearer token', async () => {
  const res = await request(createApp()).get('/public/doctors');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

test('GET /public/doctors (patient) → 200 with active doctors only', async () => {
  const res = await request(createApp())
    .get('/public/doctors')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.doctors), 'expected doctors array');
  assert.ok(res.body.doctors.length >= 1, 'seed should have ≥1 doctor');
  for (const doc of res.body.doctors) {
    assert.equal(typeof doc.id, 'string');
    assert.equal(typeof doc.full_name, 'string');
    assert.equal(typeof doc.branch_count, 'number');
    assert.ok(doc.branch_count >= 1, 'each doctor should have ≥1 branch');
    // Email must NEVER leak through the public endpoint (NFR-007).
    assert.equal(doc.email, undefined, 'email must not leak');
  }
});

test('GET /public/doctors (admin) → 200 (any role can read catalog)', async () => {
  const res = await request(createApp())
    .get('/public/doctors')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.doctors));
});

// ───────────────────────────────────────────────────────────────────
// /public/branches — requires Bearer; optional ?doctor_id= filter
// ───────────────────────────────────────────────────────────────────
test('GET /public/branches → 401 when no Bearer token', async () => {
  const res = await request(createApp()).get('/public/branches');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

test('GET /public/branches (no filter) → 200 with all active branches + 7 days of hours', async () => {
  const res = await request(createApp())
    .get('/public/branches')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.branches));
  assert.ok(res.body.branches.length >= 2, 'seed has East + West');
  for (const b of res.body.branches) {
    assert.equal(typeof b.id, 'string');
    assert.equal(typeof b.name, 'string');
    assert.equal(typeof b.tz, 'string');
    assert.ok(Array.isArray(b.hours));
    assert.equal(b.hours.length, 7, 'branch should have 7 day rows');
  }
});

test('GET /public/branches?doctor_id=<uuid> → 200 with only that doctor\'s branches', async () => {
  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get(`/public/branches?doctor_id=${doctorId}`)
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.branches));
  // East lead only works at East, so the response should be { id: branch-east }.
  const ids = res.body.branches.map((b: { id: string }) => b.id);
  assert.ok(ids.includes(branchId), 'should include East branch');
});

test('GET /public/branches?doctor_id=not-a-uuid → 400 invalid_doctor_id', async () => {
  const res = await request(createApp())
    .get('/public/branches?doctor_id=not-a-uuid')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

// ───────────────────────────────────────────────────────────────────
// /public/appointment-types — requires Bearer; returns only active
// ───────────────────────────────────────────────────────────────────
test('GET /public/appointment-types → 401 when no Bearer token', async () => {
  const res = await request(createApp()).get('/public/appointment-types');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

test('GET /public/appointment-types (patient) → 200 with active types', async () => {
  const res = await request(createApp())
    .get('/public/appointment-types')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.appointment_types));
  assert.ok(res.body.appointment_types.length >= 1, 'seed has types');
  for (const t of res.body.appointment_types) {
    assert.equal(typeof t.id, 'string');
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.duration_minutes, 'number');
    assert.ok(t.duration_minutes >= 5 && t.duration_minutes <= 480);
  }
});
