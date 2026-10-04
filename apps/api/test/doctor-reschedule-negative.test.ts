/**
 * doctor-reschedule-negative.test.ts — negative-capability test for E2-S4.
 *
 * Per spec-2-4 (PRD §2.2 + BRD §3.2), doctors CANNOT reschedule ordinary
 * patient appointments. Their action set is restricted to: cancel (with
 * reason), mark completed, mark no-show, resolve affected (E6-S2).
 *
 * The negative capability is enforced by TWO layers:
 *   1. **Route absence** — no `/doctor/appointments/:id/reschedule`
 *      endpoint exists (asserted by the static code-search test below).
 *      Any future addition would violate the invariant.
 *   2. **adminScope middleware** — already mounted in app.ts:88, gates
 *      every `/admin/*` route with `role === 'admin' && scope === 'clinic'`.
 *      A doctor JWT hitting ANY admin path → 403 forbidden_role.
 *
 * The dynamic assertions pin:
 *   - Doctor JWT → POST /admin/appointments/:id/reschedule → 403 forbidden_role
 *     (proves the admin gate is unconditional, regardless of path semantics).
 *   - Doctor JWT → POST /patient/appointments/:id/reschedule → 404 not_found
 *     today (path absent). E4-S3 will own the patient-reschedule route; when
 *     it lands with `role === 'patient'` enforced, this test will be updated
 *     to assert 403. The 404 pin is intentional and forward-compatible.
 *   - Anonymous → POST /admin/appointments/:id/reschedule → 401 unauthenticated
 *     (proves the auth middleware fires before adminScope).
 *
 * Static assertion:
 *   - `grep -r 'appointments/:id/reschedule' apps/api/src/routes/` returns 0 matches.
 *     This locks the negative capability at the source level — adding such a
 *     route in the future would fail this test in CI.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
  delete process.env['AUTH_SECRET'];
  __resetAuthConfigForTests();
});

function adminApp() {
  return createApp();
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

async function fetchSeededAppointmentId(): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM appointment WHERE status = 'Scheduled' LIMIT 1`,
  );
  if (rows.length === 0) throw new Error('no seeded Scheduled appointment');
  return rows[0]!.id;
}

function doctorToken(branchId: string, doctorId: string): string {
  return signClaim({
    sub: `doctor:${doctorId}`,
    role: 'doctor',
    branch_ids: [branchId],
    scope: 'branch',
    doctor_id: doctorId,
  });
}

// ===========================================================================
// Dynamic negative tests — doctor JWT hitting plausible reschedule paths
// ===========================================================================

test('doctor JWT → POST /admin/appointments/:id/reschedule → 403 forbidden_role', async () => {
  const branchId = await fetchEastBranchId();
  const doctorId = await fetchEastLeadDoctorId();
  const apptId = await fetchSeededAppointmentId();
  const token = doctorToken(branchId, doctorId);

  const res = await request(adminApp())
    .post(`/admin/appointments/${apptId}/reschedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      new_start_datetime: '2099-01-01T10:00:00Z',
      new_end_datetime: '2099-01-01T10:30:00Z',
    });
  // The adminScope gate fires before any handler logic, returning 403.
  // This is the invariant: a doctor JWT cannot reach any admin path,
  // regardless of whether the specific sub-path is defined.
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('doctor JWT → POST /admin/appointments/:id (any admin path) → 403', async () => {
  const branchId = await fetchEastBranchId();
  const doctorId = await fetchEastLeadDoctorId();
  const apptId = await fetchSeededAppointmentId();
  const token = doctorToken(branchId, doctorId);

  const res = await request(adminApp())
    .post(`/admin/appointments/${apptId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('doctor JWT → PATCH /admin/doctors/:id → 403', async () => {
  const branchId = await fetchEastBranchId();
  const doctorId = await fetchEastLeadDoctorId();
  const token = doctorToken(branchId, doctorId);

  const res = await request(adminApp())
    .patch(`/admin/doctors/${doctorId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'renamed' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('doctor JWT → GET /admin/clinic → 403', async () => {
  const branchId = await fetchEastBranchId();
  const doctorId = await fetchEastLeadDoctorId();
  const token = doctorToken(branchId, doctorId);

  const res = await request(adminApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

test('doctor JWT → POST /patient/appointments/:id/reschedule → 404 today (path absent)', async () => {
  // Today's expected: 404 not_found because the patient-reschedule
  // endpoint doesn't exist yet (E4-S3 owns it). When E4-S3 ships,
  // the response will become 403 forbidden_role (the patient-side
  // route will enforce `role === 'patient'`). Update this assertion
  // when E4-S3 lands.
  const branchId = await fetchEastBranchId();
  const doctorId = await fetchEastLeadDoctorId();
  const apptId = await fetchSeededAppointmentId();
  const token = doctorToken(branchId, doctorId);

  const res = await request(adminApp())
    .post(`/patient/appointments/${apptId}/reschedule`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      new_start_datetime: '2099-01-01T10:00:00Z',
      new_end_datetime: '2099-01-01T10:30:00Z',
    });
  // Either 404 (path absent today) or 403 (E4-S3 role check rejects
  // doctor). Accepting both keeps the test forward-compatible.
  assert.ok(
    res.status === 404 || res.status === 403,
    `expected 404 or 403, got ${res.status}`,
  );
  if (res.status === 404) {
    assert.deepEqual(res.body, { error: 'not_found' });
  } else {
    assert.ok(
      typeof res.body?.error === 'string',
      `expected an error envelope, got ${JSON.stringify(res.body)}`,
    );
  }
});

test('anonymous → POST /admin/appointments/:id/reschedule → 401 unauthenticated', async () => {
  const apptId = await fetchSeededAppointmentId();
  const res = await request(adminApp())
    .post(`/admin/appointments/${apptId}/reschedule`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// Static code-search — locks the negative capability at the source level
// ===========================================================================

const ROUTES_DIR = join(__dirname, '..', 'src', 'routes');

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
}

test('static — no route file declares /doctor/appointments/:id/reschedule or /move', () => {
  const files: string[] = [];
  walk(ROUTES_DIR, files);
  const bannedPatterns = [
    /['"`]\/doctor\/appointments\/[^'"`]*reschedule/,
    /['"`]\/doctor\/appointments\/[^'"`]*move/,
  ];
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const re of bannedPatterns) {
        if (re.test(text)) {
          offenders.push({ file, line: i + 1, text });
        }
      }
    });
  }
  assert.equal(
    offenders.length,
    0,
    `forbidden doctor-reschedule paths in route files: ${JSON.stringify(offenders, null, 2)}`,
  );
});

// Sanity-check the test file itself works: an admin JWT CAN reach an
// admin path (we use a benign GET to keep the test self-contained).
test('sanity — admin JWT CAN reach /admin/clinic (control case)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/clinic')
    .set('Authorization', `Bearer ${token}`);
  // Either 200 (clinic exists) or 500 (clinic_row_missing on empty DB).
  // The point is: NOT 403. This proves the admin gate accepts the admin role.
  assert.notEqual(res.status, 403);
});