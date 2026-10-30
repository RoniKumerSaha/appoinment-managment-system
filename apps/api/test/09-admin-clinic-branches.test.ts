/**
 * 09-admin-clinic-branches.test.ts — admin scope: clinic + branches + hours.
 *
 * Coverage:
 *   - GET   /admin/clinic
 *   - PATCH /admin/clinic
 *   - POST  /admin/branches
 *   - GET   /admin/branches              (list with `?active=true|false`)
 *   - GET   /admin/branches/:id
 *   - PATCH /admin/branches/:id          (rename, activate, deactivate)
 *   - GET   /admin/branches/:id/hours
 *   - POST  /admin/branches/:id/hours-impact   (preview)
 *   - PATCH /admin/branches/:id/hours          (commit with impact check)
 *
 * Notes:
 *   - Admin scope is `scope: 'clinic'`; no `clinic_id` JWT claim (AD-8).
 *     The route consults ONLY the JWT — never `req.body.clinic_id`.
 *   - Branch deactivate with future Scheduled appointments → 409
 *     `branch_has_future_appointments` (BR-005, AC-11).
 *   - Hours PATCH runs in a transaction with `SELECT FOR UPDATE` on
 *     the branch row; impact check runs after writing the proposed
 *     hours, in the same txn (TOCTOU-safe).
 *   - Doctor-not-at-branch (BR-031/BR-033) means the impact response
 *     can include `requires_doctor_acknowledgement: true`, which
 *     requires the admin to set `?acknowledge_doctor_impact=true`
 *     on the commit path.
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
    // Doctor schedule for both East-branch doctors (recurring tests
    // assume this; we mirror it here for hours-impact edge cases).
    await client.query(
      `INSERT INTO doctor_schedule
         (doctor_id, branch_id, day_of_week, start_time, end_time, effective_from, created_by)
       SELECT d.id, b.id, dow, '09:00:00'::time, '17:00:00'::time, '2020-01-01'::date, 'staff:test-setup'
         FROM doctor d, branch b, generate_series(0, 6) AS dow
        WHERE d.full_name IN ($1, $2)
          AND b.name = $3
        ON CONFLICT DO NOTHING`,
      [DR_EAST_LEAD, DR_EAST_SUPPORT, EAST_BRANCH],
    );
    // Cancel any Scheduled rows for the 5 seed patients so deactivation
    // (BR-005) doesn't trip the future-appointments check.
    await client.query(
      `UPDATE appointment SET status = 'Cancelled'
        WHERE patient_phone IN ('+15550000001','+15550000002','+15550000003','+15550000004','+15550000005')
          AND status = 'Scheduled'`,
    );
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
    sub: 'admin-main@clinic.local',
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
}
function doctorToken(email: string, doctorId: string, branchId: string): string {
  return signClaim({
    sub: email,
    role: 'doctor',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
}

async function lookupIds(name: string, branch: string): Promise<{ doctorId: string; branchId: string; typeId: string }> {
  const { rows: drows } = await db.pool.query<{ id: string }>(`SELECT id FROM doctor WHERE full_name = $1`, [name]);
  const { rows: brows } = await db.pool.query<{ id: string }>(`SELECT id FROM branch WHERE name = $1`, [branch]);
  const { rows: trows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE is_active = true ORDER BY created_at LIMIT 1`,
  );
  if (!drows[0] || !brows[0]) throw new Error(`seed missing: ${name}/${branch}`);
  if (!trows[0]) throw new Error('seed missing: appointment_type');
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

/** Standard 7-row hours array for an East-branch work week. */
function standardHours(open = '09:00', close = '17:00'): Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }> {
  return Array.from({ length: 7 }, (_, d) => ({
    day_of_week: d,
    open_time: open,
    close_time: close,
    is_closed: false,
  }));
}

// ═══════════════════════════════════════════════════════════════════
// GET /admin/clinic
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/clinic (no auth) → 401', async () => {
  const res = await request(createApp()).get('/admin/clinic');
  assert.equal(res.status, 401);
});

test('GET /admin/clinic (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /admin/clinic (admin) → 200 with counts', async () => {
  const res = await request(createApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.id, 'string');
  assert.equal(typeof res.body.name, 'string');
  assert.equal(typeof res.body.counts.branches_total, 'number');
  assert.equal(typeof res.body.counts.branches_active, 'number');
  assert.equal(typeof res.body.counts.branches_inactive, 'number');
  assert.equal(typeof res.body.counts.doctors_total, 'number');
  assert.equal(typeof res.body.counts.patients_total, 'number');
});

test('GET /admin/clinic ignores body.clinic_id (admin scope is JWT-only)', async () => {
  const res = await request(createApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ clinic_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 200);
  // Server must use the singleton clinic — never the body's claim.
  assert.notEqual(res.body.id, '00000000-0000-0000-0000-000000000000');
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /admin/clinic
// ═══════════════════════════════════════════════════════════════════
test('PATCH /admin/clinic (no auth) → 401', async () => {
  const res = await request(createApp()).patch('/admin/clinic').send({ name: 'X' });
  assert.equal(res.status, 401);
});

test('PATCH /admin/clinic (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({ name: 'X' });
  assert.equal(res.status, 403);
});

test('PATCH /admin/clinic (missing name) → 400 invalid_name', async () => {
  const res = await request(createApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_name');
});

test('PATCH /admin/clinic (name is whitespace only) → 400 invalid_name', async () => {
  const res = await request(createApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_name');
});

test('PATCH /admin/clinic (name too long) → 400 invalid_name', async () => {
  const res = await request(createApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'x'.repeat(121) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_name');
});

test('PATCH /admin/clinic (valid rename) → 200', async () => {
  const res = await request(createApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'MediSlot Downtown' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'MediSlot Downtown');
  // Reset for downstream tests
  await request(createApp())
    .patch('/admin/clinic')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'MediSlot' });
});

// ═══════════════════════════════════════════════════════════════════
// POST /admin/branches
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/branches (no auth) → 401', async () => {
  const res = await request(createApp()).post('/admin/branches').send({ name: 'X' });
  assert.equal(res.status, 401);
});

test('POST /admin/branches (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({ name: 'X' });
  assert.equal(res.status, 403);
});

test('POST /admin/branches (missing name) → 400 invalid_name', async () => {
  const res = await request(createApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_name');
});

test('POST /admin/branches (valid name) → 201 active=true', async () => {
  const res = await request(createApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'South Branch' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'South Branch');
  assert.equal(res.body.active, true);
  // Cleanup
  await db.pool.query(`DELETE FROM branch WHERE id = $1`, [res.body.id]);
});

test('POST /admin/branches (whitespace-only name) → 400 invalid_name', async () => {
  const res = await request(createApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_name');
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/branches
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/branches (no auth) → 401', async () => {
  const res = await request(createApp()).get('/admin/branches');
  assert.equal(res.status, 401);
});

test('GET /admin/branches (admin) → 200 with list', async () => {
  const res = await request(createApp())
    .get('/admin/branches')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2);
  for (const b of res.body) {
    assert.equal(typeof b.id, 'string');
    assert.equal(typeof b.name, 'string');
    assert.equal(typeof b.active, 'boolean');
  }
});

test('GET /admin/branches?active=true → only active', async () => {
  const res = await request(createApp())
    .get('/admin/branches?active=true')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  for (const b of res.body) assert.equal(b.active, true);
});

test('GET /admin/branches?active=false → only inactive', async () => {
  // Create + deactivate a branch so the test is non-flaky.
  const create = await request(createApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'Inactive Test Branch' });
  assert.equal(create.status, 201);
  const deactivate = await request(createApp())
    .patch(`/admin/branches/${create.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: false });
  assert.equal(deactivate.status, 200);

  const res = await request(createApp())
    .get('/admin/branches?active=false')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  const found = res.body.find((b: { id: string }) => b.id === create.body.id);
  assert.ok(found);
  assert.equal(found.active, false);

  // Cleanup
  await db.pool.query(`DELETE FROM branch WHERE id = $1`, [create.body.id]);
});

test('GET /admin/branches?active=garbage → 400 invalid_active_filter', async () => {
  const res = await request(createApp())
    .get('/admin/branches?active=yes')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_active_filter');
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/branches/:id
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/branches/:id (non-UUID) → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .get('/admin/branches/not-a-uuid')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /admin/branches/:id (unknown UUID) → 404 branch_not_found', async () => {
  const res = await request(createApp())
    .get('/admin/branches/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'branch_not_found');
});

test('GET /admin/branches/:id (existing) → 200', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, branchId);
  assert.equal(res.body.name, EAST_BRANCH);
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /admin/branches/:id
// ═══════════════════════════════════════════════════════════════════
test('PATCH /admin/branches/:id (no auth) → 401', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .send({ name: 'X' });
  assert.equal(res.status, 401);
});

test('PATCH /admin/branches/:id (unknown field) → 400 unknown_field', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ role: 'doctor' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('PATCH /admin/branches/:id (empty body) → 400 no_fields_to_update', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'no_fields_to_update');
});

test('PATCH /admin/branches/:id (rename) → 200', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'East Branch (renamed)' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'East Branch (renamed)');
  // Restore
  await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: EAST_BRANCH });
});

test('PATCH /admin/branches/:id (activate an inactive branch) → 200', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Deactivate first
  const d = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: false });
  assert.equal(d.status, 200);
  // Reactivate
  const r = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.active, true);
});

// ─── address + tz (the branch editor's Address field) ──────────────
//
// `branch.address` exists (0015) and the branch editor's Address input
// posts to this route. The route used to reject `address` as an
// unknown field, so the field could not be saved at all.

test('PATCH /admin/branches/:id (set address) → 200 and persists', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const address = '12 King St, Riyadh';
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ address });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.address, address);

  // The write must be durable, not just echoed back.
  const reread = await db.pool.query<{ address: string | null }>(
    `SELECT address FROM branch WHERE id = $1`,
    [branchId],
  );
  assert.equal(reread.rows[0]!.address, address);

  // Restore
  await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ address: null });
});

test('PATCH /admin/branches/:id (clear address with null) → 200', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ address: 'temporary' });
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ address: null });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.address, null);
});

test('PATCH /admin/branches/:id (address of a non-string type) → 400 invalid_address', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ address: 42 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_address');
});

test('PATCH /admin/branches/:id (address over 500 chars) → 400 invalid_address', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ address: 'x'.repeat(501) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_address');
});

test('PATCH /admin/branches/:id (set tz) → 200 and persists', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ tz: 'Asia/Riyadh' });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.tz, 'Asia/Riyadh');

  const reread = await db.pool.query<{ tz: string }>(
    `SELECT tz FROM branch WHERE id = $1`,
    [branchId],
  );
  assert.equal(reread.rows[0]!.tz, 'Asia/Riyadh');

  // Restore
  await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ tz: 'America/New_York' });
});

test('PATCH /admin/branches/:id (bogus tz) → 400 invalid_timezone', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ tz: 'Not/AZone' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_timezone');
});

test('GET /admin/branches exposes address and tz on every row', async () => {
  const res = await request(createApp())
    .get('/admin/branches')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, 'expected at least one branch');
  for (const b of res.body) {
    assert.ok('address' in b, `branch ${b.id} is missing address`);
    assert.ok('tz' in b, `branch ${b.id} is missing tz`);
    assert.equal(typeof b.tz, 'string');
  }
});

test('GET /admin/branches/:id exposes address and tz', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok('address' in res.body, 'address missing from branch detail');
  assert.ok('tz' in res.body, 'tz missing from branch detail');
});

test('PATCH /admin/branches/:id (deactivate with no future appts) → 200', async () => {
  const { branchId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  // Reactivate
  await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: true });
});

test('PATCH /admin/branches/:id (deactivate with future appts) → 409 branch_has_future_appointments', async () => {
  // Create a fresh branch, schedule a future appointment on it, then
  // attempt to deactivate.
  const created = await request(createApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ name: 'Conflict Branch' });
  assert.equal(created.status, 201);
  const branchId = created.body.id;
  const { doctorId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);

  // Move the doctor onto this branch so we can book a future appt.
  await db.pool.query(
    `INSERT INTO doctor_branch (doctor_id, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [doctorId, branchId],
  );
  // Schedule a future appointment on this branch.
  const start = new Date(Date.now() + 2 * 86400_000);
  start.setUTCHours(15, 0, 0, 0);
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, $1, $2, $3, $4,
            $5::timestamptz, $5::timestamptz + interval '30 minutes',
            'Scheduled', $6
       FROM clinic c LIMIT 1
     RETURNING id`,
    [branchId, doctorId, PATIENT, typeId, start.toISOString(), `patient:${PATIENT}`],
  );
  assert.ok(ins.rows[0]);
  await db.pool.query(
    `INSERT INTO appointment_audit (appointment_id, actor_role, actor_id, event, payload)
     VALUES ($1, 'patient', $2, 'created', '{}'::jsonb)`,
    [ins.rows[0].id, `patient:${PATIENT}`],
  );

  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ active: false });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'branch_has_future_appointments');
  // The count travels with the 409 so the admin UI can state how many
  // appointments are in the way (BR-059). Exactly one future Scheduled
  // appointment exists on this branch.
  assert.equal(res.body.future_appointment_count, 1);

  // Cleanup: cancel the appointment so the branch row can be removed
  // (FK from appointment to branch otherwise blocks DELETE). The
  // appointment_audit row stays (append-only trigger P0001); a future
  // seedWith() in the next test run will reset everything.
  await db.pool.query(
    `UPDATE appointment SET status = 'Cancelled' WHERE id = $1`,
    [ins.rows[0].id],
  );
  await db.pool.query(`DELETE FROM doctor_branch WHERE branch_id = $1`, [branchId]);
});

// ═══════════════════════════════════════════════════════════════════
// GET /admin/branches/:id/hours
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/branches/:id/hours (no auth) → 401', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp()).get(`/admin/branches/${branchId}/hours`);
  assert.equal(res.status, 401);
});

test('GET /admin/branches/:id/hours (non-UUID) → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .get('/admin/branches/not-a-uuid/hours')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /admin/branches/:id/hours (unknown branch) → 404 branch_not_found', async () => {
  const res = await request(createApp())
    .get('/admin/branches/00000000-0000-0000-0000-000000000000/hours')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'branch_not_found');
});

test('GET /admin/branches/:id/hours (existing) → 200 with 7 rows', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get(`/admin/branches/${branchId}/hours`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.branch_id, branchId);
  assert.equal(typeof res.body.tz, 'string');
  assert.ok(Array.isArray(res.body.hours));
  assert.equal(res.body.hours.length, 7);
  for (let d = 0; d < 7; d++) {
    const row = res.body.hours.find((r: { day_of_week: number }) => r.day_of_week === d);
    assert.ok(row, `day ${d} missing`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /admin/branches/:id/hours-impact
// ═══════════════════════════════════════════════════════════════════
test('POST /admin/branches/:id/hours-impact (no auth) → 401', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/branches/${branchId}/hours-impact`)
    .send({ hours: standardHours() });
  assert.equal(res.status, 401);
});

test('POST /admin/branches/:id/hours-impact (non-UUID) → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .post('/admin/branches/not-a-uuid/hours-impact')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours: standardHours() });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('POST /admin/branches/:id/hours-impact (length=6) → 400 invalid_hours_length', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/branches/${branchId}/hours-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours: standardHours().slice(0, 6) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_hours_length');
});

test('POST /admin/branches/:id/hours-impact (length=8) → 400 invalid_hours_length', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const eight = [...standardHours(), { day_of_week: 7, open_time: '09:00', close_time: '17:00', is_closed: false }];
  const res = await request(createApp())
    .post(`/admin/branches/${branchId}/hours-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours: eight });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_hours_length');
});

test('POST /admin/branches/:id/hours-impact (duplicate day) → 400 invalid_day_of_week', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const hours = standardHours();
  hours[1]!.day_of_week = 0; // duplicate
  const res = await request(createApp())
    .post(`/admin/branches/${branchId}/hours-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_day_of_week');
});

test('POST /admin/branches/:id/hours-impact (open >= close) → 400 invalid_time_range', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const hours = standardHours();
  hours[0]!.open_time = '17:00';
  hours[0]!.close_time = '09:00';
  const res = await request(createApp())
    .post(`/admin/branches/${branchId}/hours-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_time_range');
});

test('POST /admin/branches/:id/hours-impact (valid; no future appts) → 200 count_affected=0', async () => {
  const { branchId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const res = await request(createApp())
    .post(`/admin/branches/${branchId}/hours-impact`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours: standardHours(), include_affected: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.count_affected, 0);
  assert.deepEqual(res.body.affected, []);
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /admin/branches/:id/hours
// ═══════════════════════════════════════════════════════════════════
test('PATCH /admin/branches/:id/hours (no auth) → 401', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}/hours`)
    .send({ hours: standardHours() });
  assert.equal(res.status, 401);
});

test('PATCH /admin/branches/:id/hours (unknown field) → 400 unknown_field', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}/hours`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ bogus: 'x', hours: standardHours() });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('PATCH /admin/branches/:id/hours (no fields) → 400 no_fields_to_update', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}/hours`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'no_fields_to_update');
});

test('PATCH /admin/branches/:id/hours (tz-only fast path) → 200', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}/hours`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ tz: 'America/New_York' });
  assert.equal(res.status, 200);
  assert.equal(res.body.tz, 'America/New_York');
});

test('PATCH /admin/branches/:id/hours (invalid tz) → 400 invalid_timezone', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}/hours`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ tz: 'Mars/Olympus' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_timezone');
});

test('PATCH /admin/branches/:id/hours (valid hours, no impact) → 200', async () => {
  const { branchId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}/hours`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours: standardHours('09:00', '17:00') });
  assert.equal(res.status, 200);
  assert.equal(res.body.impact.count_affected, 0);
  assert.equal(res.body.hours.length, 7);
});

test('PATCH /admin/branches/:id/hours (invalid length) → 400 invalid_hours_length', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .patch(`/admin/branches/${branchId}/hours`)
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hours: standardHours().slice(0, 5) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_hours_length');
});

// ═══════════════════════════════════════════════════════════════════
// Cross-role: only admin can read/write admin/clinic
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/clinic (doctor role) → 403 forbidden_role', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});
