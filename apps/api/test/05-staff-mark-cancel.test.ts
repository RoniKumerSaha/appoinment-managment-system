/**
 * 05-staff-mark-cancel.test.ts — Staff status mutations.
 *
 * Coverage:
 *   - POST /appointments/:id/mark-status     (doctor or receptionist, Completed | No-show)
 *   - POST /appointments/:id/cancel          (doctor, with required reason)
 *   - POST /reception/appointments/:id/cancel (receptionist, with required reason)
 *
 * Notes:
 *   - `mark-status` requires a *past* Scheduled row.
 *   - Cancel requires a Scheduled row (past or future).
 *   - FR-027 partial unique: only ONE Scheduled row per (patient_phone,
 *     doctor_id). We allocate 15 distinct (patient, doctor) pairs and
 *     consume them in order. Once a row is Cancelled / Completed /
 *     No-show, the pair is freed; the same pair is reused for the next
 *     terminal-state test.
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

// 15 distinct (patient, doctor) pairs. The counter increments after
// each `insertScheduled` so we never collide with FR-027.
//
// The seed's pre-existing Scheduled row for (+15550000001, East Lead)
// is cancelled in `before()` below, freeing the (0, 0) pair.
let pairIdx = 0;
const PAIRS: Array<{ patient: string; doctor: { name: string; branch: string; email: string } }> = [];
const PATIENTS = ['+15550000001', '+15550000002', '+15550000003', '+15550000004', '+15550000005'];
const DOCTORS = [
  { name: 'Dr. East Lead', branch: 'East Branch', email: 'dr.-east-lead@clinic.local' },
  { name: 'Dr. East Support', branch: 'East Branch', email: 'dr.-east-support@clinic.local' },
  { name: 'Dr. West Lead', branch: 'West Branch', email: 'dr.-west-lead@clinic.local' },
];
for (const p of PATIENTS) {
  for (const d of DOCTORS) {
    PAIRS.push({ patient: p, doctor: d });
  }
}

function nextPair(): { patient: string; doctor: { name: string; branch: string; email: string } } {
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
    // The seed pre-inserts a Scheduled row for (+15550000001, East Lead).
    // Cancel it (and its audit) so this (patient, doctor) pair is free
    // for tests in this file. We do this manually because the
    // appointment_audit FK + append-only trigger block
    // DELETE-from-appointment; an UPDATE to 'Cancelled' is enough to
    // free the FR-027 partial unique.
    await client.query(
      `UPDATE appointment SET status = 'Cancelled'
        WHERE patient_phone = '+15550000001'
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

// ── token helpers ──
function patientToken(phone: string): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
}
function doctorToken(email: string, doctorId: string, branchId: string): string {
  return signClaim({ sub: email, role: 'doctor', branch_ids: [branchId], scope: 'branch', doctor_id: doctorId });
}
function receptionistToken(email: string, branchId: string): string {
  return signClaim({ sub: email, role: 'receptionist', branch_ids: [branchId], scope: 'branch' });
}

// ── insert helpers ──
async function lookupDoctor(name: string, branch: string): Promise<{ doctorId: string; branchId: string; typeId: string }> {
  const { rows: drows } = await db.pool.query<{ id: string }>(`SELECT id FROM doctor WHERE full_name = $1`, [name]);
  const { rows: brows } = await db.pool.query<{ id: string }>(`SELECT id FROM branch WHERE name = $1`, [branch]);
  const { rows: trows } = await db.pool.query<{ id: string }>(`SELECT id FROM appointment_type WHERE name = 'General Consultation'`);
  if (!drows[0] || !brows[0] || !trows[0]) throw new Error(`seed missing: ${name}/${branch}`);
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

/** Insert a Scheduled appointment at `daysFromNow` (negative for past).
 *  The caller must pass a `dayOffsetHours` to keep the start time
 *  unique within the (doctor, branch) so the GIST overlap exclusion
 *  does not fire across tests. */
async function insertScheduled(
  patientPhone: string,
  doctorName: string,
  branchName: string,
  daysFromNow: number,
  hourOffset = 0,
): Promise<{ id: string; branchId: string; doctorId: string }> {
  const ins = await db.pool.query<{ id: string; branch_id: string; doctor_id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     SELECT c.id, b.id, d.id, $1, t.id,
            app_now() + ($2::int || ' days')::interval + ($3::int || ' hours')::interval,
            app_now() + ($2::int || ' days')::interval + ($3::int || ' hours')::interval + interval '30 minutes',
            'Scheduled', 'patient:' || $1
       FROM clinic c, branch b, doctor d, appointment_type t, doctor_branch db
      WHERE b.name = $4
        AND d.full_name = $5
        AND t.name = 'General Consultation'
        AND db.doctor_id = d.id AND db.branch_id = b.id
      LIMIT 1
     RETURNING id, branch_id, doctor_id`,
    [patientPhone, daysFromNow, hourOffset, branchName, doctorName],
  );
  if (!ins.rows[0]) throw new Error(`insertScheduled failed: ${patientPhone}/${doctorName}/${branchName}`);
  return { id: ins.rows[0].id, branchId: ins.rows[0].branch_id, doctorId: ins.rows[0].doctor_id };
}

/** Allocate a fresh (patient, doctor) pair and insert a Scheduled appt.
 *  `seq` is used as the hour offset to keep every (doctor, branch) row
 *  on a distinct time slot — the GIST overlap exclusion then has
 *  nothing to fight. */
async function insertUnique(daysFromNow: number, seq = 0): Promise<{
  id: string; branchId: string; doctorId: string;
  patient: string; doctorName: string; branchName: string; email: string;
}> {
  const p = nextPair();
  const a = await insertScheduled(p.patient, p.doctor.name, p.doctor.branch, daysFromNow, seq);
  return { ...a, patient: p.patient, doctorName: p.doctor.name, branchName: p.doctor.branch, email: p.doctor.email };
}

// ═══════════════════════════════════════════════════════════════════
// POST /appointments/:id/mark-status
// ═══════════════════════════════════════════════════════════════════
test('POST /appointments/:id/mark-status (doctor, past Scheduled) → 200 Completed', async () => {
  const a = await insertUnique(-1, 1);
  const token = doctorToken(a.email, a.doctorId, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/mark-status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment.status, 'Completed');

  const audit = await db.pool.query<{ event: string; actor_id: string }>(
    `SELECT event, actor_id FROM appointment_audit WHERE appointment_id = $1 AND event LIKE 'marked_%'`,
    [a.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.event, 'marked_completed');
  assert.equal(audit.rows[0]!.actor_id, `staff:${a.email}`);
});

test('POST /appointments/:id/mark-status (receptionist, past Scheduled) → 200 No-show', async () => {
  const a = await insertUnique(-2, 2);
  const token = receptionistToken(RECEPTIONIST_EAST, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/mark-status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'No-show' });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment.status, 'No-show');
});

test('POST /appointments/:id/mark-status (future Scheduled) → 422 appointment_in_future', async () => {
  const a = await insertUnique(3, 3);
  const token = doctorToken(a.email, a.doctorId, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/mark-status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'appointment_in_future');
});

test('POST /appointments/:id/mark-status (patient role) → 403 forbidden_role', async () => {
  const a = await insertUnique(-3, 4);
  const res = await request(createApp())
    .post(`/appointments/${a.id}/mark-status`)
    .set('Authorization', `Bearer ${patientToken(a.patient)}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('POST /appointments/:id/mark-status (already Cancelled) → 422 already_in_terminal_state', async () => {
  const a = await insertUnique(-4, 5);
  await db.pool.query(`UPDATE appointment SET status = 'Cancelled' WHERE id = $1`, [a.id]);
  const token = receptionistToken(RECEPTIONIST_EAST, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/mark-status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'already_in_terminal_state');
});

test('POST /appointments/:id/mark-status (invalid status) → 400 invalid_status', async () => {
  const a = await insertUnique(-5, 6);
  const token = receptionistToken(RECEPTIONIST_EAST, a.branchId);
  const res = await request(createApp())
    .post(`/appointments/${a.id}/mark-status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'Cancelled' }); // not a valid mark-status target
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_status');
});

test('POST /appointments/:id/mark-status (foreign doctor) → 403 outside_branch_scope', async () => {
  // East Branch appt, West Lead doctor tries to mark
  const a = await insertUnique(-6, 7);
  if (a.branchName !== 'East Branch') {
    // Force a known East appointment by using the East Lead directly
    const { doctorId, branchId } = await lookupDoctor('Dr. East Lead', 'East Branch');
    const { id } = await insertScheduled(a.patient, 'Dr. East Lead', 'East Branch', -6, 8);
    // we just overwrote the assignment; use these
    const { doctorId: westDoctorId, branchId: westBranchId } = await lookupDoctor('Dr. West Lead', 'West Branch');
    const token = doctorToken('dr.-west-lead@clinic.local', westDoctorId, westBranchId);
    const res = await request(createApp())
      .post(`/appointments/${id}/mark-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'Completed' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'outside_branch_scope');
    return;
  }
  const { doctorId: westDoctorId, branchId: westBranchId } = await lookupDoctor('Dr. West Lead', 'West Branch');
  const token = doctorToken('dr.-west-lead@clinic.local', westDoctorId, westBranchId);
  const res = await request(createApp())
    .post(`/appointments/${a.id}/mark-status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

test('POST /appointments/:id/mark-status (non-UUID id) → 404 not_found', async () => {
  const res = await request(createApp())
    .post('/appointments/not-a-uuid/mark-status')
    .set('Authorization', `Bearer ${signClaim({ sub: 'r', role: 'receptionist', branch_ids: ['x'], scope: 'branch' })}`)
    .send({ status: 'Completed' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

// ═══════════════════════════════════════════════════════════════════
// POST /appointments/:id/cancel (doctor)
// ═══════════════════════════════════════════════════════════════════
test('POST /appointments/:id/cancel (doctor) → 200 Cancelled, audit has reason', async () => {
  const a = await insertUnique(5, 8);
  const token = doctorToken(a.email, a.doctorId, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'Doctor unavailable' });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment.status, 'Cancelled');

  const audit = await db.pool.query<{ event: string; actor_id: string; payload: unknown }>(
    `SELECT event, actor_id, payload FROM appointment_audit
       WHERE appointment_id = $1 AND event = 'cancelled'`,
    [a.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.actor_id, `staff:${a.email}`);
  assert.equal((audit.rows[0]!.payload as { reason: string }).reason, 'Doctor unavailable');
});

test('POST /appointments/:id/cancel (no reason) → 400 reason_required', async () => {
  const a = await insertUnique(6, 9);
  const token = doctorToken(a.email, a.doctorId, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'reason_required');
});

test('POST /appointments/:id/cancel (whitespace reason) → 400 reason_required', async () => {
  const a = await insertUnique(7, 10);
  const token = doctorToken(a.email, a.doctorId, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'reason_required');
});

test('POST /appointments/:id/cancel (receptionist role) → 403 forbidden_role', async () => {
  const a = await insertUnique(8, 11);
  const token = receptionistToken(RECEPTIONIST_EAST, a.branchId);
  const res = await request(createApp())
    .post(`/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('POST /appointments/:id/cancel (already Cancelled) → 422 already_in_terminal_state', async () => {
  const a = await insertUnique(9, 12);
  await db.pool.query(`UPDATE appointment SET status = 'Cancelled' WHERE id = $1`, [a.id]);
  const token = doctorToken(a.email, a.doctorId, a.branchId);

  const res = await request(createApp())
    .post(`/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'redundant' });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'already_in_terminal_state');
});

// ═══════════════════════════════════════════════════════════════════
// POST /reception/appointments/:id/cancel (receptionist)
// ═══════════════════════════════════════════════════════════════════
test('POST /reception/appointments/:id/cancel (receptionist, own branch) → 200 Cancelled', async () => {
  const a = await insertUnique(10, 13);
  // Pick the right receptionist based on branch
  const { branchId: westBranchId } = await lookupDoctor('Dr. West Lead', 'West Branch');
  const token = receptionistToken(
    a.branchName === 'West Branch' ? RECEPTIONIST_WEST : RECEPTIONIST_EAST,
    a.branchName === 'West Branch' ? westBranchId : a.branchId,
  );

  const res = await request(createApp())
    .post(`/reception/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'Patient requested' });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.appointment.status, 'Cancelled');

  const audit = await db.pool.query<{ event: string; actor_role: string; payload: unknown }>(
    `SELECT event, actor_role, payload FROM appointment_audit
       WHERE appointment_id = $1 AND event = 'cancelled'`,
    [a.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.actor_role, 'receptionist');
  assert.equal((audit.rows[0]!.payload as { reason: string }).reason, 'Patient requested');
});

test('POST /reception/appointments/:id/cancel (receptionist, foreign branch) → 403 outside_branch_scope', async () => {
  const a = await insertUnique(11, 14);
  if (a.branchName !== 'East Branch') {
    // Swap to an East appointment
    const { id } = await insertScheduled(a.patient, 'Dr. East Lead', 'East Branch', 11, 15);
    const { branchId: westBranchId } = await lookupDoctor('Dr. West Lead', 'West Branch');
    const token = receptionistToken(RECEPTIONIST_WEST, westBranchId);
    const res = await request(createApp())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'cross-branch' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'outside_branch_scope');
    return;
  }
  const { branchId: westBranchId } = await lookupDoctor('Dr. West Lead', 'West Branch');
  const token = receptionistToken(RECEPTIONIST_WEST, westBranchId);
  const res = await request(createApp())
    .post(`/reception/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'cross-branch' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

test('POST /reception/appointments/:id/cancel (doctor role) → 403 forbidden_role', async () => {
  const a = await insertUnique(12, 15);
  const token = doctorToken(a.email, a.doctorId, a.branchId);

  const res = await request(createApp())
    .post(`/reception/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'wrong path' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('POST /reception/appointments/:id/cancel (no reason) → 400 reason_required', async () => {
  const a = await insertUnique(13, 16);
  const { branchId: westBranchId } = await lookupDoctor('Dr. West Lead', 'West Branch');
  const token = receptionistToken(
    a.branchName === 'West Branch' ? RECEPTIONIST_WEST : RECEPTIONIST_EAST,
    a.branchName === 'West Branch' ? westBranchId : a.branchId,
  );

  const res = await request(createApp())
    .post(`/reception/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'reason_required');
});

test('POST /reception/appointments/:id/cancel (reason too long) → 400 reason_too_long', async () => {
  const a = await insertUnique(14, 17);
  const { branchId: westBranchId } = await lookupDoctor('Dr. West Lead', 'West Branch');
  const token = receptionistToken(
    a.branchName === 'West Branch' ? RECEPTIONIST_WEST : RECEPTIONIST_EAST,
    a.branchName === 'West Branch' ? westBranchId : a.branchId,
  );

  const res = await request(createApp())
    .post(`/reception/appointments/${a.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'x'.repeat(501) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'reason_too_long');
});

test('POST /reception/appointments/:id/cancel (non-UUID id) → 404 not_found', async () => {
  const res = await request(createApp())
    .post('/reception/appointments/not-a-uuid/cancel')
    .set('Authorization', `Bearer ${signClaim({ sub: 'r', role: 'receptionist', branch_ids: ['x'], scope: 'branch' })}`)
    .send({ reason: 'test' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});
