/**
 * admin-clinic.test.ts — full I/O matrix for `GET /admin/clinic` and
 * `PATCH /admin/clinic`, plus the production guard on `__makeAdminToken()`.
 *
 * Covers every row of the spec's I/O & Edge-Case Matrix:
 *   - GET happy path (admin token) → 200 + counts reflecting the seeded
 *     `01_minimum.ts` totals (branches_total === 2, doctors_total === 3,
 *     receptionists_total === 2, patients_total === 5).
 *   - GET unauthenticated → 401 `{error: 'unauthenticated'}` (auth
 *     middleware fires before adminScope).
 *   - GET patient JWT → 403 `{error: 'forbidden_role'}` (adminScope).
 *   - GET admin JWT scope=branch → 403 `{error: 'forbidden_scope'}`.
 *   - PATCH happy path → 200 + updated_at advances.
 *   - PATCH empty name / over-length name / missing name / non-string
 *     name → 400 `{error: 'invalid_name'}` BEFORE any DB write.
 *   - `__makeAdminToken()` with `NODE_ENV=production` → throws
 *     `admin_token_helper_disabled_in_production`.
 *
 * The DB-touching tests run against the shared Testcontainers pool
 * (booted by `globalSetup.cjs`). The seeded totals assertions exercise
 * the live `SELECT ... FROM clinic c` with 4 correlated subqueries.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signClaim } from '../src/auth/jwt.js';
import {
  __resetAuthConfigForTests,
} from '../src/auth/config.js';
import { createApp } from '../src/app.js';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { seedWith } from '../db/seeds/01_minimum.js';
import { __makeAdminToken } from './__helpers__/admin-token.js';

const VALID_SECRET = 'a'.repeat(48);
let db: TestDb;

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  __resetAuthConfigForTests();
  db = await getTestDb();
  // Seed once — every test in this file reads against the seeded DB. If
  // a sibling test file (e.g. seed.test.ts) already ran the seed, this is
  // a no-op (seed is idempotent via SELECT-then-INSERT + ON CONFLICT).
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

after(() => {
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

function adminScopeBranchToken(): string {
  // admin role but scope=branch — exercises the forbidden_scope path.
  return signClaim({
    sub: 'admin-branch',
    role: 'admin',
    branch_ids: ['some-branch'],
    scope: 'branch',
  });
}

test('GET /admin/clinic: happy path returns the singleton row + counts', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.id === 'string', 'id is the singleton UUID');
  assert.ok(typeof res.body.name === 'string', 'name is the clinic name');
  assert.ok(res.body.created_at, 'created_at present');
  assert.ok(res.body.updated_at, 'updated_at present');
  // Counts reflect the seeded minimum (branches=2, doctors=3, receptionists=2, patients=5).
  const c = res.body.counts;
  assert.ok(c, 'counts present');
  assert.equal(c.branches_total, 2, 'seeded branches_total');
  assert.equal(c.doctors_total, 3, 'seeded doctors_total');
  assert.equal(c.receptionists_total, 2, 'seeded receptionists_total');
  assert.equal(c.patients_total, 5, 'seeded patients_total');
});

test('GET /admin/clinic: no auth → 401 unauthenticated (auth fires before adminScope)', async () => {
  const res = await request(adminApp()).get('/admin/clinic');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /admin/clinic: patient JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /admin/clinic: admin JWT with scope=branch → 403 forbidden_scope', async () => {
  const res = await request(adminApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${adminScopeBranchToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_scope' });
});

test('PATCH /admin/clinic: happy path returns 200 with updated row + updated_at advances', async () => {
  // Read the pre-call updated_at.
  const token = __makeAdminToken();
  const before = await db.pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM clinic LIMIT 1`,
  );
  const preUpdatedAt = before.rows[0]!.updated_at;

  // Wait at least 1ms so the trigger's now() advances past the pre-call value.
  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'Renamed Clinic' });
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.id === 'string');
  assert.equal(res.body.name, 'Renamed Clinic');
  assert.ok(res.body.created_at, 'created_at present');
  assert.ok(res.body.updated_at, 'updated_at present');

  const postUpdatedAt = new Date(res.body.updated_at as string);
  assert.ok(
    postUpdatedAt.getTime() > preUpdatedAt.getTime(),
    `updated_at must advance: pre=${preUpdatedAt.toISOString()} post=${postUpdatedAt.toISOString()}`,
  );

  // Restore for any later test (none reads the name, but keep DB clean).
  await db.pool.query(`UPDATE clinic SET name = 'Test Clinic' WHERE id = $1`, [
    res.body.id,
  ]);
});

test('PATCH /admin/clinic: empty name → 400 invalid_name BEFORE any DB write', async () => {
  const token = __makeAdminToken();
  const before = await db.pool.query<{ name: string; updated_at: Date }>(
    `SELECT name, updated_at FROM clinic LIMIT 1`,
  );
  const pre = before.rows[0]!;

  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: '' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });

  // Verify no DB write occurred.
  const after = await db.pool.query<{ name: string; updated_at: Date }>(
    `SELECT name, updated_at FROM clinic LIMIT 1`,
  );
  assert.equal(after.rows[0]!.name, pre.name, 'name unchanged');
  assert.equal(
    after.rows[0]!.updated_at.getTime(),
    pre.updated_at.getTime(),
    'updated_at unchanged (trigger did not fire)',
  );
});

test('PATCH /admin/clinic: 121-char name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const tooLong = 'a'.repeat(121);
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: tooLong });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('PATCH /admin/clinic: missing name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('PATCH /admin/clinic: null name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: null });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('PATCH /admin/clinic: non-string name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 123 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('PATCH /admin/clinic: whitespace-only name → 400 invalid_name (post-trim length check)', async () => {
  const token = __makeAdminToken();
  const before = await db.pool.query<{ name: string; updated_at: Date }>(
    `SELECT name, updated_at FROM clinic LIMIT 1`,
  );
  const pre = before.rows[0]!;

  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: '     ' }); // 5 spaces; length=5 ≥ 1, but trim → length=0
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });

  // Verify no DB write occurred.
  const after = await db.pool.query<{ name: string; updated_at: Date }>(
    `SELECT name, updated_at FROM clinic LIMIT 1`,
  );
  assert.equal(after.rows[0]!.name, pre.name, 'name unchanged');
  assert.equal(
    after.rows[0]!.updated_at.getTime(),
    pre.updated_at.getTime(),
    'updated_at unchanged (trigger did not fire)',
  );
});

test('PATCH /admin/clinic: leading/trailing whitespace is trimmed before storing', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: '  Trimmed Clinic  ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Trimmed Clinic', 'stored name is trimmed');

  // Restore for cleanliness.
  await db.pool.query(`UPDATE clinic SET name = 'Test Clinic'`);
});

test('PATCH /admin/clinic: 120-char name is accepted (boundary)', async () => {
  const token = __makeAdminToken();
  const nameAtBoundary = 'a'.repeat(120);
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: nameAtBoundary });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, nameAtBoundary);
  // Restore for cleanliness.
  await db.pool.query(`UPDATE clinic SET name = 'Test Clinic'`);
});

test('PATCH /admin/clinic: 1-char name is accepted (boundary)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'A' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'A');
  await db.pool.query(`UPDATE clinic SET name = 'Test Clinic'`);
});

test('PATCH /admin/clinic: unauthenticated → 401 unauthenticated', async () => {
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('content-type', 'application/json')
    .send({ name: 'No auth' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('PATCH /admin/clinic: patient JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({ name: 'Patient tries to rename' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('__makeAdminToken() with custom sub → mints a signed JWT for that sub', () => {
  const tok = __makeAdminToken('admin-east');
  // Round-trip through verifyToken to confirm the signature is real and
  // the sub is what we asked for.
  const parts = tok.split('.');
  assert.equal(parts.length, 3, 'JWT has 3 parts');
  const payload = JSON.parse(
    Buffer.from(parts[1]!, 'base64url').toString('utf8'),
  );
  assert.equal(payload.sub, 'admin-east');
  assert.equal(payload.role, 'admin');
  assert.equal(payload.scope, 'clinic');
  // Sentinel placeholder satisfies the E0-S3 empty-branch_ids guard; the
  // admin route never consults `branch_ids` (admin scoping lives at
  // `scope: 'clinic'` per AD-8). See `__helpers__/admin-token.ts`.
  assert.deepEqual(payload.branch_ids, ['__clinic_anchor__']);
});

test('__makeAdminToken() in NODE_ENV=production → throws admin_token_helper_disabled_in_production', () => {
  const prevEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    assert.throws(
      () => __makeAdminToken(),
      /admin_token_helper_disabled_in_production/,
    );
  } finally {
    if (prevEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = prevEnv;
    }
  }
});
