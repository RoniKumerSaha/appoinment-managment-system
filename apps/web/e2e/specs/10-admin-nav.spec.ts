/**
 * 10-admin-nav.spec.ts — admin AppShell navigation + sub-page.
 *
 * Uses the admin storageState produced by auth.setup.ts so we land
 * directly in the AppShell on the default #/admin/clinic route.
 *
 * Drives:
 *   - Each section in the AppShell (clinic, branches, doctors, ...)
 *   - A doctor sub-page via direct hash navigation
 *     (`#/admin/doctors/doctor-east-lead/assign`)
 *
 * Why direct hash navigation for the sub-page: the kebab menu in the
 * doctors list is one more selector to keep in sync; the hash router
 * is the contract this spec is actually trying to lock.
 */
import { test, expect } from '../fixtures.ts';
import { AdminPage } from '../pages/admin.page.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('admin can navigate every section + a doctor sub-page', async ({ page }) => {
  const admin = new AdminPage(page);

  await page.goto('/');
  await admin.expectMounted();
  // The default landing page is the clinic section (active-section
  // indicator; the URL hash is empty in this state).
  await admin.expectActiveSection('clinic');

  // Walk each implemented section. The AppShell disables unimplemented
  // sections, but in this build all six are implemented. Each click
  // updates window.location.hash via the router.
  for (const section of [
    'branches',
    'doctors',
    'receptionists',
    'types',
    'audit',
    'clinic',
  ] as const) {
    await admin.gotoSection(section);
    await admin.expectActiveSection(section);
  }

  // Open a doctor sub-page via the hash router.
  await admin.openDoctorSubPage(
    FIXTURE.doctorEastLead.email.replace(/^dr\.-/, 'dr-').replace(/@.*$/, ''),
    'assign',
  );
  // Sanity: we are no longer on the top-level doctors page.
  await expect(page).not.toHaveURL(/#\/admin\/doctors$/);
});
