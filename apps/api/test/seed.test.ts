/**
 * seed.test.ts — live snapshot-then-replay test for the E0-S1 minimum seed.
 *
 * Rewritten from the source-level-only version (E0-S1) into a real DB-touching
 * assertion (E0-S2 AC-9). Compares the `(table, pk, name/email)` set between
 * two equivalent seed operations — not just row counts, because a TRUNCATE-
 * and-reinsert seed would pass a count-only assertion while violating the
 * idempotency contract.
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
import { seedWith } from '../db/seeds/01_minimum.js';

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

async function snapshot(db: TestDb): Promise<RowKey[]> {
  const refs: Array<[string, string, string | null]> = [
    ['clinic', 'id', 'name'],
    ['branch', 'id', 'name'],
    ['doctor', 'id', 'full_name'],
    ['doctor_branch', "doctor_id || '-' || branch_id", null],
    ['receptionist', 'id', 'email'],
    ['admin_user', 'id', 'email'],
  ];
  const out: RowKey[] = [];
  for (const [table, idCol, identCol] of refs) {
    const sql =
      identCol !== null
        ? `SELECT ${idCol}::text AS pk, ${identCol}::text AS ident FROM ${table}`
        : `SELECT ${idCol}::text AS pk, NULL::text AS ident FROM ${table}`;
    // Column names are not user input here (hardcoded list); identifier is
    // safely escaped via ::text casts.
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
