/**
 * seed.test.ts — live snapshot-then-replay test for the E0-S5 minimum seed.
 *
 * Rewritten from the source-level-only version (E0-S1) into a real DB-touching
 * assertion (E0-S2 AC-9). Compares the `(table, pk, identifier)` set between
 * two equivalent seed operations — not just row counts, because a TRUNCATE-
 * and-reinsert seed would pass a count-only assertion while violating the
 * idempotency contract.
 *
 * E0-S5 widens the snapshot to cover the new entities (`patient`,
 * `appointment_type`, `appointment`) and adds:
 *   - "patient 0001 has future appointment" assertion (AC-3)
 *   - `seed_unchanged` path assertion (AC-2): a second `seedWith` invocation
 *     reports `inserted: false` (the CLI wrapper maps this to the
 *     `seed_unchanged` structured log; the assertion here is on the flag,
 *     which is the source-of-truth side of the mapping).
 *
 * P24: the test imports `seedWith` from `db/seeds/01_minimum.ts` (the
 * production seed) instead of duplicating its logic. This is the only way
 * the test can catch a regression in the production seed itself.
 *
 * D8: no `beforeEach` TRUNCATE — the seed is idempotent and other DB-touching
 * tests in the same worker rely on accumulated fixture rows. Pool isolation
 * (one pool per worker) is the only isolation boundary; within it, fixtures
 * accumulate.
 *
 * D7: no per-file `closeShared()` — the shared pool is closed by
 * `process.on('beforeExit')` (with SIGTERM/SIGINT handlers). Closing in
 * `after()` would race with sibling test files that have not yet finished.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { seedWith, formatSeedLog, type SeedResult } from '../db/seeds/01_minimum.js';
import { loadPatient } from './fixtures/loader.js';
import { PATIENT_0001_PHONE } from '../db/seeds/02_role_ids.js';

let db: TestDb;

before(async () => {
  db = await getTestDb();
});

after(async () => {
  // No-op: cleanup is process-level (see withTestDb.ts).
});

interface RowKey {
  table: string;
  pk: string;
  identifier: string | null;
}

/**
 * Snapshot the deterministic identity of every row in the seed-managed
 * tables. The PK is the table's primary key (or composite PK for
 * `doctor_branch`). The identifier is a human-readable label that lets the
 * snapshot distinguish "Dr. East Lead" from "Dr. East Support" — without
 * it, two doctors in the same branch would collide on `pk` for `doctor_branch`.
 *
 * Column names are not user input here (hardcoded list); identifiers are
 * safely escaped via ::text casts.
 */
async function snapshot(db: TestDb): Promise<RowKey[]> {
  const refs: Array<[string, string, string | null]> = [
    ['clinic', 'id', 'name'],
    ['branch', 'id', 'name'],
    ['doctor', 'id', 'full_name'],
    ['doctor_branch', "doctor_id || '-' || branch_id", null],
    ['receptionist', 'id', 'email'],
    ['admin_user', 'id', 'email'],
    ['patient', 'id', 'phone_number'],
    ['appointment_type', 'id', 'name'],
    ['appointment', 'id', "doctor_id || '-' || patient_phone"],
  ];
  const out: RowKey[] = [];
  for (const [table, idCol, identCol] of refs) {
    const sql =
      identCol !== null
        ? `SELECT ${idCol}::text AS pk, ${identCol}::text AS ident FROM ${table}`
        : `SELECT ${idCol}::text AS pk, NULL::text AS ident FROM ${table}`;
    const { rows } = await db.pool.query<{ pk: string; ident: string | null }>(sql);
    for (const r of rows) out.push({ table, pk: r.pk, identifier: r.ident });
  }
  return out;
}

const keyOf = (r: RowKey): string => `${r.table}|${r.pk}|${r.identifier ?? ''}`;

test('AC-9: seed is idempotent — snapshot set identical between runs', async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const first = await snapshot(db);
  assert.ok(first.length > 0, 'first seed run should produce rows');

  const client2 = await db.pool.connect();
  try {
    await client2.query('BEGIN');
    await seedWith(client2);
    await client2.query('COMMIT');
  } finally {
    client2.release();
  }
  const second = await snapshot(db);

  const firstKeys = new Set(first.map(keyOf));
  const secondKeys = new Set(second.map(keyOf));

  const onlyFirst = [...firstKeys].filter((k) => !secondKeys.has(k));
  const onlySecond = [...secondKeys].filter((k) => !firstKeys.has(k));

  assert.deepEqual(
    onlyFirst,
    [],
    `rows present in first run but missing in second: ${onlyFirst.join(', ')}`,
  );
  assert.deepEqual(
    onlySecond,
    [],
    `rows present in second run but missing in first: ${onlySecond.join(', ')}`,
  );
  assert.equal(firstKeys.size, secondKeys.size, 'snapshot set sizes must match');
});

test('seed runs without error against a populated DB', async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await seedWith(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const snap = await snapshot(db);
  assert.ok(snap.length > 0, 'seed must produce rows on a populated DB');
});

test('AC-2: second seed run returns inserted=false (seeds the seed_unchanged log path)', async () => {
  // The seed has been run at least once (by the prior tests in this file).
  // A fresh run on the populated DB must be a true no-op — no new rows.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await seedWith(client);
    await client.query('COMMIT');
    assert.equal(
      result.inserted,
      false,
      `second run on a populated DB must report inserted=false (the CLI logs 'seed_unchanged' on this path); got inserted=${result.inserted}`,
    );
    assert.ok(result.rowCount > 0, 'rowCount must reflect the existing rows');
  } finally {
    client.release();
  }
});

test('AC-3: patient 0001 carries exactly one Scheduled future appointment', async () => {
  // The seed's "patient 0001 has future appointment" assertion is split into
  // two halves: (a) the fixture file declares the boolean true; (b) the DB
  // has exactly one Scheduled appointment for that phone. Reading the
  // fixture via the loader also exercises the path-based fixture loading.
  const fixture = loadPatient('0001');
  assert.equal(fixture.phone_number, PATIENT_0001_PHONE);
  assert.equal(fixture.has_future_appointment, true);

  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM appointment
     WHERE patient_phone = $1 AND status = 'Scheduled' AND start_datetime > now()`,
    [PATIENT_0001_PHONE],
  );
  const count = Number(rows[0]!.count);
  // P1: strict equality — the seed creates exactly one Scheduled future
  // appointment for patient 0001. A `>= 1` assertion would let a duplicate
  // insert pass silently if the idempotency contract regressed.
  assert.equal(
    count,
    1,
    `patient ${PATIENT_0001_PHONE} must have exactly one future Scheduled appointment; got ${count}`,
  );
});

test('P3: formatSeedLog emits seed_complete on insert, seed_unchanged on no-op (single JSON line)', () => {
  // The CLI `seed()` owns the `seed_complete` / `seed_unchanged` mapping.
  // Rather than driving `seed()` through a pool (which would require
  // DATABASE_URL or a real Testcontainers), exercise the pure formatter
  // directly. This pins the AC-2 contract: the printed line is exactly one
  // JSON object whose `event` field tracks the `inserted` boolean.
  const insertLine = formatSeedLog({ inserted: true, rowCount: 9 });
  let parsed: { event?: unknown; rowCount?: unknown };
  try {
    parsed = JSON.parse(insertLine) as typeof parsed;
  } catch {
    assert.fail(`insert path must emit valid JSON; got: ${insertLine}`);
  }
  assert.equal(parsed.event, 'seed_complete', 'insert path → seed_complete');
  assert.equal(parsed.rowCount, 9, 'rowCount must round-trip');

  const noopLine = formatSeedLog({ inserted: false, rowCount: 9 });
  let parsedNoop: { event?: unknown; rowCount?: unknown };
  try {
    parsedNoop = JSON.parse(noopLine) as typeof parsedNoop;
  } catch {
    assert.fail(`no-op path must emit valid JSON; got: ${noopLine}`);
  }
  assert.equal(parsedNoop.event, 'seed_unchanged', 'no-op path → seed_unchanged');
  assert.equal(parsedNoop.rowCount, 9, 'rowCount must round-trip');
});

test('P3b: live seed returns the same event the formatter expects (inserted=false → seed_unchanged)', async () => {
  // The seed has been run at least once by the prior tests in this file.
  // A second invocation against the populated DB returns `inserted: false`,
  // which the formatter maps to `seed_unchanged` — this is the production
  // shape AC-2 promises. Cross-checks the formatter against the live flag.
  const client = await db.pool.connect();
  let result: SeedResult;
  try {
    await client.query('BEGIN');
    result = await seedWith(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const line = formatSeedLog(result);
  const parsed = JSON.parse(line) as { event: string; rowCount: number };
  assert.equal(parsed.event, 'seed_unchanged');
  assert.ok(parsed.rowCount > 0);
});
