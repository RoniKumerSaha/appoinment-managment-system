/**
 * patient-cancel.test.ts — integration tests for
 * POST /patient/appointments/:id/cancel.
 *
 * Spec-4-2 (E4-S2) + FR-033 + FR-050 + BR-038 + BR-053: the verified
 * patient cancels their own Scheduled appointment. The row transitions
 * to status='Cancelled' (never deleted per BR-038), the slot is
 * released (GIST exclusion is scoped on status='Scheduled', so a
 * Cancelled row no longer blocks the time range per BR-053), and an
 * audit row is written.
 *
 * Privacy (E7-S3): the appointment must match `claim.sub`. Any other
 * outcome (not found, wrong owner) returns 404 — NEVER 403 — so a
 * patient cannot enumerate other patients' appointments by id.
 *
 * Terminal states (Cancelled / Completed / No-Show) return a distinct
 * envelope `404 not_found_appointment_in_terminal_state` because it
 * is a separate code: the row exists, you own it, but the cancel
 * would be a no-op.
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
  // Best-effort cleanup of any test-prefixed appointments + audits.
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

// Helper: look up seeded entities by name so we can INSERT clean
// fixtures without re-running the seed's full SQL.
async function seededFixture(): Promise<{
  clinicId: string;
  branchId: string;
  doctorId: string;
  typeId: string;
  durationMinutes: number;
}> {
  const clinic = await db.pool.query<{ id: string }>(
    `SELECT id FROM clinic LIMIT 1`,
  );
  const branch = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = 'East Branch'`,
  );
  const doctor = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = 'Dr. East Lead'`,
  );
  const type = await db.pool.query<{ id: string; duration_minutes: number }>(
    `SELECT id, duration_minutes FROM appointment_type
       WHERE name = 'General Consultation'`,
  );
  return {
    clinicId: clinic.rows[0]!.id,
    branchId: branch.rows[0]!.id,
    doctorId: doctor.rows[0]!.id,
    typeId: type.rows[0]!.id,
    durationMinutes: type.rows[0]!.duration_minutes,
  };
}

async function insertAppointment(
  phone: string,
  status: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show',
  startMs: number,
): Promise<{ id: string; fixture: Awaited<ReturnType<typeof seededFixture>> }> {
  const fx = await seededFixture();
  const dur = fx.durationMinutes;
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9)
     RETURNING id::text AS id`,
    [
      fx.clinicId,
      fx.branchId,
      fx.doctorId,
      phone,
      fx.typeId,
      new Date(startMs).toISOString(),
      new Date(startMs + dur * 60_000).toISOString(),
      status,
      `patient:${phone}`,
    ],
  );
  return { id: result.rows[0]!.id, fixture: fx };
}

// ===========================================================================
// Auth
// ===========================================================================

test('POST /patient/appointments/:id/cancel: no auth → 401', async () => {
  // Random UUID — never collides with anything.
  const res = await request(app()).post(
    '/patient/appointments/00000000-0000-0000-0000-000000000000/cancel',
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /patient/appointments/:id/cancel: doctor JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/patient/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${doctorToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /patient/appointments/:id/cancel: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/patient/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /patient/appointments/:id/cancel: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/patient/appointments/00000000-0000-0000-0000-000000000000/cancel')
    .set('Authorization', `Bearer ${receptionistToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Privacy — same envelope for "doesn't exist" and "exists but not yours"
// ===========================================================================

test('POST /patient/appointments/:id/cancel: malformed UUID → 404 not_found', async () => {
  // E7-S3 privacy: a malformed id gets the same envelope as a valid
  // but-unknown id — never reveal whether the path itself is parseable.
  const res = await request(app())
    .post('/patient/appointments/not-a-uuid/cancel')
    .set('Authorization', `Bearer ${patientToken('+15559990001')}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('POST /patient/appointments/:id/cancel: unknown id → 404 not_found', async () => {
  const res = await request(app())
    .post(
      '/patient/appointments/00000000-0000-0000-0000-000000000000/cancel',
    )
    .set('Authorization', `Bearer ${patientToken('+15559990002')}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('POST /patient/appointments/:id/cancel: not your appointment → 404 not_found (privacy)', async () => {
  // Insert a future Scheduled appointment owned by patient +15559990003,
  // then try to cancel it AS a different patient (+15559990004). The
  // response is identical to "doesn't exist" — never 403, never a
  // distinct envelope (E7-S3: don't reveal that another patient's
  // appointment exists at this id).
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990003',
      'Scheduled',
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken('+15559990004')}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not_found' });

    // The row must still be Scheduled — wrong-owner cancel is a no-op.
    const row = await db.pool.query<{ status: string }>(
      `SELECT status FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(row.rows[0]!.status, 'Scheduled');
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE actor_id = $1`,
      [`patient:+15559990003`],
    );
  }
});

// ===========================================================================
// Terminal states → distinct envelope
// ===========================================================================

test('POST /patient/appointments/:id/cancel: already Cancelled → 404 not_found_appointment_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990005',
      'Cancelled',
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken('+15559990005')}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      error: 'not_found_appointment_in_terminal_state',
    });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE actor_id = $1`,
      [`patient:+15559990005`],
    );
  }
});

test('POST /patient/appointments/:id/cancel: Completed → 404 not_found_appointment_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990006',
      'Completed',
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken('+15559990006')}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      error: 'not_found_appointment_in_terminal_state',
    });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE actor_id = $1`,
      [`patient:+15559990006`],
    );
  }
});

test('POST /patient/appointments/:id/cancel: No-Show → 404 not_found_appointment_in_terminal_state', async () => {
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      '+15559990007',
      'No-Show',
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken('+15559990007')}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      error: 'not_found_appointment_in_terminal_state',
    });
  } finally {
    if (insertedIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE actor_id = $1`,
      [`patient:+15559990007`],
    );
  }
});

// ===========================================================================
// BR-053 / FR-050 — slot becomes available after cancel
// ===========================================================================

test('POST /patient/appointments/:id/cancel: cancelled slot reappears in /availability (BR-053 / FR-050)', async () => {
  // FR-050 / BR-053: cancelling a Scheduled appointment releases the
  // slot for re-booking. Mechanically, the GIST exclusion constraint
  // `appointment_no_overlap` is scoped on `status='Scheduled'` (per
  // 0008), so a `Cancelled` row no longer blocks the same time range.
  //
  // Strategy: pick a fresh patient + insert a single Scheduled row at
  // a unique start_datetime on a future day, count the slots the
  // engine returns on that day, cancel the row, re-count. The cancel
  // MUST have released the held time range, so the post-cancel slot
  // count MUST be strictly greater than the pre-cancel count (a
  // 30-min appointment blocks exactly one slot of the same duration).
  //
  // Using a fresh patient with no other Scheduled rows keeps the
  // before/after delta attributable solely to the cancelled row.
  const phone = '+15559990010';
  const insertedIds: string[] = [];
  try {
    const fx = await seededFixture();
    // today+2 lands inside the engine's 30-day window
    // ([today+1, today+30]).
    const targetMs = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const target = new Date(targetMs);
    // Probe date in UTC YYYY-MM-DD form (matches the engine's `date`
    // query param shape used in availability-route.test.ts).
    const dateStr = new Date(
      Date.UTC(
        target.getUTCFullYear(),
        target.getUTCMonth(),
        target.getUTCDate(),
      ),
    )
      .toISOString()
      .slice(0, 10);

    // Pre-cancel slot count for this fresh patient.
    const before = await request(app())
      .get('/availability')
      .query({
        doctor_id: fx.doctorId,
        branch_id: fx.branchId,
        appointment_type_id: fx.typeId,
        date: dateStr,
        patient_phone: phone,
      })
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(before.status, 200);
    const beforeSlots = before.body.slots as Array<{
      start_datetime: string;
      end_datetime: string;
    }>;
    const beforeCount = beforeSlots.length;

    // Pick a start_datetime inside the doctor's working hours on
    // targetMs. Use the very middle of the day in UTC (12:00 UTC) so
    // we land inside the local 09:00-17:00 window regardless of the
    // branch's UTC offset.
    const startMs = Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      target.getUTCDate(),
      12,
      0,
      0,
    );
    const { id } = await insertAppointment(phone, 'Scheduled', startMs);
    insertedIds.push(id);

    // Cancel it.
    const cancel = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(cancel.status, 200);

    // Post-cancel slot count for the same probe — strictly larger
    // because the cancelled 30-min row no longer blocks a slot.
    const after = await request(app())
      .get('/availability')
      .query({
        doctor_id: fx.doctorId,
        branch_id: fx.branchId,
        appointment_type_id: fx.typeId,
        date: dateStr,
        patient_phone: phone,
      })
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(after.status, 200);
    const afterSlots = after.body.slots as Array<{
      start_datetime: string;
      end_datetime: string;
    }>;
    assert.ok(
      afterSlots.length > beforeCount,
      `BR-053 / FR-050: post-cancel slot count (${afterSlots.length}) ` +
        `must exceed pre-cancel count (${beforeCount})`,
    );
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

test('POST /patient/appointments/:id/cancel: own Scheduled → 200 with status=Cancelled + audit row', async () => {
  // Insert a fresh Scheduled appointment owned by +15559990008, then
  // cancel it. The response carries status='Cancelled' and the audit
  // row carries actor_role='patient', actor_id='patient:<phone>',
  // event='cancelled', payload={} (FR-033 — no reason required).
  const phone = '+15559990008';
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      phone,
      'Scheduled',
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const res = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.id, id);
    assert.equal(res.body.appointment.status, 'Cancelled');
    assert.equal(typeof res.body.appointment.branch_id, 'string');
    assert.equal(typeof res.body.appointment.doctor_id, 'string');
    assert.equal(typeof res.body.appointment.appointment_type_id, 'string');
    assert.equal(typeof res.body.appointment.start_datetime, 'string');
    assert.equal(typeof res.body.appointment.end_datetime, 'string');

    // The DB row reflects status='Cancelled' (BR-038: row is updated,
    // never deleted).
    const row = await db.pool.query<{ status: string }>(
      `SELECT status FROM appointment WHERE id = $1::uuid`,
      [id],
    );
    assert.equal(row.rows[0]!.status, 'Cancelled');

    // The audit row matches FR-033: actor_role='patient',
    // actor_id='patient:<phone>', event='cancelled', payload={}.
    const audit = await db.pool.query<{
      actor_role: string;
      actor_id: string;
      event: string;
      payload: string;
    }>(
      `SELECT actor_role, actor_id, event, payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.actor_role, 'patient');
    assert.equal(audit.rows[0]!.actor_id, `patient:${phone}`);
    assert.equal(audit.rows[0]!.event, 'cancelled');
    assert.equal(audit.rows[0]!.payload, '{}');
  } finally {
    if (insertedIds.length > 0) {
      // Audit row carries a FK to appointment, so the appointment row
      // can only be deleted after the audit row is deleted.
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

test('POST /patient/appointments/:id/cancel: idempotent — second cancel → 404 not_found_appointment_in_terminal_state', async () => {
  // First cancel succeeds, second cancel sees status='Cancelled' and
  // returns the terminal-state envelope (not an error, not a duplicate
  // audit row). Atomicity: SELECT FOR UPDATE serializes both attempts.
  const phone = '+15559990009';
  const insertedIds: string[] = [];
  try {
    const { id } = await insertAppointment(
      phone,
      'Scheduled',
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    insertedIds.push(id);

    const first = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(first.status, 200);

    const second = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(second.status, 404);
    assert.deepEqual(second.body, {
      error: 'not_found_appointment_in_terminal_state',
    });

    // Exactly one audit row (the first cancel).
    const audit = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointment_audit
        WHERE appointment_id = $1::uuid`,
      [id],
    );
    assert.equal(audit.rows[0]!.n, '1');
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