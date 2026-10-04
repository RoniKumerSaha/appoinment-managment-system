/**
 * staff-doctor-cancel.test.ts — integration tests for
 * POST /appointments/:id/cancel (doctor flow).
 *
 * Spec-5-2 (E5-S2) + F-10 (Cancel branch) + BR-037 / FR-035 +
 * BR-053 / FR-050: doctor cancels a Scheduled appointment on
 * behalf of a patient. Reason is required (FR-035). The slot is
 * released (GIST exclusion is scoped on status='Scheduled', so a
 * Cancelled row no longer blocks the time range).
 *
 * Doctor scope: doubly-bound — `appt.doctor_id = claim.doctor_id`
 * AND `appt.branch_id ∈ claim.branch_ids`. Mismatch → 403
 * outside_branch_scope.
 *
 * Reason gate (FR-035): missing / empty / whitespace-only →
 * 400 reason_required. > 500 chars → 400 reason_too_long.
 *
 * Status gate: only `Scheduled` rows are cancellable. Terminal
 * states (Cancelled / Completed / No-Show) → 422
 * already_in_terminal_state (distinct from the patient-facing
 * `not_found_appointment_in_terminal_state` because the staff
 * flow sees the row).
 *
 * Auth: patient / admin / receptionist → 403 forbidden_role.
 * Anonymous → 401.
 *
 * Audit row inspection: actor_role='doctor',
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
         'staff:doctor-east-lead',
         'staff:doctor-east-support',
         'staff:doctor-west-lead'
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
  // Insert at 09:00 UTC of tomorrow — within the seeded
  // branch_weekly_hours (Mon–Sat 09:00–17:00 UTC-ish in
  // America/New_York which is +5h ahead in winter so the local
  // slot would be 04:00 — but the seed just records the UTC
  // interval; the route is not checking branch hours, only the
  // GIST exclusion). The point is to put it on a future day for
  // the BR-053 / FR-050 slot-release probe.
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

test('POST /appointments/:id/cancel: no auth → 401', async () => {
  const res = await request(app()).post(
    '/appointments/00000000-0000-0000-0000-000000000000/cancel',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /appointments/:id/cancel: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /appointments/:id/cancel: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /appointments/:id/cancel: receptionist JWT → 403 forbidden_role', async () => {
  // Receptionist cancel is E5-S3; this route is doctor-only.
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Malformed UUID / unknown id
// ===========================================================================

test('POST /appointments/:id/cancel: malformed UUID → 404 not_found', async () => {
  const res = await request(app())
    .post('/appointments/not-a-uuid/cancel')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('POST /appointments/:id/cancel: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

// ===========================================================================
// Reason gate (FR-035)
// ===========================================================================

test('POST /appointments/:id/cancel: missing reason → 400 reason_required', async () => {
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_required' });
});

test('POST /appointments/:id/cancel: empty reason → 400 reason_required', async () => {
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ reason: '' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_required' });
});

test('POST /appointments/:id/cancel: whitespace-only reason → 400 reason_required', async () => {
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ reason: '   \t\n  ' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_required' });
});

test('POST /appointments/:id/cancel: reason > 500 chars → 400 reason_too_long', async () => {
  const res = await request(app())
    .post('/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({ reason: 'x'.repeat(501) });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'reason_too_long' });
});

// ===========================================================================
// Happy path — own Scheduled → Cancelled with reason in audit
// ===========================================================================

test('POST /appointments/:id/cancel: doctor cancels own Scheduled → 200 + audit with reason', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990001', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ reason: 'Patient requested reschedule' });

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
    assert.equal(auditRows[0]!.actor_role, 'doctor');
    assert.equal(auditRows[0]!.actor_id, 'staff:doctor-east-lead');
    assert.equal(auditRows[0]!.event, 'cancelled');
    const payloadText =
      typeof auditRows[0]!.payload === 'string'
        ? auditRows[0]!.payload
        : JSON.stringify(auditRows[0]!.payload);
    const parsed = JSON.parse(payloadText) as { reason: string };
    assert.equal(parsed.reason, 'Patient requested reschedule');
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

test('POST /appointments/:id/cancel: reason is trimmed before storing', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990002', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ reason: '   Patient declined   ' });

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
    assert.equal(parsed.reason, 'Patient declined');
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

test('POST /appointments/:id/cancel: reason with unicode / multi-byte chars → 200', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990003', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ reason: 'Patient withdrew (اعتذر المريض)' });

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
    assert.equal(parsed.reason, 'Patient withdrew (اعتذر المريض)');
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

test('POST /appointments/:id/cancel: reason at 500 chars → 200', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990004', 'Scheduled');
    insertedIds.push(id);

    const reason = 'x'.repeat(500);
    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ reason });

    assert.equal(res.status, 200);
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

test('POST /appointments/:id/cancel: already-Cancelled → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990005', 'Cancelled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
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

test('POST /appointments/:id/cancel: Completed → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990006', 'Completed');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
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

test('POST /appointments/:id/cancel: No-Show → 422 already_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990007', 'No-Show');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
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
// Doctor scope — wrong doctor / wrong branch
// ===========================================================================

test('POST /appointments/:id/cancel: doctor-east-support cancels Dr. East Lead\'s appointment → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990008', 'Scheduled', {
      doctorName: 'Dr. East Lead',
    });
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({ reason: 'wrong doctor' });

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

test('POST /appointments/:id/cancel: doctor-west-lead cancels branch-east appointment → 403 outside_branch_scope', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment('+15559990009', 'Scheduled');
    insertedIds.push(id);

    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorWestLeadToken()}`)
      .send({ reason: 'wrong branch' });

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
// Slot release — BR-053 / FR-050
// ===========================================================================

test('POST /appointments/:id/cancel: cancelled slot is available for re-booking (BR-053 / FR-050)', async () => {
  // Probe /availability at the slot's date BEFORE and AFTER the
  // cancel; assert the post-cancel slot count is strictly greater.
  const insertedIds: string[] = [];
  try {
    const { id, branchId } = await insertAppointment(
      '+15559990010',
      'Scheduled',
    );
    insertedIds.push(id);

    // Look up the slot's date.
    const { rows: dateRows } = await db.pool.query<{
      start_datetime: Date;
      duration_minutes: number;
      doctor_id: string;
      appointment_type_id: string;
    }>(
      `SELECT start_datetime,
              EXTRACT(EPOCH FROM (end_datetime - start_datetime)) / 60 AS duration_minutes,
              doctor_id::text AS doctor_id,
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
        .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
      assert.equal(res.status, 200);
      // /availability returns { date, slots: [{start, end}, ...] }
      // (or whatever the schema is — we just want a count).
      const slots = Array.isArray(res.body?.slots) ? res.body.slots : [];
      return slots.length;
    };

    const beforeCount = await probeAvailability();

    const cancelRes = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
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