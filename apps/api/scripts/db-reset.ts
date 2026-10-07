/**
 * db-reset.ts — drop every public-schema table, re-apply every
 * migration, then re-run the baseline seed. Idempotent. Used by the
 * demo seeder to start from a known-empty state without touching the
 * Postgres container.
 *
 * Run with: `pnpm exec --filter @clinic/api tsx scripts/db-reset.ts`
 */
import './_load-env.js';
import { getPool, closePool } from '../src/db/pool.js';
import { default as runMigrate } from 'node-pg-migrate';
import { seedWith } from '../db/seeds/01_minimum.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(SCRIPT_DIR, '..');
const MIGRATIONS_DIR = path.resolve(API_DIR, 'db', 'migrations');

async function resetSchema(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA public CASCADE`);
    await c.query(`CREATE SCHEMA public`);
    await c.query(`GRANT ALL ON SCHEMA public TO PUBLIC`);
    console.log('db-reset: public schema dropped + recreated');
  } finally {
    c.release();
  }
}

async function runMigrations(): Promise<void> {
  // node-pg-migrate is the same tool `pnpm db:migrate` calls. We
  // invoke it programmatically so the whole reset is one command.
  // `direction: 'up'` re-runs every forward migration; the
  // `.applied.json` ledger resets when we drop the schema.
  await runMigrate({
    databaseUrl: process.env['DATABASE_URL']!,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    ignorePattern: 'down\\.sql$',
    singleTransaction: true,
    noLock: false,
    decamelize: false,
    logger: { info: () => {}, warn: () => {}, error: console.error, debug: () => {} },
  });
  console.log('db-reset: migrations applied');
}

async function runBaselineSeed(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await seedWith(c);
    await c.query('COMMIT');
    console.log('db-reset: baseline seed applied');
  } finally {
    c.release();
  }
}

async function main(): Promise<void> {
  await resetSchema();
  await runMigrations();
  await runBaselineSeed();
  await closePool();
}
main().catch(async (err) => {
  console.error('db-reset: fatal', err);
  await closePool();
  process.exit(1);
});