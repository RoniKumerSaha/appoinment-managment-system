/**
 * no-tentative-holds-concurrent.test.ts — concurrent-booking integration
 * test for E7-S7.
 *
 * Per spec-7-7 (Architecture §2 "atomicity over clever UX" + UX-FLOWS §6.2):
 *   "The UI may display slots; it may not assume a slot is still
 *    bookable, and it may not hold tentative reservations outside the
 *    server's booking transaction."
 *
 * This file is the **dynamic half** of the E7-S7 pair. The static half
 * (`apps/web/test/no-tentative-holds.test.ts`) locks the invariant at the
 * source level; this file pins the **server contract** that ConflictModal
 * (E7-S4) consumes.
 *
 * The invariant under test:
 *   - When session A wins a slot and session B races for the same slot,
 *     B receives a 409 with the documented booking-conflict envelope and
 *     NO `appointment` row is created for B.
 *   - Only session A's transaction writes an `appointment_audit` row;
 *     the failure path must NOT write audit.
 *   - The `appointment` count for the contested slot ends at exactly 1
 *     (never 2). This proves the GIST exclusion + atomic txn are the
 *     race-safety net, NOT a client-side hold.
 *
 * Why a separate file:
 *   - The 0008 GIST exclusion is the source of truth, but its behavior
 *     is shaped by the booking transaction's error mapping. Asserting
 *     the *combined* contract here means a future regression in either
 *     the constraint or the route's error envelope fails this test.
 *   - `bookings.test.ts` exercises the deterministic "pre-inserted"
 *     path; this file exercises the **simultaneous-request** path that
 *     would be hit by two real users clicking "Book" within the same
 *     second.
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
  // Best-effort cleanup of any test-prefixed rows. `appointment_audit` is
  // append-only (trigger P0001 on DELETE) and the appointment FK from the
  // audit table is ON DELETE RESTRICT, so neither row can be removed. The
  // appointments are marked Cancelled instead, which keeps them off the
  // kanban / patient list and off every availability query.
  const client = await db.pool.connect();
  try {
    await client.query(
      `UPDATE appointment SET status = 'Cancelled'
        WHERE created_by IN ('patient:+15559990002', 'patient:+15559990003',
                             'patient:+15559990004', 'patient:+15559990005')
          AND status = 'Scheduled'`,
    );
  } finally {
    client.release();
  }
});

function adminApp() {
  return createApp();
}

function patientTokenA(): string {
  return signClaim({
    sub: '+15559990002',
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

function patientTokenB(): string {
  return signClaim({
    sub: '+15559990003',
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

/** The control-case test books under its own patient. It must not reuse
 *  patient A: whichever racer wins the test above leaves a Scheduled
 *  appointment for that phone, and FR-027 (one Scheduled appointment per
 *  patient+doctor) would then reject the control case with
 *  `patient_has_future_with_doctor` before the slot check ever runs. */
const CONTROL_PATIENT = '+15559990004';

/** The already-booked slot the control case races against. A third
 *  distinct phone: the pre-inserted row is Scheduled for the same
 *  doctor, so it must not collide with either racer under the FR-027
 *  partial unique index. */
const PREINSERTED_PATIENT = '+15559990005';

function controlPatientToken(): string {
  return signClaim({
    sub: CONTROL_PATIENT,
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

async function fetchEastBranchId(): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = 'East Branch'`,
  );
  if (rows.length === 0) throw new Error('seeded East Branch not found');
  return rows[0]!.id;
}

async function fetchEastLeadDoctorId(): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = 'Dr. East Lead'`,
  );
  if (rows.length === 0) throw new Error('seeded Dr. East Lead not found');
  return rows[0]!.id;
}

async function fetchGeneralConsultationTypeId(): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (rows.length === 0)
    throw new Error('seeded General Consultation appointment type not found');
  return rows[0]!.id;
}

function slotIso(date: string, hh: number, mm: number): string {
  return `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
}

/** Pick a date 5 days out so the seed's branch_weekly_hours covers the
 *  DOW (the seed inserts hours for all 7 days of the week per the spec
 *  for E0-S5; the date itself is a regular weekday to dodge the DOW=0
 *  edge case that the E3 booking code handles separately). */
function futureWeekdayIso(): string {
  const d = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  // Walk forward until the result is Mon-Fri (DOW 1..5 in UTC).
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// ===========================================================================
// Dynamic test — two concurrent POST /bookings for the same slot
// ===========================================================================
//
// E7-S7 invariant: there is no client-side hold. The server's 0008 GIST
// exclusion is the only race-safety net. Two sessions racing for the
// same slot must end with exactly 1 appointment row and exactly 1 audit
// row, and the loser must receive a 409 with the documented envelope
// that ConflictModal (E7-S4) consumes.

test('POST /bookings: concurrent racers — exactly one 201, one 409 slot_raced', async () => {
  const branchId = await fetchEastBranchId();
  const doctorId = await fetchEastLeadDoctorId();
  const typeId = await fetchGeneralConsultationTypeId();
  const date = futureWeekdayIso();
  // 14:00 UTC = 10:00 NY (EDT) — safely inside the seed's 9-17 NY
  // branch hours AND inside the doctor schedule. Earlier 9:00 UTC
  // fell outside_branch_hours because NY is UTC-4 in October.
  const startIso = slotIso(date, 14, 0);
  const endIso = slotIso(date, 14, 30);

  const body = {
    doctor_id: doctorId,
    branch_id: branchId,
    appointment_type_id: typeId,
    start_datetime: startIso,
    end_datetime: endIso,
    slot_duration_minutes: 30,
    patient_phone: '+15559990002',
    patient_name: 'Test Patient A',
  };
  const body2 = {
    ...body,
    patient_phone: '+15559990003',
    patient_name: 'Test Patient B',
  };

  // Fire both requests in parallel; Promise.all preserves the rejection
  // of either, and the GIST exclusion will cause one of them to 409.
  const [resA, resB] = await Promise.all([
    request(adminApp())
      .post('/bookings')
      .set('Authorization', `Bearer ${patientTokenA()}`)
      .set('content-type', 'application/json')
      .send(body),
    request(adminApp())
      .post('/bookings')
      .set('Authorization', `Bearer ${patientTokenB()}`)
      .set('content-type', 'application/json')
      .send(body2),
  ]);

  const statuses = [resA.status, resB.status].sort();
  // Exactly one 201 (winner) and one 409 (loser). The 409 must be a
  // documented booking-conflict code so ConflictModal can render it.
  assert.deepEqual(
    statuses,
    [201, 409],
    `expected one 201 + one 409, got A=${resA.status} B=${resB.status}; ` +
      `A.body=${JSON.stringify(resA.body)}; B.body=${JSON.stringify(resB.body)}`,
  );

  // Identify winner + loser.
  const winner = resA.status === 201 ? resA : resB;
  const loser = resA.status === 409 ? resA : resB;
  assert.equal(winner.status, 201);
  assert.equal(loser.status, 409);

  // Loser envelope must be one of the documented booking-conflict codes.
  // Per bookings.ts: 'slot_raced' is the GIST-race path. The exact code
  // is pinned so ConflictModal can branch on it.
  assert.equal(loser.body.error, 'slot_raced');
  assert.equal(loser.body.code, 'SLOT_RACED');
  assert.ok(
    Array.isArray(loser.body.can_do),
    'slot_raced envelope must carry can_do[] for ConflictModal',
  );
  assert.ok(
    loser.body.can_do.some(
      (c: { action: string }) => c.action === 'refresh_availability',
    ),
    'slot_raced envelope must list refresh_availability in can_do[]',
  );

  // DB invariant: exactly one appointment row for the contested slot.
  const apptCount = await db.pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM appointment
      WHERE doctor_id = $1
        AND start_datetime = $2::timestamptz`,
    [doctorId, startIso],
  );
  assert.equal(
    apptCount.rows[0]!.c,
    1,
    `expected exactly 1 appointment row for the contested slot, got ${apptCount.rows[0]!.c}`,
  );

  // DB invariant: exactly one audit row for the winning booking. The
  // failure path must not write audit (per bookings.ts comment: "Audit
  // row is INSERT-only — 0009's reject_audit_mutation trigger raises on
  // UPDATE/DELETE", and the audit is written in the same txn as the
  // appointment insert, so a failed insert must roll back the audit too).
  // The audit payload stores start_datetime as `2026-10-21T14:00:00.000Z`
  // (milliseconds appended); the test slotIso doesn't add `.000`. Match
  // by the appointment_id instead, which is in the row but not in the
  // payload — use the appointment row directly via a subquery.
  const winnerApptId = winner.body.appointment.id;
  const auditCount = await db.pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM appointment_audit
      WHERE event = 'created'
        AND appointment_id = $1`,
    [winnerApptId],
  );
  assert.equal(
    auditCount.rows[0]!.c,
    1,
    `expected exactly 1 'created' audit row for winner ${winnerApptId}, got ${auditCount.rows[0]!.c}`,
  );
});

test('POST /bookings: pre-inserted row → 409 slot_raced envelope (control case)', async () => {
  // The deterministic "slot already booked" path — pins the same envelope
  // shape without depending on timing. Mirrors bookings.test.ts:531 but
  // lives here so E7-S7 owns its full contract surface. Acts as the
  // "what the loser of a real race sees" control case.
  const branchId = await fetchEastBranchId();
  const doctorId = await fetchEastLeadDoctorId();
  const typeId = await fetchGeneralConsultationTypeId();
  // Different slot to avoid colliding with the concurrent test above.
  const date = futureWeekdayIso();
  // 16:00 UTC = 12:00 NY (EDT) — inside 9-17 NY hours.
  const startIso = slotIso(date, 16, 0);
  const endIso = slotIso(date, 16, 30);

  // Pre-insert the "winner" so the loser's slot check fails.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: clinicRows } = await client.query<{ id: string }>(
      `SELECT id FROM clinic LIMIT 1`,
    );
    await client.query(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
          start_datetime, end_datetime, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'Scheduled', $8)`,
      [
        clinicRows[0]!.id,
        branchId,
        doctorId,
        PREINSERTED_PATIENT,
        typeId,
        startIso,
        endIso,
        `patient:${PREINSERTED_PATIENT}`,
      ],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  try {
    const res = await request(adminApp())
      .post('/bookings')
      .set('Authorization', `Bearer ${controlPatientToken()}`)
      .set('content-type', 'application/json')
      .send({
        doctor_id: doctorId,
        branch_id: branchId,
        appointment_type_id: typeId,
        start_datetime: startIso,
        end_datetime: endIso,
        slot_duration_minutes: 30,
        patient_phone: CONTROL_PATIENT,
        patient_name: 'Control Patient',
      });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'slot_raced');
    assert.equal(res.body.code, 'SLOT_RACED');
  } finally {
    // Cleanup the pre-inserted row. `appointment_audit` is append-only
    // and the appointment FK from it is ON DELETE RESTRICT, so the row
    // is cancelled rather than deleted.
    const cleanup = await db.pool.connect();
    try {
      await cleanup.query(
        `UPDATE appointment SET status = 'Cancelled'
          WHERE patient_phone = $1
            AND start_datetime = $2::timestamptz`,
        [PREINSERTED_PATIENT, startIso],
      );
    } finally {
      cleanup.release();
    }
  }
});
