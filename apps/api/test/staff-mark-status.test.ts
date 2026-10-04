/**
 * staff-mark-status.test.ts — integration tests for
 * POST /appointments/:id/mark-status.
 *
 * Spec-5-1 (E5-S1) + F-10 + FR-036 / FR-037 + BR-039 / BR-040:
 * doctor or receptionist marks an appointment as Completed or
 * No-Show. Atomic status transition + audit row. No reason
 * required. The slot is NOT released (it's a past row).
 *
 * Doctor scope: doubly-bound — `appt.doctor_id = claim.doctor_id`
 * AND `appt.branch_id ∈ claim.branch_ids`. Mismatch → 403
 * outside_branch_scope.
 *
 * Receptionist scope: `appt.branch_id ∈ claim.branch_ids` only
 * (BR-004). Mismatch → 403 outside_branch_scope.
 *
 * Status gate: only `Scheduled` rows are markable. Terminal
 * states (Cancelled / Completed / No-Show) → 422
 * already_in_terminal_state (distinct from the patient-facing
 * `not_found_appointment_in_terminal_state` because the staff flow
 * sees the row in their queue).
 *
 * Time gate: `start_datetime <= now()`. Future Scheduled rows
 * → 422 appointment_in_future.
 *
 * Auth: patient / admin → 403 forbidden_role. Anonymous → 401.
 *
 * Audit row inspection: actor_role='doctor'|'receptionist',
 * actor_id='staff:<sub>', event='marked_completed'|'marked_no_show',
 * payload='{}' (BR-039 / BR-040 — no reason).
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
    await client.query(
      `DELETE FROM appointment_audit WHERE actor_id LIKE 'staff:%'
         AND actor_id IN (
           'staff:doctor-east-lead',
           'staff:doctor-east-support',
           'staff:doctor-west-lead',
           'staff:receptionist-east',
           'staff:receptionist-west'
         )`,
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

function doctorEastLeadToken(): string {
  return signClaim({
    sub: 'doctor-east-lead',
    role: 'doctor',
    branch_ids: ['branch-east'],
    scope: 'branch',
    doctor_id: 'doctor-east-lead',
  });
}

function doctorEastSupportToken(): string {
  return signClaim({
    sub: 'doctor-east-support',
    role: 'doctor',
    branch_ids: ['branch-east'],
    scope: 'branch',
    doctor_id: 'doctor-east-support',
  });
}

function doctorWestLeadToken(): string {
  return signClaim({
    sub: 'doctor-west-lead',
    role: 'doctor',
    branch_ids: ['branch-west'],
    scope: 'branch',
    doctor_id: 'doctor-west-lead',
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

function receptionistWestToken(): string {
  return signClaim({
    sub: 'receptionist-west',
    role: 'receptionist',
    branch_ids: ['branch-west'],
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
): Promise<{ id: string }> {
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

function pastIso(): string {
  // 1 hour ago in ms, e.g. 2026-10-04T15:00:00.000Z
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

function futureIso(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

async function insertAppointment(
  phone: string,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show',
  startMs: number,
  options?: { doctorName?: string; branchName?: string },
): Promise<{ id: string; branchId: string; doctorId: string }> {
  const doctor = await fetchDoctorByName(options?.doctorName ?? 'Dr. East Lead');
  const branch = await fetchBranchByName(options?.branchName ?? 'East Branch');
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
  return {
    id: result.rows[0]!.id,
    branchId: branch.id,
    doctorId: doctor.id,
  };
}

// ===========================================================================
// Auth
// ===========================================================================

test('POST /appointments/:id/mark-status: no auth → 401', async () => {
  const res = await request(app()).post(
    '/appointments/00000000-0000-0000-0000-000000000000/mark-status',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /appointments/:id/mark-status: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post(
      '/appointments/00000000-0000-0000-0000-000000000000/mark-status',
    )
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /appointments/:id/mark-status: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post(
      '/appointments/00000000-0000-0000-0000-000000000000/mark-status',
    )
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Malformed body
// ===========================================================================

test('POST /appointments/:id/mark-status: missing status → 400 invalid_status', async () => {
  const res = await request(app())
    .post(
      '/appointments/00000000-0000-0000-0000-000000000000/mark-status',
    )
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_status' });
});

test('POST /appointments/:id/mark-status: status="Cancelled" → 400 invalid_status', async () => {
  // Cancelled is reached via the patient / doctor / receptionist cancel
  // flows, never via this route.
  const res = await request(app())
    .post(
      '/appointments/00000000-0000-0000-0000-000000000000/mark-status',
    )
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ status: 'Cancelled' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_status' });
});

test('POST /appointments/:id/mark-status: status="Scheduled" → 400 invalid_status', async () => {
  const res = await request(app())
    .post(
      '/appointments/00000000-0000-0000-0000-000000000000/mark-status',
    )
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ status: 'Scheduled' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_status' });
});

// ===========================================================================
// Not-found / privacy envelopes (staff token doesn't need privacy filter;
// the row is shared with them by branch).
// ===========================================================================

test('POST /appointments/:id/mark-status: malformed UUID → 404 not_found', async () => {
  const res = await request(app())
    .post('/appointments/not-a-uuid/mark-status')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('POST /appointments/:id/mark-status: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .post(
      '/appointments/00000000-0000-0000-0000-000000000000/mark-status',
    )
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

// ===========================================================================
// Doctor scope — happy path × 2 statuses
// ===========================================================================

test('POST /appointments/:id/mark-status: doctor marks own past Scheduled Completed → 200 + audit', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990001',
      'Scheduled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
    assert.equal(res.body.appointment.status, 'Completed');

    const { rows: apptRows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(apptRows[0]!.status, 'Completed');

    const { rows: auditRows } = await db.pool.query<{
      actor_role: string;
      actor_id: string;
      event: string;
      payload: string | object;
    }>(
      `SELECT actor_role, actor_id, event, payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]!.actor_role, 'doctor');
    assert.equal(auditRows[0]!.actor_id, 'staff:doctor-east-lead');
    assert.equal(auditRows[0]!.event, 'marked_completed');
    // payload stored as jsonb — pg returns a parsed object when selected as text.
    const payloadText =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    assert.equal(payloadText, '{}');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('POST /appointments/:id/mark-status: doctor marks own past Scheduled No-Show → 200 + audit', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990002',
      'Scheduled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ status: 'No-Show' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.status, 'No-Show');

    const { rows: auditRows } = await db.pool.query<{
      actor_role: string;
      event: string;
      payload: string | object;
    }>(
      `SELECT actor_role, event, payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]!.actor_role, 'doctor');
    assert.equal(auditRows[0]!.event, 'marked_no_show');
    const payloadText =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    assert.equal(payloadText, '{}');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Receptionist scope — happy path
// ===========================================================================

test('POST /appointments/:id/mark-status: receptionist marks branch-east past Scheduled Completed → 200 + audit', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990003',
      'Scheduled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.status, 'Completed');

    const { rows: auditRows } = await db.pool.query<{
      actor_role: string;
      actor_id: string;
      event: string;
    }>(
      `SELECT actor_role, actor_id, event
         FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]!.actor_role, 'receptionist');
    assert.equal(auditRows[0]!.actor_id, 'staff:receptionist-east');
    assert.equal(auditRows[0]!.event, 'marked_completed');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('POST /appointments/:id/mark-status: receptionist marks branch-east past Scheduled No-Show → 200 + audit', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990003a',
      'Scheduled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ status: 'No-Show' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.status, 'No-Show');

    const { rows: auditRows } = await db.pool.query<{
      actor_role: string;
      actor_id: string;
      event: string;
      payload: string | object;
    }>(
      `SELECT actor_role, actor_id, event, payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]!.actor_role, 'receptionist');
    assert.equal(auditRows[0]!.actor_id, 'staff:receptionist-east');
    assert.equal(auditRows[0]!.event, 'marked_no_show');
    const payloadText =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    assert.equal(payloadText, '{}');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Doctor scope — doctor at other branch / doctor at same branch with different id
// ===========================================================================

test('POST /appointments/:id/mark-status: doctor-east-support marks Dr. East Lead\'s appointment → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990004',
      'Scheduled',
      Date.parse(pastIso()),
      { doctorName: 'Dr. East Lead' },
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'outside_branch_scope' });

    const { rows: apptRows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(apptRows[0]!.status, 'Scheduled');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('POST /appointments/:id/mark-status: doctor-west-lead marks branch-east appointment → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990005',
      'Scheduled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorWestLeadToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'outside_branch_scope' });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Receptionist scope — receptionist at other branch
// ===========================================================================

test('POST /appointments/:id/mark-status: receptionist-west marks branch-east appointment → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990006',
      'Scheduled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${receptionistWestToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'outside_branch_scope' });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Time gate — future Scheduled → 422 appointment_in_future
// ===========================================================================

test('POST /appointments/:id/mark-status: future Scheduled Completed → 422 appointment_in_future', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990007',
      'Scheduled',
      Date.parse(futureIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'appointment_in_future' });

    const { rows: apptRows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(apptRows[0]!.status, 'Scheduled');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('POST /appointments/:id/mark-status: future Scheduled No-Show → 422 appointment_in_future', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990008',
      'Scheduled',
      Date.parse(futureIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ status: 'No-Show' });

    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'appointment_in_future' });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Status gate — terminal states × 3 (Cancelled / Completed / No-Show)
// ===========================================================================

test('POST /appointments/:id/mark-status: already-Cancelled → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990009',
      'Cancelled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'already_in_terminal_state' });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('POST /appointments/:id/mark-status: already-Completed → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990010',
      'Completed',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ status: 'Completed' });

    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'already_in_terminal_state' });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('POST /appointments/:id/mark-status: already-No-Show → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990011',
      'No-Show',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ status: 'No-Show' });

    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'already_in_terminal_state' });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

// ===========================================================================
// Atomicity — concurrent SELECT FOR UPDATE serializes
// ===========================================================================

test('POST /appointments/:id/mark-status: two concurrent doctor requests → first 200, second 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990012',
      'Scheduled',
      Date.parse(pastIso()),
    );
    insertedIds.push(id);

    const [res1, res2] = await Promise.all([
      request(app())
        .post(`/appointments/${id}/mark-status`)
        .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
        .send({ status: 'Completed' }),
      request(app())
        .post(`/appointments/${id}/mark-status`)
        .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
        .send({ status: 'No-Show' }),
    ]);
    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 422]);
    // Exactly one of them is the terminal-state rejection.
    const rejected = res1.status === 422 ? res1.body : res2.body;
    assert.deepEqual(rejected, { error: 'already_in_terminal_state' });

    // Exactly one audit row was written.
    const { rows: auditRows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    assert.equal(auditRows[0]!.count, '1');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [insertedIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});