#!/usr/bin/env node
/**
 * run-a11y-touch-targets.mjs — driver for the E7-S5 static web test.
 *
 * Sanctioned entry point: `pnpm --filter @clinic/web run test:e7-s5-touch`.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, 'a11y-touch-targets.test.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', testFile],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
