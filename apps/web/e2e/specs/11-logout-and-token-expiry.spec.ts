/**
 * 11-logout-and-token-expiry.spec.ts — two negative-path auth checks.
 *
 *   (a) Clicking "Sign out" returns the user to the LoginPage.
 *   (b) An expired token in localStorage (manually patched
 *       `expires_at`) is also detected on reload and routes back to
 *       the LoginPage.
 *
 * The expiry path exercises `useAuth()`'s "60s before expiry" check
 * (see apps/web/src/auth/store.ts: `expired` computed each render).
 * The store does NOT clear localStorage on its own — the boot
 * effect in App.tsx (`getMe()` → 401 → `clearAuth()`) is what
 * actually evicts the token. We don't depend on the boot effect
 * here: the simple "set expires_at to the past" + reload test is
 * enough to lock the path.
 */
import { test, expect } from '../fixtures.ts';
import { AdminPage } from '../pages/admin.page.ts';
import { LoginPage } from '../pages/login.page.ts';
import { PatientPage } from '../pages/patient.page.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe('admin logout + token expiry', () => {
  test('clicking Sign out returns to LoginPage', async ({ page }) => {
    const admin = new AdminPage(page);
    const login = new LoginPage(page);

    await page.goto('/');
    await admin.expectMounted();

    await admin.signOut();

    // After logout, the store clears localStorage and the AppShell
    // unmounts. The LoginPage staff card is the active form.
    await admin.shell.waitFor({ state: 'detached' });
    await expect(login.staffSubmit).toBeVisible();
  });

  test('expired token in localStorage returns to LoginPage after reload', async ({ page }) => {
    const admin = new AdminPage(page);
    const login = new LoginPage(page);
    const patient = new PatientPage(page);

    await page.goto('/');
    await admin.expectMounted();

    // Patch the stored auth: keep the token shape but mark it
    // expired. The store's `expired` derived state will be true
    // and the boot effect in App.tsx will clear the session.
    const patched = await page.evaluate(() => {
      const raw = window.localStorage.getItem('medislot.auth');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed['expires_at'] = '2000-01-01T00:00:00.000Z';
      window.localStorage.setItem('medislot.auth', JSON.stringify(parsed));
      return parsed['expires_at'];
    });
    expect(patched, 'localStorage must have had a medislot.auth entry').toBe(
      '2000-01-01T00:00:00.000Z',
    );

    await page.reload();

    // The shell should unmount; the LoginPage staff form should
    // become visible. We don't care about the patient app here
    // but assert it didn't mount.
    await admin.shell.waitFor({ state: 'detached' });
    await expect(login.staffSubmit).toBeVisible();
    await patient.expectNotMounted();
  });
});
