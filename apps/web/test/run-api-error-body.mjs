#!/usr/bin/env node
/**
 * run-api-error-body.mjs — driver for the API-client error-body test.
 *
 * Shells out to `node --import tsx --test` against the single test file
 * so it can use TypeScript syntax without a bundler.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, 'api-error-body.test.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', testFile],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
