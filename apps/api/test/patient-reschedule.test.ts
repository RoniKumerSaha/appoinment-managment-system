/**
 * patient-reschedule.test.ts — integration tests for
 * POST /patient/appointments/:id/reschedule.
 *
 * Spec-4-3 (E4-S3) + F-05 + BR-041…045 / FR-039…043: the verified
 * patient reschedules their own Scheduled appointment. The doctor is
 * locked (FR-040, BR-042 — body schema never accepts `new_doctor_id`);
 * branch, type, date, and time may all change (FR-041). The
 * transaction reserves the new slot BEFORE releasing the old slot
 * (FR-042): if the new reservation fails, the original is untouched
 * (FR-043, Scenario 9). Audit row payload carries `{from, to,
 * branch_change, type_change}` per F-05.
 *
 * Privacy (E7-S3): the appointment must match `claim.sub`. Any other
 * outcome (not found, wrong owner) returns 404 — NEVER 403 — so a
 * patient cannot enumerate other patients' appointments by id.
 *
 * Testcontainer runtime is not available in this environment, so the
 * integration suite is structurally validated but not executed.
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

/** Build an ISO timestamp for a slot at HH:MM (UTC) on `date`
 *  (YYYY-MM-DD UTC). The route accepts ISO with TZ; using `Z` keeps
 *  the slot in the UTC working plane. */
function slotIso(date: string, hh: number, mm: number): string {
  return `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
}

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function insertScheduled(
  phone: string,
  doctorId: string,
  branchId: string,
  typeId: string,
  startMs: number,
  durationMinutes: number,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show' = 'Scheduled',
): Promise<string> {
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
      branchId,
      doctorId,
      phone,
      typeId,
      new Date(startMs).toISOString(),
      new Date(startMs + durationMinutes * 60_000).toISOString(),
      status,
      `patient:${phone}`,
    ],
  );
  return result.rows[0]!.id;
}

async function fetchRow(
  id: string,
): Promise<{
  branch_id: string;
  appointment_type_id: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
}> {
  const r = await db.pool.query<{
    branch_id: string;
    appointment_type_id: string;
    start_datetime: Date;
    end_datetime: Date;
    status: string;
  }>(
    `SELECT branch_id::text AS branch_id,
            appointment_type_id::text AS appointment_type_id,
            start_datetime, end_datetime, status
       FROM appointment
      WHERE id = $1::uuid`,
    [id],
  );
  return r.rows[0]!;
}

// ===========================================================================
// Auth
// ===========================================================================

test('POST /patient/appointments/:id/reschedule: no auth → 401', async () => {
  const res = await request(app()).post(
    '/patient/appointments/00000000-0000-0000-0000-000000000000/reschedule',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /patient/appointments/:id/reschedule: doctor JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/reschedule',
    )
    .set('Authorization', `Bearer ${doctorToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /patient/appointments/:id/reschedule: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/reschedule',
    )
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /patient/appointments/:id/reschedule: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/reschedule',
    )
    .set('Authorization', `Bearer ${receptionistToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Body validation
// ===========================================================================

test('POST /patient/appointments/:id/reschedule: new_doctor_id → 400 unknown_field (FR-040)', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(app())
    .post(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/reschedule',
    )
    .set('Authorization', `Bearer ${patientToken('+15559990001')}`)
    .send({
      new_branch_id: branch.id,
      new_appointment_type_id: type.id,
      new_start_datetime: slotIso(date, 15, 0),
      new_end_datetime: slotIso(date, 15, 30),
      new_slot_duration_minutes: 30,
      // FR-040 / BR-042: the route NEVER accepts a new doctor.
      new_doctor_id: doctor.id,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'unknown_field' });
});

test('POST /patient/appointments/:id/reschedule: malformed UUID → 404 not_found', async () => {
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(app())
    .post('/patient/appointments/not-a-uuid/reschedule')
    .set('Authorization', `Bearer ${patientToken('+15559990002')}`)
    .send({
      new_branch_id: branch.id,
      new_appointment_type_id: type.id,
      new_start_datetime: slotIso(date, 15, 0),
      new_end_datetime: slotIso(date, 15, 30),
      new_slot_duration_minutes: 30,
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

// ===========================================================================
// Privacy — same envelope for "doesn't exist" and "exists but not yours"
// ===========================================================================

test('POST /patient/appointments/:id/reschedule: unknown id → 404 not_found', async () => {
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const res = await request(app())
    .post(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/reschedule',
    )
    .set('Authorization', `Bearer ${patientToken('+15559990003')}`)
    .send({
      new_branch_id: branch.id,
      new_appointment_type_id: type.id,
      new_start_datetime: slotIso(date, 15, 0),
      new_end_datetime: slotIso(date, 15, 30),
      new_slot_duration_minutes: 30,
    });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('POST /patient/appointments/:id/reschedule: not your appointment → 404 not_found (privacy)', async () => {
  // Insert a Scheduled appointment owned by patient +15559990004, then
  // try to reschedule it AS a different patient (+15559990005).
  // E7-S3: same envelope as "doesn't exist" — never 403.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startMs = Date.parse(`${date}T16:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990004',
      doctor.id,
      branch.id,
      type.id,
      startMs,
      type.duration_minutes,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990005')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 17, 0),
        new_end_datetime: slotIso(date, 17, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not_found' });

    // The row's branch/start/end/type are unchanged — wrong-owner is a no-op.
    const row = await fetchRow(id);
    assert.equal(row.branch_id, branch.id);
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
// Terminal states → distinct envelope
// ===========================================================================

test('POST /patient/appointments/:id/reschedule: Cancelled → 404 not_found_appointment_in_terminal_state', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startMs = Date.parse(`${date}T16:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990006',
      doctor.id,
      branch.id,
      type.id,
      startMs,
      type.duration_minutes,
      'Cancelled',
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990006')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 17, 0),
        new_end_datetime: slotIso(date, 17, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      error: 'not_found_appointment_in_terminal_state',
    });
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

test('POST /patient/appointments/:id/reschedule: Completed → 404 not_found_appointment_in_terminal_state', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startMs = Date.parse(`${date}T16:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990007',
      doctor.id,
      branch.id,
      type.id,
      startMs,
      type.duration_minutes,
      'Completed',
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990007')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 17, 0),
        new_end_datetime: slotIso(date, 17, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      error: 'not_found_appointment_in_terminal_state',
    });
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

test('POST /patient/appointments/:id/reschedule: No-Show → 404 not_found_appointment_in_terminal_state', async () => {
  // Mirrors the E4-S2 No-Show terminal-state envelope.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startMs = Date.parse(`${date}T16:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990016',
      doctor.id,
      branch.id,
      type.id,
      startMs,
      type.duration_minutes,
      'No-Show',
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990016')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 17, 0),
        new_end_datetime: slotIso(date, 17, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      error: 'not_found_appointment_in_terminal_state',
    });
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

test('POST /patient/appointments/:id/reschedule: own Scheduled → 200 with new (branch, type, start, end) + audit row', async () => {
  // Insert a Scheduled appointment for +15559990010 at tomorrow 16:00 UTC,
  // then reschedule to tomorrow 18:00 UTC (same doctor, same branch, same
  // type — branch_change=false, type_change=false). Verify the row's
  // branch_id / appointment_type_id / start_datetime / end_datetime are
  // updated and the audit row carries the F-05 payload shape.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const oldStartMs = Date.parse(`${date}T16:00:00Z`);
  const newStartMs = Date.parse(`${date}T18:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990010',
      doctor.id,
      branch.id,
      type.id,
      oldStartMs,
      type.duration_minutes,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990010')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 18, 0),
        new_end_datetime: slotIso(date, 18, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
    assert.equal(res.body.appointment.status, 'Scheduled');
    assert.equal(res.body.appointment.branch_id, branch.id);
    assert.equal(res.body.appointment.doctor_id, doctor.id);
    assert.equal(res.body.appointment.appointment_type_id, type.id);
    assert.equal(
      new Date(res.body.appointment.start_datetime).getTime(),
      newStartMs,
    );
    assert.equal(
      new Date(res.body.appointment.end_datetime).getTime(),
      newStartMs + 30 * 60_000,
    );

    // DB-side pin: row reflects the new (start, end).
    const row = await fetchRow(id);
    assert.equal(row.branch_id, branch.id);
    assert.equal(row.appointment_type_id, type.id);
    assert.equal(row.start_datetime.getTime(), newStartMs);
    assert.equal(row.end_datetime.getTime(), newStartMs + 30 * 60_000);
    assert.equal(row.status, 'Scheduled');

    // Audit row carries the F-05 metadata: {from, to, branch_change,
    // type_change} — both false here because nothing structural changed.
    const audit = await db.pool.query<{
      actor_role: string;
      actor_id: string;
      event: string;
      payload: string;
    }>(
      `SELECT actor_role, actor_id, event, payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = $1::uuid AND event = 'rescheduled'`,
      [id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.actor_role, 'patient');
    assert.equal(
      audit.rows[0]!.actor_id,
      `patient:+15559990010`,
    );
    const payload = JSON.parse(audit.rows[0]!.payload) as {
      from: { branch_id: string; appointment_type_id: string; start_datetime: string; end_datetime: string };
      to: { branch_id: string; appointment_type_id: string; start_datetime: string; end_datetime: string };
      branch_change: boolean;
      type_change: boolean;
    };
    assert.equal(payload.from.branch_id, branch.id);
    assert.equal(payload.from.appointment_type_id, type.id);
    assert.equal(payload.to.branch_id, branch.id);
    assert.equal(payload.to.appointment_type_id, type.id);
    assert.equal(payload.branch_change, false);
    assert.equal(payload.type_change, false);
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
// Failure paths — original row must remain unchanged (FR-043)
// ===========================================================================

test('POST /patient/appointments/:id/reschedule: new slot already taken → 409 slot_raced, original unchanged', async () => {
  // Insert two Scheduled appointments for +15559990011 — `appt` is the
  // row to reschedule, `blocker` occupies the new target slot. The
  // GIST exclusion constraint on (doctor, branch, tstzrange,
  // status='Scheduled') — excluding the current row id — must catch
  // the collision. The original row's start/end stay put.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const oldStartMs = Date.parse(`${date}T16:00:00Z`);
  const blockerStartMs = Date.parse(`${date}T17:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990011',
      doctor.id,
      branch.id,
      type.id,
      oldStartMs,
      type.duration_minutes,
    );
    insertedIds.push(id);
    const blockerId = await insertScheduled(
      '+15559990012',
      doctor.id,
      branch.id,
      type.id,
      blockerStartMs,
      type.duration_minutes,
    );
    insertedIds.push(blockerId);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990011')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 17, 0),
        new_end_datetime: slotIso(date, 17, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'slot_raced');

    // Original row is untouched.
    const row = await fetchRow(id);
    assert.equal(row.start_datetime.getTime(), oldStartMs);
    assert.equal(row.end_datetime.getTime(), oldStartMs + 30 * 60_000);
    assert.equal(row.status, 'Scheduled');
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

test('POST /patient/appointments/:id/reschedule: duration mismatch → 409 duration_mismatch', async () => {
  // Submit a slot duration that doesn't match the stored duration of
  // the appointment type. Mirrors E3-S2's 409 duration_mismatch.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startMs = Date.parse(`${date}T16:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990013',
      doctor.id,
      branch.id,
      type.id,
      startMs,
      type.duration_minutes,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990013')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 18, 0),
        new_end_datetime: slotIso(date, 18, 45),
        // type.duration_minutes is 30; submit 45 → mismatch.
        new_slot_duration_minutes: 45,
      });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'duration_mismatch' });
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

test('POST /patient/appointments/:id/reschedule: new slot overlaps existing patient row → 409 patient_time_conflict (FR-029)', async () => {
  // FR-029: the patient has another Scheduled appointment that
  // overlaps the NEW target slot. The reschedule must fail at the
  // re-check stage (before UPDATE) and the ORIGINAL row must stay
  // unchanged (FR-043). To avoid tripping FR-027, the blocking row
  // belongs to a DIFFERENT doctor (Dr. East Support); the patient
  // can have one future row per doctor, just not overlapping time
  // across doctors.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const doctor2 = await fetchDoctorByName('Dr. East Support');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const oldStartMs = Date.parse(`${date}T16:00:00Z`);
  const blockerStartMs = Date.parse(`${date}T18:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990017',
      doctor.id,
      branch.id,
      type.id,
      oldStartMs,
      type.duration_minutes,
    );
    insertedIds.push(id);
    const blockerId = await insertScheduled(
      '+15559990017',
      doctor2.id,
      branch.id,
      type.id,
      blockerStartMs,
      type.duration_minutes,
    );
    insertedIds.push(blockerId);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990017')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 18, 0),
        new_end_datetime: slotIso(date, 18, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'patient_time_conflict' });

    // FR-043: original row's start/end/type are unchanged.
    const row = await fetchRow(id);
    assert.equal(row.start_datetime.getTime(), oldStartMs);
    assert.equal(row.appointment_type_id, type.id);
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

test('POST /patient/appointments/:id/reschedule: new doctor not at new branch → 400 doctor_not_at_branch', async () => {
  // Dr. East Lead is at branch-east. Reschedule his appointment to
  // branch-west (where he does NOT work) → doctor_not_at_branch.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const west = await fetchBranchByName('West Branch');
  const type = await fetchTypeByName('General Consultation');
  const date = tomorrowIso();
  const startMs = Date.parse(`${date}T16:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990014',
      doctor.id,
      east.id,
      type.id,
      startMs,
      type.duration_minutes,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990014')}`)
      .send({
        new_branch_id: west.id,
        new_appointment_type_id: type.id,
        new_start_datetime: slotIso(date, 18, 0),
        new_end_datetime: slotIso(date, 18, 30),
        new_slot_duration_minutes: 30,
      });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'doctor_not_at_branch' });

    // Original unchanged.
    const row = await fetchRow(id);
    assert.equal(row.branch_id, east.id);
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

test('POST /patient/appointments/:id/reschedule: type_change true when type_id changes', async () => {
  // Reschedule the appointment to a different appointment_type. The
  // audit row must reflect type_change=true.
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const general = await fetchTypeByName('General Consultation');
  const followup = await fetchTypeByName('Follow-up');
  const date = tomorrowIso();
  const oldStartMs = Date.parse(`${date}T16:00:00Z`);
  const insertedIds: string[] = [];
  try {
    const id = await insertScheduled(
      '+15559990015',
      doctor.id,
      branch.id,
      general.id,
      oldStartMs,
      general.duration_minutes,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/reschedule`)
      .set('Authorization', `Bearer ${patientToken('+15559990015')}`)
      .send({
        new_branch_id: branch.id,
        new_appointment_type_id: followup.id,
        new_start_datetime: slotIso(date, 18, 0),
        new_end_datetime: slotIso(date, 18, 15),
        new_slot_duration_minutes: followup.duration_minutes,
      });
    assert.equal(res.status, 200);
    assert.equal(
      res.body.appointment.appointment_type_id,
      followup.id,
    );

    const audit = await db.pool.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM appointment_audit
        WHERE appointment_id = $1::uuid AND event = 'rescheduled'`,
      [id],
    );
    const payload = JSON.parse(audit.rows[0]!.payload) as {
      from: { appointment_type_id: string };
      to: { appointment_type_id: string };
      branch_change: boolean;
      type_change: boolean;
    };
    assert.equal(payload.from.appointment_type_id, general.id);
    assert.equal(payload.to.appointment_type_id, followup.id);
    assert.equal(payload.branch_change, false);
    assert.equal(payload.type_change, true);
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