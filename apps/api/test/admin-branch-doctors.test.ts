/**
 * admin-branch-doctors.test.ts — full I/O matrix for E1-S3
 * (POST/GET/PATCH /admin/doctors, GET /admin/doctors/:id,
 * PUT /admin/doctors/:id/branches).
 *
 * Covers every row of spec-1-3's I/O & Edge-Case Matrix:
 *   - POST happy path with full body, doctor + branches persisted.
 *   - POST empty / over-length / missing full_name → 400 invalid_full_name.
 *   - POST invalid email → 400 invalid_email.
 *   - POST duplicate email → 409 email_already_exists.
 *   - POST empty branch_ids → 400 invalid_branch_ids.
 *   - POST non-UUID branch_id → 400 invalid_branch_id + fields[].
 *   - POST unknown branch_id → 400 branch_not_found + fields[].
 *   - POST without auth → 401.
 *   - POST with patient JWT → 403.
 *   - GET list returns 3 seeded doctors, each with branches: [...].
 *   - GET ?active=true / ?active=false filters.
 *   - GET ?active=banana → 400 invalid_active_filter.
 *   - GET ?branch_id=<uuid> returns only doctors at that branch.
 *   - GET single doctor by id → 200; unknown id → 404; bad UUID → 400.
 *   - PATCH rename → 200 + updated_at advances.
 *   - PATCH deactivate CLEAN → 200 + warning: null.
 *   - PATCH deactivate WITH future appointment → 200 + warning
 *     'doctor_has_future_appointments' AND doctor.active flips AND
 *     future appointment stays Scheduled.
 *   - PATCH reactivate → 200 + active=true.
 *   - PATCH empty body / invalid active / unknown fields → 400.
 *   - PATCH unknown id → 404.
 *   - PUT branches happy → 200 + branches replaced atomically.
 *   - PUT branches empty → 400 doctor_must_work_at_least_one_branch.
 *   - PUT branches bad UUID / unknown branch → 400.
 *   - PUT branches unknown doctor → 404.
 *
 * after-hook restores the DB to its seeded state (delete any newly
 * created doctors, reactivate any deactivated doctors) so sibling
 * test files aren't affected by bleed.
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
  // Cleanup: reactivate any doctor we deactivated; delete any doctor we
  // created (by full_name LIKE 'New Doctor %' or 'Branch %' or 'Test %'
  // — matches the uniqueName patterns used below).
  await db.pool.query(
    `UPDATE doctor SET active = true WHERE active = false AND full_name LIKE 'Test %'`,
  );
  await db.pool.query(
    `DELETE FROM doctor WHERE full_name LIKE 'New Doctor %' OR full_name LIKE 'Branch %' OR full_name LIKE 'Put %' OR full_name LIKE 'Warn %'`,
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
  email: string;
  active: boolean;
  full_name: string;
}> {
  const { rows } = await db.pool.query<{
    id: string;
    email: string;
    active: boolean;
    full_name: string;
  }>(
    `SELECT id, email, active, full_name FROM doctor WHERE full_name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchBranchByName(name: string): Promise<{
  id: string;
  active: boolean;
}> {
  const { rows } = await db.pool.query<{ id: string; active: boolean }>(
    `SELECT id, active FROM branch WHERE name = $1`,
    [name],
  );
  return rows[0]!;
}

// ===========================================================================
// POST /admin/doctors
// ===========================================================================

test('POST /admin/doctors: happy path returns 201 with full row + branches', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const west = await fetchBranchByName('West Branch');
  const uniqueName = `New Doctor ${Date.now()}`;
  const uniqueEmail = `new-doc-${Date.now()}@clinic.local`;
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: uniqueName,
      email: uniqueEmail,
      branch_ids: [east.id, west.id],
    });
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.id === 'string');
  assert.ok(typeof res.body.clinic_id === 'string');
  assert.equal(res.body.full_name, uniqueName);
  assert.equal(res.body.email, uniqueEmail);
  assert.equal(res.body.active, true, 'newly created doctors default to active=true');
  assert.ok(Array.isArray(res.body.branches));
  assert.equal(res.body.branches.length, 2);
  const names = res.body.branches.map((b: { name: string }) => b.name).sort();
  assert.deepEqual(names, ['East Branch', 'West Branch']);
  assert.ok(res.body.created_at);
  assert.ok(res.body.updated_at);

  // DB-side pin: confirm the doctor + branch rows persisted.
  const byName = await db.pool.query<{ id: string; active: boolean; email: string }>(
    `SELECT id, active, email FROM doctor WHERE full_name = $1`,
    [uniqueName],
  );
  assert.equal(byName.rows.length, 1);
  assert.equal(byName.rows[0]!.id, res.body.id);
  assert.equal(byName.rows[0]!.active, true);
  assert.equal(byName.rows[0]!.email, uniqueEmail);

  const dbBranches = await db.pool.query<{ name: string }>(
    `SELECT b.name FROM doctor_branch db JOIN branch b ON b.id = db.branch_id
      WHERE db.doctor_id = $1 ORDER BY b.name`,
    [res.body.id],
  );
  assert.equal(dbBranches.rows.length, 2);
  assert.deepEqual(
    dbBranches.rows.map((r) => r.name),
    ['East Branch', 'West Branch'],
  );
});

test('POST /admin/doctors: empty full_name → 400 invalid_full_name', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: '',
      email: `empty-${Date.now()}@x.com`,
      branch_ids: [east.id],
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_full_name' });
});

test('POST /admin/doctors: over-length full_name (121 chars) → 400 invalid_full_name', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: 'a'.repeat(121),
      email: `over-${Date.now()}@x.com`,
      branch_ids: [east.id],
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_full_name' });
});

test('POST /admin/doctors: missing full_name → 400 invalid_full_name', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ email: `miss-${Date.now()}@x.com`, branch_ids: [east.id] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_full_name' });
});

test('POST /admin/doctors: invalid email → 400 invalid_email', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Email Bad ${Date.now()}`,
      email: 'not-an-email',
      branch_ids: [east.id],
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_email' });
});

test('POST /admin/doctors: missing email → 400 invalid_email', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: `No Email ${Date.now()}`, branch_ids: [east.id] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_email' });
});

test('POST /admin/doctors: duplicate email → 409 email_already_exists', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  // The seed gives East Lead Dr a non-clinic-specific email — we re-use
  // that to trigger the conflict.
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Dup ${Date.now()}`,
      email: eastLead.email,
      branch_ids: [east.id],
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'email_already_exists' });
});

test('POST /admin/doctors: empty branch_ids → 400 invalid_branch_ids', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Empty Branches ${Date.now()}`,
      email: `empty-b-${Date.now()}@x.com`,
      branch_ids: [],
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_ids' });
});

test('POST /admin/doctors: missing branch_ids → 400 invalid_branch_ids', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Missing Branches ${Date.now()}`,
      email: `miss-b-${Date.now()}@x.com`,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_ids' });
});

test('POST /admin/doctors: non-UUID branch_id → 400 invalid_branch_id + fields[]', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Bad Branch ${Date.now()}`,
      email: `bad-b-${Date.now()}@x.com`,
      branch_ids: ['not-a-uuid'],
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
  assert.ok(Array.isArray(res.body.fields));
  assert.ok(res.body.fields.includes('not-a-uuid'));
});

test('POST /admin/doctors: non-array branch_ids → 400 invalid_branch_ids', async () => {
  // Spec matrix row: `POST branch_ids: 'east'` → 400 invalid_branch_ids
  // (the validator rejects non-array values; P-A6 from E1-S3 review-loop-1
  // adds coverage).
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Non-array Branch ${Date.now()}`,
      email: `na-b-${Date.now()}@x.com`,
      branch_ids: 'east',
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_ids' });
});

test('POST /admin/doctors: unknown branch_id → 400 branch_not_found + fields[]', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000010';
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Unknown Branch ${Date.now()}`,
      email: `unk-b-${Date.now()}@x.com`,
      branch_ids: [randomUuid],
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'branch_not_found', fields: [randomUuid] });
});

test('POST /admin/doctors: no auth → 401 unauthenticated', async () => {
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('content-type', 'application/json')
    .send({
      full_name: `No Auth ${Date.now()}`,
      email: `na-${Date.now()}@x.com`,
      branch_ids: ['00000000-0000-4000-8000-000000000020'],
    });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /admin/doctors: patient JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .post('/admin/doctors')
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Patient Doc ${Date.now()}`,
      email: `pd-${Date.now()}@x.com`,
      branch_ids: ['00000000-0000-4000-8000-000000000021'],
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// GET /admin/doctors
// ===========================================================================

test('GET /admin/doctors: happy path returns the 3 seeded doctors with branches', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/doctors')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const seeded = res.body.filter((d: { full_name: string }) =>
    d.full_name === 'Dr. East Lead' ||
    d.full_name === 'Dr. East Support' ||
    d.full_name === 'Dr. West Lead',
  );
  assert.equal(seeded.length, 3, 'seeded doctors: East Lead + East Support + West Lead');
  for (const d of seeded) {
    assert.equal(d.active, true);
    assert.ok(typeof d.id === 'string');
    assert.ok(typeof d.clinic_id === 'string');
    assert.ok(Array.isArray(d.branches));
    assert.ok(d.branches.length >= 1);
    assert.ok(d.created_at);
    assert.ok(d.updated_at);
    for (const b of d.branches) {
      assert.ok(typeof b.id === 'string');
      assert.ok(typeof b.name === 'string');
      assert.ok(typeof b.tz === 'string');
      assert.equal(typeof b.active, 'boolean');
    }
  }
});

test('GET /admin/doctors?active=true filters out inactive doctors', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  await db.pool.query(`UPDATE doctor SET active = false WHERE id = $1`, [
    westLead.id,
  ]);
  try {
    const res = await request(adminApp())
      .get('/admin/doctors?active=true')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    const seeded = res.body.filter((d: { full_name: string }) =>
      d.full_name === 'Dr. East Lead' ||
      d.full_name === 'Dr. East Support' ||
      d.full_name === 'Dr. West Lead',
    );
    assert.equal(seeded.length, 2, 'only East Lead + East Support active among seeded');
    const names = seeded.map((d: { full_name: string }) => d.full_name).sort();
    assert.deepEqual(names, ['Dr. East Lead', 'Dr. East Support']);
  } finally {
    await db.pool.query(`UPDATE doctor SET active = true WHERE id = $1`, [
      westLead.id,
    ]);
  }
});

test('GET /admin/doctors?active=false returns only inactive doctors', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  await db.pool.query(`UPDATE doctor SET active = false WHERE id = $1`, [
    westLead.id,
  ]);
  try {
    const res = await request(adminApp())
      .get('/admin/doctors?active=false')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    const seeded = res.body.filter((d: { full_name: string }) =>
      d.full_name === 'Dr. East Lead' ||
      d.full_name === 'Dr. East Support' ||
      d.full_name === 'Dr. West Lead',
    );
    assert.equal(seeded.length, 1, 'only West Lead inactive');
    assert.equal(seeded[0].full_name, 'Dr. West Lead');
    assert.equal(seeded[0].active, false);
  } finally {
    await db.pool.query(`UPDATE doctor SET active = true WHERE id = $1`, [
      westLead.id,
    ]);
  }
});

test('GET /admin/doctors?active=banana → 400 invalid_active_filter', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/doctors?active=banana')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active_filter' });
});

test('GET /admin/doctors?branch_id=<east> returns only doctors at East', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .get(`/admin/doctors?branch_id=${east.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  // Seeded East doctors: Dr. East Lead + Dr. East Support.
  const seeded = res.body.filter((d: { full_name: string }) =>
    d.full_name === 'Dr. East Lead' ||
    d.full_name === 'Dr. East Support' ||
    d.full_name === 'Dr. West Lead',
  );
  assert.equal(seeded.length, 2);
  const names = seeded.map((d: { full_name: string }) => d.full_name).sort();
  assert.deepEqual(names, ['Dr. East Lead', 'Dr. East Support']);
});

test('GET /admin/doctors?branch_id=<bad uuid> → 400 invalid_branch_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/doctors?branch_id=not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /admin/doctors?branch_id=<valid uuid with no doctors> → 200 []', async () => {
  // Spec "Always" guarantee: empty list returns 200 []. Spin up a branch
  // (no doctors attached), query with `?branch_id=<that branch's id>`,
  // and confirm the response is `[]`. P-A7 from E1-S3 review-loop-1.
  const token = __makeAdminToken();
  const clinicRows = await db.pool.query<{ id: string }>(
    `SELECT id FROM clinic LIMIT 1`,
  );
  const clinicId = clinicRows.rows[0]!.id;
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, 'EmptyBranch', 'UTC') RETURNING id`,
    [clinicId],
  );
  const emptyBranchId = await fetchBranchByName('East Branch');
  void emptyBranchId;
  const branchId = ins.rows[0]!.id;
  try {
    const res = await request(adminApp())
      .get(`/admin/doctors?branch_id=${branchId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0, 'no doctors at this branch → []');
  } finally {
    await db.pool.query(`DELETE FROM branch WHERE id = $1`, [branchId]);
  }
});

test('GET /admin/doctors: no auth → 401 unauthenticated', async () => {
  const res = await request(adminApp()).get('/admin/doctors');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// GET /admin/doctors/:id
// ===========================================================================

test('GET /admin/doctors/:id: happy path returns doctor + branches', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .get(`/admin/doctors/${eastLead.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, eastLead.id);
  assert.equal(res.body.full_name, 'Dr. East Lead');
  assert.equal(res.body.active, true);
  assert.ok(Array.isArray(res.body.branches));
  assert.equal(res.body.branches.length, 1);
  assert.equal(res.body.branches[0].name, 'East Branch');
});

test('GET /admin/doctors/:id: unknown UUID → 404 doctor_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000100';
  const res = await request(adminApp())
    .get(`/admin/doctors/${randomUuid}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('GET /admin/doctors/:id: non-UUID id → 400 invalid_doctor_id (no DB lookup)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/doctors/not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('GET /admin/doctors/:id: no auth → 401', async () => {
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp()).get(`/admin/doctors/${eastLead.id}`);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// PATCH /admin/doctors/:id
// ===========================================================================

test('PATCH /admin/doctors/:id: rename → 200 + updated_at advances', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  const before = await db.pool.query<{ full_name: string; updated_at: Date }>(
    `SELECT full_name, updated_at FROM doctor WHERE id = $1`,
    [westLead.id],
  );
  const preUpdatedAt = before.rows[0]!.updated_at;

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/doctors/${westLead.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'Dr. West Lead Renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.full_name, 'Dr. West Lead Renamed');
  assert.ok(res.body.updated_at);

  const postUpdatedAt = new Date(res.body.updated_at as string);
  assert.ok(
    postUpdatedAt.getTime() > preUpdatedAt.getTime(),
    `updated_at must advance: pre=${preUpdatedAt.toISOString()} post=${postUpdatedAt.toISOString()}`,
  );

  // DB-side pin.
  const persisted = await db.pool.query<{ full_name: string }>(
    `SELECT full_name FROM doctor WHERE id = $1`,
    [westLead.id],
  );
  assert.equal(persisted.rows[0]!.full_name, 'Dr. West Lead Renamed');

  // Restore.
  await db.pool.query(`UPDATE doctor SET full_name = 'Dr. West Lead' WHERE id = $1`, [
    westLead.id,
  ]);
});

test('PATCH /admin/doctors/:id: deactivate CLEAN doctor → 200 + warning: null', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  // Sanity: West Lead has no future Scheduled appointment (seed only provisions one on East Lead).
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE doctor_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [westLead.id],
  );
  assert.equal(
    Number(future.rows[0]!.count),
    0,
    'precondition: West Lead has no future Scheduled',
  );

  const before = await db.pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM doctor WHERE id = $1`,
    [westLead.id],
  );
  const preUpdatedAt = before.rows[0]!.updated_at;

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/doctors/${westLead.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  assert.equal(res.body.warning, null);
  assert.equal(res.body.future_appointment_count, 0);

  // DB-side pin.
  const after = await db.pool.query<{ active: boolean; updated_at: Date }>(
    `SELECT active, updated_at FROM doctor WHERE id = $1`,
    [westLead.id],
  );
  assert.equal(after.rows[0]!.active, false);
  assert.ok(
    after.rows[0]!.updated_at.getTime() > preUpdatedAt.getTime(),
    'updated_at must advance on deactivate clean',
  );

  // Restore.
  await db.pool.query(`UPDATE doctor SET active = true WHERE id = $1`, [
    westLead.id,
  ]);
});

test('PATCH /admin/doctors/:id: deactivate WITH future appointments → 200 + warning (NOT 409, F-18)', async () => {
  // Dr. East Lead has ≥1 future Scheduled appointment (the seed provisions
  // one). Deactivating must succeed with a warning, NOT return 409.
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  // Sanity.
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE doctor_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [eastLead.id],
  );
  assert.ok(
    Number(future.rows[0]!.count) >= 1,
    'precondition: East Lead has ≥1 future Scheduled',
  );

  const before = await db.pool.query<{ active: boolean; status: string }>(
    `SELECT d.active, a.status
       FROM doctor d
       LEFT JOIN appointment a ON a.doctor_id = d.id AND a.start_datetime > now() AND a.status = 'Scheduled'
      WHERE d.id = $1
      LIMIT 1`,
    [eastLead.id],
  );
  const preActive = before.rows[0]!.active;

  const res = await request(adminApp())
    .patch(`/admin/doctors/${eastLead.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: false });
  assert.equal(res.status, 200, 'deactivate must NOT block on future appointments (F-18)');
  assert.equal(res.body.active, false);
  assert.equal(res.body.warning, 'doctor_has_future_appointments');
  assert.ok(res.body.future_appointment_count >= 1);

  // DB-side pin: doctor.active = false AND the future appointment is
  // still Scheduled (deactivate does not touch appointments).
  const after = await db.pool.query<{ active: boolean }>(
    `SELECT active FROM doctor WHERE id = $1`,
    [eastLead.id],
  );
  assert.equal(after.rows[0]!.active, false);

  const apptStill = await db.pool.query<{ status: string }>(
    `SELECT status FROM appointment
       WHERE doctor_id = $1 AND start_datetime > now()
       ORDER BY start_datetime ASC LIMIT 1`,
    [eastLead.id],
  );
  assert.equal(
    apptStill.rows[0]!.status,
    'Scheduled',
    'future appointment must remain Scheduled after doctor deactivation (F-18 explicit)',
  );

  // Restore: reactivate the doctor so subsequent tests aren't affected.
  await db.pool.query(`UPDATE doctor SET active = $1 WHERE id = $2`, [
    preActive,
    eastLead.id,
  ]);
});

test('PATCH /admin/doctors/:id: reactivate → 200 + active=true', async () => {
  const token = __makeAdminToken();
  const westLead = await fetchDoctorByName('Dr. West Lead');
  await db.pool.query(`UPDATE doctor SET active = false WHERE id = $1`, [
    westLead.id,
  ]);

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/doctors/${westLead.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, true);

  // DB-side pin.
  const persisted = await db.pool.query<{ active: boolean }>(
    `SELECT active FROM doctor WHERE id = $1`,
    [westLead.id],
  );
  assert.equal(persisted.rows[0]!.active, true);

  // Restore.
  await db.pool.query(`UPDATE doctor SET active = true WHERE id = $1`, [
    westLead.id,
  ]);
});

test('PATCH /admin/doctors/:id: empty body → 400 no_fields_to_update', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .patch(`/admin/doctors/${eastLead.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'no_fields_to_update' });
});

test('PATCH /admin/doctors/:id: invalid active → 400 invalid_active', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .patch(`/admin/doctors/${eastLead.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: 'maybe' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active' });
});

test('PATCH /admin/doctors/:id: unknown fields → 400 unknown_field', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .patch(`/admin/doctors/${eastLead.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'No Effect', surprise: true, role: 'super' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.ok(res.body.fields.includes('surprise'));
  assert.ok(res.body.fields.includes('role'));
});

test('PATCH /admin/doctors/:id: unknown id → 404 doctor_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000200';
  const res = await request(adminApp())
    .patch(`/admin/doctors/${randomUuid}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'No Such' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('PATCH /admin/doctors/:id: non-UUID id → 400 invalid_doctor_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/doctors/not-a-uuid')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'Whatever' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

// ===========================================================================
// PUT /admin/doctors/:id/branches
// ===========================================================================

test('PUT /admin/doctors/:id/branches: happy path replaces branch set', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const west = await fetchBranchByName('West Branch');
  // East Lead is seeded at East; we move them to West.
  const res = await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [west.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, eastLead.id);
  assert.equal(res.body.branches.length, 1);
  assert.equal(res.body.branches[0].name, 'West Branch');

  // DB-side pin: the old East row is gone; the new West row is present.
  const dbBranches = await db.pool.query<{ name: string }>(
    `SELECT b.name FROM doctor_branch db JOIN branch b ON b.id = db.branch_id
      WHERE db.doctor_id = $1 ORDER BY b.name`,
    [eastLead.id],
  );
  assert.equal(dbBranches.rows.length, 1);
  assert.equal(dbBranches.rows[0]!.name, 'West Branch');

  // Restore.
  await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      branch_ids: [(await fetchBranchByName('East Branch')).id],
    });
});

test('PUT /admin/doctors/:id/branches: no-op (same set) → 200', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [east.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.branches.length, 1);
  assert.equal(res.body.branches[0].name, 'East Branch');
});

test('PUT /admin/doctors/:id/branches: empty branch_ids → 400 doctor_must_work_at_least_one_branch', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'doctor_must_work_at_least_one_branch' });
});

test('PUT /admin/doctors/:id/branches: bad UUID → 400 invalid_branch_id + fields[]', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const res = await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: ['not-a-uuid'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
  assert.ok(res.body.fields.includes('not-a-uuid'));
});

test('PUT /admin/doctors/:id/branches: unknown branch → 400 branch_not_found + fields[]', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const randomUuid = '00000000-0000-4000-8000-000000000300';
  const res = await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [randomUuid] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'branch_not_found', fields: [randomUuid] });
});

test('PUT /admin/doctors/:id/branches: unknown doctor → 404 doctor_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000301';
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .put(`/admin/doctors/${randomUuid}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [east.id] });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'doctor_not_found' });
});

test('PUT /admin/doctors/:id/branches: non-UUID doctor id → 400 invalid_doctor_id', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .put('/admin/doctors/not-a-uuid/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [east.id] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_doctor_id' });
});

test('PUT /admin/doctors/:id/branches: unknown fields → 400 unknown_field', async () => {
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [east.id], surprise: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.ok(res.body.fields.includes('surprise'));
});

test('PUT /admin/doctors/:id/branches: duplicate branch_id in body is deduped (200, not 500)', async () => {
  // The doctor_branch PK is (doctor_id, branch_id). Without dedup, two
  // INSERTs with the same branch_id would raise 23505 on the second and
  // surface as 500. The route dedupes via `Array.from(new Set(...))`
  // before the INSERTs (P-A2 from E1-S3 review-loop-1).
  const token = __makeAdminToken();
  const eastLead = await fetchDoctorByName('Dr. East Lead');
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .put(`/admin/doctors/${eastLead.id}/branches`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_ids: [east.id, east.id, east.id] });
  assert.equal(res.status, 200, 'duplicate branch_id must dedupe, not 500');
  assert.equal(res.body.branches.length, 1);
  assert.equal(res.body.branches[0].id, east.id);

  // DB-side pin: confirm exactly 1 doctor_branch row for this doctor +
  // branch pair (no orphans, no duplicates).
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM doctor_branch
       WHERE doctor_id = $1 AND branch_id = $2`,
    [eastLead.id, east.id],
  );
  assert.equal(Number(rows[0]!.count), 1, 'dedupe must collapse to 1 row');
});