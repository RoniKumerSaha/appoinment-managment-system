/**
 * recurring-confirm.test.ts — integration tests for
 * POST /recurring/confirm.
 *
 * Spec-6-1 (E6-S1) + PRD F-11 + BR-047…053 + FR-047…050:
 * Atomic batch insert of a recurring series' valid occurrences.
 * Each created row carries the same `recurring_series_id`. One
 * audit row per created occurrence with
 * `event='recurring_created'` and
 * `payload={series_id, recurrence_kind, recurrence_interval_days,
 * occurrence_index}`.
 *
 * Per-occurrence independence (BR-052, FR-049): each created row
 * is an independent appointment thereafter — cancellable /
 * reschedulable via E4-S2 / E4-S3 individually.
 *
 * Race-safety (FR-050): per-occurrence re-validation inside the txn
 * catches slots that became taken between preview and confirm; the
 * row is skipped (partial success, FR-047).
 *
 * Auth: patient / admin → 403 forbidden_role. Anonymous → 401.
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
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE patient_phone LIKE '+1555999%' OR actor_id = 'staff:receptionist-east' OR actor_id = 'staff:doctor-east-support'`,
    );
    await db.pool.query(
      `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%' OR recurring_series_id IS NOT NULL`,
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

function doctorEastSupportToken(): string {
  return signClaim({
    sub: 'doctor-east-support',
    role: 'doctor',
    branch_ids: ['branch-east'],
    scope: 'branch',
    doctor_id: 'doctor-east-support',
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

async function fetchDoctorByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchBranchByName(name: string): Promise<{
  id: string;
  tz: string;
}> {
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

/** Returns YYYY-MM-DD `days` from now in UTC. */
function dateOffset(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Pre-book a Scheduled appointment at (doctor, branch, time) to
 *  seed a conflict for the confirm's in-txn re-validation. */
async function insertAppointment(
  phone: string,
  startMs: number,
  options?: { doctorName?: string; branchName?: string },
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
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'Scheduled', $8)
     RETURNING id::text AS id`,
    [
      clinicId,
      branch.id,
      doctor.id,
      phone,
      type.id,
      new Date(startMs).toISOString(),
      new Date(startMs + type.duration_minutes * 60_000).toISOString(),
      `patient:${phone}`,
    ],
  );
  return { id: result.rows[0]!.id };
}

/** Helper that does a preview and returns the preview_id. The
 *  preview's response carries the recurrence shape; the confirm
 *  route looks it up server-side. */
async function preview(
  token: string,
  args: {
    doctorName?: string;
    branchName?: string;
    typeName?: string;
    patientPhone: string;
    recurrenceKind: 'weekly' | 'every_two_weeks' | 'custom_days';
    recurrenceIntervalDays?: number;
    startOffsetDays: number;
    timeOfDay: string;
    durationMinutes: number;
    occurrences: number;
  },
): Promise<{ previewId: string; body: unknown }> {
  const doctor = await fetchDoctorByName(args.doctorName ?? 'Dr. East Support');
  const branch = await fetchBranchByName(args.branchName ?? 'East Branch');
  const type = await fetchTypeByName(args.typeName ?? 'General Consultation');
  const body: Record<string, unknown> = {
    doctor_id: doctor.id,
    branch_id: branch.id,
    appointment_type_id: type.id,
    patient_phone: args.patientPhone,
    recurrence_kind: args.recurrenceKind,
    start_date: dateOffset(args.startOffsetDays),
    time_of_day: args.timeOfDay,
    duration_minutes: args.durationMinutes,
    occurrences_or_until_date: args.occurrences,
  };
  if (args.recurrenceKind === 'custom_days') {
    body['recurrence_interval_days'] = args.recurrenceIntervalDays ?? 1;
  }
  const res = await request(app())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  return { previewId: res.body.preview_id, body: res.body };
}

// ===========================================================================
// Auth
// ===========================================================================

test('POST /recurring/confirm: no auth → 401', async () => {
  const res = await request(app())
    .post('/recurring/confirm')
    .send({ preview_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /recurring/confirm: patient JWT → 403 forbidden_role (FR-045)', async () => {
  const res = await request(app())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({ preview_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('POST /recurring/confirm: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ preview_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Body validation
// ===========================================================================

test('POST /recurring/confirm: malformed uuid → 404 preview_not_found', async () => {
  const res = await request(app())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
    .send({ preview_id: 'not-a-uuid' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'preview_not_found' });
});

test('POST /recurring/confirm: unknown preview_id → 404 preview_not_found', async () => {
  const res = await request(app())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
    .send({ preview_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'preview_not_found' });
});

test('POST /recurring/confirm: missing preview_id → 400 invalid_preview_id', async () => {
  const res = await request(app())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_preview_id' });
});

// ===========================================================================
// Happy path — all valid
// ===========================================================================

test('POST /recurring/confirm: doctor confirms a 4-occurrence weekly series → 201 with 4 created, 0 skipped', async () => {
  const insertedIds: string[] = [];
  try {
    const { previewId } = await preview(doctorEastSupportToken(), {
      patientPhone: '+15550000002',
      recurrenceKind: 'weekly',
      startOffsetDays: 1,
      timeOfDay: '09:00',
      durationMinutes: 30,
      occurrences: 4,
    });

    const res = await request(app())
      .post('/recurring/confirm')
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({ preview_id: previewId });

    assert.equal(res.status, 201);
    assert.equal(res.body.created.length, 4);
    assert.equal(res.body.skipped.length, 0);
    assert.equal(typeof res.body.series_id, 'string');
    assert.match(
      res.body.series_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // All created rows share the same recurring_series_id.
    for (const c of res.body.created) {
      insertedIds.push(c.id);
    }
    const { rows: apptRows } = await db.pool.query<{
      recurring_series_id: string;
    }>(
      `SELECT recurring_series_id::text AS recurring_series_id
         FROM appointment WHERE id = ANY($1::uuid[])`,
      [insertedIds],
    );
    assert.equal(apptRows.length, 4);
    const seriesIds = new Set(apptRows.map((r) => r.recurring_series_id));
    assert.equal(seriesIds.size, 1, 'all created rows must share the same series_id');
    assert.equal([...seriesIds][0], res.body.series_id);

    // One audit row per created occurrence.
    const { rows: auditRows } = await db.pool.query<{
      actor_role: string;
      actor_id: string;
      event: string;
    }>(
      `SELECT actor_role, actor_id, event
         FROM appointment_audit
        WHERE appointment_id = ANY($1::uuid[])`,
      [insertedIds],
    );
    assert.equal(
      auditRows.length,
      4,
      `expected 4 audit rows, got ${auditRows.length}`,
    );
    for (const a of auditRows) {
      assert.equal(a.actor_role, 'doctor');
      assert.equal(a.actor_id, 'staff:doctor-east-support');
      assert.equal(a.event, 'recurring_created');
    }
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
// Happy path — receptionist
// ===========================================================================

test('POST /recurring/confirm: receptionist confirms a 2-occurrence series → 201 with 2 created', async () => {
  const insertedIds: string[] = [];
  try {
    const { previewId } = await preview(receptionistEastToken(), {
      patientPhone: '+15550000002',
      recurrenceKind: 'weekly',
      startOffsetDays: 1,
      timeOfDay: '10:00',
      durationMinutes: 30,
      occurrences: 2,
    });

    const res = await request(app())
      .post('/recurring/confirm')
      .set('Authorization', `Bearer ${receptionistEastToken()}`)
      .send({ preview_id: previewId });

    assert.equal(res.status, 201);
    assert.equal(res.body.created.length, 2);
    for (const c of res.body.created) insertedIds.push(c.id);

    const { rows: auditRows } = await db.pool.query<{
      actor_role: string;
      actor_id: string;
    }>(
      `SELECT actor_role, actor_id
         FROM appointment_audit
        WHERE appointment_id = ANY($1::uuid[])`,
      [insertedIds],
    );
    assert.equal(auditRows.length, 2);
    for (const a of auditRows) {
      assert.equal(a.actor_role, 'receptionist');
      assert.equal(a.actor_id, 'staff:receptionist-east');
    }
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
// FR-050 — race-safety: a slot that became taken between preview and confirm
// ===========================================================================

test('POST /recurring/confirm: a slot taken between preview and confirm → skipped (FR-050 partial success)', async () => {
  const insertedConflictIds: string[] = [];
  const createdIds: string[] = [];
  try {
    const { previewId, body: previewBody } = await preview(
      doctorEastSupportToken(),
      {
        patientPhone: '+15550000002',
        recurrenceKind: 'weekly',
        startOffsetDays: 1,
        timeOfDay: '11:00',
        durationMinutes: 30,
        occurrences: 4,
      },
    );

    // Steal the 3rd occurrence (start_offset = 1 + 14 = 15 days).
    // The preview's will_create list tells us exactly which slot to
    // target.
    const target = (previewBody as { will_create: Array<{ index: number; start_datetime: string }> })
      .will_create.find((o) => o.index === 3);
    assert.ok(target !== undefined, 'preview must include occurrence #3');
    const startMs = Date.parse(target.start_datetime);
    const { id: conflictId } = await insertAppointment(
      '+15559990101',
      startMs,
      { doctorName: 'Dr. East Support' },
    );
    insertedConflictIds.push(conflictId);

    const res = await request(app())
      .post('/recurring/confirm')
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({ preview_id: previewId });

    assert.equal(res.status, 201);
    assert.equal(res.body.created.length, 3);
    assert.equal(res.body.skipped.length, 1);
    assert.equal(res.body.skipped[0].occurrence_index, 3);
    assert.ok(
      ['slot_raced', 'patient_has_future_with_doctor'].includes(
        res.body.skipped[0].reason,
      ),
      `expected slot_raced or patient_has_future_with_doctor; got ${res.body.skipped[0].reason}`,
    );

    for (const c of res.body.created) createdIds.push(c.id);
  } finally {
    for (const ids of [insertedConflictIds, createdIds]) {
      if (ids.length > 0) {
        await db.pool.query(
          `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
          [ids],
        );
        await db.pool.query(
          `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
          [ids],
        );
      }
    }
  }
});

// ===========================================================================
// Per-occurrence independence — cancel one occurrence leaves siblings untouched
// ===========================================================================

test('POST /recurring/confirm: cancelling one occurrence leaves siblings untouched (FR-049)', async () => {
  const createdIds: string[] = [];
  try {
    const { previewId } = await preview(doctorEastSupportToken(), {
      patientPhone: '+15550000002',
      recurrenceKind: 'weekly',
      startOffsetDays: 1,
      timeOfDay: '12:00',
      durationMinutes: 30,
      occurrences: 3,
    });
    const confirmRes = await request(app())
      .post('/recurring/confirm')
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({ preview_id: previewId });
    assert.equal(confirmRes.status, 201);
    for (const c of confirmRes.body.created) createdIds.push(c.id);

    // Cancel the 2nd occurrence via the doctor cancel route.
    const target = createdIds[1]!;
    const cancelRes = await request(app())
      .post(`/appointments/${target}/cancel`)
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({ reason: 'patient requested cancel' });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.appointment.status, 'Cancelled');

    // The other two occurrences remain Scheduled.
    const { rows: apptRows } = await db.pool.query<{
      id: string;
      status: string;
    }>(
      `SELECT id::text AS id, status FROM appointment WHERE id = ANY($1::uuid[]) ORDER BY start_datetime ASC`,
      [createdIds],
    );
    assert.equal(apptRows.length, 3);
    const targetIdx = apptRows.findIndex((r) => r.id === target);
    assert.equal(apptRows[targetIdx]!.status, 'Cancelled');
    for (let i = 0; i < apptRows.length; i++) {
      if (i === targetIdx) continue;
      assert.equal(
        apptRows[i]!.status,
        'Scheduled',
        `sibling occurrence #${i + 1} must remain Scheduled; got ${apptRows[i]!.status}`,
      );
    }
  } finally {
    if (createdIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [createdIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [createdIds],
      );
    }
  }
});

// ===========================================================================
// Audit payload — payload shape
// ===========================================================================

test('POST /recurring/confirm: audit payload carries series_id, recurrence_kind, recurrence_interval_days, occurrence_index', async () => {
  const createdIds: string[] = [];
  try {
    const { previewId } = await preview(doctorEastSupportToken(), {
      patientPhone: '+15550000002',
      recurrenceKind: 'weekly',
      startOffsetDays: 1,
      timeOfDay: '13:00',
      durationMinutes: 30,
      occurrences: 2,
    });
    const confirmRes = await request(app())
      .post('/recurring/confirm')
      .set('Authorization', `Bearer ${doctorEastSupportToken()}`)
      .send({ preview_id: previewId });
    assert.equal(confirmRes.status, 201);
    for (const c of confirmRes.body.created) createdIds.push(c.id);

    const { rows: auditRows } = await db.pool.query<{
      appointment_id: string;
      payload: string | object;
    }>(
      `SELECT appointment_id::text AS appointment_id, payload::text AS payload
         FROM appointment_audit
        WHERE appointment_id = ANY($1::uuid[]) AND event = 'recurring_created'`,
      [createdIds],
    );
    assert.equal(auditRows.length, 2);
    for (let i = 0; i < auditRows.length; i++) {
      const raw = auditRows[i]!.payload;
      const text: string =
        typeof raw === 'string' ? raw : JSON.stringify(raw);
      const payload: {
        recurrence_kind: string;
        recurrence_interval_days: number;
        series_id: string;
        occurrence_index: number;
      } = JSON.parse(text);
      assert.equal(payload.recurrence_kind, 'weekly');
      assert.equal(payload.recurrence_interval_days, 7);
      assert.equal(payload.series_id, confirmRes.body.series_id);
      assert.equal(typeof payload.occurrence_index, 'number');
      assert.ok(payload.occurrence_index >= 1);
    }
  } finally {
    if (createdIds.length > 0) {
      await db.pool.query(
        `DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`,
        [createdIds],
      );
      await db.pool.query(
        `DELETE FROM appointment WHERE id = ANY($1::uuid[])`,
        [createdIds],
      );
    }
  }
});