/**
 * globalSetup for node:test with --test flag.
 *
 * Boots one Postgres container for the test worker and applies migrations.
 * The pool URL is exported via `DATABASE_URL` env var so individual test files
 * can use `withTestDb()` without re-booting.
 *
 * To enable: configure Node's test runner via `--test-global-setup=...` (not
 * yet supported by node:test as of Node 20). Workaround used here: each test
 * file calls `getTestDb()` lazily on first use; `closeShared()` is wired to
 * `process.on('beforeExit')`.
 */
import { closeShared, getTestDb } from '../db/withTestDb.js';

export async function setup(): Promise<void> {
  await getTestDb();
  // Defensive: ensure cleanup runs on process exit.
  process.on('beforeExit', () => {
    void closeShared();
  });
}
