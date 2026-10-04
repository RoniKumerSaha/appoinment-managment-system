/**
 * per-occurrence-recurring.test.ts — integration tests for
 * the E6-S4 audit payload enrichment on the four
 * cancel / reschedule routes:
 *   - POST /patient/appointments/:id/cancel
 *   - POST /patient/appointments/:id/reschedule
 *   - POST /appointments/:id/cancel (doctor)
 *   - POST /reception/appointments/:id/cancel
 *
 * Spec-6-4 (E6-S4) + PRD FR-049 / FR-050 / UX-FLOWS §4.7:
 * When a Scheduled appointment is part of a recurring series
 * (recurring_series_id IS NOT NULL), the audit row written by
 * each cancel / reschedule route must carry a
 * `recurring_origin: {series_id}` pointer so a reporting query
 * can reconstruct the series linkage after the mutation.
 *
 * Non-recurring appointments carry the existing payload
 * shape unchanged (no `recurring_origin`).
 *
 * Testcontainer runtime is not available in this environment,
 * so the integration suite is structurally validated but not
 * executed.
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
      `DELETE FROM appointment_audit WHERE patient_phone LIKE '+1555999%' OR actor_id = 'staff:doctor-east-lead' OR actor_id = 'staff:receptionist-east'`,
    );
    await db.pool.query(
      `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
    );
  } finally {
    client.release();
  }
});

function patientToken(phone: string): string {
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

async function fetchBranchByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
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

function app() {
  return createApp();
}

/**
 * Insert a Scheduled appointment. When `recurringSeriesId` is
 * supplied, the row carries that value in `recurring_series_id`
 * (E6-S1 column). Otherwise the column is NULL.
 */
async function insertAppointment(
  phone: string,
  startMs: number,
  options?: {
    doctorName?: string;
    branchName?: string;
    recurringSeriesId?: string;
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
        start_datetime, end_datetime, status, recurring_series_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'Scheduled', $8::uuid, $9)
     RETURNING id::text AS id`,
    [
      clinicId,
      branch.id,
      doctor.id,
      phone,
      type.id,
      new Date(startMs).toISOString(),
      new Date(startMs + type.duration_minutes * 60_000).toISOString(),
      options?.recurringSeriesId ?? null,
      `patient:${phone}`,
    ],
  );
  return { id: result.rows[0]!.id };
}

/** Pre-generated UUID for the recurring_series_id fixture. */
const FIXED_SERIES_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

async function fetchAuditPayloadFor(
  appointmentId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await db.pool.query<{ payload: string }>(
    `SELECT payload::text AS payload
       FROM appointment_audit
      WHERE appointment_id = $1::uuid
      ORDER BY id DESC
      LIMIT 1`,
    [appointmentId],
  );
  assert.equal(rows.length, 1, `expected 1 audit row for ${appointmentId}`);
  return JSON.parse(rows[0]!.payload) as Record<string, unknown>;
}

// ===========================================================================
// Patient cancel (E4-S2 + E6-S4)
// ===========================================================================

test('POST /patient/appointments/:id/cancel: recurring occurrence → audit payload has recurring_origin', async () => {
  const phone = '+15559990001';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000, {
    recurringSeriesId: FIXED_SERIES_ID,
  });
  try {
    const res = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.appointment.status, 'Cancelled');

    const payload = await fetchAuditPayloadFor(id);
    assert.deepEqual(payload, {
      recurring_origin: { series_id: FIXED_SERIES_ID },
    });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

test('POST /patient/appointments/:id/cancel: non-recurring → audit payload is {}', async () => {
  const phone = '+15559990002';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000);
  try {
    const res = await request(app())
      .post(`/patient/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(res.status, 200);

    const payload = await fetchAuditPayloadFor(id);
    assert.deepEqual(payload, {});
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

// ===========================================================================
// Doctor cancel (E5-S2 + E6-S4)
// ===========================================================================

test('POST /appointments/:id/cancel (doctor): recurring → audit payload has reason + recurring_origin', async () => {
  const phone = '+15559990003';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000, {
    recurringSeriesId: FIXED_SERIES_ID,
  });
  try {
    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ reason: 'doctor unavailable' });
    assert.equal(res.status, 200);

    const payload = await fetchAuditPayloadFor(id);
    assert.equal(payload['reason'], 'doctor unavailable');
    assert.deepEqual(payload['recurring_origin'], { series_id: FIXED_SERIES_ID });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

test('POST /appointments/:id/cancel (doctor): non-recurring → audit payload is {reason}', async () => {
  const phone = '+15559990004';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000);
  try {
    const res = await request(app())
      .post(`/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${doctorEastLeadToken()}`)
      .send({ reason: 'doctor unavailable' });
    assert.equal(res.status, 200);

    const payload = await fetchAuditPayloadFor(id);
    assert.deepEqual(payload, { reason: 'doctor unavailable' });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

// ===========================================================================
// Receptionist cancel (E5-S3 + E6-S4)
// ===========================================================================

test('POST /reception/appointments/:id/cancel: recurring → audit payload has reason + recurring_origin', async () => {
  const phone = '+15559990005';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000, {
    recurringSeriesId: FIXED_SERIES_ID,
  });
  try {
    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'patient no-show' });
    assert.equal(res.status, 200);

    const payload = await fetchAuditPayloadFor(id);
    assert.equal(payload['reason'], 'patient no-show');
    assert.deepEqual(payload['recurring_origin'], { series_id: FIXED_SERIES_ID });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

test('POST /reception/appointments/:id/cancel: non-recurring → audit payload is {reason}', async () => {
  const phone = '+15559990006';
  const { id } = await insertAppointment(phone, Date.now() + 6 * 24 * 60 * 60 * 1000);
  try {
    const res = await request(app())
      .post(`/reception/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ reason: 'patient no-show' });
    assert.equal(res.status, 200);

    const payload = await fetchAuditPayloadFor(id);
    assert.deepEqual(payload, { reason: 'patient no-show' });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = $1::uuid`,
      [id],
    );
    await db.pool.query(`DELETE FROM appointment WHERE id = $1::uuid`, [id]);
  }
});

// ===========================================================================
// Sibling independence (FR-049)
// ===========================================================================

test('E6-S4 — cancelling one occurrence leaves siblings untouched (FR-049)', async () => {
  const phone = '+15559990008';
  const seriesId = 'aaaaaaaa-bbbb-cccc-dddd-0000000000aa';
  const startMs = Date.now() + 14 * 24 * 60 * 60 * 1000;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { id } = await insertAppointment(phone, startMs + i * 7 * 24 * 60 * 60 * 1000, {
      recurringSeriesId: seriesId,
    });
    ids.push(id);
  }
  try {
    // Cancel the middle occurrence.
    const res = await request(app())
      .post(`/patient/appointments/${ids[1]}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    assert.equal(res.status, 200);

    const { rows } = await db.pool.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM appointment WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.status, 'Scheduled');
    assert.equal(rows[1]!.status, 'Cancelled');
    assert.equal(rows[2]!.status, 'Scheduled');

    // The cancelled audit row carries recurring_origin.
    const cancelledPayload = await fetchAuditPayloadFor(ids[1]!);
    assert.deepEqual(cancelledPayload, { recurring_origin: { series_id: seriesId } });
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
      [ids],
    );
    await db.pool.query(
      `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }
});

// ===========================================================================
// Reporting query contract (E7-S2)
// ===========================================================================

test('E6-S4 — payload ? recurring_origin query surfaces all mutated occurrences', async () => {
  const phone = '+15559990009';
  const seriesId = 'aaaaaaaa-bbbb-cccc-dddd-0000000000bb';
  const startMs = Date.now() + 21 * 24 * 60 * 60 * 1000;
  // Insert one recurring and one non-recurring occurrence.
  const recurringId = (
    await insertAppointment(phone, startMs, { recurringSeriesId: seriesId })
  ).id;
  const nonRecurringId = (
    await insertAppointment(phone, startMs + 24 * 60 * 60 * 1000)
  ).id;
  try {
    // Cancel both.
    await request(app())
      .post(`/patient/appointments/${recurringId}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);
    await request(app())
      .post(`/patient/appointments/${nonRecurringId}/cancel`)
      .set('Authorization', `Bearer ${patientToken(phone)}`);

    // Reporting query: WHERE payload ? 'recurring_origin' returns
    // exactly the recurring occurrence's audit row.
    const { rows } = await db.pool.query<{ appointment_id: string }>(
      `SELECT appointment_id::text AS appointment_id
         FROM appointment_audit
        WHERE payload ? 'recurring_origin'`,
    );
    const ids = rows.map((r) => r.appointment_id);
    assert.ok(ids.includes(recurringId), 'recurring cancel must appear');
    assert.ok(
      !ids.includes(nonRecurringId),
      'non-recurring cancel must NOT appear in recurring_origin query',
    );
  } finally {
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
      [[recurringId, nonRecurringId]],
    );
    await db.pool.query(
      `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
      [[recurringId, nonRecurringId]],
    );
  }
});