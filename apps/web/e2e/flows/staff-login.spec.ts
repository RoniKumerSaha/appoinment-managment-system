/**
 * e2e/flows/staff-login.spec.ts
 *
 * The staff sign-in form: the password is REQUIRED.
 *
 * The gap this pins: the password field was optional. A blank
 * password fell through to the API's dev/test-only email-only login
 * path, which minted a VALID token for anyone who knew a seeded
 * staff address — no credential required. Every seeded staff account
 * now carries a `password_hash`, so the stub path serves no purpose
 * and only widens the hole.
 *
 * The fix is in the UI: the form refuses to submit without a
 * password, and the submit button stays disabled until one is typed.
 * These specs drive the real form and assert:
 *   1. the submit button is disabled while the password is blank,
 *   2. a forced submit (bypassing the disabled button) still
 *      refuses with `password_required` and does NOT authenticate,
 *   3. a wrong password is rejected by the API,
 *   4. the correct password signs each role in.
 */
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Clinic@12345678';

const ROLES = [
  { role: 'admin', email: 'admin-main@clinic.local' },
  { role: 'doctor', email: 'dr.-east-lead@clinic.local' },
  { role: 'receptionist', email: 'receptionist-east@clinic.local' },
] as const;

/** Open the staff form on a clean (unauthenticated) page. */
async function openLogin(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  // The app root shows the chooser; the staff form is its own screen.
  await page.goto('/#/login/staff');
  await expect(page.locator('#staff-email')).toBeVisible();
}

test.describe('staff login requires a password', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the submit button is disabled until a password is typed', async ({
    page,
  }) => {
    await openLogin(page);

    await page.locator('#staff-role').selectOption('doctor');
    await page.locator('#staff-email').fill('dr.-east-lead@clinic.local');

    // No password yet — the button must not be clickable.
    await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeDisabled();

    await page.locator('#staff-password').fill(PASSWORD);
    await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeEnabled();
  });

  test('a blank password is refused and does NOT authenticate', async ({
    page,
  }) => {
    await openLogin(page);

    await page.locator('#staff-role').selectOption('doctor');
    await page.locator('#staff-email').fill('dr.-east-lead@clinic.local');

    // Force the submit past the disabled button — the form's own
    // guard has to hold, not just the button's `disabled` attribute.
    await page.evaluate(() => {
      const input = document.querySelector('#staff-email');
      (input?.closest('form') as HTMLFormElement | null)?.requestSubmit();
    });

    await expect(page.getByRole('alert')).toContainText('password_required');

    // Still on the login page, and no session was minted.
    await expect(page.locator('#staff-email')).toBeVisible();
    const token = await page.evaluate(() =>
      window.localStorage.getItem('medislot.auth'),
    );
    expect(token, 'no auth token was stored').toBeNull();
  });

  test('a wrong password is rejected by the API', async ({ page }) => {
    await openLogin(page);

    await page.locator('#staff-role').selectOption('doctor');
    await page.locator('#staff-email').fill('dr.-east-lead@clinic.local');
    await page.locator('#staff-password').fill('not-the-right-password');
    await page.getByRole('button', { name: /^Sign in$/ }).click();

    await expect(page.getByRole('alert')).toContainText('invalid_credentials');
    await expect(page.locator('#staff-email')).toBeVisible();
  });

  test('an unknown email is rejected', async ({ page }) => {
    await openLogin(page);

    await page.locator('#staff-role').selectOption('doctor');
    await page.locator('#staff-email').fill('nobody@clinic.local');
    await page.locator('#staff-password').fill(PASSWORD);
    await page.getByRole('button', { name: /^Sign in$/ }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('#staff-email')).toBeVisible();
  });
});

test.describe('staff login with the correct password', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const r of ROLES) {
    test(`${r.role} signs in with email + password`, async ({ page }) => {
      await openLogin(page);

      await page.locator('#staff-role').selectOption(r.role);
      await page.locator('#staff-email').fill(r.email);
      await page.locator('#staff-password').fill(PASSWORD);
      await page.getByRole('button', { name: /^Sign in$/ }).click();

      // The login form goes away and the role's shell mounts.
      await expect(page.locator('#staff-email')).toHaveCount(0, {
        timeout: 15_000,
      });

      const token = await page.evaluate(() =>
        window.localStorage.getItem('medislot.auth'),
      );
      expect(token, 'an auth token was stored').toBeTruthy();
      expect(token, 'the stored session carries the role').toContain(r.role);
    });
  }
});
