#!/usr/bin/env node
/**
 * run-conflict-modal-singleton.mjs — driver for the E7-S4 static web test.
 *
 * Same shape as `run-no-tentative-holds.mjs`. The web package's `test`
 * script is intentionally a no-op (it predates the E7 cross-cutting
 * pass). This driver is the sanctioned entry point for running the
 * E7-S4 web test in isolation — used by `pnpm --filter @clinic/web
 * run test:e7-s4` and by CI's E7 cross-cutting pass.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, 'conflict-modal-singleton.test.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', testFile],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
