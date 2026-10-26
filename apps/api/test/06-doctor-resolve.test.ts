/**
 * 06-doctor-resolve.test.ts — Doctor's conflict-resolution surface.
 *
 * Coverage:
 *   - GET  /doctor/affected                      (kanban for a doctor)
 *   - POST /doctor/affected/:id/move             (move an affected appt)
 *   - GET  /doctor/appointments/:id/audit        (audit drawer)
 *
 * Notes:
 *   - "Affected" rows are appointments whose `start_datetime` falls
 *     OUTSIDE the current `branch_weekly_hours` for the appointment's
 *     branch. The seed sets Sunday as `is_closed = true` for both
 *     branches, so any appointment we insert on a Sunday at noon is
 *     automatically `closed_day`. That gives us deterministic test rows
 *     without needing to PATCH branch hours.
 *   - Doctor scope is doubly-bound (doctor_id + branch_id).
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

const DOCTOR_EAST_LEAD = {
  name: 'Dr. East Lead',
  branch: 'East Branch',
  email: 'dr.-east-lead@clinic.local',
};
const DOCTOR_EAST_SUPPORT = {
  name: 'Dr. East Support',
  branch: 'East Branch',
  email: 'dr.-east-support@clinic.local',
};

// (patient, doctor) pair rotation to dodge FR-027. Tests use distinct
// pairs; after a row is moved/cancelled, the pair is "free" again.
let pairIdx = 0;
const PAIRS: Array<{ patient: string; doctor: typeof DOCTOR_EAST_LEAD }> = [];
const PATIENTS = ['+15550000001', '+15550000002', '+15550000003', '+15550000004', '+15550000005'];
for (const p of PATIENTS) {
  for (const d of [DOCTOR_EAST_LEAD, DOCTOR_EAST_SUPPORT]) {
    PAIRS.push({ patient: p, doctor: d });
  }
}
function nextPair(): { patient: string; doctor: typeof DOCTOR_EAST_LEAD } {
  const p = PAIRS[pairIdx % PAIRS.length]!;
  pairIdx += 1;
  return p;
}

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
  db = await getTestDb();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    // Insert doctor_schedule rows for East Lead + East Support (all 7
    // days, 09-17 local) so the doctor_unavailable check doesn't trip
    // when we move an appt to a weekday.
    await client.query(
      `INSERT INTO doctor_schedule
         (doctor_id, branch_id, day_of_week, start_time, end_time, effective_from, created_by)
       SELECT d.id, b.id, dow, '09:00:00'::time, '17:00:00'::time, '2020-01-01'::date, 'staff:test-setup'
         FROM doctor d, branch b, generate_series(0, 6) AS dow
        WHERE b.name = 'East Branch'
        ON CONFLICT DO NOTHING`,
    );
    // Cancel ALL Scheduled rows for the 5 seed patients. Earlier test
    // files (01..05) left Scheduled rows behind (the audit-table
    // append-only trigger + FK from appointment_audit to appointment
    // prevent a clean DELETE). Cancelling frees the FR-027 partial
    // unique for the 5×3 = 15 (patient, doctor) pairs we use here.
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
async function lookupIds(name: string, branch: string): Promise<{ doctorId: string; branchId: string }> {
  const { rows: drows } = await db.pool.query<{ id: string }>(`SELECT id FROM doctor WHERE full_name = $1`, [name]);
  const { rows: brows } = await db.pool.query<{ id: string }>(`SELECT id FROM branch WHERE name = $1`, [branch]);
  if (!drows[0] || !brows[0]) throw new Error(`seed missing: ${name}/${branch}`);
  return { doctorId: drows[0].id, branchId: brows[0].id };
}
function doctorToken(email: string, doctorId: string, branchId: string): string {
  return signClaim({ sub: email, role: 'doctor', branch_ids: [branchId], scope: 'branch', doctor_id: doctorId });
}
function receptionistToken(branchId: string): string {
  return signClaim({ sub: 'r', role: 'receptionist', branch_ids: [branchId], scope: 'branch' });
}

/** Insert a future Scheduled appointment on a Sunday (branch is closed
 *  on Sundays per the seed) so it shows up in the doctor's affected
 *  queue. Uses an explicit future Sunday at 15:00 UTC. Also inserts a
 *  matching 'created' audit row so audit-read tests see ≥1 entry. */
async function insertSundayScheduled(
  patientPhone: string,
  doctorName: string,
  branchName: string,
  sundaysOut: number,
  hourOffset: number,
): Promise<{ id: string; branchId: string; doctorId: string }> {
  // Find the next Sunday
  const d = new Date();
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 0) break;
  }
  // Add `sundaysOut` weeks (0 = this Sunday, 1 = next, ...)
  d.setUTCDate(d.getUTCDate() + sundaysOut * 7);
  d.setUTCHours(15, 0, 0, 0);
  // Add hourOffset hours for uniqueness (GIST overlap exclusion)
  d.setUTCHours(d.getUTCHours() + hourOffset);

  const ins = await db.pool.query<{ id: string; branch_id: string; doctor_id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, b.id, d.id, $1, t.id, $2::timestamptz, $2::timestamptz + interval '30 minutes',
            'Scheduled', 'patient:' || $1
       FROM clinic c, branch b, doctor d, appointment_type t, doctor_branch db
      WHERE b.name = $3
        AND d.full_name = $4
        AND t.name = 'General Consultation'
        AND db.doctor_id = d.id AND db.branch_id = b.id
      LIMIT 1
     RETURNING id, branch_id, doctor_id`,
    [patientPhone, d.toISOString(), branchName, doctorName],
  );
  if (!ins.rows[0]) throw new Error(`insertSundayScheduled failed: ${patientPhone}/${doctorName}/${branchName}`);

  // Mirror the route's audit INSERT so audit-read tests have a row to find.
  await db.pool.query(
    `INSERT INTO appointment_audit (appointment_id, actor_role, actor_id, event, payload)
     VALUES ($1, 'patient', $2, 'created', '{}'::jsonb)`,
    [ins.rows[0].id, `patient:${patientPhone}`],
  );

  return { id: ins.rows[0].id, branchId: ins.rows[0].branch_id, doctorId: ins.rows[0].doctor_id };
}

// ═══════════════════════════════════════════════════════════════════
// GET /doctor/affected
// ═══════════════════════════════════════════════════════════════════
test('GET /doctor/affected (no auth) → 401', async () => {
  const res = await request(createApp()).get('/doctor/affected');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthenticated');
});

test('GET /doctor/affected (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${patientToken('+15550000002')}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /doctor/affected (doctor, no Sunday rows) → 200 count=0', async () => {
  const { doctorId, branchId } = await lookupIds(DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch);
  const token = doctorToken(DOCTOR_EAST_LEAD.email, doctorId, branchId);
  const res = await request(createApp())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.count, 'number');
  assert.equal(res.body.count, 0, 'no Sunday rows inserted yet');
});

test('GET /doctor/affected (doctor, with Sunday row) → 200 returns it as closed_day', async () => {
  // Use a unique pair for this test
  const p = nextPair();
  const { doctorId, branchId } = await lookupIds(p.doctor.name, p.doctor.branch);
  await insertSundayScheduled(p.patient, p.doctor.name, p.doctor.branch, 0, 0);
  const token = doctorToken(p.doctor.email, doctorId, branchId);

  const res = await request(createApp())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.count >= 1);
  assert.ok(res.body.appointments.length >= 1);
  for (const a of res.body.appointments) {
    assert.equal(a.doctor_id, doctorId, 'rows must belong to the calling doctor');
    assert.equal(a.branch_id, branchId, 'rows must be in the doctor\'s branch');
    assert.equal(a.reason, 'closed_day', 'Sunday row must be tagged closed_day');
  }
});

test('GET /doctor/affected (cross-doctor) → only own rows', async () => {
  // East Support has no Sunday rows; expect count=0
  const { doctorId, branchId } = await lookupIds(DOCTOR_EAST_SUPPORT.name, DOCTOR_EAST_SUPPORT.branch);
  const token = doctorToken(DOCTOR_EAST_SUPPORT.email, doctorId, branchId);
  const res = await request(createApp())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0, 'East Support has no affected rows');
});

test('GET /doctor/affected?branch_id=other → 403 outside_branch_scope', async () => {
  const { doctorId, branchId } = await lookupIds(DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch);
  // West Branch is NOT in the doctor's branch_ids
  const { branchId: westBranchId } = await lookupIds('Dr. West Lead', 'West Branch');
  const token = doctorToken(DOCTOR_EAST_LEAD.email, doctorId, branchId);
  const res = await request(createApp())
    .get(`/doctor/affected?branch_id=${westBranchId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

test('GET /doctor/affected?branch_id=not-a-uuid → 400 invalid_branch_id', async () => {
  const { doctorId, branchId } = await lookupIds(DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch);
  const token = doctorToken(DOCTOR_EAST_LEAD.email, doctorId, branchId);
  const res = await request(createApp())
    .get('/doctor/affected?branch_id=not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /doctor/affected?date=not-a-date → 400 invalid_date', async () => {
  const { doctorId, branchId } = await lookupIds(DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch);
  const token = doctorToken(DOCTOR_EAST_LEAD.email, doctorId, branchId);
  const res = await request(createApp())
    .get('/doctor/affected?date=not-a-date')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_date');
});

// ═══════════════════════════════════════════════════════════════════
// POST /doctor/affected/:id/move
// ═══════════════════════════════════════════════════════════════════
test('POST /doctor/affected/:id/move (doctor, future) → 200 with new slot', async () => {
  const p = nextPair();
  const { doctorId, branchId } = await lookupIds(p.doctor.name, p.doctor.branch);
  const appt = await insertSundayScheduled(p.patient, p.doctor.name, p.doctor.branch, 0, 1);
  const token = doctorToken(p.doctor.email, doctorId, branchId);

  // Find next Tuesday
  const tue = new Date();
  for (let i = 0; i < 8; i++) {
    tue.setUTCDate(tue.getUTCDate() + 1);
    if (tue.getUTCDay() === 2) break;
  }
  tue.setUTCHours(14, 0, 0, 0);
  const tueEnd = new Date(tue.getTime() + 30 * 60 * 1000);

  const res = await request(createApp())
    .post(`/doctor/affected/${appt.id}/move`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      new_branch_id: branchId,
      new_start_datetime: tue.toISOString(),
      new_end_datetime: tueEnd.toISOString(),
    });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment.status, 'Scheduled');

  // Audit row
  const audit = await db.pool.query<{ event: string; payload: unknown }>(
    `SELECT event, payload FROM appointment_audit WHERE appointment_id = $1 AND event = 'moved_by_doctor'`,
    [appt.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal((audit.rows[0]!.payload as { reason: string }).reason, 'conflict_resolution');
});

test('POST /doctor/affected/:id/move (no-op: same slot) → 422 no_op_move', async () => {
  const p = nextPair();
  const { doctorId, branchId } = await lookupIds(p.doctor.name, p.doctor.branch);
  const appt = await insertSundayScheduled(p.patient, p.doctor.name, p.doctor.branch, 0, 2);
  const token = doctorToken(p.doctor.email, doctorId, branchId);

  // Look up the appt's current start/end from DB
  const { rows } = await db.pool.query<{ start_datetime: Date; end_datetime: Date }>(
    `SELECT start_datetime, end_datetime FROM appointment WHERE id = $1`, [appt.id],
  );
  const sd = rows[0]!.start_datetime.toISOString();
  const ed = rows[0]!.end_datetime.toISOString();

  const res = await request(createApp())
    .post(`/doctor/affected/${appt.id}/move`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      new_branch_id: branchId,
      new_start_datetime: sd,
      new_end_datetime: ed,
    });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'no_op_move');
});

test('POST /doctor/affected/:id/move (receptionist) → 403 forbidden_role', async () => {
  const p = nextPair();
  const appt = await insertSundayScheduled(p.patient, p.doctor.name, p.doctor.branch, 0, 3);
  const token = receptionistToken(appt.branchId);
  const res = await request(createApp())
    .post(`/doctor/affected/${appt.id}/move`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      new_branch_id: appt.branchId,
      new_start_datetime: '2026-12-15T14:00:00Z',
      new_end_datetime: '2026-12-15T14:30:00Z',
    });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('POST /doctor/affected/:id/move (foreign doctor) → 403 outside_branch_scope', async () => {
  // Insert an East Lead appt
  const p1 = nextPair();
  const appt = await insertSundayScheduled(p1.patient, DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch, 0, 4);
  // East Support doctor tries to move
  const { doctorId: otherDocId, branchId: otherBranchId } = await lookupIds(DOCTOR_EAST_SUPPORT.name, DOCTOR_EAST_SUPPORT.branch);
  const token = doctorToken(DOCTOR_EAST_SUPPORT.email, otherDocId, otherBranchId);

  const res = await request(createApp())
    .post(`/doctor/affected/${appt.id}/move`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      new_branch_id: otherBranchId,
      new_start_datetime: '2026-12-15T14:00:00Z',
      new_end_datetime: '2026-12-15T14:30:00Z',
    });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

test('POST /doctor/affected/:id/move (unknown new_doctor_id body field) → 400 unknown_field', async () => {
  const p = nextPair();
  const { doctorId, branchId } = await lookupIds(p.doctor.name, p.doctor.branch);
  const appt = await insertSundayScheduled(p.patient, p.doctor.name, p.doctor.branch, 0, 5);
  const token = doctorToken(p.doctor.email, doctorId, branchId);

  const res = await request(createApp())
    .post(`/doctor/affected/${appt.id}/move`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      new_branch_id: branchId,
      new_start_datetime: '2026-12-15T14:00:00Z',
      new_end_datetime: '2026-12-15T14:30:00Z',
      new_doctor_id: '00000000-0000-0000-0000-000000000000', // FORBIDDEN
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('POST /doctor/affected/:id/move (past source) → 422 appointment_in_past', async () => {
  // Use a unique pair so FR-027 doesn't fire on the INSERT.
  const p = nextPair();
  const { doctorId, branchId } = await lookupIds(p.doctor.name, p.doctor.branch);
  // 1 hour ago, in the past
  const start = new Date(Date.now() - 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  // Add a small ms offset to avoid colliding with a prior test's row
  start.setUTCSeconds(start.getUTCSeconds() + pairIdx);
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, $1::uuid, $2::uuid, $3, t.id,
            $4::timestamptz, $4::timestamptz + interval '30 minutes',
            'Scheduled', 'patient:' || $3
       FROM clinic c, appointment_type t WHERE t.name = 'General Consultation'
     RETURNING id`,
    [branchId, doctorId, p.patient, start.toISOString()],
  );
  const apptId = ins.rows[0]!.id;
  const token = doctorToken(p.doctor.email, doctorId, branchId);

  const res = await request(createApp())
    .post(`/doctor/affected/${apptId}/move`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      new_branch_id: branchId,
      new_start_datetime: '2026-12-15T14:00:00Z',
      new_end_datetime: '2026-12-15T14:30:00Z',
    });
  assert.equal(res.status, 422, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'appointment_in_past');
});

test('POST /doctor/affected/:id/move (non-UUID id) → 404 not_found', async () => {
  const { doctorId, branchId } = await lookupIds(DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch);
  const token = doctorToken(DOCTOR_EAST_LEAD.email, doctorId, branchId);
  const res = await request(createApp())
    .post('/doctor/affected/not-a-uuid/move')
    .set('Authorization', `Bearer ${token}`)
    .send({
      new_branch_id: branchId,
      new_start_datetime: '2026-12-15T14:00:00Z',
      new_end_datetime: '2026-12-15T14:30:00Z',
    });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

// ═══════════════════════════════════════════════════════════════════
// GET /doctor/appointments/:id/audit
// ═══════════════════════════════════════════════════════════════════
test('GET /doctor/appointments/:id/audit (own appt) → 200 with audit rows', async () => {
  const p = nextPair();
  const { doctorId, branchId } = await lookupIds(p.doctor.name, p.doctor.branch);
  const appt = await insertSundayScheduled(p.patient, p.doctor.name, p.doctor.branch, 1, 0);
  const token = doctorToken(p.doctor.email, doctorId, branchId);

  const res = await request(createApp())
    .get(`/doctor/appointments/${appt.id}/audit`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment_id, appt.id);
  assert.ok(res.body.count >= 1);
  assert.ok(res.body.audit.length >= 1);
  assert.equal(res.body.audit[0]!.event, 'created');
});

test('GET /doctor/appointments/:id/audit (foreign doctor) → 403', async () => {
  // East Lead appt, East Support doctor reads audit
  const p = nextPair();
  const appt = await insertSundayScheduled(p.patient, DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch, 1, 1);
  const { doctorId: supportDocId, branchId } = await lookupIds(DOCTOR_EAST_SUPPORT.name, DOCTOR_EAST_SUPPORT.branch);
  const token = doctorToken(DOCTOR_EAST_SUPPORT.email, supportDocId, branchId);

  const res = await request(createApp())
    .get(`/doctor/appointments/${appt.id}/audit`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

test('GET /doctor/appointments/:id/audit (receptionist) → 403 forbidden_role', async () => {
  const p = nextPair();
  const appt = await insertSundayScheduled(p.patient, p.doctor.name, p.doctor.branch, 1, 2);
  const token = receptionistToken(appt.branchId);
  const res = await request(createApp())
    .get(`/doctor/appointments/${appt.id}/audit`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('GET /doctor/appointments/:id/audit (non-UUID) → 404 not_found', async () => {
  const { doctorId, branchId } = await lookupIds(DOCTOR_EAST_LEAD.name, DOCTOR_EAST_LEAD.branch);
  const token = doctorToken(DOCTOR_EAST_LEAD.email, doctorId, branchId);
  const res = await request(createApp())
    .get('/doctor/appointments/not-a-uuid/audit')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});
