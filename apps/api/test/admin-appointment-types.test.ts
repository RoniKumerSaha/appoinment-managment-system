/**
 * admin-appointment-types.test.ts — full I/O matrix for E2-S3
 * (GET /admin/appointment-types,
 *  POST /admin/appointment-types,
 *  GET /admin/appointment-types/:id,
 *  PATCH /admin/appointment-types/:id).
 *
 * Covers every row of spec-2-3's I/O & Edge-Case Matrix:
 *   - GET happy / ?active=true|false / invalid filter / no-auth / patient-403.
 *   - POST happy / duration<5 / duration>480 / non-integer duration /
 *     name empty / name>120 / unknown field / missing fields / no auth /
 *     patient 403.
 *   - GET-id happy / unknown / non-UUID / no auth / patient 403.
 *   - PATCH rename / activate / deactivate clean / deactivate-with-future
 *     (warns, count>=1) / duration<5 / empty body / unknown field /
 *     unknown id / non-UUID id / no auth / patient 403.
 *
 * Seed note — the 01_minimum seed provisions:
 *   - 3 appointment_types: General Consultation (30 min) [used by the
 *     seeded future appointment], Follow-up (15 min), Specialist
 *     Consult (45 min). All active=true.
 *   - 1 future Scheduled appointment referencing General Consultation.
 * Tests targeting the "deactivate-with-future" branch deactivate
 * General Consultation; tests targeting the "deactivate-clean" branch
 * deactivate Follow-up or Specialist Consult.
 *
 * The after-hook restores all 3 seeded types to their canonical state
 * (active=true + original name) so sibling tests aren't affected.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signClaim } from '../src/auth/jwt.js';
import { __resetAuthConfigForTests } from '../src/auth/config.js';
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
  // Restore all 3 seeded appointment_types to canonical active=true +
  // original name + original duration. Tests may have deactivated them;
  // the rename test self-restores via an inline PATCH. Any rows
  // created by tests are deleted by their `E2-S3 test` prefix.
  await db.pool.query(
    `DELETE FROM appointment_type WHERE name LIKE 'E2-S3 test %'`,
  );
  await db.pool.query(
    `UPDATE appointment_type
        SET is_active = true,
            duration_minutes = CASE name
              WHEN 'General Consultation' THEN 30
              WHEN 'Follow-up' THEN 15
              WHEN 'Specialist Consult' THEN 45
              ELSE duration_minutes
            END
      WHERE name IN ('General Consultation', 'Follow-up', 'Specialist Consult')`,
  );
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

async function fetchTypeByName(name: string): Promise<{
  id: string;
  duration_minutes: number;
  is_active: boolean;
}> {
  const { rows } = await db.pool.query<{
    id: string;
    duration_minutes: number;
    is_active: boolean;
  }>(`SELECT id, duration_minutes, is_active FROM appointment_type WHERE name = $1`, [name]);
  if (rows.length === 0) {
    throw new Error(`seeded type "${name}" not found`);
  }
  return rows[0]!;
}

// ===========================================================================
// GET /admin/appointment-types
// ===========================================================================

test('GET /admin/appointment-types: happy path returns 3 seeded types', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 3);
  const names = res.body.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, ['Follow-up', 'General Consultation', 'Specialist Consult']);
  for (const t of res.body) {
    assert.ok(typeof t.id === 'string');
    assert.ok(typeof t.duration_minutes === 'number');
    assert.equal(t.is_active, true);
    assert.ok(typeof t.created_by === 'string');
  }
});

test('GET ?active=true returns all 3 (seeded types are all active)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/appointment-types?active=true')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
});

test('GET ?active=false returns empty (no seeded inactive types)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/appointment-types?active=false')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET ?active=banana → 400 invalid_active_filter', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/appointment-types?active=banana')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active_filter' });
});

test('GET /admin/appointment-types: no auth → 401', async () => {
  const res = await request(adminApp()).get('/admin/appointment-types');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /admin/appointment-types: patient JWT → 403', async () => {
  const res = await request(adminApp())
    .get('/admin/appointment-types')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// POST /admin/appointment-types
// ===========================================================================

test('POST /admin/appointment-types: happy → 201 + is_active=true', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test specialist',
      duration_minutes: 60,
    });
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.id === 'string');
  assert.equal(res.body.name, 'E2-S3 test specialist');
  assert.equal(res.body.duration_minutes, 60);
  assert.equal(res.body.is_active, true);
  assert.equal(res.body.created_by, 'staff:admin-main');

  // DB-side pin.
  const persisted = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment_type WHERE id = $1`,
    [res.body.id],
  );
  assert.equal(Number(persisted.rows[0]!.count), 1);

  // Cleanup so the after-hook sees a stable state.
  await db.pool.query(`DELETE FROM appointment_type WHERE id = $1`, [res.body.id]);
});

test('POST: duration_minutes=1 (sub-5) → 400 invalid_duration_minutes', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test tiny',
      duration_minutes: 1,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_duration_minutes' });
});

test('POST: duration_minutes=481 (over-480) → 400', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test huge',
      duration_minutes: 481,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_duration_minutes' });
});

test('POST: duration_minutes="30" (string) → 400', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test string-dur',
      duration_minutes: '30',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_duration_minutes' });
});

test('POST: name="" (empty) → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: '',
      duration_minutes: 30,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('POST: name 121 chars → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'x'.repeat(121),
      duration_minutes: 30,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('POST: missing duration_minutes → 400 invalid_duration_minutes', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test no-duration',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_duration_minutes' });
});

test('POST: unknown field → 400 unknown_field + fields[]', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test unknown',
      duration_minutes: 30,
      foo: 'bar',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.deepEqual(res.body.fields, ['foo']);
});

test('POST: no auth → 401', async () => {
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test no-auth',
      duration_minutes: 30,
    });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST: patient JWT → 403', async () => {
  const res = await request(adminApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test patient',
      duration_minutes: 30,
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// GET /admin/appointment-types/:id
// ===========================================================================

test('GET /admin/appointment-types/:id: happy', async () => {
  const token = __makeAdminToken();
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .get(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, followup.id);
  assert.equal(res.body.name, 'Follow-up');
  assert.equal(res.body.duration_minutes, 15);
  assert.equal(res.body.is_active, true);
});

test('GET /:id: unknown UUID → 404 appointment_type_not_found', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/appointment-types/00000000-0000-4000-8000-000000003000')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'appointment_type_not_found' });
});

test('GET /:id: non-UUID → 400 invalid_appointment_type_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/appointment-types/not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_appointment_type_id' });
});

test('GET /:id: no auth → 401', async () => {
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp()).get(
    `/admin/appointment-types/${followup.id}`,
  );
  assert.equal(res.status, 401);
});

// ===========================================================================
// PATCH /admin/appointment-types/:id
// ===========================================================================

test('PATCH /:id: rename → 200 + warning:null + future_appointment_count:0', async () => {
  const token = __makeAdminToken();
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'E2-S3 test rename target',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'E2-S3 test rename target');
  assert.equal(res.body.future_appointment_count, 0);
  assert.equal(res.body.warning, null);

  // Restore so the after-hook leaves the seed canonical.
  await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'Follow-up' });
});

test('PATCH /:id: activate → 200 (idempotent, no warning)', async () => {
  const token = __makeAdminToken();
  const followup = await fetchTypeByName('Follow-up');
  // already active, but the transition is a no-op + warning:null
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      is_active: true,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.is_active, true);
  assert.equal(res.body.future_appointment_count, 0);
  assert.equal(res.body.warning, null);
});

test('PATCH /:id: deactivate clean (Follow-up has 0 future appts) → 200 + warning:null', async () => {
  const token = __makeAdminToken();
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      is_active: false,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.is_active, false);
  assert.equal(res.body.future_appointment_count, 0);
  assert.equal(res.body.warning, null);

  // DB-side pin.
  const persisted = await db.pool.query<{ is_active: boolean }>(
    `SELECT is_active FROM appointment_type WHERE id = $1`,
    [followup.id],
  );
  assert.equal(persisted.rows[0]!.is_active, false);

  // Self-restore: leave Follow-up active so a mid-suite CI crash
  // doesn't poison seed state for sibling tests (P1 from review).
  await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ is_active: true });
});

test('PATCH /:id: deactivate WITH future (General Consultation has 1) → 200 + warning + count≥1', async () => {
  const token = __makeAdminToken();
  const general = await fetchTypeByName('General Consultation');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${general.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      is_active: false,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.is_active, false);
  assert.ok(res.body.future_appointment_count >= 1);
  assert.equal(res.body.warning, 'appointment_type_has_future_appointments');

  // Verify the future appointment stayed Scheduled (deactivate is
  // non-blocking per F-08).
  const futureAppts = await db.pool.query<{ status: string }>(
    `SELECT status FROM appointment WHERE appointment_type_id = $1 AND status = 'Scheduled' AND start_datetime > now()`,
    [general.id],
  );
  assert.ok(futureAppts.rows.length >= 1);

  // Self-restore: reactivate General Consultation (P1 from review).
  await request(adminApp())
    .patch(`/admin/appointment-types/${general.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ is_active: true });
});

test('PATCH /:id: duration_minutes is immutable (unknown_field)', async () => {
  const token = __makeAdminToken();
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      duration_minutes: 90,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.deepEqual(res.body.fields, ['duration_minutes']);
});

test('PATCH /:id: empty body → 400 no_fields_to_update', async () => {
  const token = __makeAdminToken();
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'no_fields_to_update' });
});

test('PATCH /:id: unknown field → 400 unknown_field', async () => {
  const token = __makeAdminToken();
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      name: 'irrelevant',
      foo: 'bar',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.deepEqual(res.body.fields, ['foo']);
});

test('PATCH /:id: unknown UUID → 404 appointment_type_not_found', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/appointment-types/00000000-0000-4000-8000-000000003010')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'noop' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'appointment_type_not_found' });
});

test('PATCH /:id: non-UUID → 400 invalid_appointment_type_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/appointment-types/not-a-uuid')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'noop' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_appointment_type_id' });
});

test('PATCH /:id: no auth → 401', async () => {
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('content-type', 'application/json')
    .send({ name: 'noop' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('PATCH /:id: patient JWT → 403', async () => {
  const followup = await fetchTypeByName('Follow-up');
  const res = await request(adminApp())
    .patch(`/admin/appointment-types/${followup.id}`)
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({ name: 'noop' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});