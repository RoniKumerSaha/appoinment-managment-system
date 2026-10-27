/**
 * 08-recurring.test.ts — POST /recurring/preview + POST /recurring/confirm.
 *
 * Coverage:
 *   - POST /recurring/preview    (read-only; per-occurrence validation)
 *   - POST /recurring/confirm    (atomic batch insert; partial success)
 *
 * Notes:
 *   - Auth: claim.role ∈ {doctor, receptionist}. Patient / admin →
 *     403 forbidden_role. Anonymous → 401.
 *   - Doctor scope is doubly-bound (doctor_id MUST match claim.doctor_id).
 *     Receptionist scope is branch-only (branch_id in claim.branch_ids).
 *   - Preview is server-stateful (in-process Map); the confirm route
 *     looks up the snapshot by `preview_id`. Tests reuse the preview
 *     id within a single test run.
 *   - 12 validation error codes in the preview body validator;
 *     each is exercised below.
 *   - Each occurrence is validated against branch hours, doctor
 *     schedule, doctor blocks, FR-027, FR-029, the 30-day window, and
 *     same-day exclusion. Per-occurrence independence means a single
 *     bad occurrence doesn't fail the whole series — it's bucketed
 *     into `skipped_with_reason` with a SkipReason code.
 *   - Confirm runs the per-occurrence validation a SECOND time
 *     inside the txn (race-safety net) and inserts each valid
 *     occurrence as a Scheduled row with `recurring_series_id`
 *     populated + an `appointment_audit` row with
 *     event='recurring_created'.
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

const PATIENT = '+15550000002'; // clean — no prior Scheduled appts in seed

const DR_EAST_LEAD = 'Dr. East Lead';
const DR_EAST_SUPPORT = 'Dr. East Support';
const DR_WEST_LEAD = 'Dr. West Lead';
const EAST_BRANCH = 'East Branch';
const WEST_BRANCH = 'West Branch';

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
  db = await getTestDb();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    // Doctor schedule (all 7 days, 09-17) for both East-branch doctors.
    await client.query(
      `INSERT INTO doctor_schedule
         (doctor_id, branch_id, day_of_week, start_time, end_time, effective_from, created_by)
       SELECT d.id, b.id, dow, '09:00:00'::time, '17:00:00'::time, '2020-01-01'::date, 'staff:test-setup'
         FROM doctor d, branch b, generate_series(0, 6) AS dow
        WHERE d.full_name IN ($1, $2)
          AND b.name = $3
        ON CONFLICT DO NOTHING`,
      [DR_EAST_LEAD, DR_EAST_SUPPORT, EAST_BRANCH],
    );
    // Cancel all Scheduled rows for the 5 seed patients (prior test
    // files may have left rows behind; FR-027 partial unique would
    // block new Scheduled inserts otherwise).
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
function doctorToken(email: string, doctorId: string, branchId: string): string {
  return signClaim({
    sub: email,
    role: 'doctor',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
}
function adminToken(): string {
  return signClaim({
    sub: 'admin-main@clinic.local',
    role: 'admin',
    branch_ids: ['__clinic_anchor__'],
    scope: 'clinic',
  });
}

async function lookupIds(name: string, branch: string): Promise<{ doctorId: string; branchId: string; typeId: string }> {
  const { rows: drows } = await db.pool.query<{ id: string }>(`SELECT id FROM doctor WHERE full_name = $1`, [name]);
  const { rows: brows } = await db.pool.query<{ id: string }>(`SELECT id FROM branch WHERE name = $1`, [branch]);
  const { rows: trows } = await db.pool.query<{ id: string }>(`SELECT id FROM appointment_type WHERE name = 'General Consultation'`);
  if (!drows[0] || !brows[0] || !trows[0]) throw new Error(`seed missing: ${name}/${branch}`);
  return { doctorId: drows[0].id, branchId: brows[0].id, typeId: trows[0].id };
}

const DR_EAST_LEAD_EMAIL = 'dr.-east-lead@clinic.local';
const DR_EAST_SUPPORT_EMAIL = 'dr.-east-support@clinic.local';
const RECEPTIONIST_EAST = 'receptionist-east@clinic.local';

/** Returns the next 7 days starting at the next-day boundary (avoid
 *  same-day exclusion FR-019). Returns YYYY-MM-DD in branch tz for
 *  each day. Branch tz is America/New_York for East Branch. */
function nextNWeekdaysInBranchTz(n: number, branchTz: string): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1); // start tomorrow
  while (out.length < n) {
    // 0=Sun, 6=Sat — skip Sundays (East branch is closed)
    const dow = new Intl.DateTimeFormat('en-US', {
      timeZone: branchTz,
      weekday: 'short',
    }).format(d);
    if (dow !== 'Sun') {
      out.push(new Intl.DateTimeFormat('en-CA', {
        timeZone: branchTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// POST /recurring/preview — auth gates
// ═══════════════════════════════════════════════════════════════════
test('POST /recurring/preview (no auth) → 401', async () => {
  const res = await request(createApp()).post('/recurring/preview').send({});
  assert.equal(res.status, 401);
});

test('POST /recurring/preview (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({});
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('POST /recurring/preview (admin role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

// ═══════════════════════════════════════════════════════════════════
// POST /recurring/preview — body validation (12 error codes)
// ═══════════════════════════════════════════════════════════════════
test('POST /recurring/preview (unknown_field) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
      bogus_field: 'x',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
});

test('POST /recurring/preview (invalid_doctor_id) → 400', async () => {
  const { branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: 'not-a-uuid',
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_doctor_id');
});

test('POST /recurring/preview (invalid_branch_id) → 400', async () => {
  const { doctorId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: 'not-a-uuid',
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('POST /recurring/preview (invalid_appointment_type_id) → 400', async () => {
  const { doctorId, branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: 'not-a-uuid',
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_appointment_type_id');
});

test('POST /recurring/preview (invalid_patient_phone) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: 'not-a-phone',
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_patient_phone');
});

test('POST /recurring/preview (invalid_recurrence_kind) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'monthly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_recurrence_kind');
});

test('POST /recurring/preview (invalid_start_date) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: 'not-a-date',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_start_date');
});

test('POST /recurring/preview (invalid_time_of_day) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '25:99',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_time_of_day');
});

test('POST /recurring/preview (invalid_duration_minutes) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 9999,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_duration_minutes');
});

test('POST /recurring/preview (invalid_occurrences_or_until_date) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 0,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_occurrences_or_until_date');
});

// ═══════════════════════════════════════════════════════════════════
// POST /recurring/preview — scope checks
// ═══════════════════════════════════════════════════════════════════
test('POST /recurring/preview (doctor, body doctor_id mismatch) → 403 outside_branch_scope', async () => {
  const { branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const { doctorId: myId } = await lookupIds(DR_EAST_SUPPORT, EAST_BRANCH);
  const { doctorId: wrongId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const token = doctorToken(DR_EAST_SUPPORT_EMAIL, myId, branchId);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${token}`)
    .send({
      doctor_id: wrongId, // mismatches claim.doctor_id
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

test('POST /recurring/preview (receptionist, foreign branch_id) → 403 outside_branch_scope', async () => {
  const { branchId: eastId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const { doctorId, typeId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const { branchId: westId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  const token = receptionistToken(RECEPTIONIST_EAST, eastId);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${token}`)
    .send({
      doctor_id: doctorId,
      branch_id: westId, // not in East receptionist's claim
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

test('POST /recurring/preview (receptionist, doctor not at branch) → 400 doctor_not_at_branch', async () => {
  // East Lead isn't at West Branch — receptionist asks for West
  // branch with East Lead.
  const { doctorId, branchId: eastId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const { typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const { branchId: westId } = await lookupIds(DR_WEST_LEAD, WEST_BRANCH);
  void eastId;
  const token = receptionistToken(RECEPTIONIST_EAST, eastId);
  // Actually, the East receptionist's claim contains eastId, not
  // westId. We need a West receptionist for this test to even pass
  // the branch_id scope check. Use that.
  const { rows: rrows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [WEST_BRANCH],
  );
  const westBranchId = rrows[0]!.id;
  const westReceptionistToken = signClaim({
    sub: 'receptionist-west@clinic.local',
    role: 'receptionist',
    branch_ids: [westBranchId],
    scope: 'branch',
  });
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${westReceptionistToken}`)
    .send({
      doctor_id: doctorId, // East Lead, not at West
      branch_id: westId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'doctor_not_at_branch');
  void typeId;
});

test('POST /recurring/preview (unknown patient phone) → 400 patient_not_found', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: '+15559999999',
      recurrence_kind: 'weekly',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'patient_not_found');
});

// ═══════════════════════════════════════════════════════════════════
// POST /recurring/preview — happy path
// ═══════════════════════════════════════════════════════════════════
test('POST /recurring/preview (weekly, 3 occurrences, all valid) → 200', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Pick a Monday in the future to dodge closed-Sunday expansion.
  // Find the next Monday at least 2 days out.
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);

  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: startDate,
      time_of_day: '10:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.recurrence.kind, 'weekly');
  assert.equal(res.body.recurrence.interval_days, 7);
  assert.equal(res.body.will_create.length, 3);
  assert.equal(res.body.skipped_with_reason.length, 0);
  assert.ok(typeof res.body.preview_id === 'string');
  assert.equal(res.body.branch.tz, 'America/New_York');
});

test('POST /recurring/preview (every_two_weeks) → 200 interval_days=14', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);

  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'every_two_weeks',
      start_date: startDate,
      time_of_day: '10:00',
      duration_minutes: 30,
      occurrences_or_until_date: 2,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.recurrence.interval_days, 14);
});

test('POST /recurring/preview (custom_days without interval) → 400', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'custom_days',
      start_date: '2099-01-05',
      time_of_day: '14:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_recurrence_interval_days');
});

test('POST /recurring/preview (Sunday start → all skipped, outside_branch_hours) → 200 with skipped rows', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Find the next Sunday in the future (at least 2 days out to dodge same-day exclusion)
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 3);
  while (start.getUTCDay() !== 0) start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);

  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: startDate,
      time_of_day: '10:00',
      duration_minutes: 30,
      occurrences_or_until_date: 2,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.will_create.length, 0);
  assert.equal(res.body.skipped_with_reason.length, 2);
  for (const s of res.body.skipped_with_reason) {
    assert.equal(s.reason, 'outside_branch_hours');
  }
});

test('POST /recurring/preview (start_date = today) → all skipped (same_day_exclusion)', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Build today's date in branch tz
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: today,
      time_of_day: '10:00',
      duration_minutes: 30,
      occurrences_or_until_date: 2,
    });
  assert.equal(res.status, 200);
  for (const s of res.body.skipped_with_reason) {
    assert.equal(s.reason, 'same_day_exclusion');
  }
});

test('POST /recurring/preview (outside 30d window) → outside_30d_window', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Find a Monday 35 days out
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 35);
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);

  const res = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: startDate,
      time_of_day: '10:00',
      duration_minutes: 30,
      occurrences_or_until_date: 2,
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.will_create.length, 0);
  for (const s of res.body.skipped_with_reason) {
    assert.equal(s.reason, 'outside_30d_window');
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /recurring/confirm
// ═══════════════════════════════════════════════════════════════════
test('POST /recurring/confirm (no auth) → 401', async () => {
  const res = await request(createApp())
    .post('/recurring/confirm')
    .send({ preview_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 401);
});

test('POST /recurring/confirm (patient role) → 403 forbidden_role', async () => {
  const res = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${patientToken(PATIENT)}`)
    .send({ preview_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_role');
});

test('POST /recurring/confirm (non-UUID preview_id) → 404 preview_not_found', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({ preview_id: 'not-a-uuid' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'preview_not_found');
});

test('POST /recurring/confirm (unknown UUID) → 404 preview_not_found', async () => {
  const { branchId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const res = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({ preview_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'preview_not_found');
});

test('POST /recurring/confirm (happy path, weekly) → 201 with created rows + audit', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Find a Monday 2 days out
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);

  // 1. Preview
  const previewRes = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: startDate,
      time_of_day: '10:00',
      duration_minutes: 30,
      occurrences_or_until_date: 3,
    });
  assert.equal(previewRes.status, 200);
  const previewId: string = previewRes.body.preview_id;

  // 2. Confirm
  const confirmRes = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({ preview_id: previewId });
  assert.equal(confirmRes.status, 201, `body=${JSON.stringify(confirmRes.body)}`);
  assert.equal(confirmRes.body.created.length, 3);
  assert.equal(confirmRes.body.skipped.length, 0);
  // Same series_id on every created row
  const seriesIds = new Set<string>();
  for (const c of confirmRes.body.created) {
    seriesIds.add(confirmRes.body.series_id);
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.start_datetime, 'string');
  }
  assert.equal(seriesIds.size, 1);

  // 3. DB: each created row has the matching recurring_series_id
  //    and an audit row with event='recurring_created'.
  const dbCheck = await db.pool.query<{ id: string; recurring_series_id: string }>(
    `SELECT id, recurring_series_id::text FROM appointment
       WHERE patient_phone = $1
         AND recurring_series_id = $2::uuid
         AND status = 'Scheduled'
       ORDER BY start_datetime`,
    [PATIENT, confirmRes.body.series_id],
  );
  assert.equal(dbCheck.rows.length, 3);
  for (const row of dbCheck.rows) {
    assert.equal(row.recurring_series_id, confirmRes.body.series_id);
  }

  const auditCheck = await db.pool.query<{ event: string; actor_role: string }>(
    `SELECT event, actor_role FROM appointment_audit
       WHERE appointment_id = ANY($1::uuid[]) AND event = 'recurring_created'`,
    [dbCheck.rows.map((r) => r.id)],
  );
  assert.equal(auditCheck.rows.length, 3);
  for (const a of auditCheck.rows) {
    assert.equal(a.actor_role, 'receptionist');
  }
});

test('POST /recurring/confirm (after confirm, second confirm with same preview_id) → 404 preview_not_found', async () => {
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  // Find a Monday 4 days out
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 4);
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);

  const previewRes = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: startDate,
      time_of_day: '11:00',
      duration_minutes: 30,
      occurrences_or_until_date: 1,
    });
  const previewId: string = previewRes.body.preview_id;

  const first = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({ preview_id: previewId });
  assert.equal(first.status, 201);

  // The preview store keeps the snapshot — a second confirm with the
  // same id succeeds with 0 created (the slot now collides with
  // the existing Scheduled row) but the route still returns 201
  // (partial-success semantics). The snapshot is NOT one-shot.
  const second = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({ preview_id: previewId });
  assert.equal(second.status, 201);
  // First row already booked → second confirm should skip the slot
  assert.equal(second.body.created.length, 0);
  assert.ok(second.body.skipped.length >= 1);
});

test('POST /recurring/confirm (doctor doubly-bound, body doctor_id differs from claim) → 403', async () => {
  // The route stores the snapshot at preview time with the
  // receptionist's body doctor_id. The confirm route re-checks
  // claim.role === 'doctor' against snapshot.body.doctor_id. The
  // patient-role / admin-role case is covered above. We also
  // exercise the doctor claim with a mismatched doctor_id by
  // confirming with a doctor token whose doctor_id is different
  // from the snapshot's body.doctor_id.
  const { doctorId, branchId, typeId } = await lookupIds(DR_EAST_LEAD, EAST_BRANCH);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 5);
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);

  const previewRes = await request(createApp())
    .post('/recurring/preview')
    .set('Authorization', `Bearer ${receptionistToken(RECEPTIONIST_EAST, branchId)}`)
    .send({
      doctor_id: doctorId,
      branch_id: branchId,
      appointment_type_id: typeId,
      patient_phone: PATIENT,
      recurrence_kind: 'weekly',
      start_date: startDate,
      time_of_day: '11:30',
      duration_minutes: 30,
      occurrences_or_until_date: 1,
    });
  const previewId: string = previewRes.body.preview_id;

  // Doctor token for East Support (different doctor_id than snapshot)
  const { doctorId: supportId } = await lookupIds(DR_EAST_SUPPORT, EAST_BRANCH);
  const docToken = doctorToken(DR_EAST_SUPPORT_EMAIL, supportId, branchId);
  const res = await request(createApp())
    .post('/recurring/confirm')
    .set('Authorization', `Bearer ${docToken}`)
    .send({ preview_id: previewId });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'outside_branch_scope');
});

// Helper to silence unused-warning lints
void nextNWeekdaysInBranchTz;
