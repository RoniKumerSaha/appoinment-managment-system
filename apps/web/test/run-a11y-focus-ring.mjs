#!/usr/bin/env node
/**
 * run-a11y-focus-ring.mjs — driver for the E7-S5 static web test.
 *
 * Sanctioned entry point: `pnpm --filter @clinic/web run test:e7-s5-focus`.
 * Shells out to `node --import tsx --test` so the .ts file can use
 * TypeScript syntax (import.meta.url, file walking) without bundling.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, 'a11y-focus-ring.test.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', testFile],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
