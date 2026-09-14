/**
 * DB-touching test helper.
 *
 * Two operating modes:
 *
 * 1. **TESTCONTAINERS mode (CI default):** spins up a `postgres:16-alpine`
 *    container, applies all migrations, yields a pool. The container is
 *    stopped when the process exits (beforeExit / SIGTERM / SIGINT).
 *
 * 2. **DATABASE_URL mode (local dev):** uses an existing `DATABASE_URL` (the
 *    migrations must already be applied). No container lifecycle to manage.
 *    Selected automatically when `DATABASE_URL` is present in the env.
 *
 * The test container is shared across the worker via a promise-as-mutex
 * singleton (`sharedDbPromise`). Re-entry returns the same promise, so two
 * parallel first-callers cannot double-boot a container. Cleanup is
 * process-level — `beforeExit` + `SIGTERM` + `SIGINT` — not per-call, because
 * per-call close would defeat the shared container invariant.
 */
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'db', 'migrations');

export interface TestDb {
  pool: pg.Pool;
  /** Connection URI used to construct `pool`. Useful for tests that need
   *  to plumb the URI into other subsystems (e.g. `process.env.DATABASE_URL`
   *  so the production code path `getPool()` picks it up). */
  connectionUri: string;
  close: () => Promise<void>;
}

// Promise-as-mutex singleton: two parallel first-callers both receive the
// same in-flight promise, so only one container spin-up runs.
let sharedDbPromise: Promise<TestDb> | null = null;
let sharedDbResolved: TestDb | null = null;
let isClosed = false;

async function applyMigrations(pool: pg.Pool): Promise<void> {
  // Forward-only; ignore already-applied (we boot a fresh DB each time).
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.includes('.down.'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await pool.query(sql);
  }
}

async function fromEnv(): Promise<TestDb> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL not set and Testcontainers not enabled');
  const pool = new Pool({ connectionString: url });
  return {
    pool,
    connectionUri: url,
    close: async () => {
      await pool.end();
    },
  };
}

async function fromTestcontainers(): Promise<TestDb> {
  // Lazy import so dev environments without testcontainers don't fail at parse time.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = container.getConnectionUri();
  const pool = new Pool({ connectionString: uri });
  await applyMigrations(pool);
  // Side-effect: expose the container URI on `process.env.DATABASE_URL` so
  // production code paths that read DATABASE_URL (e.g. `getPool()` from
  // `src/db/pool.ts`) pick up the testcontainer's pool. Without this, HTTP
  // tests that drive routes through `createApp()` would create a SEPARATE
  // Pool from a missing DATABASE_URL and fail with `DATABASE_URL is not set`.
  // The env is reset on `closeShared()` below.
  process.env['DATABASE_URL'] = uri;
  return {
    pool,
    connectionUri: uri,
    close: async () => {
      await pool.end();
      await container.stop();
      // Clear the env hint so a subsequent test file's local DATABASE_URL
      // (if any) isn't accidentally clobbered by the prior container URI.
      if (process.env['DATABASE_URL'] === uri) {
        delete process.env['DATABASE_URL'];
      }
    },
  };
}

/**
 * Get (or create) the shared test DB. Subsequent calls return the same pool.
 * Concurrent first-callers are de-duplicated via the promise-as-mutex.
 */
export async function getTestDb(): Promise<TestDb> {
  if (isClosed) {
    throw new Error('withTestDb: shared pool already closed; cannot re-open');
  }
  if (!sharedDbPromise) {
    sharedDbPromise = (async () => {
      const db = process.env['DATABASE_URL']
        ? await fromEnv()
        : await fromTestcontainers();
      sharedDbResolved = db;
      return db;
    })();
  }
  return sharedDbPromise;
}

/**
 * Close the shared test DB. Idempotent: subsequent calls are no-ops.
 *
 * Cleanup is also wired to `process.on('beforeExit' | 'SIGTERM' | 'SIGINT')`
 * at module-load time so test workers don't leak containers on non-zero exit.
 * Per-file `after()` hooks should NOT call this — sibling test files in the
 * same worker would re-bootstrap the container (~5s spin-up penalty each).
 */
export async function closeShared(): Promise<void> {
  if (sharedDbResolved) {
    const db = sharedDbResolved;
    sharedDbResolved = null;
    sharedDbPromise = null;
    isClosed = true;
    await db.close();
  }
}

// Process-level cleanup. `beforeExit` fires only on natural event-loop drain;
// SIGTERM/SIGINT cover non-zero exits (CI test failures that crash the worker
// would otherwise leak the Testcontainers container). All three are no-ops if
// the pool was already closed by `closeShared()`.
const cleanup = () => {
  void closeShared().catch(() => undefined);
};
process.on('beforeExit', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

export async function withTestDb<T>(fn: (db: TestDb) => Promise<T>): Promise<T> {
  const db = await getTestDb();
  // Intentionally NOT closing the shared pool here — the process-level
  // handlers above own cleanup. Per-call close would defeat the shared
  // container invariant.
  return await fn(db);
}
