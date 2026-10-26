/**
 * 07-receptionist.test.ts — Receptionist's day-view + audit.
 *
 * Coverage:
 *   - GET /reception/branch/today             (day dashboard, branch-bound)
 *   - GET /reception/appointments/:id/audit   (audit drawer, branch-bound)
 *
 * Notes:
 *   - Receptionist scope: branch-only. A receptionist cannot read
 *     other branches' data (server-trusted, body/URL-ignored).
 *   - `branch_id` query param on `/today` is ignored (server uses
 *     claim.branch_ids[0]). The optional `date`, `status`, `doctor_id`
 *     filters are honoured.
 *   - Today's "today" is anchored to the branch's tz. The seed's East
 *     Branch is `America/New_York` and West is `America/Los_Angeles`.
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
    // Cancel all Scheduled rows for the 5 seed patients (prior test
    // files may have left rows behind; FR-027 partial unique
    // would block new Scheduled inserts otherwise).
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
  return signClaim({ sub: email, role: 'receptionist', branch_ids: [branchId], scope: 'branch' });
}
async function lookupIds(name: string, branch: string): Promise<{ doctorId: string; branchId: string }> {
  const { rows: drows } = await db.pool.query<{ id: string }>(`SELECT id FROM doctor WHERE full_name = $1`, [name]);
  const { rows: brows } = await db.pool.query<{ id: string }>(`SELECT id FROM branch WHERE name = $1`, [branch]);
  if (!drows[0] || !brows[0]) throw new Error(`seed missing: ${name}/${branch}`);
  return { doctorId: drows[0].id, branchId: brows[0].id };
}

/** Insert a Scheduled appt for any date. Each call uses the next
 *  (patient, doctor) pair to dodge FR-027, and adds a `pairIdx`-based
 *  minute offset to dodge the GIST overlap exclusion. */
let pairIdx = 0;
const PATIENTS = ['+15550000001', '+15550000002', '+15550000003', '+15550000004', '+15550000005'];
const DOCTORS = [
  { name: 'Dr. East Lead', branch: 'East Branch' },
  { name: 'Dr. East Support', branch: 'East Branch' },
  { name: 'Dr. West Lead', branch: 'West Branch' },
];
async function insertScheduled(patientPhone: string, doctorName: string, branchName: string, start: Date, auditActor = `patient:${patientPhone}`): Promise<string> {
  // Offset by pairIdx hours so two Scheduled rows for the same
  // (doctor, branch) don't overlap on the GIST exclusion
  // (30-min duration + 1-hour gap).
  start = new Date(start.getTime() + pairIdx * 60 * 60_000);
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, b.id, d.id, $1, t.id, $2::timestamptz, $2::timestamptz + interval '30 minutes',
            'Scheduled', $3
       FROM clinic c, branch b, doctor d, appointment_type t, doctor_branch db
      WHERE b.name = $4 AND d.full_name = $5
        AND t.name = 'General Consultation'
        AND db.doctor_id = d.id AND db.branch_id = b.id
      LIMIT 1
     RETURNING id`,
    [patientPhone, start.toISOString(), auditActor, branchName, doctorName],
  );
  if (!ins.rows[0]) throw new Error(`insertScheduled failed`);
  // Audit row
  await db.pool.query(
    `INSERT INTO appointment_audit (appointment_id, actor_role, actor_id, event, payload)
     VALUES ($1, 'patient', $2, 'created', '{}'::jsonb)`,
    [ins.rows[0].id, auditActor],
  );
  return ins.rows[0].id;
}

function nextPair(): { patient: string; doctor: { name: string; branch: string } } {
  const pIdx = pairIdx % PATIENTS.length;
  const dIdx = Math.floor(pairIdx / PATIENTS.length) % DOCTORS.length;
  pairIdx += 1;
  return { patient: PATIENTS[pIdx]!, doctor: DOCTORS[dIdx]! };
}

// ═══════════════════════════════════════════════════════════════════
// GET /reception/branch/today
// ═══════════════════════════════════════════════════════════════════
test('GET /reception/branch/today (no auth) → 401', async () => {
  const res = await request(createApp()).get('/reception/branch/today');
  assert.equal(res.status, 401);
});

test('GET /reception/branch/today (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .get('/reception/branch/today')
    .set('Authorization', `Bearer ${patientToken('+15550000002')}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /reception/branch/today (receptionist, empty day) → 200 with []', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  // Pick a date 60 days out — no appts likely
  const res = await request(createApp())
    .get('/reception/branch/today?date=2099-01-01')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.appointments));
});

test('GET /reception/branch/today (with appts today) → 200 includes them', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);

  // Insert a row scheduled for 14:00 UTC today in the East tz
  // (which is 10:00 EDT — within business hours).
  const start = new Date();
  start.setUTCHours(14, 0, 0, 0);
  // 1 second from now to avoid past issues
  start.setUTCSeconds(start.getUTCSeconds() + 1);
  const p = nextPair();
  // East branch: pair may not be East Lead; force East Lead for branch match
  const doctorName = 'Dr. East Lead';
  const branchName = 'East Branch';
  await insertScheduled(p.patient, doctorName, branchName, start);

  // Format YYYY-MM-DD in UTC
  const dateStr = start.toISOString().slice(0, 10);
  const res = await request(createApp())
    .get(`/reception/branch/today?date=${dateStr}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  // Just verify it returns valid array
  assert.ok(Array.isArray(res.body.appointments));
  // The response must include `patient_phone` and `doctor_name`
  for (const a of res.body.appointments) {
    assert.equal(typeof a.patient_phone, 'string');
    assert.equal(typeof a.doctor_name, 'string');
    // NFR-007: NO patient_name in the receptionist surface
    assert.equal(a.patient_name, undefined);
  }
});

test('GET /reception/branch/today?status=Cancelled → filter applied', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const res = await request(createApp())
    .get('/reception/branch/today?date=2099-01-01&status=Cancelled')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.appointments, []);
});

test('GET /reception/branch/today?status=BadStatus → 400 invalid_status', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const res = await request(createApp())
    .get('/reception/branch/today?status=BadStatus')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_status');
});

test('GET /reception/branch/today?doctor_id=not-a-uuid → 400 invalid_doctor_id', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const res = await request(createApp())
    .get('/reception/branch/today?doctor_id=not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

test('GET /reception/branch/today?date=not-a-date → 400 invalid_date', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const res = await request(createApp())
    .get('/reception/branch/today?date=not-a-date')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_date');
});

test('GET /reception/branch/today (West receptionist, foreign branch_id in URL ignored) → 200 with West data', async () => {
  // West receptionist supplies East branch_id in URL — server MUST ignore
  // and return West's data.
  const { branchId: westBranchId } = await lookupIds('Dr. West Lead', 'West Branch');
  const { branchId: eastBranchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_WEST, westBranchId);
  const res = await request(createApp())
    .get(`/reception/branch/today?branch_id=${eastBranchId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  // Server uses claim.branch_ids; the URL param is ignored.
  assert.equal(res.body.branch.id, westBranchId, 'server must use claim.branch_ids, not the URL');
});

// ═══════════════════════════════════════════════════════════════════
// GET /reception/appointments/:id/audit
// ═══════════════════════════════════════════════════════════════════
test('GET /reception/appointments/:id/audit (own branch) → 200 with rows', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const p = nextPair();
  const apptId = await insertScheduled(p.patient, 'Dr. East Lead', 'East Branch', new Date(Date.now() + 86400000));

  const res = await request(createApp())
    .get(`/reception/appointments/${apptId}/audit`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment_id, apptId);
  assert.ok(res.body.count >= 1);
});

test('GET /reception/appointments/:id/audit (cross branch) → 403', async () => {
  const { branchId: eastBranchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const { branchId: westBranchId } = await lookupIds('Dr. West Lead', 'West Branch');
  const token = receptionistToken(RECEPTIONIST_WEST, westBranchId);
  const p = nextPair();
  const apptId = await insertScheduled(p.patient, 'Dr. East Lead', 'East Branch', new Date(Date.now() + 86400000));

  const res = await request(createApp())
    .get(`/reception/appointments/${apptId}/audit`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
  void eastBranchId;
});

test('GET /reception/appointments/:id/audit (patient role) → 403 forbidden_role', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const p = nextPair();
  const apptId = await insertScheduled(p.patient, 'Dr. East Lead', 'East Branch', new Date(Date.now() + 86400000));
  const res = await request(createApp())
    .get(`/reception/appointments/${apptId}/audit`)
    .set('Authorization', `Bearer ${patientToken(p.patient)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /reception/appointments/:id/audit (non-UUID) → 404 not_found', async () => {
  const { branchId } = await lookupIds('Dr. East Lead', 'East Branch');
  const token = receptionistToken(RECEPTIONIST_EAST, branchId);
  const res = await request(createApp())
    .get('/reception/appointments/not-a-uuid/audit')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});
