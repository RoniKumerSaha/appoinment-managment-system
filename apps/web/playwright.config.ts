/**
 * Playwright E2E config for @clinic/web.
 *
 * Why this lives at apps/web/playwright.config.ts (not the workspace
 * root): the runner is consumed only by the web package; the API and
 * any other workspace members do not need a browser.
 *
 * Conventions:
 *   - Single Chromium project. Webkit/Firefox are out of scope for v1.
 *   - One worker, no parallelism. The dev API talks to a single
 *     Postgres, so a parallel race in a developer's local env is more
 *     likely to flake than to find bugs. Flip `workers` and
 *     `fullyParallel` once a dedicated test API exists.
 *   - The Vite dev server is the only process we boot. The API on
 *     :3001 is assumed to be running. `auth.setup.ts` does a tiny
 *     /authz probe so a misconfigured local env fails inside `setup`
 *     with a clear message.
 *   - `reuseExistingServer: !process.env.CI` lets `pnpm run test:e2e`
 *     work in the typical "vite is already up" local flow.
 *
 * Pinned deferrals:
 *   - TODO(p7-12): add an @axe-core/playwright project here once the
 *     P7-12 "per-page AA audit" story lands. Today we only cover
 *     smoke + booking loop.
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,

  // Quiet local; readable in CI. `list` always, plus `github` annotations
  // when the runner is GitHub Actions.
  reporter: isCI ? [['list'], ['github']] : [['list']],

  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
    // Headed + slowMo for the user-flow spec (per the spec test plan).
    // CI can override via `CI=1 pnpm test:e2e` to keep automation fast.
    headless: !isCI,
    slowMo: isCI ? 0 : 1_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // TODO(p7-12): add an @axe-core/playwright project here.
  ],

  // Run once before any test. Writes storageState JSON for each role
  // under `apps/web/e2e/.auth/`. Spec files opt in via
  // `test.use({ storageState: 'e2e/.auth/<role>.json' })`.
  globalSetup: resolve(__dirname, 'e2e', 'auth.setup.ts'),

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !isCI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
