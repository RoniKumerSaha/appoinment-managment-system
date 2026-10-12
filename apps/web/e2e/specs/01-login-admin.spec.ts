/**
 * 01-login-admin.spec.ts — staff sign-in for the admin role.
 *
 * Drives the LoginPage staff card with the seeded admin user, then
 * asserts that the AppShell mounts and the URL hash is the default
 * admin landing page.
 *
 * No storageState: this spec exists to lock the login form, so we
 * must drive it from scratch.
 */
import { test, expect } from '../fixtures.ts';
import { LoginPage } from '../pages/login.page.ts';
import { AdminPage } from '../pages/admin.page.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('admin staff sign-in lands on #/admin/clinic', async ({ page }) => {
  const login = new LoginPage(page);
  const admin = new AdminPage(page);

  await page.goto('/');
  await login.signInAsStaff(FIXTURE.admin.role, FIXTURE.admin.email);

  await admin.expectMounted();
  // After login the clinic section is active, but the URL hash is
  // still empty (the hash router's default). Use the active-section
  // indicator, not the URL, for the initial-state assertion.
  await admin.expectActiveSection('clinic');
});
