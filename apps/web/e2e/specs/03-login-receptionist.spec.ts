/**
 * 03-login-receptionist.spec.ts — staff sign-in for the receptionist.
 */
import { test, expect } from '../fixtures.ts';
import { LoginPage } from '../pages/login.page.ts';
import { ReceptionistPage } from '../pages/receptionist.page.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('receptionist staff sign-in mounts ReceptionistApp', async ({ page }) => {
  const login = new LoginPage(page);
  const recep = new ReceptionistPage(page);

  await page.goto('/');
  await login.signInAsStaff(
    FIXTURE.receptionistEast.role,
    FIXTURE.receptionistEast.email,
  );

  await recep.expectMounted();
  await expect(page.locator('.shell')).toHaveCount(0);
});
