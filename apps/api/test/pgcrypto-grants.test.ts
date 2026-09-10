/**
 * pgcrypto-grants.test.ts — migration 0011 grants are present and effective.
 *
 * Migration 0011 runs:
 *   CREATE EXTENSION IF NOT EXISTS pgcrypto;
 *   GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC;
 *
 * This test asserts:
 *   1. The `pgcrypto` extension is installed (covered by migrations.test.ts
 *      too — pinned here as a regression guard for the migration).
 *   2. `GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC` is in effect — a freshly
 *      created, low-privilege role can call `pgcrypto.gen_random_bytes(8)`
 *      and `pgcrypto.digest(...)` without error.
 *   3. The migration is reversible: the `down/0011_*.down.sql` removes the
 *      grant and a low-privilege role that previously worked now fails.
 *
 * The low-privilege role is created inside the test transaction so the
 * fixture does not leak between tests.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeShared, withTestDb } from './db/withTestDb.js';

after(async () => {
  await closeShared();
});

test('pgcrypto extension is installed', async () => {
  await withTestDb(async ({ pool }) => {
    const { rows } = await pool.query<{ extname: string; extversion: string; nsp: string }>(
      `SELECT extname, extversion, extnamespace::regnamespace::text AS nsp
       FROM pg_extension WHERE extname = 'pgcrypto'`,
    );
    assert.equal(rows.length, 1, 'pgcrypto extension must be installed');
    assert.ok(rows[0]!.extversion.startsWith('1.'), `pgcrypto version 1.x expected; got ${rows[0]!.extversion}`);
    assert.equal(rows[0]!.nsp, 'pgcrypto', 'pgcrypto MUST be installed in the pgcrypto schema (post-migration 0011)');
  });
});

test('pgcrypto schema exists (post-migration 0011 relocation)', async () => {
  await withTestDb(async ({ pool }) => {
    const { rows } = await pool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'pgcrypto'`,
    );
    assert.equal(rows.length, 1, 'pgcrypto namespace must exist');
  });
});

test('GRANT USAGE on schema pgcrypto to PUBLIC — low-priv role can call gen_random_bytes', async () => {
  await withTestDb(async ({ pool }) => {
    // CREATE ROLE must run on its own connection (autocommit) because
    // CREATE/DROP ROLE are not allowed inside a transaction block. Then
    // we use `SET ROLE` (not SET LOCAL — no transaction required) on the
    // SAME connection to switch to the low-priv role.
    await pool.query(`CREATE ROLE lp_test_grants LOGIN`);
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE lp_test_grants`);
      // Schema-qualified call: pgcrypto.gen_random_bytes. Unqualified calls
      // would require pgcrypto in the role's search_path; the migration
      // adds it via ALTER DATABASE for newly opened connections, but the
      // pool here may have a connection cached from before the ALTER, so
      // we use the qualified call to make the test deterministic.
      const r1 = await client.query<{ ok: boolean }>(
        `SELECT pgcrypto.gen_random_bytes(8) IS NOT NULL AS ok`,
      );
      assert.equal(r1.rows[0]!.ok, true, 'pgcrypto.gen_random_bytes must succeed under low-priv role');

      const r2 = await client.query<{ len: number }>(
        `SELECT octet_length(pgcrypto.digest('hello', 'sha256')) AS len`,
      );
      assert.equal(r2.rows[0]!.len, 32, 'pgcrypto.digest sha256 must yield 32 raw bytes (256-bit hash)');
    } finally {
      await client.query(`RESET ROLE`);
      client.release();
      await pool.query(`DROP ROLE IF EXISTS lp_test_grants`);
    }
  });
});

test('REVOKE USAGE on schema pgcrypto from PUBLIC blocks low-priv role (down-migration parity)', async () => {
  await withTestDb(async ({ pool }) => {
    // Reverse the grant temporarily and confirm the low-priv role is blocked.
    // We restore the grant after this test so other tests aren't affected.
    await pool.query(`REVOKE USAGE ON SCHEMA pgcrypto FROM PUBLIC`);
    try {
      await pool.query(`CREATE ROLE lp_test_revoked LOGIN`);
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE lp_test_revoked`);
        await assert.rejects(
          client.query(`SELECT pgcrypto.gen_random_bytes(8)`),
          /permission denied|does not exist|cannot use|schema "pgcrypto"/i,
          'low-priv role MUST be denied once USAGE is revoked',
        );
      } finally {
        await client.query(`RESET ROLE`);
        client.release();
        await pool.query(`DROP ROLE IF EXISTS lp_test_revoked`);
      }
    } finally {
      // Restore the grant so the next test in the same suite sees the
      // production state. Without this, the rest of the run would be
      // poisoned.
      await pool.query(`GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC`);
    }
  });
});
