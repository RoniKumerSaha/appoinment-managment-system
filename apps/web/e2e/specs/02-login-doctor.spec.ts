/**
 * 02-login-doctor.spec.ts — staff sign-in for the doctor role.
 *
 * After login, the App routes the doctor straight to DoctorApp
 * (no AppShell — the doctor surface uses DoctorFrame instead).
 */
import { test, expect } from '../fixtures.ts';
import { LoginPage } from '../pages/login.page.ts';
import { DoctorPage } from '../pages/doctor.page.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('doctor staff sign-in mounts DoctorApp', async ({ page }) => {
  const login = new LoginPage(page);
  const doctor = new DoctorPage(page);

  await page.goto('/');
  await login.signInAsStaff(
    FIXTURE.doctorEastLead.role,
    FIXTURE.doctorEastLead.email,
  );

  await doctor.expectMounted();
  // The AppShell should NOT be present — the doctor surface has its
  // own frame. If the routing logic ever regresses, this catches it.
  await expect(page.locator('.shell')).toHaveCount(0);
});
