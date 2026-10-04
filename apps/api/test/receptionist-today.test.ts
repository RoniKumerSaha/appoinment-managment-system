/**
 * receptionist-today.test.ts — integration tests for
 * GET /reception/branch/today.
 *
 * Spec-5-4 (E5-S4) + F-12 + BR-063 + Scenario 11: the
 * receptionist dashboard returns today's appointments at the
 * receptionist's assigned branch. Branch is locked to
 * `claim.branch_ids[0]` server-side; `branch_id` query is
 * IGNORED. Date is anchored to the branch's tz (E7-S6).
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

async function fetchBranchByName(name: string): Promise<{ id: string; tz: string }> {
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

/** Insert an appointment at a given UTC ms timestamp. */
async function insertAppointment(
  phone: string,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show',
  startMs: number,
  options?: {
    doctorName?: string;
    branchName?: string;
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
// Auth
// ===========================================================================

test('GET /reception/branch/today: no auth → 401', async () => {
  const res = await request(app()).get('/reception/branch/today');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /reception/branch/today: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /reception/branch/today: doctor JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /reception/branch/today: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Happy path — branch metadata
// ===========================================================================

test('GET /reception/branch/today: branch-east receptionist → 200 with branch metadata + empty list', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 200);
  // Branch metadata is locked to claim.branch_ids[0].
  assert.equal(typeof res.body.branch, 'object');
  assert.equal(typeof res.body.branch.id, 'string');
  assert.equal(res.body.branch.name, 'East Branch');
  assert.equal(res.body.branch.tz, 'America/New_York');
  // Empty list when no appointments inserted for the test.
  assert.ok(Array.isArray(res.body.appointments));
  assert.equal(res.body.date.length, 10); // YYYY-MM-DD
  assert.deepEqual(res.body.filters, {
    doctor_id: null,
    status: null,
    date: null,
  });
});

test('GET /reception/branch/today: branch-west receptionist → 200 with branch-west metadata', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .set('Authorization', `Bearer ${receptionistWestToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.branch.name, 'West Branch');
  assert.equal(res.body.branch.tz, 'America/Los_Angeles');
});

// ===========================================================================
// Cross-branch URL tampering (Scenario 11)
// ===========================================================================

test('GET /reception/branch/today?branch_id=branch-west: branch-east receptionist → 200 with branch-east data (branch_id IGNORED)', async () => {
  const insertedIds: string[] = [];
  try {
    // Insert a row at branch-west only.
    const { id: wId } = await insertAppointment(
      '+15559990101',
      'Scheduled',
      Date.now() + 60 * 60 * 1000,
      { doctorName: 'Dr. West Lead', branchName: 'West Branch' },
    );
    insertedIds.push(wId);

    // Insert a row at branch-east only.
    const { id: eId } = await insertAppointment(
      '+15559990102',
      'Scheduled',
      Date.now() + 60 * 60 * 1000,
    );
    insertedIds.push(eId);

    // The branch-east receptionist probes with branch_id=branch-west.
    // Per Scenario 11 the branch_id query is IGNORED — the
    // receptionist sees their branch's data only.
    const res = await request(app())
      .get('/reception/branch/today')
      .query({ branch_id: 'branch-west' })
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.branch.name, 'East Branch');
    // The branch-west row should NOT appear.
    const westIds = res.body.appointments.map((a: { id: string }) => a.id);
    assert.ok(!westIds.includes(wId));
    // The branch-east row SHOULD appear (assuming same calendar day).
    const eastIds = res.body.appointments.map((a: { id: string }) => a.id);
    assert.ok(eastIds.includes(eId));
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
// Filter tests
// ===========================================================================

test('GET /reception/branch/today?status=Scheduled: only Scheduled rows returned', async () => {
  const insertedIds: string[] = [];
  try {
    // Three at the same doctor today, all different statuses.
    const ts = Date.now() + 60 * 60 * 1000;
    const { id: sId } = await insertAppointment('+15559990201', 'Scheduled', ts);
    const { id: cId } = await insertAppointment('+15559990202', 'Cancelled', ts + 30 * 60_000);
    const { id: coId } = await insertAppointment('+15559990203', 'Completed', ts + 60 * 60_000);
    insertedIds.push(sId, cId, coId);

    const res = await request(app())
      .get('/reception/branch/today')
      .query({ status: 'Scheduled' })
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 200);
    const ids = res.body.appointments.map((a: { id: string }) => a.id);
    assert.ok(ids.includes(sId));
    assert.ok(!ids.includes(cId));
    assert.ok(!ids.includes(coId));
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('GET /reception/branch/today?doctor_id=...: only that doctor\'s rows returned', async () => {
  const insertedIds: string[] = [];
  try {
    const ts = Date.now() + 60 * 60 * 1000;
    const { id: leadId } = await insertAppointment('+15559990301', 'Scheduled', ts, {
      doctorName: 'Dr. East Lead',
    });
    const { id: supportId } = await insertAppointment(
      '+15559990302',
      'Scheduled',
      ts + 30 * 60_000,
      { doctorName: 'Dr. East Support' },
    );
    insertedIds.push(leadId, supportId);

    const eastDoctorRow = await db.pool.query<{ id: string }>(
      `SELECT id FROM doctor WHERE full_name = 'Dr. East Lead'`,
    );
    const doctorId = eastDoctorRow.rows[0]!.id;

    const res = await request(app())
      .get('/reception/branch/today')
      .query({ doctor_id: doctorId })
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 200);
    const ids = res.body.appointments.map((a: { id: string }) => a.id);
    assert.ok(ids.includes(leadId));
    assert.ok(!ids.includes(supportId));
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});

test('GET /reception/branch/today?date=YYYY-MM-DD: dataset filtered to that calendar day', async () => {
  const insertedIds: string[] = [];
  try {
    // Insert one row today (1h from now) and one row tomorrow.
    const today = new Date(Date.now() + 60 * 60 * 1000);
    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000);
    const { id: todayId } = await insertAppointment(
      '+15559990401',
      'Scheduled',
      today.getTime(),
    );
    const { id: tomorrowId } = await insertAppointment(
      '+15559990402',
      'Scheduled',
      tomorrow.getTime(),
    );
    insertedIds.push(todayId, tomorrowId);

    const todayDate = today.toISOString().slice(0, 10);
    const tomorrowDate = tomorrow.toISOString().slice(0, 10);

    const res = await request(app())
      .get('/reception/branch/today')
      .query({ date: todayDate })
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.date, todayDate);
    const ids = res.body.appointments.map((a: { id: string }) => a.id);
    assert.ok(ids.includes(todayId));
    assert.ok(!ids.includes(tomorrowId));

    // Tomorrow: opposite.
    const res2 = await request(app())
      .get('/reception/branch/today')
      .query({ date: tomorrowDate })
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res2.status, 200);
    const ids2 = res2.body.appointments.map((a: { id: string }) => a.id);
    assert.ok(ids2.includes(tomorrowId));
    assert.ok(!ids2.includes(todayId));
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
// Privacy (E7-S3) — no patient_name in response
// ===========================================================================

test('GET /reception/branch/today: response does NOT include patient_name (E7-S3)', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990505',
      'Scheduled',
      Date.now() + 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .get('/reception/branch/today')
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 200);
    for (const a of res.body.appointments) {
      assert.equal(typeof a.patient_phone, 'string');
      assert.equal('patient_name' in a, false);
      assert.equal('patient_first_name' in a, false);
    }
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
// Validation — bad query params
// ===========================================================================

test('GET /reception/branch/today?status=Bogus → 400 invalid_status', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .query({ status: 'Bogus' })
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_status' });
});

test('GET /reception/branch/today?doctor_id=not-a-uuid → 400 invalid_doctor_id', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .query({ doctor_id: 'not-a-uuid' })
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('GET /reception/branch/today?date=not-a-date → 400 invalid_date', async () => {
  const res = await request(app())
    .get('/reception/branch/today')
    .query({ date: 'not-a-date' })
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_date' });
});

// ===========================================================================
// Empty state
// ===========================================================================

test('GET /reception/branch/today on a day with no appointments → 200 with appointments: []', async () => {
  // Probe a date well in the past — guaranteed empty.
  const res = await request(app())
    .get('/reception/branch/today')
    .query({ date: '2020-01-01' })
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.date, '2020-01-01');
  assert.deepEqual(res.body.appointments, []);
});

// ===========================================================================
// Sorting — appointments returned ASC by start_datetime, then doctor_name
// ===========================================================================

test('GET /reception/branch/today: appointments ordered ASC by start_datetime', async () => {
  const insertedIds: string[] = [];
  try {
    // Insert three at the same doctor, different times.
    const base = Date.now() + 60 * 60 * 1000;
    const { id: id1 } = await insertAppointment('+15559990601', 'Scheduled', base + 120 * 60_000);
    const { id: id2 } = await insertAppointment('+15559990602', 'Scheduled', base + 30 * 60_000);
    const { id: id3 } = await insertAppointment('+15559990603', 'Scheduled', base + 60 * 60_000);
    insertedIds.push(id1, id2, id3);

    const todayDate = new Date(base).toISOString().slice(0, 10);
    const res = await request(app())
      .get('/reception/branch/today')
      .query({ date: todayDate })
      .set('Authorization', `Bearer ${receptionistEastToken()}`);
    assert.equal(res.status, 200);

    const ids = res.body.appointments.map((a: { id: string }) => a.id);
    const expected = [id2, id3, id1]; // 30min, 60min, 120min
    // Assert all three are present.
    for (const id of expected) {
      assert.ok(ids.includes(id), `expected ${id} in response`);
    }
    // Assert pairwise ordering in the response array.
    const idx2 = ids.indexOf(id2);
    const idx3 = ids.indexOf(id3);
    const idx1 = ids.indexOf(id1);
    assert.ok(
      idx2 < idx3 && idx3 < idx1,
      `expected ${id2} < ${id3} < ${id1}, got indices ${idx2},${idx3},${idx1}`,
    );
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
  }
});