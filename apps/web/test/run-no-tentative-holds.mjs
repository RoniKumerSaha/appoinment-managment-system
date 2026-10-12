#!/usr/bin/env node
/**
 * run-no-tentative-holds.mjs — driver for the E7-S7 static web test.
 *
 * The web package's `test` script is intentionally a no-op
 * (`echo 'no web tests in E0-S1'`); it predates the E7 cross-cutting
 * pass and is preserved for backward compatibility. This driver is
 * the sanctioned entry point for running the E7-S7 web test in
 * isolation — used by `pnpm --filter @clinic/web run test:e7-s7` and
 * by CI's E7 cross-cutting pass.
 *
 * It shells out to `node --import tsx --test` against the single test
 * file so the test can use TypeScript syntax (import.meta.url, file
 * walking) without bundling.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, 'no-tentative-holds.test.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', testFile],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
