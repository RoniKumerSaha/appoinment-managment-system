/**
 * appointment-audit-reads.test.ts — integration tests for
 * the E7-S2 audit read endpoints:
 *   - GET /doctor/appointments/:id/audit
 *   - GET /reception/appointments/:id/audit
 *   - GET /admin/audit
 *
 * Spec-7-2 (E7-S2) + PRD FR-051 + NFR-005:
 * The audit log is internal-only. Doctor reads audits for
 * their own appointments. Receptionist reads audits at their
 * branch. Admin gets a policy envelope (PRD §2.4 — admin
 * never touches individual appointments).
 *
 * Auth: patient → 403 forbidden_role on every surface.
 * Anonymous → 401.
 *
 * Testcontainer runtime is not available in this environment,
 * so the integration suite is structurally validated but not
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
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE patient_phone LIKE '+1555999%' OR actor_id = 'staff:doctor-east-lead' OR actor_id = 'staff:receptionist-east'`,
    );
    await db.pool.query(
      `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
    );
  } finally {
    client.release();
  }
});

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

function receptionistEastToken(): string {
  return signClaim({
    sub: 'receptionist-east',
    role: 'receptionist',
    branch_ids: ['branch-east'],
    scope: 'branch',
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

function app() {
  return createApp();
}

/**
 * Insert a Scheduled appointment. When `recurringSeriesId` is
 * supplied, the row carries that value in `recurring_series_id`.
 */
async function insertAppointment(
  phone: string,
  startMs: number,
  options?: {
    doctorName?: string;
    branchName?: string;
    recurringSeriesId?: string;
  },
): Promise<{ id: string }> {
  const doctor = await fetchDoctorByName(options?.doctorName ?? 'Dr. East Lead');
  const branch = await fetchBranchByName(options?.branchName ?? 'East Branch');
  const type = await fetchTypeByName('General Consultation');
  const clinicId = await db.pool
    .query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`)
    .then((r) => r.rows[0]!.id);
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, recurring_series_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'Scheduled', $8::uuid, $9)
     RETURNING id::text AS id`,
    [
      clinicId,
      branch.id,
      doctor.id,
      phone,
      type.id,
      new Date(startMs).toISOString(),
      new Date(startMs + type.duration_minutes * 60_000).toISOString(),
      options?.recurringSeriesId ?? null,
      `patient:${phone}`,
    ],
  );
  return { id: result.rows[0]!.id };
}

// ===========================================================================
// Doctor audit reads
// ===========================================================================

test('GET /doctor/appointments/:id/audit: no auth → 401', async () => {
  const res = await request(app()).get(
    '/doctor/appointments/00000000-0000-0000-0000-000000000000/audit',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /doctor/appointments/:id/audit: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/doctor/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${patientToken('+15550000001')}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /doctor/appointments/:id/audit: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/doctor/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /doctor/appointments/:id/audit: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/doctor/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /doctor/appointments/:id/audit: malformed uuid → 404 not_found', async () => {
  const res = await request(app())
    .get('/doctor/appointments/not-a-uuid/audit')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('GET /doctor/appointments/:id/audit: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .get('/doctor/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('GET /doctor/appointments/:id/audit: other doctor\'s row → 403 outside_branch_scope', async () => {
  const phone = '+15559990001';
  // The appointment is owned by Dr. East Support.
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000, {
    doctorName: 'Dr. East Support',
  });
  try {
    const res = await request(app())
      .get(`/doctor/appointments/${id}/audit`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'outside_branch_scope' });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

test('GET /doctor/appointments/:id/audit: own row with audit → 200 with audit rows', async () => {
  const phone = '+15559990002';
  const seriesId = 'aaaaaaaa-bbbb-cccc-dddd-0000000000c1';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000, {
    doctorName: 'Dr. East Lead',
    recurringSeriesId: seriesId,
  });
  try {
    // Cancel the appointment to write a cancelled audit row.
    const cancelRes = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(cancelRes.status, 200);

    // Doctor reads the audit. Should see the cancellation row
    // with the E6-S4 recurring_origin enrichment.
    const res = await request(app())
      .get(`/doctor/appointments/${id}/audit`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment_id, id);
    assert.equal(res.body.patient_phone, phone);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.audit.length, 1);
    assert.equal(res.body.audit[0].event, 'cancelled');
    assert.equal(res.body.audit[0].actor_role, 'patient');
    assert.equal(res.body.audit[0].actor_id, `patient:${phone}`);
    assert.deepEqual(res.body.audit[0].payload, {
      recurring_origin: { series_id: seriesId },
    });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

test('GET /doctor/appointments/:id/audit: doctor with no claim.doctor_id → 403 outside_branch_scope', async () => {
  // Defense-in-depth.
  const token = signClaim({
    sub: 'doctor-edge',
    role: 'doctor',
    branch_ids: ['branch-east'],
    scope: 'branch',
    // no doctor_id
  });
  const res = await request(app())
    .get('/doctor/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'outside_branch_scope' });
});

// ===========================================================================
// Receptionist audit reads
// ===========================================================================

test('GET /reception/appointments/:id/audit: no auth → 401', async () => {
  const res = await request(app()).get(
    '/reception/appointments/00000000-0000-0000-0000-000000000000/audit',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /reception/appointments/:id/audit: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/reception/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${patientToken('+15550000002')}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /reception/appointments/:id/audit: doctor JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/reception/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /reception/appointments/:id/audit: malformed uuid → 404 not_found', async () => {
  const res = await request(app())
    .get('/reception/appointments/not-a-uuid/audit')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('GET /reception/appointments/:id/audit: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .get('/reception/appointments/00000000-0000-0000-0000-000000000000/audit')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('GET /reception/appointments/:id/audit: own branch → 200 with audit rows', async () => {
  const phone = '+15559990003';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000, {
    doctorName: 'Dr. East Lead',
  });
  try {
    // Cancel to write a cancelled audit row.
    await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);

    const res = await request(app())
      .get(`/reception/appointments/${id}/audit`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment_id, id);
    assert.equal(res.body.patient_phone, phone);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.audit.length, 1);
    assert.equal(res.body.audit[0].event, 'cancelled');
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

test('GET /reception/appointments/:id/audit: other branch → 403 outside_branch_scope', async () => {
  const phone = '+15559990004';
  // Insert at West branch — receptionist is at East.
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000, {
    doctorName: 'Dr. East Lead', // doctor still at east
    branchName: 'West Branch',
  });
  try {
    const res = await request(app())
      .get(`/reception/appointments/${id}/audit`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'outside_branch_scope' });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

// ===========================================================================
// Admin audit policy envelope
// ===========================================================================

test('GET /admin/audit: no auth → 401', async () => {
  const res = await request(app()).get('/admin/audit');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /admin/audit: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${patientToken('+15550000003')}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /admin/audit: doctor JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /admin/audit: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /admin/audit: admin JWT → 200 with policy envelope', async () => {
  const res = await request(app())
    .get('/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(
    res.body.appointments_audit_reads,
    'rejected_per_role_policy',
  );
  assert.ok(typeof res.body.reason === 'string');
  assert.ok(res.body.reason.includes('PRD §2.4'));
  assert.equal(
    res.body.doctor_endpoint,
    'GET /doctor/appointments/:id/audit',
  );
  assert.equal(
    res.body.receptionist_endpoint,
    'GET /reception/appointments/:id/audit',
  );
});