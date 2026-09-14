/**
 * admin-branches.test.ts — full I/O matrix for `POST/GET/PATCH /admin/branches`
 * and `GET /admin/branches/:id`.
 *
 * Covers every row of the spec's I/O & Edge-Case Matrix:
 *   - POST happy path (admin token) → 201 with full row.
 *   - POST empty / over-length / missing / non-string name → 400 invalid_name.
 *   - POST without auth → 401 unauthenticated.
 *   - POST with patient JWT → 403 forbidden_role.
 *   - GET list returns both seeded branches (East + West).
 *   - GET ?active=true / ?active=false filters.
 *   - GET ?active=banana → 400 invalid_active_filter.
 *   - GET single branch by id → 200; unknown id → 404; non-UUID → 400.
 *   - PATCH rename → 200 + updated_at advances.
 *   - PATCH deactivate on a clean branch (West) → 200 + active=false.
 *   - PATCH deactivate on a branch with a future Scheduled appointment
 *     (East — the seed provisions one) → 409 branch_has_future_appointments
 *     AND branch.active stays unchanged (transaction rolled back).
 *   - PATCH reactivate → 200 + active=true.
 *   - PATCH empty body → 400 no_fields_to_update.
 *   - PATCH invalid active → 400 invalid_active.
 *   - PATCH unknown id → 404.
 *   - PATCH without auth → 401.
 *
 * Tests seed the DB once via `seedWith(client)` in `before()` so the
 * future appointment on East Branch exists for the conflict check.
 * After-hook restores the DB to its seeded state (delete any newly
 * created branches, reactivate any deactivated branches) so sibling
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
  // Seed once — every test in this file reads against the seeded DB. If a
  // sibling test file (e.g. seed.test.ts) already ran the seed, this is a
  // no-op (seed is idempotent via SELECT-then-INSERT + ON CONFLICT).
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
  // Cleanup: scoped to the seeded branch names so a sibling test file
  // that intentionally sets some other branch inactive (e.g. a future
  // appointments test) is not flattened by this hook (P9 from E1-S1
  // review-loop-1). Restore `active=true` on East + West, and remove any
  // branches created by POST tests in this file.
  await db.pool.query(`DELETE FROM branch WHERE name NOT IN ('East Branch', 'West Branch')`);
  await db.pool.query(
    `UPDATE branch SET active = true WHERE name IN ('East Branch', 'West Branch') AND active = false`,
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
// POST /admin/branches
// ===========================================================================

test('POST /admin/branches: happy path returns 201 with full row, active=true', async () => {
  const token = __makeAdminToken();
  const uniqueName = `New Branch ${Date.now()}`;
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: uniqueName });
  assert.equal(res.status, 201);
  assert.ok(typeof res.body.id === 'string');
  assert.ok(typeof res.body.clinic_id === 'string');
  assert.equal(res.body.name, uniqueName);
  assert.equal(res.body.active, true, 'newly created branches default to active=true');
  assert.ok(res.body.created_at);
  assert.ok(res.body.updated_at);

  // Verify the row is in the DB, findable by NAME (per spec AC: "the row
  // is queryable via SELECT * FROM branch WHERE name = 'New Branch'").
  // The previous shape queried by id; that hides a regression where the
  // route stored a different name than the one in the response.
  const byName = await db.pool.query<{ id: string; active: boolean }>(
    `SELECT id, active FROM branch WHERE name = $1`,
    [uniqueName],
  );
  assert.equal(byName.rows.length, 1, 'row must be findable by name');
  assert.equal(byName.rows[0]!.id, res.body.id);
  assert.equal(byName.rows[0]!.active, true);
});

test('POST /admin/branches: empty name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const before = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM branch`,
  );
  const preCount = Number(before.rows[0]!.count);

  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: '' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });

  // No row inserted.
  const after = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM branch`,
  );
  assert.equal(Number(after.rows[0]!.count), preCount);
});

test('POST /admin/branches: 121-char name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'a'.repeat(121) });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('POST /admin/branches: missing name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('POST /admin/branches: null name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: null });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('POST /admin/branches: non-string name → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 123 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('POST /admin/branches: whitespace-only name → 400 invalid_name (post-trim length check)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: '     ' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('POST /admin/branches: leading/trailing whitespace is trimmed before storing', async () => {
  const token = __makeAdminToken();
  const unique = `Trimmed Branch ${Date.now()}`;
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: `  ${unique}  ` });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, unique, 'response carries trimmed name');

  // DB-side pin: query by the trimmed name (whitespace-stripped variant
  // would not match the unique value if a regression stored the untrimmed
  // form). If the untrimmed form were stored, the WHERE clause below
  // returns 0 rows.
  const persisted = await db.pool.query<{ name: string }>(
    `SELECT name FROM branch WHERE name = $1`,
    [unique],
  );
  assert.equal(persisted.rows.length, 1, 'trimmed name must be the persisted form');
  assert.equal(persisted.rows[0]!.name, unique);
});

test('POST /admin/branches: no auth → 401 unauthenticated', async () => {
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('content-type', 'application/json')
    .send({ name: 'No Auth Branch' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('POST /admin/branches: malformed JSON → 400 invalid_json (P-A5 from E1-S1 review)', async () => {
  // express.json() throws SyntaxError on unclosed brackets; the global
  // error handler maps that to 400 invalid_json (not 500). This is a
  // cross-cutting fix in app.ts; the admin-branches route is a convenient
  // vehicle to exercise it.
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send('{name: "No closing brace"');
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_json' });
});

test('POST /admin/branches: patient JWT → 403 forbidden_role', async () => {
  const res = await request(adminApp())
    .post('/admin/branches')
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({ name: 'Patient Tries Branch' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});

// ===========================================================================
// GET /admin/branches
// ===========================================================================

test('GET /admin/branches: happy path returns both seeded branches', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/branches')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  // Filter to the seeded names so earlier POST tests in this file (which
  // create extra rows and only get cleaned up in `after()`) don't cause
  // flakiness here. The seeded set is exactly {East, West}.
  const seeded = res.body.filter(
    (b: { name: string }) =>
      b.name === 'East Branch' || b.name === 'West Branch',
  );
  assert.equal(seeded.length, 2, 'seeded branches: East + West');
  const names = seeded.map((b: { name: string }) => b.name).sort();
  assert.deepEqual(names, ['East Branch', 'West Branch']);
  for (const b of seeded) {
    assert.equal(b.active, true);
    assert.ok(typeof b.id === 'string');
    assert.ok(typeof b.clinic_id === 'string');
    assert.ok(b.created_at);
    assert.ok(b.updated_at);
  }
});

test('GET /admin/branches?active=true filters out inactive branches', async () => {
  const token = __makeAdminToken();
  // Deactivate West Branch temporarily.
  const west = await fetchBranchByName('West Branch');
  await db.pool.query(`UPDATE branch SET active = false WHERE id = $1`, [west.id]);
  try {
    const res = await request(adminApp())
      .get('/admin/branches?active=true')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    // Filter to seeded names; earlier POST tests in this file may have
    // added extra rows that are still active=true. The point of this test
    // is the filter — confirm West is excluded among seeded branches.
    const seededActive = res.body.filter(
      (b: { name: string }) =>
        b.name === 'East Branch' || b.name === 'West Branch',
    );
    assert.equal(seededActive.length, 1, 'only East Branch should be active among seeded');
    assert.equal(seededActive[0].name, 'East Branch');
  } finally {
    await db.pool.query(`UPDATE branch SET active = true WHERE id = $1`, [west.id]);
  }
});

test('GET /admin/branches?active=false returns only inactive branches', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  await db.pool.query(`UPDATE branch SET active = false WHERE id = $1`, [west.id]);
  try {
    const res = await request(adminApp())
      .get('/admin/branches?active=false')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1, 'only West Branch should be inactive');
    assert.equal(res.body[0].name, 'West Branch');
    assert.equal(res.body[0].active, false);
  } finally {
    await db.pool.query(`UPDATE branch SET active = true WHERE id = $1`, [west.id]);
  }
});

test('GET /admin/branches?active=banana → 400 invalid_active_filter', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/branches?active=banana')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active_filter' });
});

test('GET /admin/branches: no auth → 401 unauthenticated', async () => {
  const res = await request(adminApp()).get('/admin/branches');
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// GET /admin/branches/:id
// ===========================================================================

test('GET /admin/branches/:id: happy path returns the branch row', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .get(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, east.id);
  assert.equal(res.body.name, 'East Branch');
  assert.equal(res.body.active, true);
  assert.ok(res.body.created_at);
  assert.ok(res.body.updated_at);
});

test('GET /admin/branches/:id: unknown UUID → 404 branch_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000000';
  const res = await request(adminApp())
    .get(`/admin/branches/${randomUuid}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'branch_not_found' });
});

test('GET /admin/branches/:id: non-UUID id → 400 invalid_branch_id (no DB lookup)', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .get('/admin/branches/not-a-uuid')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_id' });
});

test('GET /admin/branches/:id: uppercase UUID → 200 (case-insensitive at regex + DB layer)', async () => {
  // PostgreSQL `uuid` type normalizes uppercase on input; the
  // route's regex is case-insensitive (/.../i). End-to-end case
  // insensitivity is locked in here (P-C3 from E1-S1 review-loop-1).
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const upper = east.id.toUpperCase();
  const res = await request(adminApp())
    .get(`/admin/branches/${upper}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, east.id);
});

test('GET /admin/branches/:id: no auth → 401 unauthenticated', async () => {
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp()).get(`/admin/branches/${east.id}`);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

// ===========================================================================
// PATCH /admin/branches/:id
// ===========================================================================

test('PATCH /admin/branches/:id: rename → 200 + updated_at advances', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  const before = await db.pool.query<{ name: string; updated_at: Date }>(
    `SELECT name, updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  const pre = before.rows[0]!;
  const preUpdatedAt = pre.updated_at;

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'West Branch Renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'West Branch Renamed');
  assert.ok(res.body.updated_at);

  const postUpdatedAt = new Date(res.body.updated_at as string);
  assert.ok(
    postUpdatedAt.getTime() > preUpdatedAt.getTime(),
    `updated_at must advance: pre=${preUpdatedAt.toISOString()} post=${postUpdatedAt.toISOString()}`,
  );

  // DB-side pin: confirm the rename was persisted (not just response-shaped).
  const persisted = await db.pool.query<{ name: string; updated_at: Date }>(
    `SELECT name, updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.equal(persisted.rows[0]!.name, 'West Branch Renamed',
    'DB row must carry the new name');
  assert.ok(
    persisted.rows[0]!.updated_at.getTime() > preUpdatedAt.getTime(),
    'DB-side updated_at must also advance (proves trigger fired)',
  );

  // Restore.
  await db.pool.query(`UPDATE branch SET name = 'West Branch' WHERE id = $1`, [
    west.id,
  ]);
});

test('PATCH /admin/branches/:id: rename on a branch with future Scheduled appointment (East) succeeds — rename is orthogonal to deactivation', async () => {
  // East Branch has ≥1 future Scheduled appointment (per the seed).
  // Renaming East must NOT trigger the deactivate conflict check —
  // rename is a single-statement UPDATE with no transaction, no conflict
  // check. This pins the orthogonality between rename and deactivate.
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [east.id],
  );
  assert.ok(
    Number(future.rows[0]!.count) >= 1,
    'precondition: East has ≥1 future Scheduled',
  );
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'East Branch Renamed' });
  assert.equal(res.status, 200, 'rename must succeed even with future appointments');
  assert.equal(res.body.name, 'East Branch Renamed');
  // Restore.
  await db.pool.query(`UPDATE branch SET name = 'East Branch' WHERE id = $1`, [east.id]);
});

test('PATCH /admin/branches/:id: deactivate CLEAN branch (West) → 200 + active=false + updated_at advances', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  // Sanity: West has no future Scheduled appointment (the seed only provisions one on East).
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [west.id],
  );
  assert.equal(Number(future.rows[0]!.count), 0, 'precondition: West has no future Scheduled');

  const before = await db.pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  const preUpdatedAt = before.rows[0]!.updated_at;

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);

  // DB confirms.
  const after = await db.pool.query<{ active: boolean; updated_at: Date }>(
    `SELECT active, updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.equal(after.rows[0]!.active, false);
  assert.ok(
    after.rows[0]!.updated_at.getTime() > preUpdatedAt.getTime(),
    'updated_at must advance on deactivate clean',
  );

  // Restore.
  await db.pool.query(`UPDATE branch SET active = true WHERE id = $1`, [west.id]);
});

test('PATCH /admin/branches/:id: deactivate CONFLICT branch (East, has future Scheduled appointment) → 409 + rollback', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  // Sanity: East has at least 1 future Scheduled appointment (the seed provisions one).
  const future = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointment
       WHERE branch_id = $1 AND start_datetime > now() AND status = 'Scheduled'`,
    [east.id],
  );
  assert.ok(
    Number(future.rows[0]!.count) >= 1,
    'precondition: East has ≥1 future Scheduled',
  );

  // Snapshot active + updated_at before attempt.
  const pre = await db.pool.query<{ active: boolean; updated_at: Date }>(
    `SELECT active, updated_at FROM branch WHERE id = $1`,
    [east.id],
  );
  const preState = pre.rows[0]!;
  assert.equal(preState.active, true);

  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: false });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'branch_has_future_appointments' });

  // Confirm the transaction rolled back on BOTH active AND updated_at.
  // The trigger advances updated_at BEFORE the row is written; a partial
  // rollback that only restored `active` (impossible in PG, but the test
  // pins the invariant) would slip through if we only checked `active`.
  const post = await db.pool.query<{ active: boolean; updated_at: Date }>(
    `SELECT active, updated_at FROM branch WHERE id = $1`,
    [east.id],
  );
  assert.equal(
    post.rows[0]!.active,
    true,
    'branch.active must be unchanged after a 409 (transaction rolled back)',
  );
  assert.equal(
    post.rows[0]!.updated_at.getTime(),
    preState.updated_at.getTime(),
    'branch.updated_at must also be unchanged after a 409 (full row-state rollback)',
  );
});

test('PATCH /admin/branches/:id: deactivate on UNKNOWN UUID → 404 branch_not_found (tx path, SELECT FOR UPDATE returns 0 rows)', async () => {
  // This exercises the branch_not_found branch INSIDE the deactivate
  // transaction (SELECT FOR UPDATE returns 0 rows → ROLLBACK → 404).
  // The previous unknown-id PATCH test only sent a name-only payload,
  // which routed through the single-field rename path, NOT the tx path.
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000002';
  const res = await request(adminApp())
    .patch(`/admin/branches/${randomUuid}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: false });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'branch_not_found' });
});

test('PATCH /admin/branches/:id: reactivate → 200 + active=true', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  // Start from inactive.
  await db.pool.query(`UPDATE branch SET active = false WHERE id = $1`, [west.id]);

  const before = await db.pool.query<{ updated_at: Date }>(
    `SELECT updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  const preUpdatedAt = before.rows[0]!.updated_at;

  await new Promise((r) => setTimeout(r, 10));

  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, true);

  // DB-side pin (P6 from E1-S1 review-loop-1).
  const persisted = await db.pool.query<{ active: boolean; updated_at: Date }>(
    `SELECT active, updated_at FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.equal(persisted.rows[0]!.active, true, 'DB row must carry active=true');
  assert.ok(
    persisted.rows[0]!.updated_at.getTime() > preUpdatedAt.getTime(),
    'updated_at must advance on reactivate',
  );

  // Restore for any later test.
  await db.pool.query(`UPDATE branch SET active = true WHERE id = $1`, [west.id]);
});

test('PATCH /admin/branches/:id: empty body → 400 no_fields_to_update', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({});
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'no_fields_to_update' });
});

test('PATCH /admin/branches/:id: invalid active (string) → 400 invalid_active', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: 'maybe' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active' });
});

test('PATCH /admin/branches/:id: invalid active (number) → 400 invalid_active', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ active: 1 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_active' });
});

test('PATCH /admin/branches/:id: invalid name (empty) → 400 invalid_name', async () => {
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: '' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' });
});

test('PATCH /admin/branches/:id: name validated BEFORE active (combined invalid → invalid_name)', async () => {
  // Combined invalid payload: BOTH name="" AND active=false. The route
  // validates name FIRST; the response must be invalid_name, not
  // invalid_active (P14 from E1-S1 review-loop-1). A regression that
  // reordered validation would silently flip the error code.
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  const pre = await db.pool.query<{ name: string; active: boolean }>(
    `SELECT name, active FROM branch WHERE id = $1`,
    [west.id],
  );
  const preName = pre.rows[0]!.name;
  const preActive = pre.rows[0]!.active;

  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: '', active: false });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_name' },
    'name validation must run before active validation');

  // DB unchanged on BOTH fields (validation rejects BEFORE any tx).
  const post = await db.pool.query<{ name: string; active: boolean }>(
    `SELECT name, active FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.equal(post.rows[0]!.name, preName);
  assert.equal(post.rows[0]!.active, preActive);
});

test('PATCH /admin/branches/:id: unknown fields → 400 unknown_field (privilege-escalation guard)', async () => {
  // {role: 'super', clinic_id: '...', branch_ids: [...]} must be rejected
  // even though the route silently ignored the fields before P-A1. The
  // 400 envelope lists the unknown keys so the caller can debug.
  const token = __makeAdminToken();
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'No Effect', role: 'superadmin', clinic_id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_field');
  assert.ok(Array.isArray(res.body.fields));
  assert.ok(res.body.fields.includes('role'));
  assert.ok(res.body.fields.includes('clinic_id'));

  // DB unchanged (rejected before any UPDATE).
  const post = await db.pool.query<{ name: string }>(
    `SELECT name FROM branch WHERE id = $1`,
    [east.id],
  );
  assert.equal(post.rows[0]!.name, 'East Branch');
});

test('PATCH /admin/branches/:id: rename + deactivate CLEAN branch → 200 with both changes (DB-pinned)', async () => {
  const token = __makeAdminToken();
  const west = await fetchBranchByName('West Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${west.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'West Both', active: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'West Both');
  assert.equal(res.body.active, false);

  // DB-side atomicity pin (P5/P13 from E1-S1 review-loop-1): confirm
  // BOTH fields persisted atomically inside the transaction. The dynamic
  // SET clause must contain both `name = $1` and `active = $2`; a
  // regression that hardcoded `UPDATE branch SET active = $1` would
  // slip past a response-only assertion.
  const persisted = await db.pool.query<{ name: string; active: boolean }>(
    `SELECT name, active FROM branch WHERE id = $1`,
    [west.id],
  );
  assert.equal(persisted.rows[0]!.name, 'West Both',
    'name must be persisted atomically with active flip');
  assert.equal(persisted.rows[0]!.active, false,
    'active must be persisted atomically with the rename');

  // Restore.
  await db.pool.query(
    `UPDATE branch SET name = 'West Branch', active = true WHERE id = $1`,
    [west.id],
  );
});

test('PATCH /admin/branches/:id: unknown id → 404 branch_not_found', async () => {
  const token = __makeAdminToken();
  const randomUuid = '00000000-0000-4000-8000-000000000001';
  const res = await request(adminApp())
    .patch(`/admin/branches/${randomUuid}`)
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'No Such' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'branch_not_found' });
});

test('PATCH /admin/branches/:id: non-UUID id → 400 invalid_branch_id', async () => {
  const token = __makeAdminToken();
  const res = await request(adminApp())
    .patch('/admin/branches/not-a-uuid')
    .set('Authorization', `Bearer ${token}`)
    .set('content-type', 'application/json')
    .send({ name: 'Whatever' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_branch_id' });
});

test('PATCH /admin/branches/:id: no auth → 401 unauthenticated', async () => {
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('content-type', 'application/json')
    .send({ name: 'No Auth Rename' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'unauthenticated' });
});

test('PATCH /admin/branches/:id: patient JWT → 403 forbidden_role', async () => {
  const east = await fetchBranchByName('East Branch');
  const res = await request(adminApp())
    .patch(`/admin/branches/${east.id}`)
    .set('Authorization', `Bearer ${patientToken()}`)
    .set('content-type', 'application/json')
    .send({ name: 'Patient Rename' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'forbidden_role' });
});
