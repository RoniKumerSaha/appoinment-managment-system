/**
 * staff-receptionist-cancel.test.ts — integration tests for
 * POST /reception/appointments/:id/cancel (receptionist flow).
 *
 * Spec-5-3 (E5-S3) + F-14 + BR-036 / FR-034 + BR-053 / FR-050:
 * receptionist cancels a Scheduled appointment on behalf of a
 * patient. Reason is required (FR-034). The slot is released
 * (GIST exclusion is scoped on status='Scheduled', so a
 * Cancelled row no longer blocks the time range).
 *
 * Receptionist scope: `appt.branch_id ∈ claim.branch_ids` only
 * (BR-004). Mismatch → 403 outside_branch_scope. NO
 * doctor-scope check — a receptionist can cancel any appointment
 * at their branch regardless of which doctor is on the row.
 *
 * Reason gate (FR-034): missing / empty / whitespace-only →
 * 400 reason_required. > 500 chars → 400 reason_too_long.
 *
 * Status gate: only `Scheduled` rows are cancellable. Terminal
 * states (Cancelled / Completed / No-Show) → 422
 * already_in_terminal_state.
 *
 * Auth: patient / admin / doctor → 403 forbidden_role.
 * Anonymous → 401.
 *
 * Audit row inspection: actor_role='receptionist',
 * actor_id='staff:<sub>', event='cancelled',
 * payload={reason: '...'}.
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
      `DELETE FROM appointment_audit WHERE actor_id IN (
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

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function insertAppointment(
  phone: string,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show',
  options?: { doctorName?: string; branchName?: string },
): Promise<{ id: string; branchId: string }> {
  const doctor = await fetchDoctorByName(options?.doctorName ?? 'Dr. East Lead');
  const branch = await fetchBranchByName(options?.branchName ?? 'East Branch');
  const type = await fetchTypeByName('General Consultation');
  const clinicId = await db.pool
    .query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`)
    .then((r) => r.rows[0]!.id);
  const startMs = Date.parse(`${tomorrowIso()}T09:00:00Z`);
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

test('POST /reception/appointments/:id/cancel: no auth → 401', async () => {
  const res = await request(app()).post(
    '/reception/appointments/00000000-0000-0000-0000-000000000000/cancel',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /reception/appointments/:id/cancel: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /reception/appointments/:id/cancel: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /reception/appointments/:id/cancel: doctor JWT → 403 forbidden_role', async () => {
  // Doctor cancel is E5-S2; this route is receptionist-only.
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Malformed UUID / unknown id
// ===========================================================================

test('POST /reception/appointments/:id/cancel: malformed UUID → 404 not_found', async () => {
  const res = await request(app())
    .post('/reception/appointments/not-a-uuid/cancel')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('POST /reception/appointments/:id/cancel: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

// ===========================================================================
// Reason gate (FR-034)
// ===========================================================================

test('POST /reception/appointments/:id/cancel: missing reason → 400 reason_required', async () => {
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_required' });
});

test('POST /reception/appointments/:id/cancel: empty reason → 400 reason_required', async () => {
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({ reason: '' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_required' });
});

test('POST /reception/appointments/:id/cancel: whitespace-only reason → 400 reason_required', async () => {
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({ reason: '   \t\n  ' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_required' });
});

test('POST /reception/appointments/:id/cancel: reason > 500 chars → 400 reason_too_long', async () => {
  const res = await request(app())
    .post('/reception/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({ reason: 'x'.repeat(501) });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_too_long' });
});

// ===========================================================================
// Happy path — own-branch Scheduled → Cancelled with reason in audit
// ===========================================================================

test('POST /reception/appointments/:id/cancel: receptionist cancels branch-east Scheduled → 200 + audit', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990001', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'Patient no-showed the call' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
    assert.equal(res.body.appointment.status, 'Cancelled');

    const { rows: apptRows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(apptRows[0]!.status, 'Cancelled');

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
    assert.equal(auditRows[0]!.event, 'cancelled');
    const payloadText =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    const parsed = JSON.parse(payloadText) as { reason: string };
    assert.equal(parsed.reason, 'Patient no-showed the call');
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

test('POST /reception/appointments/:id/cancel: reason is trimmed before storing', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990002', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: '   Cancelled by phone call   ' });

    assert.equal(res.status, 200);

    const { rows: auditRows } = await db.pool.query<{
      payload: string | object;
    }>(
      `SELECT payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    const payloadText =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    const parsed = JSON.parse(payloadText) as { reason: string };
    assert.equal(parsed.reason, 'Cancelled by phone call');
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

test('POST /reception/appointments/:id/cancel: reason with unicode → 200', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990003', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'اعتذر المريض عن الموعد' });

    assert.equal(res.status, 200);

    const { rows: auditRows } = await db.pool.query<{
      payload: string | object;
    }>(
      `SELECT payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    const payloadText =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    const parsed = JSON.parse(payloadText) as { reason: string };
    assert.equal(parsed.reason, 'اعتذر المريض عن الموعد');
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
// Receptionist can cancel any doctor's appointment at their branch (BR-004)
// ===========================================================================

test('POST /reception/appointments/:id/cancel: receptionist cancels Dr. East Support\'s appointment at branch-east → 200 (BR-004)', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990004', 'Scheduled', {
      doctorName: 'Dr. East Support',
    });
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'No doctor-scope gate for receptionists' });

    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.status, 'Cancelled');
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
// Status gate — terminal states × 3
// ===========================================================================

test('POST /reception/appointments/:id/cancel: already-Cancelled → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990005', 'Cancelled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'double cancel attempt' });

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

test('POST /reception/appointments/:id/cancel: Completed → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990006', 'Completed');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'attempted cancel of completed' });

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

test('POST /reception/appointments/:id/cancel: No-Show → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990007', 'No-Show');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'attempted cancel of no-show' });

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
// Branch scope — receptionist at other branch
// ===========================================================================

test('POST /reception/appointments/:id/cancel: receptionist-west cancels branch-east appointment → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990008', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistWestToken()}`)
      .send({ reason: 'wrong branch' });

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

// ===========================================================================
// Slot release — BR-053 / FR-050
// ===========================================================================

test('POST /reception/appointments/:id/cancel: cancelled slot is available for re-booking (BR-053 / FR-050)', async () => {
  const insertedIds: string[] = [];
  try {
    const { id, branchId } = await insertAppointment(
      '+15559990009',
      'Scheduled',
    );
    insertedIds.push(id);

    const { rows: dateRows } = await db.pool.query<{
      start_datetime: Date;
      doctor_id: string;
      appointment_type_id: string;
    }>(
      `SELECT start_datetime, doctor_id::text AS doctor_id,
              appointment_type_id::text AS appointment_type_id
         FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    const slotInfo = dateRows[0]!;
    const dateIso = slotInfo.start_datetime.toISOString().slice(0, 10);

    const probeAvailability = async (): Promise<number> => {
      const res = await request(app())
        .get('/availability')
        .query({
          doctor_id: slotInfo.doctor_id,
          branch_id: branchId,
          appointment_type_id: slotInfo.appointment_type_id,
          date: dateIso,
        })
        .set('Authorization', `Bearer ${receptionistEastToken()}`);
      assert.equal(res.status, 200);
      const slots = Array.isArray(res.body?.slots) ? res.body.slots : [];
      return slots.length;
    };

    const beforeCount = await probeAvailability();

    const cancelRes = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'BR-053 probe' });
    assert.equal(cancelRes.status, 200);

    const afterCount = await probeAvailability();

    assert.ok(
      afterCount > beforeCount,
      `expected afterCount (${afterCount}) > beforeCount (${beforeCount})`,
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