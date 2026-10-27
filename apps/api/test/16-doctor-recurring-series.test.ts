/**
 * 16-doctor-recurring-series.test.ts — GET /doctor/recurring-series/:id.
 *
 * Coverage:
 *   - GET /doctor/recurring-series/:id
 *
 * The doctor back-out screen (mock 40) shows what is already on
 * the books after a recurring series was created. It needs the
 * series' occurrences plus the audit trail.
 *
 * `GET /doctor/affected` cannot serve this — it lists only
 * Scheduled appointments OUTSIDE the doctor's branch weekly hours,
 * so a normally-scheduled series never appears there.
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

const PATIENT = '+15550000002';
const OTHER_PATIENT = '+15550000003';
const DR_EAST_LEAD = 'Dr. East Lead';
const DR_EAST_SUPPORT = 'Dr. East Support';
const EAST_BRANCH = 'East Branch';

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
  db = await getTestDb();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    await client.query(
      `UPDATE appointment SET status = 'Cancelled'
        WHERE patient_phone IN ('+15550000001','+15550000002','+15550000003','+15550000004','+15550000005')
          AND status = 'Scheduled'`,
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

after(async () => {
  delete process.env['AUTH_SECRET'];
  __resetAuthConfigForTests();
});

function patientToken(phone: string): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
}
function receptionistToken(email: string, branchId: string): string {
  return signClaim({
    sub: email,
    role: 'receptionist',
    branch_ids: [branchId],
    scope: 'branch',
  });
}
function doctorToken(email: string, doctorId: string, branchId: string): string {
  return signClaim({
    sub: email,
    role: 'doctor',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
}

async function lookupIds(): Promise<{
  doctorId: string;
  otherDoctorId: string;
  branchId: string;
  typeId: string;
}> {
  const { rows: drows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [DR_EAST_LEAD],
  );
  const { rows: orows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [DR_EAST_SUPPORT],
  );
  const { rows: brows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [EAST_BRANCH],
  );
  const { rows: trows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (!drows[0] || !orows[0] || !brows[0] || !trows[0]) throw new Error('seed missing');
  return {
    doctorId: drows[0].id,
    otherDoctorId: orows[0].id,
    branchId: brows[0].id,
    typeId: trows[0].id,
  };
}

/** Insert a recurring-series occurrence. */
async function insertOccurrence(
  seriesId: string,
  patientPhone: string,
  start: Date,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show' = 'Scheduled',
  doctorId?: string,
): Promise<string> {
  const ids = await lookupIds();
  const doc = doctorId ?? ids.doctorId;
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by, recurring_series_id)
     SELECT c.id, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '30 minutes',
            $7, $8, $1
       FROM clinic c
      LIMIT 1
     RETURNING id`,
    [
      seriesId,
      ids.branchId,
      doc,
      patientPhone,
      ids.typeId,
      start.toISOString(),
      status,
      `staff:doctor-east-lead.clinic.local`,
    ],
  );
  if (!ins.rows[0]) throw new Error('insertOccurrence failed');
  return ins.rows[0].id;
}

const SERIES_A = 'dddddddd-4444-4444-8444-dddddddddddd';
const SERIES_B = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

// ═══════════════════════════════════════════════════════════════════
// Auth / role gate
// ═══════════════════════════════════════════════════════════════════
test('GET /doctor/recurring-series/:id (no auth) → 401', async () => {
  const res = await request(createApp()).get(`/doctor/recurring-series/${SERIES_A}`);
  assert.equal(res.status, 401);
});

test('GET /doctor/recurring-series/:id (patient) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .get(`/doctor/recurring-series/${SERIES_A}`)
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /doctor/recurring-series/:id (receptionist) → 403 forbidden_role', async () => {
  const { branchId } = await lookupIds();
  const res = await request(createApp())
    .get(`/doctor/recurring-series/${SERIES_A}`)
    .set(
      'Authorization',
      `Bearer ${receptionistToken('receptionist-east@clinic.local', branchId)}`,
    );
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

// ═══════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════
test('GET /doctor/recurring-series/:id → 200 with the series and its occurrences', async () => {
  await insertOccurrence(SERIES_A, PATIENT, new Date('2099-03-04T14:00:00Z'));
  await insertOccurrence(SERIES_A, PATIENT, new Date('2099-03-11T14:00:00Z'));

  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get(`/doctor/recurring-series/${SERIES_A}`)
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);

  assert.equal(res.status, 200);
  assert.ok(res.body.series);
  assert.equal(res.body.series.series_id, SERIES_A);
  assert.equal(res.body.series.doctor_name, DR_EAST_LEAD);
  assert.equal(res.body.series.branch_name, EAST_BRANCH);
  assert.equal(res.body.series.occurrence_count, 2);
  assert.equal(res.body.series.occurrences.length, 2);
  assert.equal(res.body.series.scheduled_count, 2);
  assert.equal(res.body.series.cancelled_count, 0);
  assert.equal(res.body.series.completed_count, 0);
  assert.equal(typeof res.body.series.tz, 'string');
});

test('the occurrences are listed in start order', async () => {
  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get(`/doctor/recurring-series/${SERIES_A}`)
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);
  const starts = res.body.series.occurrences.map((o: { start_datetime: string }) =>
    o.start_datetime,
  );
  assert.deepEqual(starts, [...starts].sort());
});

test('a cancelled occurrence is counted separately', async () => {
  await insertOccurrence(
    SERIES_B,
    OTHER_PATIENT,
    new Date('2099-04-01T14:00:00Z'),
    'Cancelled',
  );
  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get(`/doctor/recurring-series/${SERIES_B}`)
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.series.occurrence_count, 1);
  assert.equal(res.body.series.cancelled_count, 1);
  assert.equal(res.body.series.scheduled_count, 0);
});

// ═══════════════════════════════════════════════════════════════════
// Scope
// ═══════════════════════════════════════════════════════════════════
test('another doctor\'s series is not visible (same 404 as a missing series)', async () => {
  const { otherDoctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get(`/doctor/recurring-series/${SERIES_A}`)
    .set(
      'Authorization',
      `Bearer ${doctorToken('dr.-east-support@clinic.local', otherDoctorId, branchId)}`,
    );
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('an unknown series id → 404 not_found', async () => {
  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/doctor/recurring-series/99999999-9999-4999-8999-999999999999')
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('a non-uuid series id → 404 not_found (no id disclosure)', async () => {
  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/doctor/recurring-series/not-a-uuid')
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

// ═══════════════════════════════════════════════════════════════════
// Audit trail
// ═══════════════════════════════════════════════════════════════════
test('the audit trail lists the recurring_created rows', async () => {
  const id = await insertOccurrence(
    'ffffffff-6666-4666-8666-ffffffffffff',
    PATIENT,
    new Date('2099-07-01T14:00:00Z'),
  );
  await db.pool.query(
    `INSERT INTO appointment_audit
       (appointment_id, actor_role, actor_id, event, payload)
     VALUES ($1::uuid, 'doctor', 'staff:doctor-east-lead.clinic.local', 'recurring_created', $2::jsonb)`,
    [id, JSON.stringify({ series_id: 'ffffffff-6666-4666-8666-ffffffffffff' })],
  );

  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/doctor/recurring-series/ffffffff-6666-4666-8666-ffffffffffff')
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.audit));
  assert.ok(res.body.audit.length >= 1);
  const created = res.body.audit.find(
    (a: { event: string }) => a.event === 'recurring_created',
  );
  assert.ok(created, 'the recurring_created audit row must be listed');
  assert.equal(created.actor_role, 'doctor');
});
