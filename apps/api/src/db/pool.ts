/**
 * pg.Pool wrapper.
 *
 * - Reads DATABASE_URL from env (raw-SQL mode; no ORM).
 * - Pool is created lazily so the process can start before Postgres is reachable.
 * - `pingDb()` is what /readyz calls; failures surface as a typed error rather
 *   than a thrown stack trace.
 */
import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString,
      // Keep retry behaviour obvious: pool's underlying connect() retries per pg defaults.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
    pool.on('error', (err) => {
      // Idle client errors must not crash the process.
      // Surface via the structured logger when wired; for now, last-resort log.
      // eslint-disable-next-line no-console
      console.error('[pg.Pool] idle client error', err.message);
    });
  }
  return pool;
}

export async function pingDb(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
