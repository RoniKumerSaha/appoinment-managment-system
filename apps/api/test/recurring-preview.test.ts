/**
 * recurring-preview.test.ts — integration tests for
 * POST /recurring/preview.
 *
 * Spec-6-1 (E6-S1) + PRD F-11 + BR-047…053 + FR-044…050:
 * Doctor or receptionist previews a recurring series (Weekly /
 * Every 2 weeks / Custom). The route is READ-ONLY — it validates
 * every occurrence in isolation and returns `{will_create,
 * skipped_with_reason}`. The snapshot is keyed by `preview_id` and
 * is consumed by `/recurring/confirm`.
 *
 * Acceptance (Scenario 10): 8 weekly occurrences with one conflict
 * → 7 created + 1 skipped with reason.
 * Acceptance (FR-019): the same-day occurrence is skipped with
 * `reason='same_day_exclusion'`.
 * Acceptance (FR-018): occurrences beyond the 30-day window are
 * skipped with `reason='outside_30d_window'`.
 *
 * Auth: patient / admin → 403 forbidden_role. Anonymous → 401.
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

async function fetchBranchByName(name: string): Promise<{
  id: string;
  tz: string;
}> {
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

/** Returns YYYY-MM-DD `days` from now in UTC. */
function dateOffset(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Insert a Scheduled appointment at (doctor, branch, time) for a
 *  given phone. Used to seed conflicts for the 8-weekly + 1-conflict
 *  scenario. */
async function insertAppointment(
  phone: string,
  startMs: number,
  options?: { doctorName?: string; branchName?: string },
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
      new Date(startMs + type.duration_minutes * 60_000).toISOString(),
      `patient:${phone}`,
    ],
  );
  return { id: result.rows[0]!.id };
}

// ===========================================================================
// Auth
// ===========================================================================

test('POST /recurring/preview: no auth → 401', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /recurring/preview: patient JWT → 403 forbidden_role (FR-045)', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /recurring/preview: admin JWT → 403 forbidden_role', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Body validation
// ===========================================================================

test('POST /recurring/preview: empty body → 400 unknown_field', async () => {
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'unknown_field' });
});

test('POST /recurring/preview: invalid phone → 400 invalid_patient_phone', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: 'not-a-phone',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_patient_phone' });
});

test('POST /recurring/preview: recurrence_kind="custom_days" + interval=0 → 400 invalid_recurrence_interval_days', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'custom_days',
      recurrence_interval_days: 0,
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_recurrence_interval_days' });
});

test('POST /recurring/preview: time_of_day="bad" → 400 invalid_time_of_day', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: 'bad',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_time_of_day' });
});

// ===========================================================================
// Series-shape rejections
// ===========================================================================

test('POST /recurring/preview: doctor at claim.doctor_id mismatch (body says different doctor) → 403 outside_branch_scope', async () => {
  const doctorEastSupport = await fetchDoctorByName('Dr. East Support');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      doctor_id: doctorEastSupport.id, // wrong — claim is doctor-east-lead
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'outside_branch_scope' });
});

test('POST /recurring/preview: branch_id not in claim.branch_ids → 403 outside_branch_scope', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branchWest = await fetchBranchByName('West Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branchWest.id, // wrong — claim is branch-east
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'outside_branch_scope' });
});

test('POST /recurring/preview: unknown patient_phone → 400 patient_not_found', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15558889999', // not on file
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'patient_not_found' });
});

// ===========================================================================
// Happy path — weekly × 4, doctor
// ===========================================================================

test('POST /recurring/preview: doctor weekly × 4 → 200 with 4 will_create, 0 skipped', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.will_create.length, 4);
  assert.equal(res.body.skipped_with_reason.length, 0);
  // Echoes the recurrence shape so the UI can confirm.
  assert.equal(res.body.recurrence.kind, 'weekly');
  assert.equal(res.body.recurrence.interval_days, 7);
});

// ===========================================================================
// Happy path — receptionist
// ===========================================================================

test('POST /recurring/preview: receptionist weekly × 4 → 200', async () => {
  const doctor = await fetchDoctorByName('Dr. East Lead');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistEastToken()}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000001',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 4,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.will_create.length, 4);
});

// ===========================================================================
// Scenario 10 — 8 weekly + 1 conflict → 7 will_create + 1 skipped
// ===========================================================================

test('POST /recurring/preview: 8 weekly + 1 conflict → 7 will_create + 1 skipped (Scenario 10)', async () => {
  const insertedIds: string[] = [];
  try {
    const doctor = await fetchDoctorByName('Dr. East Lead');
    const branch = await fetchBranchByName('East Branch');
    const type = await fetchTypeByName('General Consultation');
    // Pre-book an appointment at the 3rd occurrence's slot (a +14 day
    // slot at 09:00, branch-east, Dr. East Lead).
    const startMs = Date.now() + 14 * 24 * 60 * 60 * 1000;
    // Snap to the hour (09:00) so the conflict is exact.
    const conflictMs = new Date(startMs);
    conflictMs.setUTCHours(13, 0, 0, 0); // 09:00 EDT ≈ 13:00 UTC
    const { id: conflictId } = await insertAppointment(
      '+15559990101',
      conflictMs.getTime(),
    );
    insertedIds.push(conflictId);

    const res = await request(app())
      .post('/recurring/preview')
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({
        doctor_id: doctor.id,
        branch_id: branch.id,
        appointment_type_id: type.id,
        patient_phone: '+15550000001',
        recurrence_kind: 'weekly',
        start_date: dateOffset(1),
        time_of_day: '09:00',
        duration_minutes: 30,
        occurrences_or_until_date: 8,
      });
    assert.equal(res.status, 200);
    assert.equal(
      res.body.will_create.length,
      7,
      `expected 7 will_create, got ${res.body.will_create.length}`,
    );
    assert.equal(
      res.body.skipped_with_reason.length,
      1,
      `expected 1 skipped, got ${res.body.skipped_with_reason.length}`,
    );
    // The reason on the skipped occurrence is either `slot_raced` or
    // `patient_has_future_with_doctor` (the seeded patient 0001 already
    // has a future appointment with Dr. East Lead per the seed). The
    // spec accepts either — the test pins ONE skip with a non-empty
    // reason, not a specific reason.
    const skipped = res.body.skipped_with_reason[0]!;
    assert.equal(typeof skipped.reason, 'string');
    assert.ok(skipped.reason.length > 0);
    assert.equal(typeof skipped.local_date, 'string');
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
// FR-019 — same-day exclusion
// ===========================================================================

test('POST /recurring/preview: start_date=today → same-day occurrence skipped with reason=same_day_exclusion', async () => {
  const doctor = await fetchDoctorByName('Dr. East Support');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  // Use Dr. East Support (NOT seeded with a future appointment, so
  // FR-027 doesn't fire).
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${signClaim({
      sub: 'doctor-east-support',
      role: 'doctor',
      branch_ids: ['branch-east'],
      scope: 'branch',
      doctor_id: 'doctor-east-support',
    })}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000002', // patient 0002 has no seeded future appt
      recurrence_kind: 'weekly',
      start_date: dateOffset(0), // today
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 9,
    });
  assert.equal(res.status, 200);
  // The 1st occurrence is same-day → skipped.
  const firstSkipped = res.body.skipped_with_reason.find(
    (s: { index: number }) => s.index === 1,
  );
  assert.ok(
    firstSkipped !== undefined,
    'expected the 1st occurrence to be in skipped_with_reason',
  );
  assert.equal(firstSkipped.reason, 'same_day_exclusion');
});

// ===========================================================================
// FR-018 — 30-day window cap
// ===========================================================================

test('POST /recurring/preview: recurrence crossing 30 days → occurrences beyond the window are skipped (FR-018)', async () => {
  const doctor = await fetchDoctorByName('Dr. East Support');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  // Daily recurrence × 60 → only the first ~30 will fit inside
  // [today+1, today+30]. The rest are skipped with outside_30d_window.
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${signClaim({
      sub: 'doctor-east-support',
      role: 'doctor',
      branch_ids: ['branch-east'],
      scope: 'branch',
      doctor_id: 'doctor-east-support',
    })}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000002',
      recurrence_kind: 'custom_days',
      recurrence_interval_days: 1,
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 60,
    });
  assert.equal(res.status, 200);
  // At least one occurrence should be skipped with outside_30d_window.
  const outOfWindow = res.body.skipped_with_reason.filter(
    (s: { reason: string }) => s.reason === 'outside_30d_window',
  );
  assert.ok(
    outOfWindow.length > 0,
    `expected at least one occurrence with reason='outside_30d_window'; got: ${JSON.stringify(res.body.skipped_with_reason.map((s: { reason: string }) => s.reason))}`,
  );
});

// ===========================================================================
// Sugar — recurrence_kind weekly / every_two_weeks → interval_days
// ===========================================================================

test('POST /recurring/preview: recurrence_kind=every_two_weeks → interval_days=14 in the echo', async () => {
  const doctor = await fetchDoctorByName('Dr. East Support');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${signClaim({
      sub: 'doctor-east-support',
      role: 'doctor',
      branch_ids: ['branch-east'],
      scope: 'branch',
      doctor_id: 'doctor-east-support',
    })}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000002',
      recurrence_kind: 'every_two_weeks',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 2,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.recurrence.interval_days, 14);
  assert.equal(res.body.will_create.length, 2);
});

// ===========================================================================
// preview_id is a uuid
// ===========================================================================

test('POST /recurring/preview: response preview_id is a uuid', async () => {
  const doctor = await fetchDoctorByName('Dr. East Support');
  const branch = await fetchBranchByName('East Branch');
  const type = await fetchTypeByName('General Consultation');
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${signClaim({
      sub: 'doctor-east-support',
      role: 'doctor',
      branch_ids: ['branch-east'],
      scope: 'branch',
      doctor_id: 'doctor-east-support',
    })}`)
    .send({
      doctor_id: doctor.id,
      branch_id: branch.id,
      appointment_type_id: type.id,
      patient_phone: '+15550000002',
      recurrence_kind: 'weekly',
      start_date: dateOffset(1),
      time_of_day: '09:00',
      duration_minutes: 30,
      occurrences_or_until_date: 2,
    });
  assert.equal(res.status, 200);
  assert.match(
    res.body.preview_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
});