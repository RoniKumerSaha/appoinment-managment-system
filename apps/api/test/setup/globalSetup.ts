/**
 * globalSetup for node:test with `--test-global-setup` flag.
 *
 * Boots one Postgres container for the test worker and applies migrations.
 * The pool URL is exported via `DATABASE_URL` env var so individual test
 * files can use `withTestDb()` without re-booting.
 *
 * Requires Node ≥ 22 (`--test-global-setup` support). Wired via:
 *   apps/api/package.json scripts.test → node --test --test-global-setup=…
 *
 * The actual per-process cleanup (closing the pool + stopping the container)
 * is registered in `withTestDb.ts` so it fires even if this `setup()` never
 * runs (e.g., dev environments running tests against a live DATABASE_URL).
 */
import { getTestDb } from '../db/withTestDb.js';

export async function setup(): Promise<void> {
  // Trigger lazy singleton creation. The returned pool is then cached for the
  // rest of the worker's lifetime; cleanup runs on beforeExit / SIGTERM /
  // SIGINT (see withTestDb.ts).
  await getTestDb();
}
