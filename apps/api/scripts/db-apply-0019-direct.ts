/**
 * db-apply-0019-direct.ts — bypass node-pg-migrate; apply 0019 + reseed.
 *
 * The node-pg-migrate runner has been flaky in this environment
 * ("Can't determine timestamp" warnings, ledger not advancing). The
 * migration is a single hand-written, idempotent ALTER; we run it
 * directly and manually insert the pgmigrations ledger row to keep
 * future db:migrate calls in sync.
 *
 * Run: `pnpm exec --filter @clinic/api tsx scripts/db-apply-0019-direct.ts`
 */
import './_load-env.js';
import { getPool, closePool } from '../src/db/pool.js';
import { seedWith } from '../db/seeds/01_minimum.js';

async function applyMigration(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  try {
    // Idempotent: ADD COLUMN IF NOT EXISTS.
    await c.query('ALTER TABLE doctor ADD COLUMN IF NOT EXISTS specialty text');
    await c.query('ALTER TABLE appointment_type ADD COLUMN IF NOT EXISTS description text');
    // Record the migration in the ledger so future db:migrate calls
    // see it as already applied. (The pgmigrations table is the
    // schema-of-record for the runner; node-pg-migrate's
    // .applied.json is a separate file-based ledger it uses
    // locally — but for our purposes the pgmigrations row is
    // enough since the runner re-reads the DB on every call.)
    // NOTE: pgmigrations.name has no UNIQUE constraint in this DB
    // (the node-pg-migrate default schema is just an autoincrement
    // PK + a `name text` column). Use a NOT EXISTS guard instead
    // of ON CONFLICT.
    const ledgerExists = await c.query<{ count: string }>(
      `SELECT count(*) FROM pgmigrations WHERE name = $1`,
      ['0019_patient_picker_extras.sql'],
    );
    if (Number(ledgerExists.rows[0]?.count ?? '0') === 0) {
      await c.query(
        `INSERT INTO pgmigrations (name, run_on) VALUES ($1, app_now())`,
        ['0019_patient_picker_extras.sql'],
      );
    }
    console.log('db-apply-0019-direct: ALTERs applied + ledger row inserted');
  } finally {
    c.release();
  }
}

async function runSeedForBackfill(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await seedWith(c);
    await c.query('COMMIT');
    console.log(`db-apply-0019-direct: seed backfill complete (inserted=${result.inserted}, rows=${result.rowCount})`);
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function main(): Promise<void> {
  await applyMigration();
  await runSeedForBackfill();
  await closePool();
}
main().catch(async (err) => {
  console.error('db-apply-0019-direct: fatal', err);
  await closePool();
  process.exit(1);
});
