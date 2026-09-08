/**
 * pg.Pool wrapper.
 *
 * - Reads DATABASE_URL from env (raw-SQL mode; no ORM).
 * - Pool is created lazily so the process can start before Postgres is reachable.
 * - `pingDb()` is what /readyz calls; failures surface as a typed error rather
 *   than a thrown stack trace.
 */
import pg from 'pg';
import { logger } from '../middleware/log.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let poolInitPromise: Promise<pg.Pool> | null = null;

/**
 * Return the process-wide pg.Pool, constructing it lazily on first call.
 *
 * Memoisation: a single in-flight `Promise` is shared across concurrent
 * cold-start callers. Without this, two `/readyz` requests arriving on a
 * cold process would race and both call `new Pool(...)`, leaving one Pool
 * orphaned (and leaking its idle clients).
 */
export function getPool(): Promise<pg.Pool> {
  if (pool) return Promise.resolve(pool);
  if (poolInitPromise) return poolInitPromise;
  poolInitPromise = (async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    const p = new Pool({
      connectionString,
      // Keep retry behaviour obvious: pool's underlying connect() retries per pg defaults.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
    p.on('error', (err) => {
      // Idle client errors must not crash the process. Surface via the
      // structured logger so the failure is correlated with the request_id of
      // whichever request was unlucky enough to grab the broken client.
      logger.error({ err: err.message }, 'pg_pool_idle_error');
    });
    pool = p;
    return p;
  })();
  return poolInitPromise;
}

export async function pingDb(): Promise<boolean> {
  try {
    const p = await getPool();
    const client = await p.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    // Surface the unreachable-DB cause via the structured logger rather than
    // swallowing it — /readyz still returns 503 to the caller (via the route
    // handler) but operators can see the underlying failure in pino.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'db_unreachable');
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    poolInitPromise = null;
  }
}
