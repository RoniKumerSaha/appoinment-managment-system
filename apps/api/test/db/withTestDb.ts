/**
 * DB-touching test helper.
 *
 * Two operating modes:
 *
 * 1. **TESTCONTAINERS mode (CI default):** spins up a `postgres:16-alpine`
 *    container, applies all migrations, yields a pool. The container is stopped
 *    on every callback exit (normal or thrown). Used when `DATABASE_URL` is not
 *    set and Testcontainers is available.
 *
 * 2. **DATABASE_URL mode (local dev):** uses an existing `DATABASE_URL` (the
 *    migrations must already be applied). No container lifecycle to manage.
 *    Selected automatically when `DATABASE_URL` is present in the env.
 *
 * The test container is created once per worker via `globalSetup.ts` and the
 * resulting pool is reused across `migrations.test.ts`, `invariants.test.ts`,
 * and `seed.test.ts` — re-booting per file would double migration time and
 * risk clock-skew between containers.
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
  close: () => Promise<void>;
}

let sharedDb: TestDb | null = null;

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
    close: async () => {
      await pool.end();
    },
  };
}

async function fromTestcontainers(): Promise<TestDb> {
  // Lazy import so dev environments without testcontainers don't fail at parse time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await applyMigrations(pool);
  return {
    pool,
    close: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/**
 * Get (or create) the shared test DB. Subsequent calls return the same pool.
 * Always call `closeShared()` in suite teardown (or rely on process exit).
 */
export async function getTestDb(): Promise<TestDb> {
  if (sharedDb) return sharedDb;
  sharedDb = process.env['DATABASE_URL']
    ? await fromEnv()
    : await fromTestcontainers();
  return sharedDb;
}

export async function closeShared(): Promise<void> {
  if (sharedDb) {
    await sharedDb.close();
    sharedDb = null;
  }
}

export async function withTestDb<T>(fn: (db: TestDb) => Promise<T>): Promise<T> {
  const db = await getTestDb();
  try {
    return await fn(db);
  } finally {
    // Intentionally NOT closing the shared pool here — see globalSetup.ts for
    // worker-level teardown. Per-call close would defeat the shared container.
  }
}
