/**
 * admin-branch-receptionists.test.ts — full I/O matrix for E1-S4
 * (POST/GET/PATCH /admin/receptionists, GET /admin/receptionists/:id).
 *
 * Covers every row of spec-1-4's I/O & Edge-Case Matrix:
 *   - POST happy path with full body, receptionist persisted with branch.
 *   - POST empty / over-length / missing full_name → 400 invalid_full_name.
 *   - POST invalid email / missing email → 400 invalid_email.
 *   - POST duplicate email → 409 email_already_exists.
 *   - POST non-UUID branch_id → 400 invalid_branch_id + fields[].
 *   - POST unknown branch_id → 400 branch_not_found + fields[].
 *   - POST without auth → 401.
 *   - POST with patient JWT → 403.
 *   - GET list returns 2 seeded receptionists with branch: {...}.
 *   - GET ?active=true / ?active=false filters.
 *   - GET ?active=banana → 400 invalid_active_filter.
 *   - GET ?branch_id=<uuid> returns only receptionists at that branch.
 *   - GET single receptionist by id → 200; unknown id → 404; bad UUID → 400.
 *   - PATCH rename → 200 + updated_at advances.
 *   - PATCH reassign branch → 200 + branch now points to new branch.
 *   - PATCH deactivate CLEAN → 200 + warning: null.
 *   - PATCH deactivate WITH future appointment → 200 + warning
 *     'receptionist_has_future_appointments' AND receptionist.active flips AND
 *     future appointment stays Scheduled.
 *   - PATCH reactivate → 200 + active=true.
 *   - PATCH empty body / invalid active / unknown fields → 400.
 *   - PATCH unknown id → 404.
 *
 * after-hook restores the DB to its seeded state (delete any newly
 * created receptionists, reactivate any deactivated receptionists, restore
 * branch assignments) so sibling test files aren't affected by bleed.
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
  // Cleanup: reactivate any receptionist we deactivated; delete any
  // receptionist we created (by full_name LIKE 'New Receptionist %' or
  // 'Test %' — matches the uniqueName patterns used below); restore
  // branch assignments for the 2 seeded receptionists (their canonical
  // East/West anchors live in 02_role_ids.ts).
  await db.pool.query(
    `UPDATE receptionist SET active = true WHERE active = false AND full_name LIKE 'Test %'`,
  );
  await db.pool.query(
    `DELETE FROM receptionist WHERE full_name LIKE 'New Receptionist %' OR full_name LIKE 'Test %'`,
  );
  // Restore seeded branch assignments by email (the deterministic natural key).
  const east = await fetchBranchByName('East Branch');
  const west = await fetchBranchByName('West Branch');
  await db.pool.query(`UPDATE receptionist SET branch_id = $1 WHERE email = 'receptionist-east@clinic.local'`, [east.id]);
  await db.pool.query(`UPDATE receptionist SET branch_id = $1 WHERE email = 'receptionist-west@clinic.local'`, [west.id]);
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

async function fetchReceptionistByName(name: string): Promise<{
  id: string;
  email: string;
  active: boolean;
  full_name: string;
  branch_id: string;
}> {
  const { rows } = await db.pool.query<{
    id: string;
    email: string;
    active: boolean;
    full_name: string;
    branch_id: string;
  }>(
    `SELECT id, email, active, full_name, branch_id FROM receptionist WHERE full_name = $1`,
    [name],
  );
  return rows[0]!;
}

async function fetchBranchByName(name: string): Promise<{
  id: string;
  active: boolean;
  tz: string;
}> {
  const { rows } = await db.pool.query<{ id: string; active: boolean; tz: string }>(
    `SELECT id, active, tz FROM branch WHERE name = $1`,
    [name],
  );
  return rows[0]!;
}

// ===========================================================================
// POST /admin/receptionists
// ===========================================================================

test('POST /admin/receptionists: happy path returns 201 with full row + branch', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const uniqueName = `New Receptionist ${Date.now()}`;
  const uniqueEmail = `new-rec-${Date.now()}@clinic.local`;
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: uniqueName,
      email: uniqueEmail,
      branch_id: east.id,
    });
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.id === 'string');
  assert.equal(res.body.full_name, uniqueName);
  assert.equal(res.body.email, uniqueEmail);
  assert.equal(res.body.active, true, 'newly created receptionists default to active=true');
  assert.equal(res.body.branch_id, east.id);
  assert.ok(res.body.branch);
  assert.equal(res.body.branch.id, east.id);
  assert.equal(res.body.branch.name, 'East Branch');
  assert.ok(typeof res.body.branch.tz === 'string');
  assert.equal(res.body.branch.active, true);
  assert.ok(res.body.created_at);
  assert.ok(res.body.updated_at);

  // DB-side pin: confirm the receptionist row persisted.
  const byName = await db.pool.query<{ id: string; active: boolean; email: string }>(
    `SELECT id, active, email FROM receptionist WHERE full_name = $1`,
    [uniqueName],
  );
  assert.equal(byName.rows.length, 1);
  assert.equal(byName.rows[0]!.id, res.body.id);
  assert.equal(byName.rows[0]!.active, true);
  assert.equal(byName.rows[0]!.email, uniqueEmail);
});

test('POST /admin/receptionists: empty full_name → 400 invalid_full_name', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: '',
      email: `empty-${Date.now()}@x.com`,
      branch_id: east.id,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_full_name' });
});

test('POST /admin/receptionists: over-length full_name (121 chars) → 400 invalid_full_name', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: 'a'.repeat(121),
      email: `over-${Date.now()}@x.com`,
      branch_id: east.id,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_full_name' });
});

test('POST /admin/receptionists: missing full_name → 400 invalid_full_name', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ email: `miss-${Date.now()}@x.com`, branch_id: east.id });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_full_name' });
});

test('POST /admin/receptionists: invalid email → 400 invalid_email', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Email Bad ${Date.now()}`,
      email: 'not-an-email',
      branch_id: east.id,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_email' });
});

test('POST /admin/receptionists: missing email → 400 invalid_email', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: `No Email ${Date.now()}`, branch_id: east.id });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_email' });
});

test('POST /admin/receptionists: duplicate email → 409 email_already_exists', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  // Receptionist East's email is the seeded UNIQUE.
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Dup ${Date.now()}`,
      email: eastRec.email,
      branch_id: east.id,
    });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'email_already_exists' });
});

test('POST /admin/receptionists: non-UUID branch_id → 400 invalid_branch_id + fields[]', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Bad Branch ${Date.now()}`,
      email: `bad-b-${Date.now()}@x.com`,
      branch_id: 'not-a-uuid',
    });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
  assert.ok(Array.isArray(res.body.fields));
  assert.ok(res.body.fields.includes('not-a-uuid'));
});

test('POST /admin/receptionists: missing branch_id → 400 invalid_branch_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Missing Branch ${Date.now()}`,
      email: `miss-b-${Date.now()}@x.com`,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_id' });
});

test('POST /admin/receptionists: unknown branch_id → 400 branch_not_found + fields[]', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000410';
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Unknown Branch ${Date.now()}`,
      email: `unk-b-${Date.now()}@x.com`,
      branch_id: randomUuid,
    });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'branch_not_found', fields: [randomUuid] });
});

test('POST /admin/receptionists: no auth → 401 unauthenticated', async () => {
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('content-type', 'application/json')
    .send({
      full_name: `No Auth ${Date.now()}`,
      email: `na-${Date.now()}@x.com`,
      branch_id: '00000000-0000-4000-8000-000000000420',
    });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /admin/receptionists: patient JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .post('/admin/receptionists')
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({
      full_name: `Patient Rec ${Date.now()}`,
      email: `pd-${Date.now()}@x.com`,
      branch_id: '00000000-0000-4000-8000-000000000421',
    });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// GET /admin/receptionists
// ===========================================================================

test('GET /admin/receptionists: happy path returns the 2 seeded receptionists with branch', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/receptionists')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const seeded = res.body.filter((r: { full_name: string }) =>
    r.full_name === 'Receptionist East' || r.full_name === 'Receptionist West',
  );
  assert.equal(seeded.length, 2, 'seeded receptionists: East + West');
  for (const r of seeded) {
    assert.equal(r.active, true);
    assert.ok(typeof r.id === 'string');
    assert.ok(typeof r.branch_id === 'string');
    assert.ok(typeof r.branch === 'object');
    assert.ok(typeof r.branch.id === 'string');
    assert.ok(typeof r.branch.name === 'string');
    assert.ok(typeof r.branch.tz === 'string');
    assert.equal(typeof r.branch.active, 'boolean');
    assert.ok(r.created_at);
    assert.ok(r.updated_at);
  }
});

test('GET /admin/receptionists?active=true filters out inactive receptionists', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  await db.pool.query(`UPDATE receptionist SET active = false WHERE id = $1`, [
    eastRec.id,
  ]);
  try {
    const res = await request(adminApp())
      .get('/admin/receptionists?active=true')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    const seeded = res.body.filter((r: { full_name: string }) =>
      r.full_name === 'Receptionist East' || r.full_name === 'Receptionist West',
    );
    assert.equal(seeded.length, 1, 'only Receptionist West active among seeded');
    assert.equal(seeded[0]!.full_name, 'Receptionist West');
  } finally {
    await db.pool.query(`UPDATE receptionist SET active = true WHERE id = $1`, [
      eastRec.id,
    ]);
  }
});

test('GET /admin/receptionists?active=false returns only inactive receptionists', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  await db.pool.query(`UPDATE receptionist SET active = false WHERE id = $1`, [
    eastRec.id,
  ]);
  try {
    const res = await request(adminApp())
      .get('/admin/receptionists?active=false')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    const seeded = res.body.filter((r: { full_name: string }) =>
      r.full_name === 'Receptionist East' || r.full_name === 'Receptionist West',
    );
    assert.equal(seeded.length, 1, 'only Receptionist East inactive');
    assert.equal(seeded[0]!.full_name, 'Receptionist East');
    assert.equal(seeded[0]!.active, false);
  } finally {
    await db.pool.query(`UPDATE receptionist SET active = true WHERE id = $1`, [
      eastRec.id,
    ]);
  }
});

test('GET /admin/receptionists?active=banana → 400 invalid_active_filter', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/receptionists?active=banana')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active_filter' });
});

test('GET /admin/receptionists?branch_id=<east> returns only receptionists at East', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .get(`/admin/receptionists?branch_id=${east.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const seeded = res.body.filter((r: { full_name: string }) =>
    r.full_name === 'Receptionist East' || r.full_name === 'Receptionist West',
  );
  assert.equal(seeded.length, 1, 'only Receptionist East seeded at East');
  assert.equal(seeded[0]!.full_name, 'Receptionist East');
});

test('GET /admin/receptionists?branch_id=<bad uuid> → 400 invalid_branch_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/receptionists?branch_id=not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
});

test('GET /admin/receptionists?branch_id=<valid uuid with no receptionists> → 200 []', async () => {
  // Empty branch → [].
  const token = __makeAdminToken();
  const clinicRows = await db.pool.query<{ id: string }>(
    `SELECT id FROM clinic LIMIT 1`,
  );
  const clinicId = clinicRows.rows[0]!.id;
  const ins = await db.pool.query<{ id: string }>(
    `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, 'EmptyRecBranch', 'UTC') RETURNING id`,
    [clinicId],
  );
  const branchId = ins.rows[0]!.id;
  try {
    const res = await request(adminApp())
      .get(`/admin/receptionists?branch_id=${branchId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0, 'no receptionists at this branch → []');
  } finally {
    await db.pool.query(`DELETE FROM branch WHERE id = $1`, [branchId]);
  }
});

test('GET /admin/receptionists: no auth → 401 unauthenticated', async () => {
  const res = await request(adminApp()).get('/admin/receptionists');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// GET /admin/receptionists/:id
// ===========================================================================

test('GET /admin/receptionists/:id: happy path returns receptionist + branch', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp())
    .get(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, eastRec.id);
  assert.equal(res.body.full_name, 'Receptionist East');
  assert.equal(res.body.active, true);
  assert.ok(res.body.branch);
  assert.equal(res.body.branch.name, 'East Branch');
});

test('GET /admin/receptionists/:id: unknown UUID → 404 receptionist_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000500';
  const res = await request(adminApp())
    .get(`/admin/receptionists/${randomUuid}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'receptionist_not_found' });
});

test('GET /admin/receptionists/:id: non-UUID id → 400 invalid_receptionist_id (no DB lookup)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/receptionists/not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_receptionist_id' });
});

test('GET /admin/receptionists/:id: no auth → 401', async () => {
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp()).get(`/admin/receptionists/${eastRec.id}`);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// PATCH /admin/receptionists/:id
// ===========================================================================

test('PATCH /admin/receptionists/:id: rename → 200 + updated_at advances', async () => {
  const token = __makeAdminToken();
  const westRec = await fetchReceptionistByName('Receptionist West');
  const before = await db.pool.query<{ full_name: string; updated_at: Date }>(
    `SELECT full_name, updated_at FROM receptionist WHERE id = $1`,
    [westRec.id],
  );
  const preUpdatedAt = before.rows[0]!.updated_at;

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/receptionists/${westRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'Receptionist West Renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.full_name, 'Receptionist West Renamed');
  assert.ok(res.body.updated_at);

  const postUpdatedAt = new Date(res.body.updated_at as string);
  assert.ok(
    postUpdatedAt.getTime() > preUpdatedAt.getTime(),
    `updated_at must advance: pre=${preUpdatedAt.toISOString()} post=${postUpdatedAt.toISOString()}`,
  );

  // DB-side pin.
  const persisted = await db.pool.query<{ full_name: string }>(
    `SELECT full_name FROM receptionist WHERE id = $1`,
    [westRec.id],
  );
  assert.equal(persisted.rows[0]!.full_name, 'Receptionist West Renamed');

  // Restore.
  await db.pool.query(`UPDATE receptionist SET full_name = 'Receptionist West' WHERE id = $1`, [
    westRec.id,
  ]);
});

test('PATCH /admin/receptionists/:id: reassign branch → 200 + branch_id updated', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const east = await fetchBranchByName('East Branch');
  const west = await fetchBranchByName('West Branch');

  // Sanity: Receptionist East starts at East.
  assert.equal(eastRec.branch_id, east.id);

  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_id: west.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.branch_id, west.id);
  assert.equal(res.body.branch.name, 'West Branch');

  // DB-side pin.
  const persisted = await db.pool.query<{ branch_id: string }>(
    `SELECT branch_id FROM receptionist WHERE id = $1`,
    [eastRec.id],
  );
  assert.equal(persisted.rows[0]!.branch_id, west.id);

  // Restore.
  await db.pool.query(`UPDATE receptionist SET branch_id = $1 WHERE id = $2`, [
    east.id,
    eastRec.id,
  ]);
});

test('PATCH /admin/receptionists/:id: deactivate CLEAN receptionist → 200 + warning: null', async () => {
  const token = __makeAdminToken();
  const westRec = await fetchReceptionistByName('Receptionist West');
  const west = await fetchBranchByName('West Branch');

  // Sanity: West has no future Scheduled appointment (seed only provisions one on East).
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [west.id],
  );
  assert.equal(
    Number(future.rows[0]!.count),
    0,
    'precondition: West has no future Scheduled',
  );

  const before = await db.pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM receptionist WHERE id = $1`,
    [westRec.id],
  );
  const preUpdatedAt = before.rows[0]!.updated_at;

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/receptionists/${westRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  assert.equal(res.body.warning, null);
  assert.equal(res.body.future_appointment_count, 0);

  // DB-side pin.
  const after = await db.pool.query<{ active: boolean; updated_at: Date }>(
    `SELECT active, updated_at FROM receptionist WHERE id = $1`,
    [westRec.id],
  );
  assert.equal(after.rows[0]!.active, false);
  assert.ok(
    after.rows[0]!.updated_at.getTime() > preUpdatedAt.getTime(),
    'updated_at must advance on deactivate clean',
  );

  // Restore.
  await db.pool.query(`UPDATE receptionist SET active = true WHERE id = $1`, [
    westRec.id,
  ]);
});

test('PATCH /admin/receptionists/:id: deactivate WITH future appointments → 200 + warning (NOT 409, F-19)', async () => {
  // Receptionist East's branch (East) has ≥1 future Scheduled appointment
  // (the seed provisions one). Deactivating must succeed with a warning,
  // NOT return 409.
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const east = await fetchBranchByName('East Branch');

  // Sanity.
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [east.id],
  );
  assert.ok(
    Number(future.rows[0]!.count) >= 1,
    'precondition: East branch has ≥1 future Scheduled',
  );

  const before = await db.pool.query<{ active: boolean; status: string }>(
    `SELECT r.active, a.status
       FROM receptionist r
       LEFT JOIN appointment a ON a.branch_id = r.branch_id AND a.start_datetime > now() AND a.status = 'Scheduled'
      WHERE r.id = $1
      LIMIT 1`,
    [eastRec.id],
  );
  const preActive = before.rows[0]!.active;

  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: false });
  assert.equal(res.status, 200, 'deactivate must NOT block on future appointments (F-19)');
  assert.equal(res.body.active, false);
  assert.equal(res.body.warning, 'receptionist_has_future_appointments');
  assert.ok(res.body.future_appointment_count >= 1);

  // DB-side pin: receptionist.active = false AND the future appointment is
  // still Scheduled (deactivate does not touch appointments).
  const after = await db.pool.query<{ active: boolean }>(
    `SELECT active FROM receptionist WHERE id = $1`,
    [eastRec.id],
  );
  assert.equal(after.rows[0]!.active, false);

  const apptStill = await db.pool.query<{ status: string }>(
    `SELECT status FROM appointment
       WHERE branch_id = $1 AND start_datetime > now()
       ORDER BY start_datetime ASC LIMIT 1`,
    [east.id],
  );
  assert.equal(
    apptStill.rows[0]!.status,
    'Scheduled',
    'future appointment must remain Scheduled after receptionist deactivation (F-19 explicit)',
  );

  // Restore: reactivate the receptionist so subsequent tests aren't affected.
  await db.pool.query(`UPDATE receptionist SET active = $1 WHERE id = $2`, [
    preActive,
    eastRec.id,
  ]);
});

test('PATCH /admin/receptionists/:id: reactivate → 200 + active=true', async () => {
  const token = __makeAdminToken();
  const westRec = await fetchReceptionistByName('Receptionist West');
  await db.pool.query(`UPDATE receptionist SET active = false WHERE id = $1`, [
    westRec.id,
  ]);

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/receptionists/${westRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, true);

  // DB-side pin.
  const persisted = await db.pool.query<{ active: boolean }>(
    `SELECT active FROM receptionist WHERE id = $1`,
    [westRec.id],
  );
  assert.equal(persisted.rows[0]!.active, true);

  // Restore.
  await db.pool.query(`UPDATE receptionist SET active = true WHERE id = $1`, [
    westRec.id,
  ]);
});

test('PATCH /admin/receptionists/:id: empty body → 400 no_fields_to_update', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'no_fields_to_update' });
});

test('PATCH /admin/receptionists/:id: invalid active → 400 invalid_active', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: 'maybe' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active' });
});

test('PATCH /admin/receptionists/:id: invalid branch_id → 400 invalid_branch_id + fields[]', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_id: 'not-a-uuid' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_branch_id');
  assert.ok(res.body.fields.includes('not-a-uuid'));
});

test('PATCH /admin/receptionists/:id: unknown branch_id → 400 branch_not_found + fields[]', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const randomUuid = '00000000-0000-4000-8000-000000000600';
  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ branch_id: randomUuid });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'branch_not_found', fields: [randomUuid] });
});

test('PATCH /admin/receptionists/:id: unknown fields → 400 unknown_field', async () => {
  const token = __makeAdminToken();
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'No Effect', surprise: true, role: 'super' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.ok(res.body.fields.includes('surprise'));
  assert.ok(res.body.fields.includes('role'));
});

test('PATCH /admin/receptionists/:id: unknown id → 404 receptionist_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000700';
  const res = await request(adminApp())
    .patch(`/admin/receptionists/${randomUuid}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'No Such' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'receptionist_not_found' });
});

test('PATCH /admin/receptionists/:id: non-UUID id → 400 invalid_receptionist_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/receptionists/not-a-uuid')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'Whatever' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_receptionist_id' });
});

test('PATCH /admin/receptionists/:id: no auth → 401', async () => {
  const eastRec = await fetchReceptionistByName('Receptionist East');
  const res = await request(adminApp())
    .patch(`/admin/receptionists/${eastRec.id}`)
    .set('content-type', 'application/json')
    .send({ full_name: 'No Auth' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});