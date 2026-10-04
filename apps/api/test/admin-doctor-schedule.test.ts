/**
 * admin-doctor-schedule.test.ts — full I/O matrix for E2-S1
 * (GET /admin/doctors/:id/schedule,
 *  POST /admin/doctors/:id/schedule-impact,
 *  POST /admin/doctors/:id/schedule).
 *
 * Covers every row of spec-2-1's I/O & Edge-Case Matrix:
 *   - GET happy path / empty doctor / unknown / non-UUID / 401 / 403.
 *   - POST impact clean / impact with affected / impact invalid row / 401.
 *   - POST schedule clean / with future appt impact (409) / past effective_from /
 *     overlapping rows / empty rows / branch not in doctor_branches /
 *     unknown doctor / non-UUID / 401 / 403.
 *
 * after-hook restores the seeded schedule to its baseline (East Lead has
 * Mon-Fri 09:00-17:00 at East Branch) so sibling test files aren't
 * affected by bleed. Specifically:
 *   - DELETE any schedule rows for the 3 seeded doctors (the seed does
 *     not populate doctor_schedule; the baseline is "no rows").
 *   - DELETE any schedule rows we inserted during the test.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signClaim } from '../src/auth/jwt.js';
import { __resetAuthConfigForTests } from '../src/auth/config.js';
import { createApp } from '../src/app.js';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { seedWith } from '../db/seeds/01_minimum.js';
import { __makeAdminToken } from './__helpers__/admin-token.js';

const VALID_SECRET = 'a'.repeat(48);
let db: TestDb;

function tomorrowIso(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
  // Cleanup: delete every schedule row for the 3 seeded doctors so the
  // next test file sees the seeded baseline (no schedule rows).
  await db.pool.query(
    `DELETE FROM doctor_schedule WHERE doctor_id IN
       (SELECT id FROM doctor WHERE full_name IN
         ('Dr. East Lead', 'Dr. East Support', 'Dr. West Lead'))`,
  );
  delete process.env['AUTH_SECRET'];
  __resetAuthConfigForTests();
});

function adminApp() {
  return createApp();
}

function patientToken(): string {
  return signClaim({
    sub: '+15550000099',
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
}

async function fetchDoctorByName(name: string): Promise<{
  id: string;
}> {
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

// ===========================================================================
// GET /admin/doctors/:id/schedule
// ===========================================================================

test('GET /admin/doctors/:id/schedule: happy path returns empty schedule (seed has no rows)', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .get(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.doctor_id, eastLead.id);
  assert.ok(Array.isArray(res.body.schedule));
  assert.equal(res.body.schedule.length, 0, 'seed has no doctor_schedule rows');
});

test('GET /admin/doctors/:id/schedule: with seeded rows returns the rows', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = tomorrowIso();
  // Seed one row directly via DB (simulating a prior POST).
  await db.pool.query(
    `INSERT INTO doctor_schedule
       (doctor_id, branch_id, day_of_week, start_time, end_time,
        effective_from, effective_to, created_by)
     VALUES ($1, $2, 1, '09:00:00', '17:00:00', $3, NULL, 'staff:admin-main')`,
    [eastLead.id, east.id, t],
  );
  try {
    const res = await request(adminApp())
      .get(`/admin/doctors/${eastLead.id}/schedule`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.length, 1);
    const row = res.body.schedule[0];
    assert.equal(row.branch_id, east.id);
    assert.equal(row.day_of_week, 1);
    assert.equal(row.start_time, '09:00:00');
    assert.equal(row.end_time, '17:00:00');
    assert.equal(row.effective_from, t);
    assert.equal(row.effective_to, null);
  } finally {
    await db.pool.query(
      `DELETE FROM doctor_schedule WHERE doctor_id = $1`,
      [eastLead.id],
    );
  }
});

test('GET /admin/doctors/:id/schedule: unknown UUID → 404 doctor_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000001000';
  const res = await request(adminApp())
    .get(`/admin/doctors/${randomUuid}/schedule`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('GET /admin/doctors/:id/schedule: non-UUID id → 400 invalid_doctor_id (no DB lookup)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/doctors/not-a-uuid/schedule')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('GET /admin/doctors/:id/schedule: no auth → 401', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp()).get(`/admin/doctors/${eastLead.id}/schedule`);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('GET /admin/doctors/:id/schedule: patient JWT → 403', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .get(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// POST /admin/doctors/:id/schedule-impact
// ===========================================================================

test('POST .../schedule-impact: clean (no future appts) → 200 + 0 affected', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  const west = await fetchBranchByName('West Branch');
  const t = tomorrowIso();
  const res = await request(adminApp())
    .post(`/admin/doctors/${westLead.id}/schedule-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: west.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.future_appointment_count, 0);
  assert.deepEqual(res.body.affected_appointments, []);
});

test('POST .../schedule-impact: with future appts that fall outside → 200 + masked list', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = tomorrowIso();
  // East Lead has 1 future Scheduled appointment (the seed). Propose a
  // Sunday-only schedule (day_of_week=0) at the East branch; the seed
  // appointment at day_of_week=?? — we don't know which day, but the
  // impact should pick up the appointment unless its day_of_week is 0.
  // To deterministically force an affected appointment, propose a
  // Sunday-only schedule AND verify count is at least 1 (the seed is
  // start=now+7d, which is some weekday, NOT Sunday).
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: east.id,
          day_of_week: 0, // Sunday only
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 200);
  assert.ok(res.body.future_appointment_count >= 1);
  const appt = res.body.affected_appointments[0];
  assert.equal(appt.patient_phone_masked, '+1XXXXXXXXXX');
  assert.ok(typeof appt.id === 'string');
  assert.equal(appt.doctor_id, eastLead.id);
  assert.equal(appt.branch_id, east.id);
  assert.equal(appt.status, 'Scheduled');
});

test('POST .../schedule-impact: invalid row (day_of_week 7) → 400 invalid_schedule_row', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = tomorrowIso();
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: east.id,
          day_of_week: 7, // invalid
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_schedule_row');
  assert.deepEqual(res.body.fields, [0]);
});

test('POST .../schedule-impact: past effective_from → 400 invalid_schedule_row', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: east.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: '2020-01-01', // past
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_schedule_row');
  assert.deepEqual(res.body.fields, [0]);
});

test('POST .../schedule-impact: overlapping rows → 400 schedule_rows_overlap', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = tomorrowIso();
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: east.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '13:00:00',
          effective_from: t,
          effective_to: null,
        },
        {
          branch_id: east.id,
          day_of_week: 1,
          start_time: '12:00:00', // overlaps the previous row
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'schedule_rows_overlap');
  assert.ok(res.body.fields.includes(1));
});

test('POST .../schedule-impact: branch not in doctor_branch → 400 branch_not_in_doctor_branches', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead'); // works only at East
  const west = await fetchBranchByName('West Branch'); // NOT in his branches
  const t = tomorrowIso();
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: west.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'branch_not_in_doctor_branches');
  assert.deepEqual(res.body.fields, [0]);
});

test('POST .../schedule-impact: no auth → 401', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule-impact`)
    .set('content-type', 'application/json')
    .send({ rows: [] });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// POST /admin/doctors/:id/schedule  (full-set replace)
// ===========================================================================

test('POST .../schedule: clean → 201 + inserted_count', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  const west = await fetchBranchByName('West Branch');
  const t = tomorrowIso();
  const res = await request(adminApp())
    .post(`/admin/doctors/${westLead.id}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: west.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
        {
          branch_id: west.id,
          day_of_week: 2,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted_count, 2);
  assert.equal(res.body.schedule.length, 2);

  // DB-side pin: 2 rows persisted.
  const persisted = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM doctor_schedule WHERE doctor_id = $1`,
    [westLead.id],
  );
  assert.equal(Number(persisted.rows[0]!.count), 2);

  // DB-side pin: created_by uses the admin's sub claim ('admin-main'
  // per __makeAdminToken default). P0-5 from E2-S1 review-loop-1.
  const createdBy = await db.pool.query<{ created_by: string }>(
    `SELECT created_by FROM doctor_schedule WHERE doctor_id = $1 LIMIT 1`,
    [westLead.id],
  );
  assert.equal(
    createdBy.rows[0]!.created_by,
    'staff:admin-main',
    'created_by must reflect the admin sub claim',
  );
});

test('POST .../schedule: with future appt impact → 409 + masked list (no DB write)', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = tomorrowIso();
  // Pre-condition: zero schedule rows for East Lead.
  await db.pool.query(`DELETE FROM doctor_schedule WHERE doctor_id = $1`, [eastLead.id]);

  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        // Sunday-only — invalidates the seeded future Scheduled appt.
        {
          branch_id: east.id,
          day_of_week: 0,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'schedule_invalidates_future_appointments');
  assert.ok(res.body.future_appointment_count >= 1);
  assert.equal(res.body.affected_appointments[0].patient_phone_masked, '+1XXXXXXXXXX');

  // DB-side pin: NO rows were inserted.
  const persisted = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM doctor_schedule WHERE doctor_id = $1`,
    [eastLead.id],
  );
  assert.equal(Number(persisted.rows[0]!.count), 0, 'rollback must leave no rows');
});

test('POST .../schedule: empty rows → 201 + inserted_count=0 (vacuous replace)', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  // Pre-condition: pre-seed a row so we can verify the DELETE happened.
  const east = await fetchBranchByName('East Branch');
  const t = tomorrowIso();
  await db.pool.query(
    `INSERT INTO doctor_schedule
       (doctor_id, branch_id, day_of_week, start_time, end_time,
        effective_from, effective_to, created_by)
     VALUES ($1, $2, 1, '09:00:00', '17:00:00', $3, NULL, 'staff:admin-main')`,
    [eastLead.id, east.id, t],
  );

  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ rows: [] });
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted_count, 0);
  assert.deepEqual(res.body.schedule, []);

  // DB-side pin: the pre-seeded row was wiped.
  const persisted = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM doctor_schedule WHERE doctor_id = $1`,
    [eastLead.id],
  );
  assert.equal(Number(persisted.rows[0]!.count), 0);
});

test('POST .../schedule: past effective_from → 400 invalid_schedule_row', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: east.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: '2020-01-01',
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_schedule_row');
});

test('POST .../schedule: overlapping rows → 400 schedule_rows_overlap', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const t = tomorrowIso();
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: east.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '13:00:00',
          effective_from: t,
          effective_to: null,
        },
        {
          branch_id: east.id,
          day_of_week: 1,
          start_time: '12:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'schedule_rows_overlap');
});

test('POST .../schedule: branch not in doctor_branch → 400 branch_not_in_doctor_branches', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const west = await fetchBranchByName('West Branch');
  const t = tomorrowIso();
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      rows: [
        {
          branch_id: west.id,
          day_of_week: 1,
          start_time: '09:00:00',
          end_time: '17:00:00',
          effective_from: t,
          effective_to: null,
        },
      ],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'branch_not_in_doctor_branches');
  assert.deepEqual(res.body.fields, [0]);
});

test('POST .../schedule: unknown doctor → 404 doctor_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000001001';
  const res = await request(adminApp())
    .post(`/admin/doctors/${randomUuid}/schedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ rows: [] });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('POST .../schedule: non-UUID id → 400 invalid_doctor_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/doctors/not-a-uuid/schedule')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ rows: [] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('POST .../schedule: no auth → 401', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule`)
    .set('content-type', 'application/json')
    .send({ rows: [] });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST .../schedule: patient JWT → 403', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .post(`/admin/doctors/${eastLead.id}/schedule`)
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({ rows: [] });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});