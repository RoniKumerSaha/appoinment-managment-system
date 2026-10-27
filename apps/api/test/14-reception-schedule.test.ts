/**
 * 14-reception-schedule.test.ts — receptionist day calendar.
 *
 * Coverage:
 *   - GET /reception/branch/schedule
 *
 * The receptionist's availability calendar shows BOTH open and
 * booked slots (F-15). `GET /availability` returns only the open
 * half, so the booked half comes from this route.
 *
 * Privacy (F-15): "No PII beyond first-name initial" — the route
 * exposes `patient_initial` and nothing else about the patient.
 * No name, no phone.
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

const RECEPTIONIST_EAST = 'receptionist-east@clinic.local';
const RECEPTIONIST_WEST = 'receptionist-west@clinic.local';

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
function doctorToken(sub: string, branchId: string): string {
  return signClaim({ sub, role: 'doctor', branch_ids: [branchId], scope: 'branch' });
}
function adminToken(sub: string): string {
  return signClaim({ sub, role: 'admin', branch_ids: [], scope: 'global' });
}
function receptionistToken(email: string, branchId: string): string {
  return signClaim({ sub: email, role: 'receptionist', branch_ids: [branchId], scope: 'branch' });
}

async function lookupIds(name: string, branch: string): Promise<{ doctorId: string; branchId: string }> {
  const { rows: drows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [name],
  );
  const { rows: brows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [branch],
  );
  if (!drows[0] || !brows[0]) throw new Error(`seed missing: ${name}/${branch}`);
  return { doctorId: drows[0].id, branchId: brows[0].id };
}

/** Insert a Scheduled appointment at an exact instant. Each call
 *  uses the next (patient, doctor) pair to dodge FR-027, and a
 *  per-doctor slot offset to dodge the GIST overlap exclusion. */
const PATIENTS = ['+15550000001', '+15550000002', '+15550000003', '+15550000004', '+15550000005'];
/** How many rows each doctor already has in this file — the patient
 *  index and the time offset both advance per doctor, so a second
 *  row for the same doctor never repeats a patient (FR-027) and
 *  never overlaps the first (GIST). */
const doctorSlots = new Map<string, number>();
function nextPatientFor(doctorName: string): string {
  const used = doctorSlots.get(doctorName) ?? 0;
  doctorSlots.set(doctorName, used + 1);
  return PATIENTS[used % PATIENTS.length]!;
}

interface InsertOpts {
  patientName?: string | null;
  status?: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show';
  offsetHours?: number;
}

async function insertAppointment(
  patientPhone: string,
  doctorName: string,
  branchName: string,
  start: Date,
  opts: InsertOpts = {},
): Promise<string> {
  const status = opts.status ?? 'Scheduled';
  // A 30-minute appointment plus the 1-hour GIST gap needs 90
  // minutes of headroom between two rows for the same doctor, so
  // the offset steps in 2-hour increments. The base instant is
  // midday, so even a dozen steps stay on the same calendar day.
  const slot = doctorSlots.get(doctorName) ?? 0;
  const offset = opts.offsetHours ?? slot * 2 * 60 * 60_000;
  const shifted = new Date(start.getTime() + offset);
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, b.id, d.id, $1, t.id, $2::timestamptz, $2::timestamptz + interval '30 minutes',
            $3::appointment_status, $4
       FROM clinic c, branch b, doctor d, appointment_type t, doctor_branch db
      WHERE b.name = $5 AND d.full_name = $6
        AND t.name = 'General Consultation'
        AND db.doctor_id = d.id AND db.branch_id = b.id
      LIMIT 1
     RETURNING id`,
    [patientPhone, shifted.toISOString(), status, `patient:${patientPhone}`, branchName, doctorName],
  );
  if (!ins.rows[0]) throw new Error(`insertAppointment failed`);
  const id = ins.rows[0].id;
  // `POST /bookings` upserts the patient row; the appointment insert
  // does not. The route LEFT JOINs patient on phone_number, so the
  // name has to exist for the initial to be anything but '•'.
  await db.pool.query(
    `INSERT INTO patient (phone_number, full_name)
     VALUES ($1, $2)
     ON CONFLICT (phone_number) DO UPDATE SET full_name = EXCLUDED.full_name`,
    [patientPhone, opts.patientName ?? null],
  );
  await db.pool.query(
    `INSERT INTO appointment_audit (appointment_id, actor_role, actor_id, event, payload)
     VALUES ($1, 'patient', $2, 'created', '{}'::jsonb)`,
    [id, `patient:${patientPhone}`],
  );
  return id;
}

/** A fixed calendar day, far enough out to be unambiguous, with a
 *  UTC instant that is the same day in both branch timezones. */
const DAY = '2099-06-15';
const DAY_START_UTC = new Date(`${DAY}T12:00:00.000Z`);

// ═══════════════════════════════════════════════════════════════════
// Auth / role gate
// ═══════════════════════════════════════════════════════════════════
test('GET /reception/branch/schedule (no auth) → 401', async () => {
  const res = await request(createApp()).get('/reception/branch/schedule');
  assert.equal(res.status, 401);
});

test('GET /reception/branch/schedule (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .get('/reception/branch/schedule')
    .set('Authorization', `Bearer ${patientToken('+15550000002')}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /reception/branch/schedule (doctor role) → 403 forbidden_role', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const res = await request(createApp())
    .get('/reception/branch/schedule')
    .set('Authorization', `Bearer ${doctorToken('doctor-east@clinic.local', branchId)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /reception/branch/schedule (admin role) → 403', async () => {
  // An admin token carries no branch_ids, so the auth middleware
  // rejects it before the route's role gate runs. The route would
  // reject it too (admin !== receptionist) — the status is what
  // matters, not which layer answers.
  const res = await request(createApp())
    .get('/reception/branch/schedule')
    .set('Authorization', `Bearer ${adminToken('admin@clinic.local')}`);
  assert.equal(res.status, 403);
});

test('GET /reception/branch/schedule (receptionist, no branch) → 403', async () => {
  const token = signClaim({
    sub: RECEPTIONIST_EAST,
    role: 'receptionist',
    branch_ids: [],
    scope: 'branch',
  });
  const res = await request(createApp())
    .get('/reception/branch/schedule')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
});

// ═══════════════════════════════════════════════════════════════════
// Query validation
// ═══════════════════════════════════════════════════════════════════
test('GET /reception/branch/schedule?date=not-a-date → 400 invalid_date', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const res = await request(createApp())
    .get('/reception/branch/schedule?date=not-a-date')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_date');
});

test('GET /reception/branch/schedule?doctor_id=not-a-uuid → 400 invalid_doctor_id', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const res = await request(createApp())
    .get('/reception/branch/schedule?doctor_id=not-a-uuid')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

// ═══════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════
test('GET /reception/branch/schedule → 200 with the branch envelope', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const res = await request(createApp())
    .get(`/reception/branch/schedule?date=${DAY}`)
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.date, DAY);
  assert.equal(res.body.branch.id, branchId);
  assert.equal(typeof res.body.branch.name, 'string');
  assert.equal(typeof res.body.branch.tz, 'string');
  assert.ok(Array.isArray(res.body.booked));
});

test('GET /reception/branch/schedule (no date) → defaults to today in the branch tz', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const res = await request(createApp())
    .get('/reception/branch/schedule')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`);
  assert.equal(res.status, 200);
  assert.match(res.body.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('GET /reception/branch/schedule returns the booked slot for the day', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const phone = nextPatientFor('Dr. East Lead');
  const id = await insertAppointment(phone, 'Dr. East Lead', 'East Branch', DAY_START_UTC, {
    patientName: 'Layla Haddad',
  });

  const res = await request(createApp())
    .get(`/reception/branch/schedule?date=${DAY}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const row = res.body.booked.find((b: { id: string }) => b.id === id);
  assert.ok(row, 'the inserted appointment must appear in the booked list');
  assert.equal(row.doctor_name, 'Dr. East Lead');
  assert.equal(row.appointment_type_name, 'General Consultation');
});

test('GET /reception/branch/schedule exposes only the first-name initial (F-15)', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const phone = nextPatientFor('Dr. East Lead');
  const id = await insertAppointment(phone, 'Dr. East Lead', 'East Branch', DAY_START_UTC, {
    patientName: 'Layla Haddad',
  });

  const res = await request(createApp())
    .get(`/reception/branch/schedule?date=${DAY}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const row = res.body.booked.find((b: { id: string }) => b.id === id);
  assert.ok(row);
  assert.equal(row.patient_initial, 'L');
  // No patient name, no phone — anywhere in the payload.
  assert.equal(row.patient_full_name, undefined);
  assert.equal(row.patient_name, undefined);
  assert.equal(row.patient_phone, undefined);
  assert.equal(row.phone, undefined);
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('Layla'), 'the patient name must not appear in the payload');
  assert.ok(!serialized.includes(phone), 'the patient phone must not appear in the payload');
});

test('GET /reception/branch/schedule?doctor_id= filters to one doctor', async () => {
  const { doctorId, branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const phone = nextPatientFor('Dr. East Lead');
  const id = await insertAppointment(phone, 'Dr. East Lead', 'East Branch', DAY_START_UTC, {
    patientName: 'Omar Nasser',
    offsetHours: 0,
  });
  const otherPhone = nextPatientFor('Dr. East Support');
  const otherId = await insertAppointment(otherPhone, 'Dr. East Support', 'East Branch', DAY_START_UTC, {
    patientName: 'Sara Idris',
    offsetHours: 0,
  });

  const res = await request(createApp())
    .get(`/reception/branch/schedule?date=${DAY}&doctor_id=${doctorId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const ids = res.body.booked.map((b: { id: string }) => b.id);
  assert.ok(ids.includes(id));
  assert.ok(!ids.includes(otherId), 'the other doctor must be filtered out');
});

test('GET /reception/branch/schedule excludes non-Scheduled appointments', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const phone = nextPatientFor('Dr. East Lead');
  const id = await insertAppointment(phone, 'Dr. East Lead', 'East Branch', DAY_START_UTC, {
    patientName: 'Nadia Karim',
    status: 'Cancelled',
  });

  const res = await request(createApp())
    .get(`/reception/branch/schedule?date=${DAY}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const ids = res.body.booked.map((b: { id: string }) => b.id);
  assert.ok(!ids.includes(id), 'a Cancelled appointment does not occupy a slot');
});

test('GET /reception/branch/schedule is branch-bound (foreign branch_id ignored)', async () => {
  const { branchId: westBranchId } = await lookupIds('Dr. West Lead', 'West Branch');
  const { branchId: eastBranchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_WEST, westBranchId);
  const phone = nextPatientFor('Dr. East Lead');
  const eastId = await insertAppointment(phone, 'Dr. East Lead', 'East Branch', DAY_START_UTC, {
    patientName: 'Yusuf Karim',
  });

  const res = await request(createApp())
    .get(`/reception/branch/schedule?date=${DAY}&branch_id=${eastBranchId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.branch.id, westBranchId, 'the server must use claim.branch_ids, not the query');
  const ids = res.body.booked.map((b: { id: string }) => b.id);
  assert.ok(!ids.includes(eastId), 'another branch’s appointment must not leak');
});
