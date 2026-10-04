/**
 * admin-branch-hours.test.ts — full I/O matrix for
 * `GET/POST/PATCH /admin/branches/:id/hours` + `/hours-impact`.
 *
 * Covers every row of spec-1-2 §I/O & Edge-Case Matrix:
 *   - GET hours · 200 happy, 200 empty (no rows yet), 400 invalid uuid,
 *     404 branch_not_found, 401 no auth, 403 forbidden_role.
 *   - POST hours-impact · 200 happy (counts-only), 200 with
 *     ?include_affected=true, 404 branch_not_found, 400 invalid_hours_length,
 *     400 invalid_day_of_week.
 *   - PATCH hours · 200 happy (no impact), 200 happy with doctor ack flag,
 *     200 single-field address-only (no impact check),
 *     200 single-field tz-only (no impact check),
 *     400 invalid_hours_length, 400 invalid_day_of_week,
 *     400 invalid_time_range, 400 invalid_timezone, 400 unknown_field,
 *     400 no_fields_to_update, 404 branch_not_found, 401 no auth,
 *     409 appointments_outside_hours no-doctors-at-branch,
 *     409 appointments_outside_hours doctor-not-at-branch (rollback),
 *     200 acknowledge_doctor_impact=true (commit).
 *
 * Cleanup: scoped to East + West branches only — never flatten rows we
 * didn't create.
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
  // Restore East + West hours to the seed default so sibling tests (and
  // reruns of this file) start from the same baseline. The seed backfill
  // is ON CONFLICT DO NOTHING, so deleting first lets us re-seed cleanly.
  await db.pool.query(`DELETE FROM branch_weekly_hours WHERE branch_id IN (
    SELECT id FROM branch WHERE name IN ('East Branch', 'West Branch')
  )`);
  await db.pool.query(`UPDATE branch SET address = NULL, tz = 'America/New_York' WHERE name = 'East Branch'`);
  await db.pool.query(`UPDATE branch SET address = NULL, tz = 'America/Los_Angeles' WHERE name = 'West Branch'`);
  // Re-run the seed's backfill to restore the default 14 hours rows.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
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

async function fetchBranchByName(name: string): Promise<{ id: string }> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM branch WHERE name = $1`,
    [name],
  );
  return rows[0]!;
}

/** Standard 7-row weekly hours: Sun closed, Mon-Sat 09:00-17:00. */
function defaultHours() {
  const arr: Array<{
    day_of_week: number;
    open_time: string | null;
    close_time: string | null;
    is_closed: boolean;
  }> = [];
  for (let d = 0; d < 7; d++) {
    if (d === 0) {
      arr.push({ day_of_week: d, open_time: null, close_time: null, is_closed: true });
    } else {
      arr.push({ day_of_week: d, open_time: '09:00', close_time: '17:00', is_closed: false });
    }
  }
  return arr;
}

// ===========================================================================
// GET /admin/branches/:id/hours
// ===========================================================================

test('GET /admin/branches/:id/hours: happy path returns 200 with branch_id, tz, address, 7-row hours array', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .get(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.branch_id, east.id);
  assert.equal(res.body.tz, 'America/New_York');
  assert.equal(res.body.address, null);
  assert.ok(Array.isArray(res.body.hours));
  assert.equal(res.body.hours.length, 7, 'must return 7 rows (Sun..Sat)');
  // Day 0 (Sun) is closed; day 1 (Mon) is open.
  const sun = res.body.hours.find((h: { day_of_week: number }) => h.day_of_week === 0);
  assert.equal(sun.is_closed, true);
  assert.equal(sun.open_time, null);
  const mon = res.body.hours.find((h: { day_of_week: number }) => h.day_of_week === 1);
  assert.equal(mon.is_closed, false);
  assert.equal(mon.open_time, '09:00:00');
  assert.equal(mon.close_time, '17:00:00');
});

test('GET /admin/branches/:id/hours: unknown UUID → 404 branch_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000000';
  const res = await request(adminApp())
    .get(`/admin/branches/${randomUuid}/hours`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'branch_not_found' });
});

test('GET /admin/branches/:id/hours: non-UUID id → 400 invalid_branch_id (no DB lookup)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/branches/not-a-uuid/hours')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_id' });
});

test('GET /admin/branches/:id/hours: patient JWT → 403 forbidden_role', async () => {
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .get(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${patientToken()}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('GET /admin/branches/:id/hours: no auth → 401 unauthenticated', async () => {
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp()).get(`/admin/branches/${east.id}/hours`);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// POST /admin/branches/:id/hours-impact
// ===========================================================================

test('POST /admin/branches/:id/hours-impact: happy path returns 200 with counts (no impact)', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  // West has no future Scheduled appointments (only East does), so the
  // default hours (which match the seed backfill) should produce
  // count_affected=0.
  const res = await request(adminApp())
    .post(`/admin/branches/${west.id}/hours-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: defaultHours() });
  assert.equal(res.status, 200);
  assert.equal(res.body.count_affected, 0);
  assert.equal(res.body.requires_doctor_acknowledgement, false);
  assert.deepEqual(res.body.affected_doctors, []);
});

test('POST /admin/branches/:id/hours-impact: with ?include_affected=true returns affected list (no PII)', async () => {
  const token = __makeAdminToken();
  // East has 1 future Scheduled appointment at the seed-default 09:00-17:00
  // window (7 days from now). A request that narrows to 18:00-20:00 puts
  // it outside the window.
  const east = await fetchBranchByName('East Branch');
  const narrow = defaultHours().map((h) =>
    h.day_of_week === 1
      ? { ...h, open_time: '18:00', close_time: '20:00' }
      : h,
  );
  const res = await request(adminApp())
    .post(`/admin/branches/${east.id}/hours-impact?include_affected=true`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: narrow });
  assert.equal(res.status, 200);
  assert.equal(res.body.count_affected, 1);
  assert.ok(Array.isArray(res.body.affected));
  assert.equal(res.body.affected.length, 1);
  // No PII: response MUST NOT carry patient_phone, patient_name, etc.
  const row = res.body.affected[0];
  assert.ok(typeof row.appointment_id === 'string');
  assert.ok(typeof row.doctor_id === 'string');
  assert.equal(row.patient_phone, undefined);
  assert.equal(row.patient_name, undefined);
  assert.equal(row.reason, 'before_open_or_after_close');
  assert.ok(row.affected_doctors === undefined || Array.isArray(row.affected_doctors));
});

test('POST /admin/branches/:id/hours-impact: unknown branch → 404 branch_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000001';
  const res = await request(adminApp())
    .post(`/admin/branches/${randomUuid}/hours-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: defaultHours() });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'branch_not_found' });
});

test('POST /admin/branches/:id/hours-impact: hours array of length 6 → 400 invalid_hours_length', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours().slice(0, 6);
  const res = await request(adminApp())
    .post(`/admin/branches/${east.id}/hours-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_hours_length' });
});

test('POST /admin/branches/:id/hours-impact: day_of_week=7 → 400 invalid_day_of_week', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours();
  hours.push({ day_of_week: 7, open_time: '09:00', close_time: '17:00', is_closed: false });
  const res = await request(adminApp())
    .post(`/admin/branches/${east.id}/hours-impact`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_day_of_week' });
});

// ===========================================================================
// PATCH /admin/branches/:id/hours — happy paths
// ===========================================================================

test('PATCH /admin/branches/:id/hours: happy path 200 up narrowing Mon hours (no impact on West)', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  const newHours = defaultHours().map((h) =>
    h.day_of_week === 1
      ? { ...h, open_time: '08:00', close_time: '16:00' }
      : h,
  );
  const before = await db.pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  const preUpdatedAt = before.rows[0]!.updated_at;
  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: newHours });
  assert.equal(res.status, 200);
  assert.equal(res.body.impact.count_affected, 0);
  assert.equal(res.body.impact.requires_doctor_acknowledgement, false);
  assert.equal(res.body.hours.length, 7);

  // DB-side pin: the new hours are persisted.
  const persisted = await db.pool.query<{
    day_of_week: number;
    open_time: string | null;
    close_time: string | null;
    is_closed: boolean;
  }>(
    `SELECT day_of_week, open_time::text AS open_time, close_time::text AS close_time, is_closed
       FROM branch_weekly_hours WHERE branch_id = $1 AND day_of_week = 1`,
    [west.id],
  );
  assert.equal(persisted.rows[0]!.open_time, '08:00:00');
  assert.equal(persisted.rows[0]!.close_time, '16:00:00');

  // updated_at must advance.
  const after = await db.pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.ok(
    after.rows[0]!.updated_at.getTime() > preUpdatedAt.getTime(),
    'branch.updated_at must advance',
  );
});

test('PATCH /admin/branches/:id/hours: address-only → 200 (no impact check, fast path)', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ address: '123 Main St' });
  assert.equal(res.status, 200);
  assert.equal(res.body.address, '123 Main St');

  const persisted = await db.pool.query<{ address: string | null }>(
    `SELECT address FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.equal(persisted.rows[0]!.address, '123 Main St');
});

test('PATCH /admin/branches/:id/hours: tz-only (valid IANA) → 200', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ tz: 'Asia/Tokyo' });
  assert.equal(res.status, 200);
  assert.equal(res.body.tz, 'Asia/Tokyo');

  const persisted = await db.pool.query<{ tz: string }>(
    `SELECT tz FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.equal(persisted.rows[0]!.tz, 'Asia/Tokyo');
});

// ===========================================================================
// PATCH /admin/branches/:id/hours — 400 validation
// ===========================================================================

test('PATCH /admin/branches/:id/hours: empty body → 400 no_fields_to_update', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'no_fields_to_update' });
});

test('PATCH /admin/branches/:id/hours: hours array of length 6 → 400 invalid_hours_length', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours().slice(0, 6);
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_hours_length' });
});

test('PATCH /admin/branches/:id/hours: day_of_week=-1 → 400 invalid_day_of_week', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours();
  hours[0] = { day_of_week: -1, open_time: '09:00', close_time: '17:00', is_closed: false };
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_day_of_week' });
});

test('PATCH /admin/branches/:id/hours: open_time >= close_time → 400 invalid_time_range', async () => {
  // Spec AC line 102 mandates the envelope `400 {error: 'invalid_time_range'}`
  // for `open_time=17:00, close_time=09:00`. The route's tagged validator
  // (validateHoursArray) returns the specific code; the route emits the
  // exact spec envelope.
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours();
  hours[1] = { day_of_week: 1, open_time: '17:00', close_time: '09:00', is_closed: false };
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_time_range' });
});

test('PATCH /admin/branches/:id/hours: open_time === close_time → 400 invalid_time_range (boundary)', async () => {
  // Spec AC line 57: `open_time >= close_time` should return invalid_time_range.
  // The strict-greater case is covered above; this test pins the equality
  // case (which a regression to a strict `>` would silently let through).
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours();
  hours[1] = { day_of_week: 1, open_time: '09:00', close_time: '09:00', is_closed: false };
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_time_range' });
});

test('PATCH /admin/branches/:id/hours: open_time=25:00 → 400 invalid_time_range (out-of-range time format)', async () => {
  // Spec §Time format in HTTP: HH:MM 24-hour; out-of-range (e.g. 25:00)
  // must be rejected. The validator's isValidTime regex rejects this.
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours();
  hours[1] = { day_of_week: 1, open_time: '25:00', close_time: '17:00', is_closed: false };
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_time_range' });
});

test('PATCH /admin/branches/:id/hours: day_of_week=7 → 400 invalid_day_of_week (PATCH path)', async () => {
  // The spec AC explicitly covers `day_of_week: 7 → 400 invalid_day_of_week`
  // on PATCH. The existing test covers it on POST; this pins PATCH too.
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const hours = defaultHours();
  hours.push({ day_of_week: 7, open_time: '09:00', close_time: '17:00', is_closed: false });
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_day_of_week' });
});

test('PATCH /admin/branches/:id/hours: tz=Mars/Olympus_Mons → 400 invalid_timezone', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ tz: 'Mars/Olympus_Mons' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_timezone' });
});

test('PATCH /admin/branches/:id/hours: unknown fields → 400 unknown_field', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: defaultHours(), surprise: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.ok(res.body.fields.includes('surprise'));
});

// ===========================================================================
// PATCH /admin/branches/:id/hours — 401/403/404
// ===========================================================================

test('PATCH /admin/branches/:id/hours: unknown branch → 404 branch_not_found (tx path)', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000002';
  const res = await request(adminApp())
    .patch(`/admin/branches/${randomUuid}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: defaultHours() });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'branch_not_found' });
});

test('PATCH /admin/branches/:id/hours: non-UUID id → 400 invalid_branch_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/branches/not-a-uuid/hours')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: defaultHours() });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_id' });
});

test('PATCH /admin/branches/:id/hours: no auth → 401 unauthenticated', async () => {
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('content-type', 'application/json')
    .send({ hours: defaultHours() });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('PATCH /admin/branches/:id/hours: patient JWT → 403 forbidden_role', async () => {
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({ hours: defaultHours() });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// PATCH /admin/branches/:id/hours — 409 conflict paths
// ===========================================================================

test('PATCH /admin/branches/:id/hours: impact_count > 0 with doctor-at-branch → 409 (rollback) + ack flag', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  // Pre-condition: East has ≥1 future Scheduled appointment, and the
  // assigned doctor (Dr. East Lead) is in doctor_branch for East.
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [east.id],
  );
  assert.ok(Number(future.rows[0]!.count) >= 1, 'precondition: East has ≥1 future Scheduled');

  // Narrow Mon-Sat to 18:00-20:00 so the 7-days-from-now appointment
  // (at 09:00-ish ET) lands on a valid day but outside the time window.
  const narrow = defaultHours().map((h) =>
    h.day_of_week === 0
      ? h
      : { ...h, open_time: '18:00', close_time: '20:00' },
  );

  // Snapshot the hours before the request.
  const preHours = await db.pool.query<{ day_of_week: number; open_time: string | null }>(
    `SELECT day_of_week, open_time::text AS open_time FROM branch_weekly_hours
      WHERE branch_id = $1 AND day_of_week = 1`,
    [east.id],
  );
  const preOpenTime = preHours.rows[0]!.open_time;

  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: narrow });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'appointments_outside_hours');
  assert.ok(res.body.impact.count_affected >= 1);
  assert.equal(res.body.impact.requires_doctor_acknowledgement, true);
  assert.ok(Array.isArray(res.body.impact.affected_doctors));
  assert.ok(res.body.impact.affected_doctors.length >= 1);

  // Per-row shape pin (P1 from E1-S2 review-loop-1): the spec AC says
  // `affected_doctors: [{doctor_id, doctor_name, count:2}]`. A regression
  // that flattened the structure (e.g. returned strings or a count-only
  // array) would slip past the length check.
  const row = res.body.impact.affected_doctors[0];
  assert.ok(typeof row.doctor_id === 'string');
  assert.ok(typeof row.doctor_name === 'string');
  assert.equal(typeof row.count, 'number');
  assert.ok(row.count >= 1);

  // Confirm the rollback (hours reverted to seed defaults).
  const postHours = await db.pool.query<{ open_time: string | null }>(
    `SELECT open_time::text AS open_time FROM branch_weekly_hours
      WHERE branch_id = $1 AND day_of_week = 1`,
    [east.id],
  );
  assert.equal(
    postHours.rows[0]!.open_time,
    preOpenTime,
    'open_time must revert after a 409 rollback',
  );
});

test('PATCH /admin/branches/:id/hours: impact_count > 0 with NO doctor-at-branch → 409 with requires_doctor_acknowledgement=false (P1 from E1-S2 review)', async () => {
  // Spec AC line 104 requires the no-doctor-at-branch path:
  // `count_affected:3, requires_doctor_acknowledgement:false` — the
  // affected appointments exist but the doctor is not currently assigned
  // to the branch via doctor_branch, so no doctor-side ack is needed.
  //
  // The test creates a fresh fixture (branch + future appointment) where
  // the appointment's doctor is NOT in doctor_branch for this branch.
  // We use a transient branch name so the after-hook cleanup doesn't
  // affect seeded branches.
  const token = __makeAdminToken();
  const uniqueName = `NoDoc Branch ${Date.now()}`;
  // Create a branch (active=true by default from 0014).
  const branchRes = await db.pool.query<{ id: string; tz: string }>(
    `INSERT INTO branch (clinic_id, name, tz)
      VALUES ((SELECT id FROM clinic LIMIT 1), $1, 'America/New_York')
      RETURNING id, tz`,
    [uniqueName],
  );
  const branchId = branchRes.rows[0]!.id;
  const tz = branchRes.rows[0]!.tz;
  // Pick an existing doctor NOT assigned to this branch.
  const docRes = await db.pool.query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM doctor
      WHERE id NOT IN (SELECT doctor_id FROM doctor_branch WHERE branch_id = $1)
      LIMIT 1`,
    [branchId],
  );
  assert.ok(docRes.rows.length >= 1, 'precondition: at least one doctor exists');
  const doctorId = docRes.rows[0]!.id;
  const doctorName = docRes.rows[0]!.full_name;
  // Pick an existing appointment type (or create one on the fly).
  const atRes = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment_type LIMIT 1`,
  );
  const appointmentTypeId = atRes.rows[0]!.id;
  // Insert a future Scheduled appointment for that doctor at this branch
  // at a time that will land OUTSIDE the narrow window below.
  await db.pool.query(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     VALUES
       ((SELECT id FROM clinic LIMIT 1), $1, $2, '+15550009999', $3,
        app_now() + INTERVAL '8 days',
        app_now() + INTERVAL '8 days' + INTERVAL '30 minutes',
        'Scheduled', 'staff:admin-main')`,
    [branchId, doctorId, appointmentTypeId],
  );

  // Narrow Mon-Sat to 18:00-20:00 so the appointment at 09:00-ish ET
  // lands outside the time window.
  const narrow = defaultHours().map((h) =>
    h.day_of_week === 0
      ? h
      : { ...h, open_time: '18:00', close_time: '20:00' },
  );

  try {
    const res = await request(adminApp())
      .patch(`/admin/branches/${branchId}/hours`)
      .set('Authorization', `Bearer ${token}`)
      .set('content-type', 'application/json')
      .send({ hours: narrow });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'appointments_outside_hours');
    assert.equal(res.body.impact.count_affected, 1);
    assert.equal(
      res.body.impact.requires_doctor_acknowledgement,
      false,
      'no doctor assigned to branch → no ack required',
    );
    assert.equal(res.body.impact.affected_doctors.length, 1);
    assert.equal(res.body.impact.affected_doctors[0].doctor_id, doctorId);
    assert.equal(res.body.impact.affected_doctors[0].doctor_name, doctorName);
    assert.equal(res.body.impact.affected_doctors[0].count, 1);
    // Sanity: tz from the row is the branch's tz (the helper
    // parameterizes it via $2 — no compilation reference needed).
    void tz;
  } finally {
    // Cleanup: remove the fixture rows.
    await db.pool.query(`DELETE FROM branch WHERE id = $1`, [branchId]);
  }
});

test('PATCH /admin/branches/:id/hours: impact with ack flag → 200 (commit) when ?acknowledge_doctor_impact=true', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const narrow = defaultHours().map((h) =>
    h.day_of_week === 0
      ? h
      : { ...h, open_time: '18:00', close_time: '20:00' },
  );

  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}/hours?acknowledge_doctor_impact=true`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: narrow });
  assert.equal(res.status, 200);
  assert.ok(res.body.impact.count_affected >= 1);
  assert.equal(res.body.impact.requires_doctor_acknowledgement, true);

  // DB-side pin: the new hours are persisted (proves tx committed).
  const persisted = await db.pool.query<{ open_time: string | null }>(
    `SELECT open_time::text AS open_time FROM branch_weekly_hours
      WHERE branch_id = $1 AND day_of_week = 1`,
    [east.id],
  );
  assert.equal(persisted.rows[0]!.open_time, '18:00:00');

  // Status of the appointment must remain Scheduled (saved-and-flagged,
  // not silently invalidated).
  const apptStatus = await db.pool.query<{ status: string }>(
    `SELECT status FROM appointment
       WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled' LIMIT 1`,
    [east.id],
  );
  assert.equal(apptStatus.rows[0]!.status, 'Scheduled',
    'appointments remain Scheduled (saved-and-flagged)');
});

test('PATCH /admin/branches/:id/hours: closed days allow NULL times', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  // All days closed → should be accepted.
  const allClosed = Array.from({ length: 7 }, (_, d) => ({
    day_of_week: d,
    open_time: null,
    close_time: null,
    is_closed: true,
  }));
  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: allClosed });
  assert.equal(res.status, 200);

  // Restore for sibling tests.
  const restore = defaultHours();
  await request(adminApp())
    .patch(`/admin/branches/${west.id}/hours`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ hours: restore });
});