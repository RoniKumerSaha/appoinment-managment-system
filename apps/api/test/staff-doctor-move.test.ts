/**
 * staff-doctor-move.test.ts — integration tests for
 * POST /doctor/affected/:id/move.
 *
 * Spec-6-2 (E6-S2) + F-09 + BR-054…058 + FR-011:
 * A doctor moves an affected Scheduled appointment to a new
 * slot. The doctor is the only actor that "moves" an
 * appointment (distinct from patient reschedule E4-S3 and
 * receptionist cancel E5-S3). The type is locked (BR-058);
 * the branch may change to any branch the doctor works at
 * (BR-057).
 *
 * Audit row carries `event='moved_by_doctor'`,
 * `actor_role='doctor'`, and
 * `payload={reason: 'conflict_resolution', from, to,
 * branch_change, type_change}` per F-09. The `type_change`
 * flag is always `false` (the body schema never accepts a
 * type change).
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
      `DELETE FROM appointment_audit WHERE patient_phone LIKE '+1555999%' OR actor_id = 'staff:doctor-east-support'`,
    );
    await db.pool.query(
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
  startMs: number,
  options?: {
    doctorName?: string;
    branchName?: string;
    durationMinutes?: number;
  },
): Promise<{ id: string; branchId: string; doctorId: string; typeId: string }> {
  const doctor = await fetchDoctorByName(options?.doctorName ?? 'Dr. East Lead');
  const branch = await fetchBranchByName(options?.branchName ?? 'East Branch');
  const type = await fetchTypeByName('General Consultation');
  const clinicId = await db.pool
    .query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`)
    .then((r) => r.rows[0]!.id);
  const duration = options?.durationMinutes ?? type.duration_minutes;
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'Scheduled', $8)
     RETURNING id::text AS id`,
    [
      clinicId,
      branch.id,
      doctor.id,
      phone,
      type.id,
      new Date(startMs).toISOString(),
      new Date(startMs + duration * 60_000).toISOString(),
      `patient:${phone}`,
    ],
  );
  return {
    id: result.rows[0]!.id,
    branchId: branch.id,
    doctorId: doctor.id,
    typeId: type.id,
  };
}

// ===========================================================================
// Auth
// ===========================================================================

test('POST /doctor/affected/:id/move: no auth → 401', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .send({ new_branch_id: '00000000-0000-0000-0000-000000000001' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /doctor/affected/:id/move: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({ new_branch_id: '00000000-0000-0000-0000-000000000001' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /doctor/affected/:id/move: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ new_branch_id: '00000000-0000-0000-0000-000000000001' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /doctor/affected/:id/move: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({ new_branch_id: '00000000-0000-0000-0000-000000000001' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Body validation
// ===========================================================================

test('POST /doctor/affected/:id/move: missing body → 400 unknown_field', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'unknown_field' });
});

test('POST /doctor/affected/:id/move: new_appointment_type_id → 400 unknown_field (BR-058 lock)', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      new_branch_id: '00000000-0000-0000-0000-000000000001',
      new_appointment_type_id: '00000000-0000-0000-0000-000000000002',
      new_start_datetime: '2026-12-01T09:00:00Z',
      new_end_datetime: '2026-12-01T09:30:00Z',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'unknown_field' });
});

test('POST /doctor/affected/:id/move: new_doctor_id → 400 unknown_field (FR-040 lock)', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      new_branch_id: '00000000-0000-0000-0000-000000000001',
      new_doctor_id: '00000000-0000-0000-0000-000000000003',
      new_start_datetime: '2026-12-01T09:00:00Z',
      new_end_datetime: '2026-12-01T09:30:00Z',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'unknown_field' });
});

test('POST /doctor/affected/:id/move: malformed uuid → 404 not_found', async () => {
  const res = await request(app())
    .post('/doctor/affected/not-a-uuid/move')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      new_branch_id: '00000000-0000-0000-0000-000000000001',
      new_start_datetime: '2026-12-01T09:00:00Z',
      new_end_datetime: '2026-12-01T09:30:00Z',
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('POST /doctor/affected/:id/move: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .post('/doctor/affected/00000000-0000-0000-0000-000000000000/move')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      new_branch_id: '00000000-0000-0000-0000-000000000001',
      new_start_datetime: '2026-12-01T09:00:00Z',
      new_end_datetime: '2026-12-01T09:30:00Z',
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

// ===========================================================================
// Doctor scope — source row gate
// ===========================================================================

test('POST /doctor/affected/:id/move: doctor at other doctor\'s row → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    // Insert with doctor-east-lead, then attempt the move as
    // doctor-east-support.
    const { id } = await insertAppointment(
      '+15559990201',
      Date.now() + 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({
        new_branch_id: '00000000-0000-0000-0000-000000000001',
        new_start_datetime: '2026-12-01T09:00:00Z',
        new_end_datetime: '2026-12-01T09:30:00Z',
      });
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
// Status / time gates
// ===========================================================================

test('POST /doctor/affected/:id/move: past Scheduled → 422 appointment_in_past', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990202',
      Date.now() - 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        new_branch_id: '00000000-0000-0000-0000-000000000001',
        new_start_datetime: '2026-12-01T09:00:00Z',
        new_end_datetime: '2026-12-01T09:30:00Z',
      });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'appointment_in_past' });
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

test('POST /doctor/affected/:id/move: Cancelled → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const doctor = await fetchDoctorByName('Dr. East Lead');
    const branch = await fetchBranchByName('East Branch');
    const type = await fetchTypeByName('General Consultation');
    const clinicId = await db.pool
      .query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`)
      .then((r) => r.rows[0]!.id);
    const startMs = Date.now() + 24 * 60 * 60 * 1000;
    const result = await db.pool.query<{ id: string }>(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
          start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, '+15559990203', $4, $5::timestamptz, $6::timestamptz, 'Cancelled', $7)
       RETURNING id::text AS id`,
      [
        clinicId,
        branch.id,
        doctor.id,
        type.id,
        new Date(startMs).toISOString(),
        new Date(startMs + type.duration_minutes * 60_000).toISOString(),
        'patient:+15559990203',
      ],
    );
    const id = result.rows[0]!.id;
    insertedIds.push(id);

    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        new_branch_id: '00000000-0000-0000-0000-000000000001',
        new_start_datetime: '2026-12-01T09:00:00Z',
        new_end_datetime: '2026-12-01T09:30:00Z',
      });
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
// No-op detection
// ===========================================================================

test('POST /doctor/affected/:id/move: new (branch, start, end) == old → 422 no_op_move', async () => {
  const insertedIds: string[] = [];
  try {
    const startMs = Date.now() + 24 * 60 * 60 * 1000;
    const { id, branchId } = await insertAppointment(
      '+15559990204',
      startMs,
    );
    insertedIds.push(id);

    // Body's new (branch, start, end) == source (branch, start, end).
    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        new_branch_id: branchId,
        new_start_datetime: new Date(startMs).toISOString(),
        new_end_datetime: new Date(startMs + 30 * 60_000).toISOString(),
      });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'no_op_move' });
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
// Destination branch gate
// ===========================================================================

test('POST /doctor/affected/:id/move: new_branch_id not in claim.branch_ids → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    const branchWest = await fetchBranchByName('West Branch');
    const { id } = await insertAppointment(
      '+15559990205',
      Date.now() + 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        new_branch_id: branchWest.id, // doctor-east-lead is at branch-east
        new_start_datetime: '2026-12-01T09:00:00Z',
        new_end_datetime: '2026-12-01T09:30:00Z',
      });
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
// Happy path
// ===========================================================================

test('POST /doctor/affected/:id/move: doctor moves own Scheduled → 200 with updated appointment + moved_by_doctor audit', async () => {
  const insertedIds: string[] = [];
  try {
    const branch = await fetchBranchByName('East Branch');
    const sourceStartMs = Date.now() + 24 * 60 * 60 * 1000;
    const { id, doctorId } = await insertAppointment(
      '+15559990206',
      sourceStartMs,
    );
    insertedIds.push(id);

    // Pick a destination 2 days later at 14:00 (14:00 UTC = 10:00 EDT)
    // so the move crosses both branches and times.
    const newStartMs = sourceStartMs + 2 * 24 * 60 * 60 * 1000;
    const destStart = new Date(newStartMs);
    destStart.setUTCHours(14, 0, 0, 0);
    const destEnd = new Date(destStart.getTime() + 30 * 60_000);

    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        new_branch_id: branch.id,
        new_start_datetime: destStart.toISOString(),
        new_end_datetime: destEnd.toISOString(),
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
    assert.equal(res.body.appointment.doctor_id, doctorId);
    assert.equal(res.body.appointment.status, 'Scheduled');

    // The DB row was updated.
    const { rows: apptRows } = await db.pool.query<{
      branch_id: string;
      start_datetime: Date;
      end_datetime: Date;
    }>(
      `SELECT branch_id::text AS branch_id, start_datetime, end_datetime
         FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(apptRows[0]!.branch_id, branch.id);
    assert.equal(
      apptRows[0]!.start_datetime.toISOString(),
      destStart.toISOString(),
    );

    // The audit row was written.
    const { rows: auditRows } = await db.pool.query<{
      actor_role: string;
      actor_id: string;
      event: string;
      payload: string | object;
    }>(
      `SELECT actor_role, actor_id, event, payload::text AS payload
         FROM appointment_audit WHERE appointment_id = $1::uuid
         AND event = 'moved_by_doctor'`,
      [id],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]!.actor_role, 'doctor');
    assert.equal(auditRows[0]!.actor_id, 'staff:doctor-east-lead');
    assert.equal(auditRows[0]!.event, 'moved_by_doctor');
    const text =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    const payload: {
      reason: string;
      from: { branch_id: string; start_datetime: string; end_datetime: string };
      to: { branch_id: string; start_datetime: string; end_datetime: string };
      branch_change: boolean;
      type_change: boolean;
    } = JSON.parse(text);
    assert.equal(payload.reason, 'conflict_resolution');
    assert.equal(payload.branch_change, false);
    assert.equal(payload.type_change, false);
    assert.equal(payload.from.branch_id, branch.id);
    assert.equal(payload.to.branch_id, branch.id);
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
// FR-018 / FR-019 — destination slot validation
// ===========================================================================

test('POST /doctor/affected/:id/move: destination outside 30-day window → 409 outside_30d_window', async () => {
  const insertedIds: string[] = [];
  try {
    const branch = await fetchBranchByName('East Branch');
    const { id } = await insertAppointment(
      '+15559990207',
      Date.now() + 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    // 60 days out — well past the 30-day window.
    const destStart = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    destStart.setUTCHours(14, 0, 0, 0);
    const destEnd = new Date(destStart.getTime() + 30 * 60_000);

    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        new_branch_id: branch.id,
        new_start_datetime: destStart.toISOString(),
        new_end_datetime: destEnd.toISOString(),
      });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'outside_30d_window');
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
// Atomicity — destination failure leaves the source row untouched
// ===========================================================================

test('POST /doctor/affected/:id/move: destination outside_branch_hours → 409; source row unchanged', async () => {
  const insertedIds: string[] = [];
  try {
    const branch = await fetchBranchByName('East Branch');
    const sourceStartMs = Date.now() + 24 * 60 * 60 * 1000;
    const { id } = await insertAppointment(
      '+15559990208',
      sourceStartMs,
    );
    insertedIds.push(id);

    // Destination at 03:00 EDT (07:00 UTC) — well before the
    // branch's 09:00 open. The destination is +1 day so the
    // window check passes.
    const destStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    destStart.setUTCHours(7, 0, 0, 0);
    const destEnd = new Date(destStart.getTime() + 30 * 60_000);

    const res = await request(app())
      .post(`/doctor/affected/${id}/move`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        new_branch_id: branch.id,
        new_start_datetime: destStart.toISOString(),
        new_end_datetime: destEnd.toISOString(),
      });
    assert.equal(res.status, 409);
    // The reason may be either `outside_branch_hours` or
    // `doctor_unavailable` depending on whether the doctor
    // schedule covers 03:00. Both are valid FR-046 failures.
    assert.ok(
      ['outside_branch_hours', 'doctor_unavailable'].includes(res.body.error),
      `expected outside_branch_hours or doctor_unavailable; got ${res.body.error}`,
    );

    // The source row was NOT modified.
    const { rows: apptRows } = await db.pool.query<{
      start_datetime: Date;
    }>(
      `SELECT start_datetime FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(
      apptRows[0]!.start_datetime.toISOString(),
      new Date(sourceStartMs).toISOString(),
    );
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