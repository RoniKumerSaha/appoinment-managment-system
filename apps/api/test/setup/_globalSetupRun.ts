/**
 * The actual globalSetup logic. Loaded via tsx (see `globalSetup.cjs`)
 * so its imports of `.ts` files resolve correctly.
 */
import { getTestDb } from '../db/withTestDb.js';

export async function setup(): Promise<void> {
  await getTestDb();
}

// Node's test runner imports this file and calls `setup()`. We also invoke
// it directly when run as a child process via `globalSetup.cjs`.
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('_globalSetupRun.ts');

if (invokedDirectly) {
  setup()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('global_setup_failed', err);
      process.exit(1);
    });
}
