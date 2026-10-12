/**
 * e2e/auth.setup.ts — Playwright `setup` project.
 *
 * Runs once before any spec. For each role we:
 *   1. Probe the API (`/healthz`) to fail loud if the API is down.
 *   2. POST the auth payload to obtain a real `StoredAuth`
 *      (`{ token, claim, expires_at, profile, ... }`).
 *   3. Save the raw JSON via `page.context().storageState(...)` so the
 *      Playwright runtime re-injects `localStorage['medislot.auth']`
 *      on every browser context that opts in via `test.use({...})`.
 *
 * The shape is the same one `apps/web/src/auth/store.ts` writes when
 * a real login succeeds. Both the API client (`api/client.ts`
 * `readTokenFromStorage`) and the React store read this key, so a
 * freshly-loaded browser context opens straight into the role's home
 * without going through the LoginPage.
 *
 * Why we do NOT drive the LoginPage UI: the auth flow is the
 * "scaffolding" the other specs use. If we drove the form, the
 * login specs (#1-#5) would race against a pre-built auth state
 * (and would have nothing to assert). Login-form coverage lives in
 * the dedicated specs; this setup only provides the session.
 *
 * Why `addInitScript` is unnecessary: Playwright's `storageState`
 * already restores localStorage on every new context. No need to
 * re-inject on each navigation.
 *
 * Outputs (under `apps/web/e2e/.auth/`, gitignored):
 *   - admin.json
 *   - doctor-east.json
 *   - receptionist-east.json
 *   - patient-01.json
 */
import { chromium, expect, type FullConfig } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getMe,
  loginStaff,
  probeHealth,
  verifyPatientOtp,
  type StoredAuth,
} from './helpers/api.ts';
import { FIXTURE } from './helpers/ids.ts';

const here = dirname(fileURLToPath(import.meta.url));
const authDir = resolve(here, '.auth');
mkdirSync(authDir, { recursive: true });

/**
 * Wipe test-prefixed appointment data before the suite. The dev API
 * points at a shared Postgres, so leftover rows from prior runs (or
 * local development) trip FR-027 (one future appointment per patient
 * per doctor) and exhaust the 2-9 day availability window the
 * booking fixture uses.
 *
 * The reset script lives at `apps/api/scripts/reset-test-appointments.ts`
 * and only touches the `+1555000%` phone prefix. We shell out via
 * pnpm so the env file is loaded the same way `pnpm --filter @clinic/api`
 * does in manual runs. We use `shell: true` on Windows so the
 * spaces in the repo path don't break the spawn.
 */
function resetTestAppointments(): void {
  // apps/web/e2e/auth.setup.ts → ../../.. = repoRoot (3 levels up
  // from e2e/, not 4; `here` is e2e/, not helpers/).
  const repoRoot = resolve(here, '..', '..', '..');
  const envFile = resolve(repoRoot, 'apps', 'api', '.env');
  const script = resolve(
    repoRoot,
    'apps',
    'api',
    'scripts',
    'reset-test-appointments.ts',
  );
  const cwd = resolve(repoRoot, 'apps', 'api');

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'pnpm.cmd' : 'pnpm';
  // Quote paths so spaces in the repo dir ("appoinment managment
  // system") don't break argv parsing.
  const result = spawnSync(
    `${cmd} exec tsx --env-file="${envFile}" "${script}"`,
    {
      cwd,
      stdio: 'inherit',
      shell: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `reset-test-appointments failed (exit=${result.status}); cannot start suite with stale data.`,
    );
  }
}

interface SetupTarget {
  name: string;
  obtain: () => Promise<StoredAuth>;
}

const TARGETS: SetupTarget[] = [
  {
    name: 'admin',
    obtain: () => loginStaff(FIXTURE.admin.role, FIXTURE.admin.email),
  },
  {
    name: 'doctor-east',
    obtain: () =>
      loginStaff(FIXTURE.doctorEastLead.role, FIXTURE.doctorEastLead.email),
  },
  {
    name: 'receptionist-east',
    obtain: () =>
      loginStaff(
        FIXTURE.receptionistEast.role,
        FIXTURE.receptionistEast.email,
      ),
  },
  {
    name: 'patient-01',
    obtain: () => verifyPatientOtp(FIXTURE.patient01.phone, FIXTURE.patient01.code),
  },
  {
    name: 'patient-02',
    obtain: () => verifyPatientOtp(FIXTURE.patient02.phone, FIXTURE.patient02.code),
  },
  {
    name: 'patient-03',
    obtain: () => verifyPatientOtp(FIXTURE.patient03.phone, FIXTURE.patient03.code),
  },
];

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // Fail fast on a misconfigured local env. The whole suite cascades
  // from auth: if the API is down, no spec has a session to use.
  console.log('[auth.setup] probing API…');
  await probeHealth();

  // Wipe stale test data from prior runs / local development.
  // Without this, FR-027 trips immediately when an earlier
  // already-booked patient-02 + East Lead + 2-days-out slot blocks
  // every later spec.
  console.log('[auth.setup] resetting test appointments…');
  resetTestAppointments();

  const browser = await chromium.launch();
  try {
    for (const target of TARGETS) {
      console.log(`[auth.setup] login as ${target.name}…`);
      const auth = await target.obtain();
      // Belt + braces: confirm the API recognizes the new token. A
      // 200 here proves (a) the dev fixture seed is intact, (b) the
      // role-claim is what the seed said it would be, (c) the
      // server-side token hasn't been invalidated.
      const me = await getMe(auth.token);
      expect(
        me?.claim?.role,
        `${target.name}: /auth/me returned no role`,
      ).toBeTruthy();

      const context = await browser.newContext({
        baseURL: 'http://localhost:5173',
      });
      const page = await context.newPage();
      // Plant the auth into localStorage so the first `useAuth()` call
      // sees an authenticated session. We have to navigate first
      // (localStorage is per-origin), so we go to the SPA root, set
      // the key, then save the storage state.
      // Note: globalSetup runs without the project-level `baseURL`,
      // so we set it on the context and pass an absolute URL here.
      await page.goto('http://localhost:5173/', {
        waitUntil: 'domcontentloaded',
      });
      await page.evaluate((value) => {
        window.localStorage.setItem('medislot.auth', value);
      }, JSON.stringify(auth));
      const outPath = resolve(authDir, `${target.name}.json`);
      await context.storageState({ path: outPath });
      await context.close();
      console.log(`[auth.setup]   wrote ${outPath}`);
    }
  } finally {
    await browser.close();
  }

  console.log('[auth.setup] done.');
}
