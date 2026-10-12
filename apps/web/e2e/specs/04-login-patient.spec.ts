/**
 * 04-login-patient.spec.ts — patient OTP sign-in.
 *
 * Dev OTP code is "123456" (see LoginPage hint block + apps/api/test
 * fixture). After verify, the patient app mounts in place of the
 * AppShell.
 */
import { test, expect } from '../fixtures.ts';
import { LoginPage } from '../pages/login.page.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('patient OTP sign-in mounts PatientApp', async ({ page }) => {
  const login = new LoginPage(page);
  const patient = new PatientPage(page);

  await page.goto('/');
  await login.signInAsPatient(
    FIXTURE.patient01.phone,
    FIXTURE.patient01.code,
  );

  await patient.expectMounted();
  await expect(page.locator('.shell')).toHaveCount(0);
  // No admin nav links should be reachable from the patient app.
  await expect(page.locator('button.nav__link[title="Clinic"]')).toHaveCount(0);
});
