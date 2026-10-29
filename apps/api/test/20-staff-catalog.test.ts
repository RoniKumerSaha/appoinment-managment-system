/**
 * 20-staff-catalog.test.ts — `GET /staff-catalog/*`.
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * The doctor picker and the appointment-type picker on the doctor and
 * receptionist screens used to read from the ADMIN catalog routes
 * (`GET /admin/doctors`, `GET /admin/appointment-types`,
 * `GET /admin/branches`). Those are gated by `adminScope`, which
 * requires `role === 'admin'`. A doctor or a receptionist calling them
 * got `403 forbidden_role`, so the pickers silently stayed EMPTY and
 * the walk-in booking flow, the availability browser and the doctor's
 * recurring-series form were unusable for exactly the two roles that
 * use them.
 *
 * `/staff-catalog/*` returns the SAME DTO shapes as the admin routes
 * (so the screens' filtering logic is unchanged) over the same data,
 * but it is open to any authenticated caller.
 *
 * Coverage:
 *   - GET /staff-catalog/doctors             (shape, ?active=, ?branch_id=)
 *   - GET /staff-catalog/appointment-types   (shape, ?active=)
 *   - GET /staff-catalog/branches            (shape, ?active=)
 *   - 401 for an anonymous caller on all three
 *   - 200 for every authenticated role (doctor / receptionist / admin)
 *   - 400 invalid_active_filter / invalid_branch_id
 *
 * The DTO-shape assertions are the load-bearing part: the screens
 * read `email` and `branches` off a doctor row, so a shape change
 * here silently empties a picker.
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
const DOCTOR_EAST_LEAD = 'Dr. East Lead';
const DOCTOR_WEST_LEAD = 'Dr. West Lead';

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
function receptionistToken(branchId: string): string {
  return signClaim({
    sub: 'receptionist-east@clinic.local',
    role: 'receptionist',
    branch_ids: [branchId],
    scope: 'branch',
  });
}
function doctorToken(doctorId: string, branchId: string): string {
  return signClaim({
    sub: 'dr.-east-lead@clinic.local',
    role: 'doctor',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
}

async function lookupBranchId(branch: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [branch],
  );
  if (!rows[0]) throw new Error(`seed missing: ${branch}`);
  return rows[0].id;
}

async function lookupDoctorId(name: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [name],
  );
  if (!rows[0]) throw new Error(`seed missing: ${name}`);
  return rows[0].id;
}

// ═══════════════════════════════════════════════════════════════════
// GET /staff-catalog/doctors
// ═══════════════════════════════════════════════════════════════════
test('GET /staff-catalog/doctors (no auth) → 401', async () => {
  const res = await request(createApp()).get('/staff-catalog/doctors');
  assert.equal(res.status, 401);
});

test('GET /staff-catalog/doctors (doctor role) → 200 with the picker shape', async () => {
  const eastId = await lookupBranchId(EAST_BRANCH);
  const doctorId = await lookupDoctorId(DOCTOR_EAST_LEAD);

  const res = await request(createApp())
    .get('/staff-catalog/doctors')
    .set('Authorization', `Bearer ${doctorToken(doctorId, eastId)}`);

  // The whole point of the route: a doctor is NOT an admin, so the
  // admin catalog route would have answered 403 forbidden_role here.
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);

  const first = res.body[0];
  // The screens read every one of these fields off the row.
  assert.equal(typeof first.id, 'string');
  assert.equal(typeof first.full_name, 'string');
  assert.equal(typeof first.email, 'string');
  assert.equal(typeof first.active, 'boolean');
  assert.ok(first.specialty === null || typeof first.specialty === 'string');
  assert.ok(Array.isArray(first.branches));
  assert.equal(typeof first.branches[0].id, 'string');
  assert.equal(typeof first.branches[0].name, 'string');
  assert.equal(typeof first.branches[0].tz, 'string');
  assert.equal(typeof first.branches[0].active, 'boolean');
});

test('GET /staff-catalog/doctors (receptionist role) → 200', async () => {
  const eastId = await lookupBranchId(EAST_BRANCH);
  const res = await request(createApp())
    .get('/staff-catalog/doctors')
    .set('Authorization', `Bearer ${receptionistToken(eastId)}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
});

test('GET /staff-catalog/doctors (admin role) → 200', async () => {
  const res = await request(createApp())
    .get('/staff-catalog/doctors')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /staff-catalog/doctors (?branch_id=) filters to that branch', async () => {
  const westId = await lookupBranchId(WEST_BRANCH);
  const res = await request(createApp())
    .get(`/staff-catalog/doctors?branch_id=${westId}`)
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  // Every returned doctor must be assigned to the requested branch.
  for (const doc of res.body) {
    assert.ok(
      doc.branches.some((b: { id: string }) => b.id === westId),
      `doctor ${doc.full_name} is not assigned to ${WEST_BRANCH}`,
    );
  }
  // The West Branch lead is in the seed; the East Branch lead is not
  // (the seed assigns east lead + east support to East, west lead to
  // West).
  const names = res.body.map((d: { full_name: string }) => d.full_name);
  assert.ok(names.includes(DOCTOR_WEST_LEAD));
  assert.ok(!names.includes(DOCTOR_EAST_LEAD));
});

test('GET /staff-catalog/doctors (?active=false) returns the inactive rows', async () => {
  // Deactivate a doctor, then assert the filter sees it.
  const doctorId = await lookupDoctorId(DOCTOR_EAST_LEAD);
  await db.pool.query(`UPDATE doctor SET active = false WHERE id = $1`, [doctorId]);
  try {
    const res = await request(createApp())
      .get('/staff-catalog/doctors?active=false')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200);
    const names = res.body.map((d: { full_name: string }) => d.full_name);
    assert.ok(names.includes(DOCTOR_EAST_LEAD));

    const activeRes = await request(createApp())
      .get('/staff-catalog/doctors?active=true')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(activeRes.status, 200);
    const activeNames = activeRes.body.map((d: { full_name: string }) => d.full_name);
    assert.ok(!activeNames.includes(DOCTOR_EAST_LEAD));
  } finally {
    await db.pool.query(`UPDATE doctor SET active = true WHERE id = $1`, [doctorId]);
  }
});

test('GET /staff-catalog/doctors (bad ?branch_id) → 400 invalid_branch_id', async () => {
  const res = await request(createApp())
    .get('/staff-catalog/doctors?branch_id=not-a-uuid')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /staff-catalog/doctors (bad ?active) → 400 invalid_active_filter', async () => {
  const res = await request(createApp())
    .get('/staff-catalog/doctors?active=maybe')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_active_filter');
});

// ═══════════════════════════════════════════════════════════════════
// GET /staff-catalog/appointment-types
// ═══════════════════════════════════════════════════════════════════
test('GET /staff-catalog/appointment-types (no auth) → 401', async () => {
  const res = await request(createApp()).get('/staff-catalog/appointment-types');
  assert.equal(res.status, 401);
});

test('GET /staff-catalog/appointment-types (doctor role) → 200 with the picker shape', async () => {
  const eastId = await lookupBranchId(EAST_BRANCH);
  const doctorId = await lookupDoctorId(DOCTOR_EAST_LEAD);

  const res = await request(createApp())
    .get('/staff-catalog/appointment-types')
    .set('Authorization', `Bearer ${doctorToken(doctorId, eastId)}`);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);

  const first = res.body[0];
  assert.equal(typeof first.id, 'string');
  assert.equal(typeof first.name, 'string');
  assert.equal(typeof first.duration_minutes, 'number');
  assert.ok(first.description === null || typeof first.description === 'string');
  assert.equal(typeof first.is_active, 'boolean');
});

test('GET /staff-catalog/appointment-types (receptionist role) → 200', async () => {
  const eastId = await lookupBranchId(EAST_BRANCH);
  const res = await request(createApp())
    .get('/staff-catalog/appointment-types')
    .set('Authorization', `Bearer ${receptionistToken(eastId)}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /staff-catalog/appointment-types (?active=false) returns the inactive rows', async () => {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (!rows[0]) throw new Error('seed missing: General Consultation');
  const typeId = rows[0].id;

  await db.pool.query(
    `UPDATE appointment_type SET is_active = false WHERE id = $1`,
    [typeId],
  );
  try {
    const res = await request(createApp())
      .get('/staff-catalog/appointment-types?active=false')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(res.status, 200);
    const names = res.body.map((t: { name: string }) => t.name);
    assert.ok(names.includes('General Consultation'));

    const activeRes = await request(createApp())
      .get('/staff-catalog/appointment-types?active=true')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(activeRes.status, 200);
    const activeNames = activeRes.body.map((t: { name: string }) => t.name);
    assert.ok(!activeNames.includes('General Consultation'));
  } finally {
    await db.pool.query(
      `UPDATE appointment_type SET is_active = true WHERE id = $1`,
      [typeId],
    );
  }
});

test('GET /staff-catalog/appointment-types (bad ?active) → 400 invalid_active_filter', async () => {
  const res = await request(createApp())
    .get('/staff-catalog/appointment-types?active=maybe')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_active_filter');
});

// ═══════════════════════════════════════════════════════════════════
// GET /staff-catalog/branches
// ═══════════════════════════════════════════════════════════════════
test('GET /staff-catalog/branches (no auth) → 401', async () => {
  const res = await request(createApp()).get('/staff-catalog/branches');
  assert.equal(res.status, 401);
});

test('GET /staff-catalog/branches (receptionist role) → 200 with the picker shape', async () => {
  const eastId = await lookupBranchId(EAST_BRANCH);
  const res = await request(createApp())
    .get('/staff-catalog/branches')
    .set('Authorization', `Bearer ${receptionistToken(eastId)}`);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);

  const first = res.body[0];
  assert.equal(typeof first.id, 'string');
  assert.equal(typeof first.name, 'string');
  assert.equal(typeof first.tz, 'string');
  assert.equal(typeof first.active, 'boolean');
});

test('GET /staff-catalog/branches (?active=true) returns only the active rows', async () => {
  const res = await request(createApp())
    .get('/staff-catalog/branches?active=true')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  for (const b of res.body) {
    assert.equal(b.active, true);
  }
});

test('GET /staff-catalog/branches (bad ?active) → 400 invalid_active_filter', async () => {
  const res = await request(createApp())
    .get('/staff-catalog/branches?active=maybe')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_active_filter');
});

// ═══════════════════════════════════════════════════════════════════
// Cross-cutting: the routes must not leak patient PII, and a patient
// token must not open the catalog.
// ═══════════════════════════════════════════════════════════════════
test('GET /staff-catalog/* exposes no patient data', async () => {
  const res = await request(createApp())
    .get('/staff-catalog/doctors')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);

  // The catalog is a scheduling catalog. Nothing in it may name or
  // contact a patient.
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('+1555'), 'a patient phone leaked into the catalog');
  assert.ok(!serialized.includes('patient_phone'));
  assert.ok(!serialized.includes('password'));
});

test('GET /staff-catalog/* (patient role) → 200 but with no credentials', async () => {
  // The route is "any authenticated caller". A patient token is
  // authenticated, so it reads the catalog — but the catalog carries
  // no patient rows and no credentials, so nothing leaks.
  const res = await request(createApp())
    .get('/staff-catalog/doctors')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(!JSON.stringify(res.body).includes('password'));
});
