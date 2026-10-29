/**
 * 15-patient-recurring-series.test.ts — GET /patient/recurring-series.
 *
 * Coverage:
 *   - GET /patient/recurring-series
 *
 * The patient per-occurrence cancel surface (E6-S4, mock 33) needs
 * the whole series in view: the target occurrence plus the siblings
 * that a single cancel will not touch (BR-052 / FR-049).
 *
 * `GET /patient/appointments` cannot serve this — it filters to
 * `Scheduled AND start_datetime > now()`, so the completed siblings
 * are missing.
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
  branchId: string;
  typeId: string;
}> {
  const { rows: drows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [DR_EAST_LEAD],
  );
  const { rows: brows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [EAST_BRANCH],
  );
  const { rows: trows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (!drows[0] || !brows[0] || !trows[0]) throw new Error('seed missing');
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

/** Insert a recurring-series occurrence. */
async function insertOccurrence(
  seriesId: string,
  patientPhone: string,
  start: Date,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-show' = 'Scheduled',
): Promise<string> {
  const { doctorId, branchId, typeId } = await lookupIds();
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
      branchId,
      doctorId,
      patientPhone,
      typeId,
      start.toISOString(),
      status,
      `patient:${patientPhone}`,
    ],
  );
  if (!ins.rows[0]) throw new Error('insertOccurrence failed');
  return ins.rows[0].id;
}

const SERIES_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SERIES_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// ═══════════════════════════════════════════════════════════════════
// Auth / role gate
// ═══════════════════════════════════════════════════════════════════
test('GET /patient/recurring-series (no auth) → 401', async () => {
  const res = await request(createApp()).get('/patient/recurring-series');
  assert.equal(res.status, 401);
});

test('GET /patient/recurring-series (receptionist) → 403 forbidden_role', async () => {
  const { branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${receptionistToken('receptionist-east@clinic.local', branchId)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /patient/recurring-series (doctor) → 403 forbidden_role', async () => {
  const { doctorId, branchId } = await lookupIds();
  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${doctorToken('dr.-east-lead@clinic.local', doctorId, branchId)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

// ═══════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════
test('GET /patient/recurring-series → 200 with the patient series', async () => {
  await insertOccurrence(SERIES_A, PATIENT, new Date('2099-03-04T14:00:00Z'));
  await insertOccurrence(SERIES_A, PATIENT, new Date('2099-03-11T14:00:00Z'));

  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.series));
  const series = res.body.series.find(
    (s: { series_id: string }) => s.series_id === SERIES_A,
  );
  assert.ok(series, 'the series must be listed');
  assert.equal(series.occurrence_count, 2);
  assert.equal(series.occurrences.length, 2);
  assert.equal(series.doctor_name, DR_EAST_LEAD);
  assert.equal(series.branch_name, EAST_BRANCH);
  assert.equal(series.appointment_type_name, 'General Consultation');
  assert.equal(typeof series.tz, 'string');
});

test('the occurrences are listed in start order', async () => {
  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  const series = res.body.series.find(
    (s: { series_id: string }) => s.series_id === SERIES_A,
  );
  const starts = series.occurrences.map((o: { start_datetime: string }) =>
    o.start_datetime,
  );
  assert.deepEqual(starts, [...starts].sort());
});

test('a non-Scheduled occurrence is still listed (the patient sees history)', async () => {
  await insertOccurrence(
    SERIES_B,
    PATIENT,
    new Date('2099-04-01T14:00:00Z'),
    'Completed',
  );
  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  const series = res.body.series.find(
    (s: { series_id: string }) => s.series_id === SERIES_B,
  );
  assert.ok(series);
  assert.equal(series.occurrences[0]?.status, 'Completed');
});

test('another patient series is not visible (E7-S3)', async () => {
  await insertOccurrence(
    'cccccccc-3333-4333-8333-cccccccccccc',
    OTHER_PATIENT,
    new Date('2099-05-01T14:00:00Z'),
  );
  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  const ids = res.body.series.map((s: { series_id: string }) => s.series_id);
  assert.ok(!ids.includes('cccccccc-3333-4333-8333-cccccccccccc'));
});

test('a patient with no series gets an empty list, not a 404', async () => {
  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${patientToken('+15559999999')}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.series, []);
});

test('a non-recurring appointment does not appear', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  await db.pool.query(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, $1, $2, $3, $4, '2099-06-01T14:00:00Z'::timestamptz,
            '2099-06-01T14:30:00Z'::timestamptz, 'Scheduled', $5
       FROM clinic c LIMIT 1`,
    [branchId, doctorId, PATIENT, typeId, `patient:${PATIENT}`],
  );
  const res = await request(createApp())
    .get('/patient/recurring-series')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`);
  const ids = res.body.series.map((s: { series_id: string }) => s.series_id);
  assert.ok(!ids.includes(null));
  for (const s of res.body.series) {
    assert.ok(s.series_id !== undefined);
    assert.ok(s.occurrences.length > 0);
  }
});
