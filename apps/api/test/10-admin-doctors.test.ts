/**
 * 10-admin-doctors.test.ts — admin scope: doctors + branches + schedule + blocks.
 *
 * Coverage:
 *   - POST  /admin/doctors
 *   - GET   /admin/doctors              (?active=, ?branch_id= filters)
 *   - GET   /admin/doctors/:id
 *   - PATCH /admin/doctors/:id          (rename / activate / deactivate)
 *   - PUT   /admin/doctors/:id/branches
 *   - GET   /admin/doctors/:id/schedule
 *   - POST  /admin/doctors/:id/schedule-impact
 *   - POST  /admin/doctors/:id/schedule
 *   - POST  /admin/doctors/:id/blocks
 *   - GET   /admin/doctors/:id/blocks
 *   - DELETE /admin/doctors/:id/blocks/:block_id
 *
 * Notes:
 *   - PUT /branches is idempotent: replaces the doctor's full set of
 *     branch assignments in a transaction (DELETE-then-INSERT with row
 *     lock on `doctor`).
 *   - Schedule rows are validated as a unit: per-row errors carry the
 *     offending index in `fields[]`. effective_from must be ≥ tomorrow
 *     (UTC); effective_to ≥ effective_from; within a (branch, day) group,
 *     no two rows overlap (half-open interval semantics).
 *   - Schedule-impact previews the future Scheduled appointments that
 *     the proposed schedule would invalidate; the actual POST path
 *     returns 409 `schedule_invalidates_future_appointments` and rolls
 *     back unless the admin acknowledges the impact via the request.
 *   - Doctor blocks are 1..240 minute windows at a specific branch;
 *     the impact preview reports count + sample of conflicting
 *     appointments.
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
const WEST_BRANCH = 'West Branch';
const DR_EAST_LEAD = 'Dr. East Lead';
const DR_EAST_SUPPORT = 'Dr. East Support';
const DR_WEST_LEAD = 'Dr. West Lead';

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

async function lookupIds(name: string, branch: string): Promise<{ doctorId: string; branchId: string; typeId: string }> {
  const { rows: drows } = await db.pool.query<{ id: string }>(`SELECT id FROM doctor WHERE full_name = $1`, [name]);
  const { rows: brows } = await db.pool.query<{ id: string }>(`SELECT id FROM branch WHERE name = $1`, [branch]);
  const { rows: trows } = await db.pool.query<{ id: string }>(`SELECT id FROM appointment_type WHERE name = 'General Consultation'`);
  if (!drows[0] || !brows[0] || !trows[0]) throw new Error(`seed missing: ${name}/${branch}`);
  return { doctorId: drows[0]!.id, branchId: brows[0]!.id, typeId: trows[0]!.id };
}

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ═══════════════════════════════════════════════════════════════════
// POST /admin/doctors
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/doctors (no auth) → 401', async () => {
  const res = await request(createApp())
    .post('/admin/doctors')
    .send({ full_name: 'X', email: 'x@y.com', branch_ids: [] });
  assert.equal(res.status, 401);
});

test('POST /admin/doctors (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({ full_name: 'X', email: 'x@y.com', branch_ids: [] });
  assert.equal(res.status, 403);
});

test('POST /admin/doctors (missing full_name) → 400 invalid_full_name', async () => {
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ email: 'newdoc@y.com', branch_ids: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_full_name');
});

test('POST /admin/doctors (bad email) → 400 invalid_email', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Dr. New', email: 'not-an-email', branch_ids: [branchId] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_email');
});

test('POST /admin/doctors (empty branch_ids) → 400 invalid_branch_ids', async () => {
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Dr. New', email: 'newdoc@y.com', branch_ids: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_ids');
});

test('POST /admin/doctors (non-UUID branch_id) → 400 invalid_branch_ids', async () => {
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Dr. New', email: 'newdoc2@y.com', branch_ids: ['not-a-uuid'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_ids');
});

test('POST /admin/doctors (unknown branch) → 400 branch_not_found', async () => {
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      full_name: 'Dr. New',
      email: 'newdoc3@y.com',
      branch_ids: ['00000000-0000-0000-0000-000000000000'],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'branch_not_found');
});

test('POST /admin/doctors (duplicate email) → 409 email_already_exists', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const seedEmail = 'dr.-east-lead@clinic.local'; // already in seed
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Dr. Duplicate', email: seedEmail, branch_ids: [branchId] });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'email_already_exists');
});

test('POST /admin/doctors (valid) → 201', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const uniqueEmail = `newdoc-${Date.now()}@y.com`;
  const res = await request(createApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Dr. Newcomer', email: uniqueEmail, branch_ids: [branchId] });
  assert.equal(res.status, 201);
  assert.equal(res.body.full_name, 'Dr. Newcomer');
  assert.equal(res.body.active, true);
  assert.equal(res.body.branches.length, 1);
  assert.equal(res.body.branches[0].id, branchId);
  // Cleanup
  await db.pool.query(`DELETE FROM doctor_branch WHERE doctor_id = $1`, [res.body.id]);
  await db.pool.query(`DELETE FROM doctor WHERE id = $1`, [res.body.id]);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/doctors
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/doctors (no auth) → 401', async () => {
  const res = await request(createApp()).get('/admin/doctors');
  assert.equal(res.status, 401);
});

test('GET /admin/doctors (admin) → 200 list', async () => {
  const res = await request(createApp())
    .get('/admin/doctors')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 3);
  for (const d of res.body) {
    assert.equal(typeof d.id, 'string');
    assert.ok(Array.isArray(d.branches));
  }
});

test('GET /admin/doctors?branch_id=... → 200 list filtered', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/doctors?branch_id=${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  for (const d of res.body) {
    assert.ok(d.branches.some((b: { id: string }) => b.id === branchId));
  }
});

test('GET /admin/doctors?branch_id=not-a-uuid → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .get('/admin/doctors?branch_id=not-a-uuid')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /admin/doctors?active=true → 200 only active', async () => {
  const res = await request(createApp())
    .get('/admin/doctors?active=true')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  for (const d of res.body) assert.equal(d.active, true);
});

test('GET /admin/doctors?active=garbage → 400 invalid_active_filter', async () => {
  const res = await request(createApp())
    .get('/admin/doctors?active=maybe')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_active_filter');
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/doctors/:id
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/doctors/:id (non-UUID) → 400 invalid_doctor_id', async () => {
  const res = await request(createApp())
    .get('/admin/doctors/not-a-uuid')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

test('GET /admin/doctors/:id (unknown) → 404 doctor_not_found', async () => {
  const res = await request(createApp())
    .get('/admin/doctors/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'doctor_not_found');
});

test('GET /admin/doctors/:id (existing) → 200 with branches', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, doctorId);
  assert.ok(res.body.branches.some((b: { id: string }) => b.id === branchId));
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /admin/doctors/:id
// ═══════════════════════════════════════════════════════════════════
test('PATCH /admin/doctors/:id (no auth) → 401', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp()).patch(`/admin/doctors/${doctorId}`).send({ full_name: 'X' });
  assert.equal(res.status, 401);
});

test('PATCH /admin/doctors/:id (unknown field) → 400 unknown_field', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ role: 'patient' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('PATCH /admin/doctors/:id (empty body) → 400 no_fields_to_update', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'no_fields_to_update');
});

test('PATCH /admin/doctors/:id (rename) → 200', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: 'Dr. East Lead (renamed)' });
  assert.equal(res.status, 200);
  assert.equal(res.body.full_name, 'Dr. East Lead (renamed)');
  // Restore
  await request(createApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ full_name: DR_EAST_LEAD });
});

test('PATCH /admin/doctors/:id (deactivate; no future appts) → 200 active=false', async () => {
  const { doctorId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  // Cancel any future appts for West Lead to avoid the warning
  await db.pool.query(
    `UPDATE appointment SET status = 'Cancelled'
       WHERE doctor_id = $1 AND status = 'Scheduled' AND start_datetime > now()`,
    [doctorId],
  );
  const res = await request(createApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  // Reactivate
  await request(createApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: true });
});

test('PATCH /admin/doctors/:id (activate invalid_active) → 400', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: 'true' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_active');
});

// ═══════════════════════════════════════════════════════════════════
// PUT /admin/doctors/:id/branches
// ═══════════════════════════════════════════════════════════════════
test('PUT /admin/doctors/:id/branches (no auth) → 401', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp()).put(`/admin/doctors/${doctorId}/branches`).send({ branch_ids: [] });
  assert.equal(res.status, 401);
});

test('PUT /admin/doctors/:id/branches (empty array) → 400 doctor_must_work_at_least_one_branch', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .put(`/admin/doctors/${doctorId}/branches`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ branch_ids: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'doctor_must_work_at_least_one_branch');
});

test('PUT /admin/doctors/:id/branches (non-UUID) → 400 invalid_branch_id', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .put(`/admin/doctors/${doctorId}/branches`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ branch_ids: ['not-a-uuid'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('PUT /admin/doctors/:id/branches (unknown branch) → 400 branch_not_found', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .put(`/admin/doctors/${doctorId}/branches`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ branch_ids: ['00000000-0000-0000-0000-000000000000'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'branch_not_found');
});

test('PUT /admin/doctors/:id/branches (replace with same set; idempotent) → 200', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .put(`/admin/doctors/${doctorId}/branches`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ branch_ids: [branchId] });
  assert.equal(res.status, 200);
  assert.equal(res.body.branches.length, 1);
  assert.equal(res.body.branches[0].id, branchId);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/doctors/:id/schedule
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/doctors/:id/schedule (non-UUID) → 400', async () => {
  const res = await request(createApp())
    .get('/admin/doctors/not-a-uuid/schedule')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

test('GET /admin/doctors/:id/schedule (unknown doctor) → 404', async () => {
  const res = await request(createApp())
    .get('/admin/doctors/00000000-0000-0000-0000-000000000000/schedule')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'doctor_not_found');
});

test('GET /admin/doctors/:id/schedule (existing) → 200', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/doctors/${doctorId}/schedule`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.doctor_id, doctorId);
  assert.ok(Array.isArray(res.body.schedule));
});

// ═══════════════════════════════════════════════════════════════════
// POST /admin/doctors/:id/schedule-impact
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/doctors/:id/schedule-impact (unknown field) → 400 unknown_field', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [], bogus: 'x' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('POST /admin/doctors/:id/schedule-impact (rows not array) → 400 invalid_rows', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_rows');
});

test('POST /admin/doctors/:id/schedule-impact (bad branch_id format) → 400 invalid_schedule_row', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      rows: [
        {
          branch_id: 'not-a-uuid',
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: tomorrowIso(),
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_schedule_row');
  assert.equal(res.body.fields[0], 0);
});

test('POST /admin/doctors/:id/schedule-impact (start >= end) → 400 invalid_schedule_row', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      rows: [
        {
          branch_id: branchId,
          day_of_week: 1,
          start_time: '17:00:00',
          end_time: '09:00:00',
          effective_from: tomorrowIso(),
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_schedule_row');
});

test('POST /admin/doctors/:id/schedule-impact (past effective_from) → 400 invalid_schedule_row', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      rows: [
        {
          branch_id: branchId,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: '2020-01-01',
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_schedule_row');
});

test('POST /admin/doctors/:id/schedule-impact (overlapping rows) → 400 schedule_rows_overlap', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      rows: [
        { branch_id: branchId, day_of_week: 1, start_time: '09:00:00', end_time: '12:00:00', effective_from: tomorrowIso(), effective_to: null },
        { branch_id: branchId, day_of_week: 1, start_time: '11:00:00', end_time: '13:00:00', effective_from: tomorrowIso(), effective_to: null },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'schedule_rows_overlap');
});

test('POST /admin/doctors/:id/schedule-impact (branch not at doctor) → 400 branch_not_in_doctor_branches', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const { branchId: westId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      rows: [
        {
          branch_id: westId, // East Lead isn't at West
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: tomorrowIso(),
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'branch_not_in_doctor_branches');
});

test('POST /admin/doctors/:id/schedule-impact (valid; no future appts) → 200 count_affected=0', async () => {
  const { doctorId, branchId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  // Cancel any future appts for West Lead
  await db.pool.query(
    `UPDATE appointment SET status = 'Cancelled'
       WHERE doctor_id = $1 AND status = 'Scheduled' AND start_datetime > now()`,
    [doctorId],
  );
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      rows: [
        {
          branch_id: branchId,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: tomorrowIso(),
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.future_appointment_count, 0);
  assert.deepEqual(res.body.affected_appointments, []);
});

// ═══════════════════════════════════════════════════════════════════
// POST /admin/doctors/:id/schedule
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/doctors/:id/schedule (unknown field) → 400 unknown_field', async () => {
  const { doctorId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [], bogus: 'x' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('POST /admin/doctors/:id/schedule (rows not array) → 400 invalid_rows', async () => {
  const { doctorId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: 'oops' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_rows');
});

test('POST /admin/doctors/:id/schedule (valid; no future appts) → 201', async () => {
  const { doctorId, branchId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  // Cancel any future appts
  await db.pool.query(
    `UPDATE appointment SET status = 'Cancelled'
       WHERE doctor_id = $1 AND status = 'Scheduled' AND start_datetime > now()`,
    [doctorId],
  );
  // Clear existing schedule rows so the test doesn't rely on prior state
  await db.pool.query(`DELETE FROM doctor_schedule WHERE doctor_id = $1`, [doctorId]);

  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/schedule`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      rows: [
        {
          branch_id: branchId,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: tomorrowIso(),
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted_count, 1);
  assert.equal(res.body.schedule.length, 1);
  // Cleanup: remove all schedule rows we just added
  await db.pool.query(`DELETE FROM doctor_schedule WHERE doctor_id = $1`, [doctorId]);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/doctors/:id/blocks
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/doctors/:id/blocks (non-UUID) → 400', async () => {
  const res = await request(createApp())
    .get('/admin/doctors/not-a-uuid/blocks')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

test('GET /admin/doctors/:id/blocks (unknown) → 404', async () => {
  const res = await request(createApp())
    .get('/admin/doctors/00000000-0000-0000-0000-000000000000/blocks')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'doctor_not_found');
});

test('GET /admin/doctors/:id/blocks (existing) → 200 list', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/doctors/${doctorId}/blocks`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.blocks), 'response must be { blocks: [...] }');
});

// ═══════════════════════════════════════════════════════════════════
// POST /admin/doctors/:id/blocks
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/doctors/:id/blocks (no auth) → 401', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp()).post(`/admin/doctors/${doctorId}/blocks`).send({});
  assert.equal(res.status, 401);
});

test('POST /admin/doctors/:id/blocks (valid) → 201', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Unique offset so we don't collide with leftover block rows from
  // earlier runs (10 days out + a few minute jitter).
  const offsetMs = (10 + Math.floor(Math.random() * 100) / 10) * 86400_000;
  const start = new Date(Date.now() + offsetMs).toISOString();
  const end = new Date(Date.now() + offsetMs + 30 * 60_000).toISOString();
  const res = await request(createApp())
    .post(`/admin/doctors/${doctorId}/blocks`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      branch_id: branchId,
      start_datetime: start,
      end_datetime: end,
      reason: 'maintenance',
    });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  // Cleanup
  await db.pool.query(`DELETE FROM doctor_block WHERE id = $1`, [res.body.id]);
});

test('POST /admin/doctors/:id/blocks (non-UUID doctor) → 400', async () => {
  const res = await request(createApp())
    .post('/admin/doctors/not-a-uuid/blocks')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /admin/doctors/:id/blocks/:block_id
// ═══════════════════════════════════════════════════════════════════
test('DELETE /admin/doctors/:id/blocks/:block_id (non-UUID) → 400', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .delete(`/admin/doctors/${doctorId}/blocks/not-a-uuid`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
});

test('DELETE /admin/doctors/:id/blocks/:block_id (unknown) → 404', async () => {
  const { doctorId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .delete(`/admin/doctors/${doctorId}/blocks/00000000-0000-0000-0000-000000000000`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
});

test('DELETE /admin/doctors/:id/blocks/:block_id (existing) → 204', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Insert a block
  const start = new Date(Date.now() + 14 * 86400_000).toISOString();
  const end = new Date(Date.now() + 14 * 86400_000 + 30 * 60_000).toISOString();
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO doctor_block (doctor_id, branch_id, start_datetime, end_datetime, reason, created_by)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 'test', 'staff:test-setup')
     RETURNING id::text AS id`,
    [doctorId, branchId, start, end],
  );
  const blockId = ins.rows[0]!.id;

  const res = await request(createApp())
    .delete(`/admin/doctors/${doctorId}/blocks/${blockId}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 204);
});