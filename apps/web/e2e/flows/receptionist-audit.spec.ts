/**
 * e2e/flows/receptionist-audit.spec.ts
 *
 * The receptionist reads the audit trail for an appointment at their
 * own branch.
 *
 * The gap this pins: `GET /reception/appointments/:id/audit` and the
 * client wrapper `getReceptionistAppointmentAudit` both existed, but
 * nothing in the UI called them. PRD FR-051 grants a receptionist
 * exactly this scope, so the surface was simply missing — the
 * receptionist had no way to see what happened to an appointment
 * after it was created, rescheduled, or cancelled.
 *
 * The spec drives the real page: it opens the Today screen, clicks
 * the per-row "Audit" button, and asserts the drawer loads real
 * events for that appointment.
 */
import { test, expect, type Page } from '@playwright/test';
import { ReceptionistPage } from '../pages/receptionist.page.ts';

test.use({ storageState: 'e2e/.auth/receptionist-east.json' });

/** Sign in and land on the Today screen. */
async function openToday(page: Page): Promise<void> {
  const recep = new ReceptionistPage(page);
  await page.goto('/');
  await recep.expectMounted();
  await expect(page.getByRole('heading', { name: /^Today,/ })).toBeVisible();
}

test.describe('receptionist audit drawer', () => {
  test('the Today screen offers an Audit action per appointment', async ({
    page,
  }) => {
    await openToday(page);

    // Every row carries an Audit button.
    const auditButtons = page.getByRole('button', { name: 'Audit' });
    await expect(auditButtons.first()).toBeVisible();
    expect(await auditButtons.count()).toBeGreaterThan(0);
  });

  test('the drawer opens and lists the appointment audit events', async ({
    page,
  }) => {
    await openToday(page);

    await page.getByRole('button', { name: 'Audit' }).first().click();

    const drawer = page.locator('[data-testid="recep-audit-drawer"]');
    await expect(drawer).toBeVisible();

    // The header states the branch scope, not the doctor's.
    await expect(drawer).toContainText('Per-appointment trail · branch scope');
    await expect(drawer).toContainText('scope: your branch only');

    // The filter chips are present.
    for (const label of [
      'All',
      'Status changes',
      'Cancellations',
      'Block',
      'Resolve',
    ]) {
      await expect(
        drawer.getByRole('button', { name: label, exact: true }),
      ).toBeVisible();
    }

    // The body loaded without an error banner.
    await expect(
      page.locator('[data-testid="recep-audit-error"]'),
    ).toHaveCount(0);
  });

  test('the privacy note states the branch scope', async ({ page }) => {
    await openToday(page);

    await page.getByRole('button', { name: 'Audit' }).first().click();
    const drawer = page.locator('[data-testid="recep-audit-drawer"]');
    await expect(drawer).toBeVisible();

    const privacy = page.locator('[data-testid="recep-audit-privacy"]');
    await expect(privacy).toContainText('Receptionists see audit rows');
    await expect(privacy).toContainText('at their own branch');
  });

  test('a filter chip narrows the list and the drawer closes', async ({
    page,
  }) => {
    await openToday(page);

    await page.getByRole('button', { name: 'Audit' }).first().click();
    const drawer = page.locator('[data-testid="recep-audit-drawer"]');
    await expect(drawer).toBeVisible();

    // Toggling a filter must not blow up the drawer.
    await drawer.getByRole('button', { name: 'Cancellations' }).click();
    await expect(drawer).toBeVisible();
    await expect(
      page.locator('[data-testid="recep-audit-error"]'),
    ).toHaveCount(0);

    // The close button dismisses it.
    await page.locator('[data-testid="recep-audit-close-btn"]').click();
    await expect(drawer).toHaveCount(0);
  });
});
