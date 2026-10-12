/**
 * 05-login-patient-invalid-otp.spec.ts — invalid OTP shows the
 * error banner and stays on the LoginPage.
 *
 * Uses code "000000" (definitely not the dev "123456"). The banner
 * comes from `describeApiError('invalid_otp_code')` in
 * apps/web/src/pages/LoginPage.tsx, which renders
 *   "invalid_otp_code: Invalid code. Try again."
 *
 * LoginPage decrements a local `attemptsLeft` counter on every
 * `invalid_otp_code` response. We submit ONCE so we don't trip the
 * "Too many wrong codes" copy and stay deterministic.
 */
import { test, expect } from '../fixtures.ts';
import { LoginPage } from '../pages/login.page.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('invalid OTP shows the role=alert banner and stays on login', async ({ page }) => {
  const login = new LoginPage(page);
  const patient = new PatientPage(page);

  await page.goto('/');
  await login.signInAsPatient(FIXTURE.patient01.phone, '000000');

  await login.expectErrorBanner('invalid_otp_code');
  // The patient app must not have mounted.
  await patient.expectNotMounted();
  // We should still be on the login page (no shell, no frame).
  await expect(page).toHaveURL(/\/$|\/index\.html/);
});
