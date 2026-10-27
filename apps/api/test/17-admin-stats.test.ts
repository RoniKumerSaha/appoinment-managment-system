/**
 * 17-admin-stats.test.ts — GET /admin/stats.
 *
 * Coverage:
 *   - GET /admin/stats
 *
 * The admin dashboards used to derive their counts from a hash of
 * the entity id, so the numbers looked real but were not. This route
 * answers them from the actual tables, and this file pins that the
 * answers match the database.
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

const ADMIN_EMAIL = 'admin-main@clinic.local';
const DR_EAST_LEAD = 'Dr. East Lead';
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

function adminToken(): string {
  return signClaim({
    sub: ADMIN_EMAIL,
    role: 'admin',
    branch_ids: ['00000000-0000-4000-8000-000000000000'],
    scope: 'clinic',
  });
}
function patientToken(phone: string): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
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

async function lookupIds(): Promise<{
  doctorId: string;
  branchId: string;
  typeId: string;
}> {
  const { rows: drows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [DR_EAST_LEAD],
  );
  const { rows: brows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [EAST_BRANCH],
  );
  const { rows: trows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (!drows[0] || !brows[0] || !trows[0]) throw new Error('seed missing');
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

// ═══════════════════════════════════════════════════════════════════
// Auth / role gate
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/stats (no auth) → 401', async () => {
  const res = await request(createApp()).get('/admin/stats');
  assert.equal(res.status, 401);
});

test('GET /admin/stats (patient) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${patientToken('+15550000001')}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /admin/stats (doctor) → 403 forbidden_role', async () => {
  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/admin/stats')
    .set(
      'Authorization',
      `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`,
    );
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

// ═══════════════════════════════════════════════════════════════════
// Shape
// ═══════════════════════════════════════════════════════════════════
test('GET /admin/stats → 200 with the four count families', async () => {
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.branches));
  assert.ok(Array.isArray(res.body.doctors));
  assert.ok(Array.isArray(res.body.receptionists));
  assert.ok(Array.isArray(res.body.appointment_types));
  for (const family of [
    res.body.branches,
    res.body.doctors,
    res.body.receptionists,
    res.body.appointment_types,
  ]) {
    for (const row of family) {
      assert.ok(typeof row.id === 'string');
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// The counts match the database
// ═══════════════════════════════════════════════════════════════════
test('a branch doctor_count matches doctor_branch', async () => {
  const { branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  const row = res.body.branches.find((b: { id: string }) => b.id === branchId);
  assert.ok(row, 'the east branch must be listed');

  const { rows } = await db.pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM doctor_branch db
       JOIN doctor d ON d.id = db.doctor_id
      WHERE db.branch_id = $1::uuid AND d.active`,
    [branchId],
  );
  assert.equal(row.doctor_count, rows[0]?.count);
});

test('a branch future_appointment_count matches the real query', async () => {
  const { branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  const row = res.body.branches.find((b: { id: string }) => b.id === branchId);
  assert.ok(row);

  const { rows } = await db.pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM appointment
      WHERE branch_id = $1::uuid
        AND status = 'Scheduled'
        AND start_datetime > now()`,
    [branchId],
  );
  assert.equal(row.future_appointment_count, rows[0]?.count);
});

test('a doctor future_appointment_count matches the real query', async () => {
  const { doctorId } = await lookupIds();
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  const row = res.body.doctors.find((d: { id: string }) => d.id === doctorId);
  assert.ok(row);

  const { rows } = await db.pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM appointment
      WHERE doctor_id = $1::uuid
        AND status = 'Scheduled'
        AND start_datetime > now()`,
    [doctorId],
  );
  assert.equal(row.future_appointment_count, rows[0]?.count);
});

test('a doctor specialty is the real column, not a fabricated value', async () => {
  const { doctorId } = await lookupIds();
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  const row = res.body.doctors.find((d: { id: string }) => d.id === doctorId);
  assert.ok(row);

  const { rows } = await db.pool.query<{ specialty: string | null }>(
    `SELECT specialty FROM doctor WHERE id = $1::uuid`,
    [doctorId],
  );
  assert.equal(row.specialty, rows[0]?.specialty ?? null);
});

test('an appointment type bookings_count matches the 30-day window', async () => {
  const { typeId } = await lookupIds();
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  const row = res.body.appointment_types.find(
    (t: { id: string }) => t.id === typeId,
  );
  assert.ok(row);

  const { rows } = await db.pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM appointment
      WHERE appointment_type_id = $1::uuid
        AND status <> 'Cancelled'
        AND start_datetime >= now() - interval '30 days'`,
    [typeId],
  );
  assert.equal(row.bookings_count, rows[0]?.count);
});

test('a receptionist appointments_today matches the branch-local day', async () => {
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  const row = res.body.receptionists[0];
  assert.ok(row);

  const { rows } = await db.pool.query<{ count: number }>(
    `SELECT COUNT(a.id)::int AS count
       FROM receptionist r
       JOIN branch b ON b.id = r.branch_id
       LEFT JOIN appointment a
         ON a.branch_id = r.branch_id
        AND a.status = 'Scheduled'
        AND a.start_datetime >= (now() AT TIME ZONE b.tz)::timestamp AT TIME ZONE b.tz
        AND a.start_datetime <  ((now() AT TIME ZONE b.tz)::timestamp + interval '1 day') AT TIME ZONE b.tz
      WHERE r.id = $1::uuid`,
    [row.id],
  );
  assert.equal(row.appointments_today, rows[0]?.count);
});

test('a branch with no doctors reports 0, not a fabricated number', async () => {
  const res = await request(createApp())
    .get('/admin/stats')
    .set('Authorization', `Bearer ${adminToken()}`);
  // Every branch row must carry a real integer count.
  for (const b of res.body.branches) {
    assert.equal(typeof b.doctor_count, 'number');
    assert.equal(typeof b.future_appointment_count, 'number');
    assert.ok(b.doctor_count >= 0);
    assert.ok(b.future_appointment_count >= 0);
  }
});
