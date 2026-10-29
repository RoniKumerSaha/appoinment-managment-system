/**
 * e2e/flows/login-split.spec.ts
 *
 * The staff and patient sign-in screens are SEPARATE pages.
 *
 * The gap this pins: the login used to be ONE page with two cards on
 * it — staff sign-in on the left, patient OTP on the right. Each
 * audience was forced to look at the other's form: a patient saw a
 * role dropdown (Administrator / Doctor / Receptionist) and a staff
 * password field, a staff member saw an OTP widget. On a narrow
 * screen the two cards stacked, so each audience scrolled past the
 * other's form first.
 *
 * The split is now:
 *   `/` (or `#/login`)     → the chooser
 *   `#/login/staff`        → the staff form alone
 *   `#/login/patient`      → the patient form alone
 *
 * These specs assert the separation holds — neither form leaks onto
 * the other's screen — and that the chooser actually routes.
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

/** Clear any stored session and land on the app root. */
async function openChooser(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await expect(page.getByTestId('login-chooser')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('the login chooser', () => {
  test('the app root shows the chooser, not a form', async ({ page }) => {
    await openChooser(page);

    await expect(page.getByTestId('login-chooser')).toBeVisible();
    await expect(page.getByTestId('login-choose-staff')).toBeVisible();
    await expect(page.getByTestId('login-choose-patient')).toBeVisible();

    // Neither form is on the root screen.
    await expect(page.locator('#staff-email')).toHaveCount(0);
    await expect(page.locator('#patient-phone')).toHaveCount(0);
  });

  test('the Staff card opens the staff form and nothing else', async ({
    page,
  }) => {
    await openChooser(page);

    await page.getByTestId('login-choose-staff').click();

    await expect(page).toHaveURL(/page=staff|#\/login\/staff/);
    await expect(page.locator('#staff-email')).toBeVisible();
    await expect(page.locator('#staff-password')).toBeVisible();
    // The patient form must NOT be on this screen.
    await expect(page.locator('#patient-phone')).toHaveCount(0);
  });

  test('the Patient card opens the patient form and nothing else', async ({
    page,
  }) => {
    await openChooser(page);

    await page.getByTestId('login-choose-patient').click();

    await expect(page).toHaveURL(/#\/login\/patient/);
    await expect(page.locator('#patient-phone')).toBeVisible();
    await expect(
      page.locator('input[aria-label^="Digit "][aria-label$=" of 6"]'),
    ).toHaveCount(6);
    // The staff form must NOT be on this screen.
    await expect(page.locator('#staff-email')).toHaveCount(0);
    await expect(page.locator('#staff-role')).toHaveCount(0);
  });
});

test.describe('direct navigation to a login screen', () => {
  test('the staff screen opens directly and survives a reload', async ({
    page,
  }) => {
    await page.goto('/#/login/staff');
    await expect(page.locator('#staff-email')).toBeVisible({
      timeout: 15_000,
    });

    await page.reload();

    await expect(page.locator('#staff-email')).toBeVisible();
    await expect(page.locator('#patient-phone')).toHaveCount(0);
  });

  test('the patient screen opens directly and survives a reload', async ({
    page,
  }) => {
    await page.goto('/#/login/patient');
    await expect(page.locator('#patient-phone')).toBeVisible({
      timeout: 15_000,
    });

    await page.reload();

    await expect(page.locator('#patient-phone')).toBeVisible();
    await expect(page.locator('#staff-email')).toHaveCount(0);
  });

  test('an unknown login hash falls back to the chooser', async ({ page }) => {
    await page.goto('/#/login/nonsense');
    await expect(page.getByTestId('login-chooser')).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('cross-links between the login screens', () => {
  test('the staff screen links to the patient screen and back', async ({
    page,
  }) => {
    await page.goto('/#/login/staff');
    await expect(page.locator('#staff-email')).toBeVisible();

    await page.getByTestId('staff-login-to-patient').click();
    await expect(page.locator('#patient-phone')).toBeVisible();

    await page.getByTestId('patient-login-to-staff').click();
    await expect(page.locator('#staff-email')).toBeVisible();
  });

  test('the Back link returns to the chooser from either screen', async ({
    page,
  }) => {
    await page.goto('/#/login/staff');
    await expect(page.locator('#staff-email')).toBeVisible();
    await page.getByTestId('staff-login-back').click();
    await expect(page.getByTestId('login-chooser')).toBeVisible();

    await page.getByTestId('login-choose-patient').click();
    await expect(page.locator('#patient-phone')).toBeVisible();
    await page.getByTestId('patient-login-back').click();
    await expect(page.getByTestId('login-chooser')).toBeVisible();
  });

  test('the browser Back button walks the login screens', async ({
    page,
  }) => {
    await openChooser(page);
    await page.getByTestId('login-choose-staff').click();
    await expect(page.locator('#staff-email')).toBeVisible();

    await page.goBack();

    await expect(page.getByTestId('login-chooser')).toBeVisible();
  });
});
