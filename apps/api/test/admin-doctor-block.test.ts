/**
 * admin-doctor-block.test.ts — full I/O matrix for E2-S2
 * (GET /admin/doctors/:id/blocks,
 *  POST /admin/doctors/:id/blocks-impact,
 *  POST /admin/doctors/:id/blocks,
 *  DELETE /admin/doctors/:id/blocks/:block_id).
 *
 * Covers every row of spec-2-2's I/O & Edge-Case Matrix:
 *   - GET happy / unknown / non-UUID / no-auth / patient-403.
 *   - POST-impact clean / with-overlap / invalid_time_range / past / branch-not-in-doctor.
 *   - POST clean / with-overlap (409) / past / invalid_time_range / branch-not-in-doctor / unknown-doctor.
 *   - DELETE happy (204) / unknown (404) / non-UUID (400).
 *
 * after-hook deletes every block row for the 3 seeded doctors so sibling
 * tests aren't affected.
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

function isoOffsetDays(days: number): string {
  // Pin to midnight UTC so the `.replace('T00:00:00', 'T01:00:00')` trick
  // in callers reliably produces a 1-hour block, regardless of when the
  // test runs. Without the floor, a test executed mid-day UTC would get
  // identical start/end timestamps → `invalid_time_range`.
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

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
  await db.pool.query(
    `DELETE FROM doctor_block WHERE doctor_id IN
       (SELECT id FROM doctor WHERE full_name IN
         ('Dr. East Lead', 'Dr. East Support', 'Dr. West Lead'))`,
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

// ===========================================================================
// GET /admin/doctors/:id/blocks
// ===========================================================================

test('GET /admin/doctors/:id/blocks: happy path returns empty list (seed has no blocks)', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .get(`/admin/doctors/${eastLead.id}/blocks`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.blocks));
  assert.equal(res.body.blocks.length, 0);
});

test('GET .../blocks: unknown doctor → 404', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/doctors/00000000-0000-4000-8000-000000002000/blocks')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('GET .../blocks: non-UUID id → 400 invalid_doctor_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/doctors/not-a-uuid/blocks')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('GET .../blocks: no auth → 401', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp()).get(`/admin/doctors/${eastLead.id}/blocks`);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET .../blocks: patient JWT → 403', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .get(`/admin/doctors/${eastLead.id}/blocks`)
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// POST /admin/doctors/:id/blocks-impact
// ===========================================================================

test('POST .../blocks-impact: clean (no overlap) → 200 + 0 affected', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  const west = await fetchBranchByName('West Branch');
  // West Lead has 0 future Scheduled appointments, so any non-overlapping
  // window returns 0.
  const res = await request(adminApp())
    .post(`/admin/doctors/${westLead.id}/blocks-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: west.id,
      start_datetime: isoOffsetDays(2),
      end_datetime: isoOffsetDays(2).replace('T00:00:00', 'T01:00:00'),
      reason: 'lunch',
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.future_appointment_count, 0);
  assert.deepEqual(res.body.affected_appointments, []);
});

test('POST .../blocks-impact: with overlap → 200 + masked list', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  // The seed provisions a future appointment for East Lead at East Branch,
  // starting ~7 days from now. Construct a block that fully covers that
  // window — guaranteed overlap.
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: east.id,
      start_datetime: isoOffsetDays(5),
      end_datetime: isoOffsetDays(10),
      reason: 'vacation',
    });
  assert.equal(res.status, 200);
  assert.ok(res.body.future_appointment_count >= 1);
  assert.equal(res.body.affected_appointments[0].patient_phone_masked, '+1XXXXXXXXXX');
});

test('POST .../blocks-impact: invalid time range (end <= start) → 400', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = isoOffsetDays(5);
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: east.id,
      start_datetime: t,
      end_datetime: t, // equal — invalid
      reason: 'noop',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_time_range' });
});

test('POST .../blocks-impact: past start_datetime → 400 start_in_past', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: east.id,
      start_datetime: '2020-01-01T10:00:00Z',
      end_datetime: '2020-01-01T11:00:00Z',
      reason: 'history',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'start_in_past');
});

test('POST .../blocks-impact: branch not in doctor_branches → 400', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const west = await fetchBranchByName('West Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: west.id,
      start_datetime: isoOffsetDays(3),
      end_datetime: isoOffsetDays(4),
      reason: 'wrong branch',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'branch_not_in_doctor_branches');
});

test('POST .../blocks-impact: unknown doctor → 404', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/doctors/00000000-0000-4000-8000-000000002001/blocks-impact')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: '00000000-0000-4000-8000-000000002003',
      start_datetime: isoOffsetDays(2),
      end_datetime: isoOffsetDays(2).replace('T00:00:00', 'T01:00:00'),
      reason: 'noop',
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

// ===========================================================================
// POST /admin/doctors/:id/blocks  (create)
// ===========================================================================

test('POST .../blocks: clean → 201 + id', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  const west = await fetchBranchByName('West Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${westLead.id}/blocks`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: west.id,
      start_datetime: isoOffsetDays(15),
      end_datetime: isoOffsetDays(16),
      reason: 'clean',
    });
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.id === 'string');
  assert.equal(res.body.doctor_id, westLead.id);
  assert.equal(res.body.branch_id, west.id);
  assert.equal(res.body.reason, 'clean');
  assert.equal(res.body.created_by, 'staff:admin-main');

  // DB-side pin.
  const persisted = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM doctor_block WHERE doctor_id = $1`,
    [westLead.id],
  );
  assert.equal(Number(persisted.rows[0]!.count), 1);
});

test('POST .../blocks: with overlap → 409 + masked list (no DB write)', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  // Pre-condition: zero blocks for East Lead.
  await db.pool.query(`DELETE FROM doctor_block WHERE doctor_id = $1`, [eastLead.id]);
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: east.id,
      start_datetime: isoOffsetDays(5),
      end_datetime: isoOffsetDays(10),
      reason: 'vacation',
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'block_overlaps_future_appointments');
  assert.ok(res.body.future_appointment_count >= 1);
  assert.equal(res.body.affected_appointments[0].patient_phone_masked, '+1XXXXXXXXXX');

  // DB-side pin: no block was inserted.
  const persisted = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM doctor_block WHERE doctor_id = $1`,
    [eastLead.id],
  );
  assert.equal(Number(persisted.rows[0]!.count), 0, 'rollback must leave no rows');
});

test('POST .../blocks: past start → 400 start_in_past', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: east.id,
      start_datetime: '2020-01-01T10:00:00Z',
      end_datetime: '2020-01-01T11:00:00Z',
      reason: 'history',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'start_in_past');
});

test('POST .../blocks: invalid time range → 400 invalid_time_range', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = isoOffsetDays(5);
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: east.id,
      start_datetime: t,
      end_datetime: t,
      reason: 'noop',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_time_range' });
});

test('POST .../blocks: branch not in doctor_branches → 400', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const west = await fetchBranchByName('West Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: west.id,
      start_datetime: isoOffsetDays(3),
      end_datetime: isoOffsetDays(4),
      reason: 'wrong branch',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'branch_not_in_doctor_branches');
});

test('POST .../blocks: unknown doctor → 404', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/doctors/00000000-0000-4000-8000-000000002002/blocks')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: '00000000-0000-4000-8000-000000002004',
      start_datetime: isoOffsetDays(2),
      end_datetime: isoOffsetDays(2).replace('T00:00:00', 'T01:00:00'),
      reason: 'noop',
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('POST .../blocks: no auth → 401', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/blocks`)
    .set('content-type', 'application/json')
    .send({
      branch_id: east.id,
      start_datetime: isoOffsetDays(2),
      end_datetime: isoOffsetDays(2).replace('T00:00:00', 'T01:00:00'),
      reason: 'noop',
    });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// DELETE /admin/doctors/:id/blocks/:block_id
// ===========================================================================

test('DELETE .../blocks/:block_id: happy path returns 204 (no body)', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  const west = await fetchBranchByName('West Branch');
  // Create a block to delete.
  const created = await request(adminApp())
    .post(`/admin/doctors/${westLead.id}/blocks`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_id: west.id,
      start_datetime: isoOffsetDays(20),
      end_datetime: isoOffsetDays(20).replace('T00:00:00', 'T01:00:00'),
      reason: 'to delete',
    });
  assert.equal(created.status, 201);
  const blockId = created.body.id as string;

  const res = await request(adminApp())
    .delete(`/admin/doctors/${westLead.id}/blocks/${blockId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 204);
  assert.equal(res.text, '');

  // DB-side pin: row is gone.
  const persisted = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM doctor_block WHERE id = $1`,
    [blockId],
  );
  assert.equal(Number(persisted.rows[0]!.count), 0);
});

test('DELETE .../blocks/:block_id: unknown UUID → 404 block_not_found', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .delete(`/admin/doctors/${eastLead.id}/blocks/00000000-0000-4000-8000-000000002010`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'block_not_found' });
});

test('DELETE .../blocks/:block_id: non-UUID block id → 400 invalid_block_id', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .delete(`/admin/doctors/${eastLead.id}/blocks/not-a-uuid`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_block_id' });
});

test('DELETE .../blocks/:block_id: non-UUID doctor id → 400 invalid_doctor_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .delete('/admin/doctors/not-a-uuid/blocks/00000000-0000-4000-8000-000000002011')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('DELETE .../blocks/:block_id: no auth → 401', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp()).delete(
    `/admin/doctors/${eastLead.id}/blocks/00000000-0000-4000-8000-000000002012`,
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});