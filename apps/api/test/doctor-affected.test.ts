/**
 * doctor-affected.test.ts — integration tests for
 * GET /doctor/affected.
 *
 * Spec-6-3 (E6-S3) + PRD F-09 + epics-and-stories E6-S3:
 * Read-only list of the doctor's Scheduled appointments that
 * fall outside the current `branch_weekly_hours` for the
 * appointment's branch. The "Resolve" badge on the doctor
 * dashboard reads this list and links each row to E6-S2's
 * POST /doctor/affected/:id/move.
 *
 * Auth: patient / receptionist / admin → 403 forbidden_role.
 * Anonymous → 401.
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
    // Clean up: test fixtures we inserted (start_datetime > now(),
    // patient_phone like +1555999%) plus any prior leftovers.
    await db.pool.query(
      `DELETE FROM appointment_audit WHERE patient_phone LIKE '+1555999%' OR actor_id = 'staff:doctor-east-lead'`,
    );
    await db.pool.query(
      `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
    );
  } finally {
    client.release();
  }
});

function patientToken(phone = '+15550000001'): string {
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

function app() {
  return createApp();
}

/**
 * Insert a Scheduled appointment at (doctor, branch, time) to
 * seed a row that will or will not be "outside hours" per the
 * branch's `branch_weekly_hours`.
 */
async function insertAppointment(
  phone: string,
  startMs: number,
  options?: {
    doctorName?: string;
    branchName?: string;
    status?: 'Scheduled' | 'Cancelled' | 'Completed' | 'No-Show';
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
        start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9)
     RETURNING id::text AS id`,
    [
      clinicId,
      branch.id,
      doctor.id,
      phone,
      type.id,
      new Date(startMs).toISOString(),
      new Date(startMs + type.duration_minutes * 60_000).toISOString(),
      options?.status ?? 'Scheduled',
      `patient:${phone}`,
    ],
  );
  return { id: result.rows[0]!.id };
}

// ===========================================================================
// Auth
// ===========================================================================

test('GET /doctor/affected: no auth → 401', async () => {
  const res = await request(app()).get('/doctor/affected');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /doctor/affected: patient JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /doctor/affected: admin JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /doctor/affected: receptionist JWT → 403 forbidden_role', async () => {
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${receptionistEastToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// Body validation (query params)
// ===========================================================================

test('GET /doctor/affected: invalid branch_id → 400 invalid_branch_id', async () => {
  const res = await request(app())
    .get('/doctor/affected')
    .query({ branch_id: 'not-a-uuid' })
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_id' });
});

test('GET /doctor/affected: invalid date → 400 invalid_date', async () => {
  const res = await request(app())
    .get('/doctor/affected')
    .query({ date: '2026-13-01' })
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  // Either: 400 invalid_date (regex caught it) or 400 invalid_date
  // (Date parse caught it).
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_date');
});

test('GET /doctor/affected: date missing day → 400 invalid_date', async () => {
  const res = await request(app())
    .get('/doctor/affected')
    .query({ date: '2026-10' })
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_date' });
});

// ===========================================================================
// Privacy / scope
// ===========================================================================

test('GET /doctor/affected: branch_id not in claim.branch_ids → 403 outside_branch_scope', async () => {
  // The doctor is at branch-east. branch-west is not in claim.
  // Fetch branch-west's real id to make the test deterministic
  // even if the seed renames it.
  const west = await fetchBranchByName('West Branch');
  const res = await request(app())
    .get('/doctor/affected')
    .query({ branch_id: west.id })
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'outside_branch_scope' });
});

test('GET /doctor/affected: empty claim.branch_ids → 403 outside_branch_scope', async () => {
  // Edge case — defense-in-depth. The middleware should reject
  // empty branch_ids at the auth layer, but the route guards it.
  const token = signClaim({
    sub: 'doctor-edge',
    role: 'doctor',
    branch_ids: [],
    scope: 'branch',
    doctor_id: 'doctor-edge',
  });
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'outside_branch_scope' });
});

// ===========================================================================
// Happy paths / scoping
// ===========================================================================

test('GET /doctor/affected: zero outside-hours rows → 200 count=0', async () => {
  // Clean any prior test fixtures.
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.appointments, []);
});

test('GET /doctor/affected: one Sunday appointment → 200, reason=closed_day', async () => {
  // Clean any prior fixtures first to keep the count deterministic.
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  // Find the next Sunday at 09:00 in America/New_York.
  const sunday = nextDayOfWeekAt(0, 9, 0); // Sunday 09:00 local
  const sundayMs = sunday.getTime();
  await insertAppointment('+15559990001', sundayMs, {
    doctorName: 'Dr. East Lead',
  });
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.appointments.length, 1);
  assert.equal(res.body.appointments[0].reason, 'closed_day');
  assert.equal(res.body.appointments[0].doctor_id, 'doctor-east-lead');
  assert.equal(res.body.appointments[0].patient_phone, '+15559990001');
});

test('GET /doctor/affected: one before-open appt at 07:00 → 200, reason=before_open_or_after_close', async () => {
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  // Find a future weekday at 07:00 in America/New_York (before 09:00 open).
  const early = futureWeekdayAt(7, 0);
  const earlyMs = early.getTime();
  await insertAppointment('+15559990002', earlyMs, {
    doctorName: 'Dr. East Lead',
  });
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.appointments[0].reason, 'before_open_or_after_close');
});

test('GET /doctor/affected: another doctor\'s row is excluded (doctor scope)', async () => {
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  // Insert a Sunday appt for doctor-east-support (NOT for lead).
  const sunday = nextDayOfWeekAt(0, 9, 0);
  await insertAppointment('+15559990003', sunday.getTime(), {
    doctorName: 'Dr. East Support',
  });
  // doctor-east-lead should see an empty queue.
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.appointments.length, 0);
});

test('GET /doctor/affected: Cancelled row is excluded (status gate)', async () => {
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  const sunday = nextDayOfWeekAt(0, 9, 0);
  await insertAppointment('+15559990004', sunday.getTime(), {
    doctorName: 'Dr. East Lead',
    status: 'Cancelled',
  });
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});

test('GET /doctor/affected: in-hours row is excluded (happy schedule)', async () => {
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  // Future weekday at 10:00 (well inside 09:00–17:00 Mon-Sat).
  const inHours = futureWeekdayAt(10, 0);
  await insertAppointment('+15559990005', inHours.getTime(), {
    doctorName: 'Dr. East Lead',
  });
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
});

test('GET /doctor/affected: ?branch_id=<own> echoes the branch', async () => {
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  const east = await fetchBranchByName('East Branch');
  const res = await request(app())
    .get('/doctor/affected')
    .query({ branch_id: east.id })
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.branch_id, east.id);
});

test('GET /doctor/affected: response includes count + appointments[] + date fields', async () => {
  await db.pool.query(
    `DELETE FROM appointment WHERE patient_phone LIKE '+1555999%'`,
  );
  const res = await request(app())
    .get('/doctor/affected')
    .set('Authorization', `Bearer ${doctorEastLeadToken()}`);
  assert.equal(res.status, 200);
  // Shape: count, branch_id (null), date (null), appointments.
  assert.equal(typeof res.body.count, 'number');
  assert.equal(res.body.branch_id, null);
  assert.equal(res.body.date, null);
  assert.ok(Array.isArray(res.body.appointments));
});

// ===========================================================================
// Date helpers (test-local — keep below the test() blocks for readability)
// ===========================================================================

/**
 * Returns the next occurrence of `dayOfWeek` (0=Sun..6=Sat) at
 * `hour:minute` in `America/New_York`. Pushes far enough into the
 * future to be safely past `now() + 60s`.
 */
function nextDayOfWeekAt(dayOfWeek: number, hour: number, minute: number): Date {
  const tz = 'America/New_York';
  const now = new Date(Date.now() + 60_000);
  // Start from tomorrow and walk forward up to 14 days.
  for (let offset = 1; offset <= 14; offset++) {
    const probe = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const localDow = localDayOfWeek(probe, tz);
    if (localDow === dayOfWeek) {
      const ymd = localYmd(probe, tz);
      const isoLocal = `${ymd}T${pad(hour)}:${pad(minute)}:00`;
      // Convert YYYY-MM-DDTHH:MM:SS (America/New_York) to a UTC instant.
      return new Date(localToUtcMs(isoLocal, tz));
    }
  }
  throw new Error('no day found within 14 days');
}

/** Returns a future weekday (Mon-Sat) at `hour:minute`. */
function futureWeekdayAt(hour: number, minute: number): Date {
  const tz = 'America/New_York';
  const now = new Date(Date.now() + 60_000);
  for (let offset = 1; offset <= 14; offset++) {
    const probe = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const localDow = localDayOfWeek(probe, tz);
    if (localDow >= 1 && localDow <= 6) {
      const ymd = localYmd(probe, tz);
      const isoLocal = `${ymd}T${pad(hour)}:${pad(minute)}:00`;
      return new Date(localToUtcMs(isoLocal, tz));
    }
  }
  throw new Error('no weekday found within 14 days');
}

function localDayOfWeek(utc: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  });
  const w = fmt.format(utc);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[w] ?? -1;
}

function localYmd(utc: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(utc);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Convert a local-clock string (YYYY-MM-DDTHH:MM:SS) in `tz` to UTC ms. */
function localToUtcMs(localIso: string, tz: string): number {
  // Strategy: treat `localIso` as UTC, then walk by the tz offset
  // for that instant. We converge in a few iterations.
  let utcMs = Date.parse(`${localIso}Z`);
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(utcMs));
    const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const mo = parts.find((p) => p.type === 'month')?.value ?? '01';
    const d = parts.find((p) => p.type === 'day')?.value ?? '01';
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mi = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const s = parts.find((p) => p.type === 'second')?.value ?? '00';
    const localRendered = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    if (localRendered === localIso) return utcMs;
    // Difference between intended local and rendered local (in seconds).
    const intendedMs = Date.parse(`${localIso}Z`);
    const renderedMs = Date.parse(`${localRendered}Z`);
    utcMs += intendedMs - renderedMs;
  }
  return utcMs;
}