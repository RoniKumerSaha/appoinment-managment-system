/**
 * patient-deep-link.test.ts — integration tests for
 * GET /patient/appointments/:id/deep-link.
 *
 * Spec-4-4 (E4-S4): staff-generated deep links land a verified
 * patient directly on the cancel or reschedule modal for a
 * specific appointment id. The route returns metadata about the
 * link target so the client can route the verified patient into
 * the right modal after OTP verification.
 *
 * Privacy (E7-S3 + NFR-007): the lookup is keyed by
 * `(id, patient_phone = claim.sub)` in a single SQL statement. A
 * row that exists but doesn't match the verified patient's phone
 * returns 0 rows → 404 not_found, identical to a non-existent id.
 *
 * Testcontainer runtime is not available in this environment, so
 * the integration suite is structurally validated but not
 * executed.
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
  const client = await db.pool.connect();
  try {
    await client.query(
      `DELETE FROM appointment_audit WHERE actor_id LIKE 'patient:+1555999%'`,
    );
    await client.query(
      `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
    );
  } finally {
    client.release();
  }
});

function app() {
  return createApp();
}

function patientToken(phone = '+15550000001'): string {
  return signClaim({
    sub: phone,
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

function doctorToken(): string {
  return signClaim({
    sub: 'doctor-east-lead',
    role: 'doctor',
    branch_ids: ['branch-east'],
    scope: 'branch',
    doctor_id: 'doctor-east-lead',
  });
}

function adminToken(): string {
  return signClaim({
    sub: 'admin-main',
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
}

function receptionistToken(): string {
  return signClaim({
    sub: 'receptionist-east',
    role: 'receptionist',
    branch_ids: ['branch-east'],
    scope: 'branch',
  });
}

async function fetchDoctorByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchBranchByName(
  name: string,
): Promise<{ id: string; tz: string }> {
  const { rows } = await db.pool.query<{ id: string; tz: string }>(
    `SELECT id, tz FROM branch WHERE name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchTypeByName(name: string): Promise<{
  id: string;
  duration_minutes: number;
}> {
  const { rows } = await db.pool.query<{
    id: string;
    duration_minutes: number;
  }>(`SELECT id, duration_minutes FROM appointment_type WHERE name = $1`, [
    name,
  ]);
  return rows[0]!;
}

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function insertAppointment(
  phone: string,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show',
  startMs: number,
): Promise<{ id: string; branchId: string }> {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const clinicId = await db.pool
    .query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`)
    .then((r) => r.rows[0]!.id);
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9)
     RETURNING id::text AS id`,
    [
      clinicId,
      branch.id,
      doctor.id,
      phone,
      type.id,
      new Date(startMs).toISOString(),
      new Date(startMs + type.duration_minutes * 60_000).toISOString(),
      status,
      `patient:${phone}`,
    ],
  );
  return { id: result.rows[0]!.id, branchId: branch.id };
}

// ===========================================================================
// Auth
// ===========================================================================

test('GET /patient/appointments/:id/deep-link: no auth → 401', async () => {
  const res = await request(app()).get(
    '/patient/appointments/00000000-0000-0000-0000-000000000000/deep-link',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /patient/appointments/:id/deep-link: doctor JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/deep-link',
    )
    .set('Authorization', `Bearer ${doctorToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /patient/appointments/:id/deep-link: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/deep-link',
    )
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /patient/appointments/:id/deep-link: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/deep-link',
    )
    .set('Authorization', `Bearer ${receptionistToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Privacy — same envelope for "doesn't exist" and "exists but not yours"
// ===========================================================================

test('GET /patient/appointments/:id/deep-link: malformed UUID → 404 not_found', async () => {
  const res = await request(app())
    .get('/patient/appointments/not-a-uuid/deep-link')
    .set('Authorization', `Bearer ${patientToken('+15559990001')}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('GET /patient/appointments/:id/deep-link: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .get(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/deep-link',
    )
    .set('Authorization', `Bearer ${patientToken('+15559990002')}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('GET /patient/appointments/:id/deep-link: not your appointment → 404 not_found (privacy)', async () => {
  // Insert a Scheduled appointment owned by +15559990003, then
  // probe it AS a different patient (+15559990004). The response
  // is identical to "doesn't exist" — never 403 (E7-S3).
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990003',
      'Scheduled',
      Date.parse(`${tomorrowIso()}T16:00:00Z`),
    );
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990004')}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Happy path — own Scheduled
// ===========================================================================

test('GET /patient/appointments/:id/deep-link: own Scheduled → 200 with can_cancel=true, can_reschedule=true', async () => {
  const insertedIds: string[] = [];
  try {
    const { id, branchId } = await insertAppointment(
      '+15559990005',
      'Scheduled',
      Date.parse(`${tomorrowIso()}T16:00:00Z`),
    );
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990005')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment_id, id);
    assert.equal(res.body.can_cancel, true);
    assert.equal(res.body.can_reschedule, true);
    // Appointment shape mirrors E4-S1 / E4-S2 responses.
    assert.equal(res.body.appointment.id, id);
    assert.equal(res.body.appointment.branch_id, branchId);
    assert.equal(typeof res.body.appointment.doctor_id, 'string');
    assert.equal(typeof res.body.appointment.appointment_type_id, 'string');
    assert.equal(typeof res.body.appointment.start_datetime, 'string');
    assert.equal(typeof res.body.appointment.end_datetime, 'string');
    assert.equal(res.body.appointment.status, 'Scheduled');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Terminal states → can_cancel=false, can_reschedule=false
// ===========================================================================

test('GET /patient/appointments/:id/deep-link: own Cancelled → 200 with can_cancel=false, can_reschedule=false', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990006',
      'Cancelled',
      Date.parse(`${tomorrowIso()}T16:00:00Z`),
    );
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990006')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.can_cancel, false);
    assert.equal(res.body.can_reschedule, false);
    assert.equal(res.body.appointment.status, 'Cancelled');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('GET /patient/appointments/:id/deep-link: own Completed → 200 with can_cancel=false, can_reschedule=false', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990007',
      'Completed',
      Date.parse(`${tomorrowIso()}T16:00:00Z`),
    );
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990007')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.can_cancel, false);
    assert.equal(res.body.can_reschedule, false);
    assert.equal(res.body.appointment.status, 'Completed');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('GET /patient/appointments/:id/deep-link: own No-Show → 200 with can_cancel=false, can_reschedule=false', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990008',
      'No-Show',
      Date.parse(`${tomorrowIso()}T16:00:00Z`),
    );
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990008')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.can_cancel, false);
    assert.equal(res.body.can_reschedule, false);
    assert.equal(res.body.appointment.status, 'No-Show');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});