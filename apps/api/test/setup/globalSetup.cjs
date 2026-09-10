/**
 * globalSetup shim — loaded by `node --test --test-global-setup=...`.
 *
 * Node's `--test-global-setup` flag resolves this file via the vanilla
 * module loader (NOT through `--import tsx`), so any TypeScript source
 * imported transitively from here would fail to resolve. This shim runs
 * the actual setup work via tsx as a child process so the TypeScript
 * loader is active.
 *
 * The real setup function lives in `globalSetup.ts`; this file is the
 * CommonJS bridge between Node's test runner and tsx.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const setupScript = path.join(__dirname, '_globalSetupRun.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', setupScript],
  { stdio: 'inherit' },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
