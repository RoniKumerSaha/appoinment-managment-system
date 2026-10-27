/**
 * 18-metrics-counters.test.ts — the named counters actually move.
 *
 * The counter registry existed, but only `otp.verification` was ever
 * incremented — the six booking / recurring counters were dead: they
 * always rendered 0 on `/metrics` no matter what the API did. These
 * tests pin the wiring so a future refactor can't silently unhook them.
 *
 * Coverage:
 *   - POST /bookings           → booking.attempt / success / conflict / failure
 *   - POST /recurring/confirm  → recurring.created / recurring.skipped
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signClaim } from '../src/auth/jwt.js';
import { __resetAuthConfigForTests } from '../src/auth/config.js';
import { createApp } from '../src/app.js';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { seedWith } from '../db/seeds/01_minimum.js';
import { reset, snapshot } from '../src/metrics/counters.js';

const VALID_SECRET = 'a'.repeat(48);
let db: TestDb;

const PATIENT_PHONE = '+15550000001';

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
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
});

beforeEach(() => {
  reset();
});

function patientToken(phone = PATIENT_PHONE): string {
  return signClaim({ sub: phone, role: 'patient', branch_ids: [], scope: 'self' });
}

function receptionistToken(branchId: string): string {
  return signClaim({
    sub: 'receptionist-east@clinic.local',
    role: 'receptionist',
    branch_ids: [branchId],
    scope: 'branch',
  });
}

async function counters(): Promise<Record<string, number>> {
  const res = await request(createApp())
    .get('/metrics')
    .set('Accept', 'application/json');
  assert.equal(res.status, 200);
  return res.body.counters as Record<string, number>;
}

interface SeedIds {
  doctorId: string;
  branchId: string;
  typeId: string;
}

async function lookupIds(): Promise<SeedIds> {
  const { rows: drows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM doctor WHERE full_name = 'Dr. East Lead'`,
  );
  const { rows: brows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = 'East Branch'`,
  );
  const { rows: trows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type WHERE name = 'General Consultation'`,
  );
  if (!drows[0] || !brows[0] || !trows[0]) throw new Error('seed missing');
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

/**
 * A future slot inside the east branch's Monday window.
 *
 * The branch is `America/New_York`, so 09:00 branch-local is 13:00 or
 * 14:00 UTC depending on DST. The offset is derived from the zone's
 * own rules via `Intl` rather than hard-coded, so the slot stays
 * in-hours across the DST boundary.
 */
function nextMondayLocal(startHour: number): Date {
  const now = new Date();
  const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
  // Anchor on midday UTC so the calendar day is stable while we
  // resolve the zone offset.
  const anchor = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilMonday,
      12,
      0,
      0,
    ),
  );
  const offsetMs = zoneOffsetMs(anchor, 'America/New_York');
  return new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate(),
      startHour,
      0,
      0,
    ) - offsetMs,
  );
}

/** The zone's UTC offset at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

function futureSlot(typeId: string, branchId: string): {
  start_datetime: string;
  end_datetime: string;
  slot_duration_minutes: number;
  branch_id: string;
  appointment_type_id: string;
} {
  const start = nextMondayLocal(9);
  const end = new Date(start.getTime() + 30 * 60_000);
  return {
    start_datetime: start.toISOString(),
    end_datetime: end.toISOString(),
    slot_duration_minutes: 30,
    branch_id: branchId,
    appointment_type_id: typeId,
  };
}

/** The same slot shape, offset by `hours` so two tests don't collide. */
function futureSlotOffset(
  typeId: string,
  branchId: string,
  hours: number,
): ReturnType<typeof futureSlot> {
  const base = futureSlot(typeId, branchId);
  const start = new Date(
    Date.parse(base.start_datetime) + hours * 3_600_000,
  );
  return {
    ...base,
    start_datetime: start.toISOString(),
    end_datetime: new Date(start.getTime() + 30 * 60_000).toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Booking counters
// ═══════════════════════════════════════════════════════════════════
test('a rejected booking body increments booking.attempt + booking.failure', async () => {
  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({ nonsense: true });
  assert.equal(res.status, 400);

  const c = await counters();
  assert.equal(c['booking.attempt'], 1);
  assert.equal(c['booking.failure'], 1);
  assert.equal(c['booking.success'], 0);
});

test('a successful booking increments booking.attempt + booking.success', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  const res = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctorId,
      patient_name: 'Metrics Patient',
      patient_phone: '+15550009999',
      ...futureSlot(typeId, branchId),
    });
  assert.equal(res.status, 201);

  const c = await counters();
  assert.equal(c['booking.attempt'], 1);
  assert.equal(c['booking.success'], 1);
  assert.equal(c['booking.failure'], 0);
});

test('a conflicting booking increments booking.conflict', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();
  // A distinct slot from the success-path test — the two bookings below
  // must collide with each other, not with the earlier test's row.
  const slot = futureSlotOffset(typeId, branchId, 2);

  const first = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctorId,
      patient_name: 'Metrics Patient',
      patient_phone: '+15550009998',
      ...slot,
    });
  assert.equal(first.status, 201);

  // Same doctor + same slot, different patient → the GIST exclusion
  // rejects it with a 409.
  const second = await request(createApp())
    .post('/bookings')
    .set('Authorization', `Bearer ${patientToken()}`)
    .send({
      doctor_id: doctorId,
      patient_name: 'Other Patient',
      patient_phone: '+15550009997',
      ...slot,
    });
  assert.equal(second.status, 409);

  const c = await counters();
  assert.equal(c['booking.attempt'], 2);
  assert.equal(c['booking.success'], 1);
  assert.equal(c['booking.conflict'], 1);
});

// ═══════════════════════════════════════════════════════════════════
// Recurring counters
// ═══════════════════════════════════════════════════════════════════
test('a recurring confirm increments recurring.created per occurrence', async () => {
  const { doctorId, branchId, typeId } = await lookupIds();

  // FR-018 caps the first occurrence at 30 days out, so the series must
  // start on a near-future Monday rather than a far-future date.
  const start = nextMondayLocal(14);
  const startDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(start);

  // The seeded clean patient — no prior Scheduled appointments, so
  // FR-027 (patient already has a future booking with this doctor) does
  // not skip the occurrences. The seeded default patient DOES have one.
  const phone = '+15550000002';

  const preview = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: phone,
      recurrence_kind: 'weekly',
      start_date: startDate,
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const previewId = preview.body.preview_id as string;

  const confirm = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${receptionistToken(branchId)}`)
    .send({ preview_id: previewId });
  assert.equal(confirm.status, 201, JSON.stringify(confirm.body));

  const c = await counters();
  const createdCount = (confirm.body.created as unknown[]).length;
  assert.ok(
    createdCount >= 1,
    `the series should create at least one occurrence; skipped=${JSON.stringify(confirm.body.skipped)}`,
  );
  assert.equal(c['recurring.created'], createdCount);
  assert.equal(
    c['recurring.skipped'],
    (confirm.body.skipped as unknown[]).length,
  );
});

// ═══════════════════════════════════════════════════════════════════
// The registry is the source of truth
// ═══════════════════════════════════════════════════════════════════
test('every named counter is exposed on /metrics', async () => {
  const c = await counters();
  for (const name of [
    'booking.attempt',
    'booking.success',
    'booking.conflict',
    'booking.failure',
    'otp.verification',
    'recurring.created',
    'recurring.skipped',
  ]) {
    assert.equal(typeof c[name], 'number', `${name} must be exposed`);
  }
});

test('the Prometheus exposition names the counters in snake_case', async () => {
  const res = await request(createApp()).get('/metrics');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('booking_attempt_total'), res.text.slice(0, 400));
  assert.ok(res.text.includes('recurring_created_total'), res.text.slice(0, 400));
});

// Keep the local snapshot helper referenced so the import is used.
test('the in-process snapshot matches what /metrics serves', async () => {
  const served = await counters();
  assert.deepEqual(snapshot(), served);
});
