/**
 * 11-admin-roles-types.test.ts — admin scope: receptionists + appointment-types + audit.
 *
 * Coverage:
 *   - POST  /admin/receptionists
 *   - GET   /admin/receptionists              (?active=, ?branch_id=)
 *   - GET   /admin/receptionists/:id
 *   - PATCH /admin/receptionists/:id          (rename / activate /
 *                                              deactivate / reassign branch)
 *   - POST  /admin/appointment-types
 *   - GET   /admin/appointment-types          (?active=)
 *   - GET   /admin/appointment-types/:id
 *   - PATCH /admin/appointment-types/:id      (rename / activate / deactivate)
 *   - GET   /admin/audit                      (policy envelope; no PII)
 *
 * Notes:
 *   - Receptionists have exactly one branch_id (BR-004) — the column
 *     IS the assignment, no junction table.
 *   - Deactivating a receptionist or appointment type emits a WARNING,
 *     not a 409 (F-19 / F-08): the response carries
 *     `warning: 'receptionist_has_future_appointments'` (or
 *     `appointment_type_has_future_appointments`) plus
 *     `future_appointment_count: N`. Future appointments stay Scheduled.
 *   - /admin/audit returns a fixed policy envelope explaining that
 *     individual-appointment audit is intentionally not exposed to the
 *     admin role (NFR-005 + PRD §2.4).
 *   - No DELETE on either route. Soft-delete = deactivate.
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

const PATIENT = '+15550000001';
const EAST_BRANCH = 'East Branch';

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

function patientToken(phone: string): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
}
function adminToken(): string {
  return signClaim({
    sub: 'admin-main',
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
}

async function lookupBranchId(branch: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(`SELECT id FROM branch WHERE name = $1`, [branch]);
  if (!rows[0]) throw new Error(`seed missing: ${branch}`);
  return rows[0].id;
}

// ═══════════════════════════════════════════════════════════════════
// POST /admin/receptionists
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/receptionists (no auth) → 401', async () => {
  const res = await request(createApp()).post('/admin/receptionists').send({});
  assert.equal(res.status, 401);
});

test('POST /admin/receptionists (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({});
  assert.equal(res.status, 403);
});

test('POST /admin/receptionists (missing full_name) → 400 invalid_full_name', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const res = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ email: 'newrec@y.com', branch_id: branchId });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_full_name');
});

test('POST /admin/receptionists (bad email) → 400 invalid_email', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const res = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Rec New', email: 'not-an-email', branch_id: branchId });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_email');
});

test('POST /admin/receptionists (missing branch_id) → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Rec New', email: 'rec-new@y.com' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('POST /admin/receptionists (non-UUID branch) → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Rec New', email: 'rec-new@y.com', branch_id: 'not-a-uuid' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('POST /admin/receptionists (valid) → 201', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const uniqueEmail = `newrec-${Date.now()}@y.com`;
  const res = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Rec New', email: uniqueEmail, branch_id: branchId });
  assert.equal(res.status, 201);
  assert.equal(res.body.full_name, 'Rec New');
  assert.equal(res.body.branch_id, branchId);
  assert.equal(res.body.active, true);
  // Cleanup
  await db.pool.query(`DELETE FROM receptionist WHERE id = $1`, [res.body.id]);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/receptionists
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/receptionists (no auth) → 401', async () => {
  const res = await request(createApp()).get('/admin/receptionists');
  assert.equal(res.status, 401);
});

test('GET /admin/receptionists (admin) → 200 list', async () => {
  const res = await request(createApp())
    .get('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 1);
  for (const r of res.body) {
    assert.equal(typeof r.id, 'string');
    assert.equal(typeof r.branch_id, 'string');
  }
});

test('GET /admin/receptionists?branch_id=... → 200 filtered', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/receptionists?branch_id=${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  for (const r of res.body) {
    assert.equal(r.branch_id, branchId);
  }
});

test('GET /admin/receptionists?branch_id=garbage → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .get('/admin/receptionists?branch_id=not-a-uuid')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /admin/receptionists?active=false → only inactive', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const email = `temprec-${Date.now()}@y.com`;
  const created = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Temp Rec', email, branch_id: branchId });
  assert.equal(created.status, 201);
  const deact = await request(createApp())
    .patch(`/admin/receptionists/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: false });
  assert.equal(deact.status, 200);

  const res = await request(createApp())
    .get('/admin/receptionists?active=false')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  const found = res.body.find((r: { id: string }) => r.id === created.body.id);
  assert.ok(found);
  assert.equal(found.active, false);

  // Cleanup
  await db.pool.query(`DELETE FROM receptionist WHERE id = $1`, [created.body.id]);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/receptionists/:id
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/receptionists/:id (non-UUID) → 400', async () => {
  const res = await request(createApp())
    .get('/admin/receptionists/not-a-uuid')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_receptionist_id');
});

test('GET /admin/receptionists/:id (unknown) → 404', async () => {
  const res = await request(createApp())
    .get('/admin/receptionists/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'receptionist_not_found');
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /admin/receptionists/:id
// ═══════════════════════════════════════════════════════════════════
test('PATCH /admin/receptionists/:id (no auth) → 401', async () => {
  const res = await request(createApp()).patch('/admin/receptionists/00000000-0000-0000-0000-000000000000').send({});
  assert.equal(res.status, 401);
});

test('PATCH /admin/receptionists/:id (empty body) → 400 no_fields_to_update', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const created = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Patch Rec', email: `patchrec-${Date.now()}@y.com`, branch_id: branchId });
  assert.equal(created.status, 201);
  const res = await request(createApp())
    .patch(`/admin/receptionists/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'no_fields_to_update');
  await db.pool.query(`DELETE FROM receptionist WHERE id = $1`, [created.body.id]);
});

test('PATCH /admin/receptionists/:id (rename) → 200', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const created = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Rename Me', email: `renamerec-${Date.now()}@y.com`, branch_id: branchId });
  assert.equal(created.status, 201);
  const res = await request(createApp())
    .patch(`/admin/receptionists/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.full_name, 'Renamed');
  await db.pool.query(`DELETE FROM receptionist WHERE id = $1`, [created.body.id]);
});

test('PATCH /admin/receptionists/:id (deactivate then reactivate) → 200', async () => {
  const branchId = await lookupBranchId(EAST_BRANCH);
  const created = await request(createApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Deact Rec', email: `deactrec-${Date.now()}@y.com`, branch_id: branchId });
  assert.equal(created.status, 201);
  const d = await request(createApp())
    .patch(`/admin/receptionists/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: false });
  assert.equal(d.status, 200);
  assert.equal(d.body.active, false);
  const r = await request(createApp())
    .patch(`/admin/receptionists/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.active, true);
  await db.pool.query(`DELETE FROM receptionist WHERE id = $1`, [created.body.id]);
});

// ═══════════════════════════════════════════════════════════════════
// POST /admin/appointment-types
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/appointment-types (no auth) → 401', async () => {
  const res = await request(createApp()).post('/admin/appointment-types').send({});
  assert.equal(res.status, 401);
});

test('POST /admin/appointment-types (patient role) → 403', async () => {
  const res = await request(createApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({});
  assert.equal(res.status, 403);
});

test('POST /admin/appointment-types (missing name) → 400 invalid_name', async () => {
  const res = await request(createApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ duration_minutes: 30 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_name');
});

test('POST /admin/appointment-types (duration < 5) → 400 invalid_duration_minutes', async () => {
  const res = await request(createApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'Tiny', duration_minutes: 1 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_duration_minutes');
});

test('POST /admin/appointment-types (duration > 480) → 400 invalid_duration_minutes', async () => {
  const res = await request(createApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'Way Too Long', duration_minutes: 9999 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_duration_minutes');
});

test('POST /admin/appointment-types (duration non-integer) → 400 invalid_duration_minutes', async () => {
  const res = await request(createApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'Float Duration', duration_minutes: 30.5 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_duration_minutes');
});

test('POST /admin/appointment-types (valid) → 201', async () => {
  const res = await request(createApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'Specialist Consult', duration_minutes: 60 });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Specialist Consult');
  assert.equal(res.body.duration_minutes, 60);
  assert.equal(res.body.is_active, true);
  // Cleanup
  await db.pool.query(`DELETE FROM appointment_type WHERE id = $1`, [res.body.id]);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/appointment-types
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/appointment-types (no auth) → 401', async () => {
  const res = await request(createApp()).get('/admin/appointment-types');
  assert.equal(res.status, 401);
});

test('GET /admin/appointment-types (admin) → 200 list', async () => {
  const res = await request(createApp())
    .get('/admin/appointment-types')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  for (const t of res.body) {
    assert.equal(typeof t.id, 'string');
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.duration_minutes, 'number');
  }
});

test('GET /admin/appointment-types?active=true → only active', async () => {
  const res = await request(createApp())
    .get('/admin/appointment-types?active=true')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  for (const t of res.body) assert.equal(t.is_active, true);
});

test('GET /admin/appointment-types?active=garbage → 400 invalid_active_filter', async () => {
  const res = await request(createApp())
    .get('/admin/appointment-types?active=maybe')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_active_filter');
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/appointment-types/:id
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/appointment-types/:id (non-UUID) → 400', async () => {
  const res = await request(createApp())
    .get('/admin/appointment-types/not-a-uuid')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_appointment_type_id');
});

test('GET /admin/appointment-types/:id (unknown) → 404', async () => {
  const res = await request(createApp())
    .get('/admin/appointment-types/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'appointment_type_not_found');
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /admin/appointment-types/:id
// ═══════════════════════════════════════════════════════════════════
test('PATCH /admin/appointment-types/:id (no auth) → 401', async () => {
  const res = await request(createApp()).patch('/admin/appointment-types/00000000-0000-0000-0000-000000000000').send({});
  assert.equal(res.status, 401);
});

test('PATCH /admin/appointment-types/:id (empty body) → 400 no_fields_to_update', async () => {
  const { rows } = await db.pool.query<{ id: string }>(`SELECT id FROM appointment_type WHERE name = 'General Consultation'`);
  const res = await request(createApp())
    .patch(`/admin/appointment-types/${rows[0]!.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'no_fields_to_update');
});

test('PATCH /admin/appointment-types/:id (rename) → 200', async () => {
  const { rows } = await db.pool.query<{ id: string }>(`SELECT id FROM appointment_type WHERE name = 'General Consultation'`);
  const res = await request(createApp())
    .patch(`/admin/appointment-types/${rows[0]!.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'General Consultation (renamed)' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'General Consultation (renamed)');
  // Restore
  await request(createApp())
    .patch(`/admin/appointment-types/${rows[0]!.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'General Consultation' });
});

test('PATCH /admin/appointment-types/:id (deactivate; warning if future appts) → 200', async () => {
  // Create a fresh type and deactivate it. No future appts → no warning.
  const created = await request(createApp())
    .post('/admin/appointment-types')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'Test Type', duration_minutes: 30 });
  assert.equal(created.status, 201);
  const d = await request(createApp())
    .patch(`/admin/appointment-types/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ is_active: false });
  assert.equal(d.status, 200);
  assert.equal(d.body.is_active, false);
  // warning is null on the no-future-appts path (not undefined)
  assert.equal(d.body.warning, null);
  await db.pool.query(`DELETE FROM appointment_type WHERE id = $1`, [created.body.id]);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/audit
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/audit (no auth) → 401', async () => {
  const res = await request(createApp()).get('/admin/audit');
  assert.equal(res.status, 401);
});

test('GET /admin/audit (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /admin/audit (admin) → 200 with policy envelope', async () => {
  const res = await request(createApp())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointments_audit_reads, 'rejected_per_role_policy');
  assert.ok(typeof res.body.reason === 'string');
  assert.equal(res.body.doctor_endpoint, 'GET /doctor/appointments/:id/audit');
  assert.equal(res.body.receptionist_endpoint, 'GET /reception/appointments/:id/audit');
  // No PII surfaces in the envelope
  assert.equal(res.body.patient_phone, undefined);
  assert.equal(res.body.appointment_id, undefined);
});
