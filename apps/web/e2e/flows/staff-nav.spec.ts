/**
 * e2e/flows/staff-nav.spec.ts
 *
 * The doctor and receptionist surfaces had NO section navigation.
 *
 * The gap this pins: `DoctorFrame` and `ReceptionistFrame` rendered a
 * wordmark, an actor chip and a Sign out button — and nothing else.
 * Every screen those two roles own was reachable only by hand-typing
 * a URL (`#/doctor?page=series`) or by finding a small teal quick-link
 * buried in another page. A doctor literally could not get from the
 * affected queue to the recurring-series form.
 *
 * `StaffNav` (`src/pages/StaffNav.tsx`) closes that gap. It is
 * URL-driven: the active link comes from the `?page=` in the hash
 * fragment, so a nav click, a pasted URL, a page reload and the
 * browser's Back button all land on the same place.
 *
 * These specs assert the three properties that matter:
 *   1. the links are present and labelled,
 *   2. clicking one swaps the screen AND writes the URL,
 *   3. the URL survives a reload (the state is in the URL, not in
 *      React state that a reload would wipe).
 */
import { test, expect, type Page } from '@playwright/test';

/** The hash route for a staff section, e.g. `#/doctor?page=series`. */
function sectionHash(role: 'doctor' | 'reception', page: string): string {
  return `#/${role}?page=${page}`;
}

test.describe('doctor section navigation', () => {
  // No storageState — these specs drive the real login form, because
  // the nav is only reachable once a session exists.
  test.use({ storageState: { cookies: [], origins: [] } });

  async function signInAsDoctor(page: Page): Promise<void> {
    await page.goto('/#/login/staff');
    await page.locator('#staff-role').selectOption('doctor');
    await page.locator('#staff-email').fill('dr.-east-lead@clinic.local');
    await page.locator('#staff-password').fill('Clinic@12345678');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await expect(page.getByTestId('doctor-frame')).toBeVisible({
      timeout: 15_000,
    });
  }

  test('the doctor nav lists both sections', async ({ page }) => {
    await signInAsDoctor(page);

    const affected = page.getByTestId('doctor-nav-affected');
    const series = page.getByTestId('doctor-nav-series');

    await expect(affected).toBeVisible();
    await expect(series).toBeVisible();
    await expect(affected).toHaveText('Affected');
    await expect(series).toHaveText('Recurring series');
  });

  test('the default section is highlighted on arrival', async ({ page }) => {
    await signInAsDoctor(page);

    // The affected queue is the doctor's every-day landing screen.
    await expect(page.getByTestId('doctor-nav-affected')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('clicking a section swaps the screen and writes the URL', async ({
    page,
  }) => {
    await signInAsDoctor(page);

    await page.getByTestId('doctor-nav-series').click();

    // The URL carries the section…
    await expect(page).toHaveURL(/page=series/);
    // …and the screen actually changed.
    await expect(
      page.getByRole('heading', { name: /recurring/i }).first(),
    ).toBeVisible();
    await expect(page.getByTestId('doctor-nav-series')).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The previous section is no longer highlighted.
    await expect(page.getByTestId('doctor-nav-affected')).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('a section survives a page reload', async ({ page }) => {
    await signInAsDoctor(page);
    await page.getByTestId('doctor-nav-series').click();
    await expect(page).toHaveURL(/page=series/);

    await page.reload();

    // The URL is the source of truth, so the reload lands on the same
    // section — not back on the default.
    await expect(page).toHaveURL(/page=series/);
    await expect(
      page.getByRole('heading', { name: /recurring/i }).first(),
    ).toBeVisible();
    await expect(page.getByTestId('doctor-nav-series')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the browser Back button returns to the previous section', async ({
    page,
  }) => {
    await signInAsDoctor(page);

    await page.getByTestId('doctor-nav-series').click();
    await expect(page).toHaveURL(/page=series/);
    await page.getByTestId('doctor-nav-affected').click();
    await expect(page).toHaveURL(/page=affected/);

    await page.goBack();

    await expect(page).toHaveURL(/page=series/);
    await expect(page.getByTestId('doctor-nav-series')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('a pasted deep link opens the section directly', async ({ page }) => {
    await signInAsDoctor(page);

    await page.goto(`/${sectionHash('doctor', 'series')}`);
    await page.reload();

    await expect(
      page.getByRole('heading', { name: /recurring/i }).first(),
    ).toBeVisible();
    await expect(page.getByTestId('doctor-nav-series')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

test.describe('receptionist section navigation', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function signInAsReceptionist(page: Page): Promise<void> {
    await page.goto('/#/login/staff');
    await page.locator('#staff-role').selectOption('receptionist');
    await page.locator('#staff-email').fill('receptionist-east@clinic.local');
    await page.locator('#staff-password').fill('Clinic@12345678');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await expect(page.getByTestId('recep-frame')).toBeVisible({
      timeout: 15_000,
    });
  }

  test('the receptionist nav lists all four sections', async ({ page }) => {
    await signInAsReceptionist(page);

    await expect(page.getByTestId('recep-nav-today')).toHaveText('Today');
    await expect(page.getByTestId('recep-nav-create')).toHaveText(
      'Book walk-in',
    );
    await expect(page.getByTestId('recep-nav-availability')).toHaveText(
      'Availability',
    );
    await expect(page.getByTestId('recep-nav-cancel')).toHaveText('Cancel');
  });

  test('each section is reachable and highlighted', async ({ page }) => {
    await signInAsReceptionist(page);

    const sections = [
      { id: 'recep-nav-today', page: 'today' },
      { id: 'recep-nav-create', page: 'create' },
      { id: 'recep-nav-availability', page: 'availability' },
      { id: 'recep-nav-cancel', page: 'cancel' },
    ];

    for (const section of sections) {
      const link = page.getByTestId(section.id);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`page=${section.page}`));
      await expect(link).toHaveAttribute('aria-current', 'page');
    }
  });

  test('a section survives a page reload', async ({ page }) => {
    await signInAsReceptionist(page);

    await page.getByTestId('recep-nav-availability').click();
    await expect(page).toHaveURL(/page=availability/);

    await page.reload();

    await expect(page).toHaveURL(/page=availability/);
    await expect(page.getByTestId('recep-nav-availability')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the browser Back button returns to the previous section', async ({
    page,
  }) => {
    await signInAsReceptionist(page);

    await page.getByTestId('recep-nav-create').click();
    await expect(page).toHaveURL(/page=create/);
    await page.getByTestId('recep-nav-today').click();
    await expect(page).toHaveURL(/page=today/);

    await page.goBack();

    await expect(page).toHaveURL(/page=create/);
    await expect(page.getByTestId('recep-nav-create')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
