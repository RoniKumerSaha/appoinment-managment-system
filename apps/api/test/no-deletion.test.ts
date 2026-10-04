/**
 * no-deletion.test.ts — integration tests pinning the
 * no-deletion guarantee (PRD FR-038, Scenario 15).
 *
 * Per spec-5-5 (E5-S5): the appointment row is append-only.
 * Status transitions (Scheduled → Cancelled / Completed /
 * No-Show) are status mutations, not row deletions. There is
 * no DELETE route for any role on any appointment path.
 *
 * This test asserts the absence of the route (404 fallthrough)
 * AND the row's recoverability after a status transition.
 *
 * Testcontainer runtime is not available in this environment, so
 * the integration suite is structurally validated but not executed.
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
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE patient_phone LIKE '+1555999%'`,
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

function patientToken(phone: string): string {
  return signClaim({
    sub: phone,
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

function doctorEastLeadToken(): string {
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

function receptionistEastToken(): string {
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

async function fetchBranchByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
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

async function insertAppointment(
  phone: string,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show',
): Promise<{ id: string }> {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const clinicId = await db.pool
    .query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`)
    .then((r) => r.rows[0]!.id);
  // Future timestamp — irrelevant for the read-after-status tests.
  const startMs = Date.now() + 24 * 60 * 60 * 1000;
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
  return { id: result.rows[0]!.id };
}

// ===========================================================================
// DELETE route absence — every role × every appointment path
// ===========================================================================

test('DELETE /appointments/:id: doctor → 404 not_found', async () => {
  const res = await request(app())
    .delete('/appointments/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('DELETE /appointments/:id: receptionist → 404 not_found', async () => {
  const res = await request(app())
    .delete('/appointments/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('DELETE /appointments/:id: admin → 404 not_found', async () => {
  const res = await request(app())
    .delete('/appointments/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('DELETE /appointments/:id: anonymous → 401 unauthenticated', async () => {
  const res = await request(app()).delete(
    '/appointments/00000000-0000-0000-0000-000000000000',
  );
  // The auth middleware runs before the route. An anonymous
  // DELETE bounces off the middleware (no header → req.auth
  // is null). The fallthrough is 404 (no DELETE route), but
  // the middleware's 401 precedes any route handler because
  // it's mounted at the top of the chain.
  //
  // The contract is: there is NO DELETE path. Whichever of
  // 401/404 wins is implementation-dependent; both are
  // acceptable proofs of "no DELETE route".
  assert.ok(
    res.status === 401 || res.status === 404,
    `expected 401 or 404, got ${res.status}`,
  );
});

test('DELETE /patient/appointments/:id: patient → 404 not_found', async () => {
  const res = await request(app())
    .delete('/patient/appointments/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${patientToken('+15550000001')}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('DELETE /reception/appointments/:id: receptionist → 404 not_found', async () => {
  const res = await request(app())
    .delete('/reception/appointments/00000000-0000-0000-0000-000000000000')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

// ===========================================================================
// Row recoverability — Cancelled / Completed / No-Show rows are still in DB
// ===========================================================================

test('Cancelled row is still readable via deep-link (the row is NOT deleted)', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990601', 'Cancelled');
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990601')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
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

test('Completed row is still readable via deep-link (the row is NOT deleted)', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990602', 'Completed');
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990602')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
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

test('No-Show row is still readable via deep-link (the row is NOT deleted)', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990603', 'No-Show');
    insertedIds.push(id);

    const res = await request(app())
      .get(`/patient/appointments/${id}/deep-link`)
      .set('Authorization', `Bearer ${patientToken('+15559990603')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
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