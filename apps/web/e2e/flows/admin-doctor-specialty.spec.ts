/**
 * e2e/flows/admin-doctor-specialty.spec.ts
 *
 * The admin edits a doctor's specialty.
 *
 * The bug this pins: the SPECIALTY tile on the admin doctor card was
 * read-only. The Edit modal had no specialty field, and the API's
 * PATCH /admin/doctors/:id rejected `specialty` as an `unknown_field`,
 * so an admin could never set (or clear) a doctor's specialty from the
 * UI. The column existed (migration 0019) and was displayed — it just
 * could not be written.
 *
 * These tests drive the real page in a real browser: open the card's
 * Edit modal, type a specialty, save, and assert the card tile shows
 * the new value. The spec restores the original specialty afterwards
 * so it leaves the dev database as it found it.
 */
import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

/** The admin's own doctor list, straight from the API. */
interface AdminDoctor {
  id: string;
  full_name: string;
  specialty: string | null;
}

async function adminToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('medislot.auth');
    if (!raw) throw new Error('no auth in localStorage');
    const parsed = JSON.parse(raw) as { token?: string };
    if (!parsed.token) throw new Error('no token in the stored session');
    return parsed.token;
  });
}

async function listAdminDoctors(page: Page): Promise<AdminDoctor[]> {
  const token = await adminToken(page);
  const res = await page.request.get('http://localhost:3001/admin/doctors', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok(), 'GET /admin/doctors is reachable').toBeTruthy();
  const body = (await res.json()) as unknown;
  // The endpoint returns a BARE ARRAY, not `{ doctors: [...] }`.
  const doctors = (Array.isArray(body)
    ? body
    : (body as { doctors?: unknown[] }).doctors) as AdminDoctor[];
  expect(Array.isArray(doctors)).toBeTruthy();
  return doctors;
}

/** Patch a doctor's specialty straight through the API. */
async function patchSpecialty(
  page: Page,
  id: string,
  specialty: string | null,
): Promise<void> {
  const token = await adminToken(page);
  const res = await page.request.patch(
    `http://localhost:3001/admin/doctors/${id}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      data: { specialty },
    },
  );
  expect(res.ok(), `PATCH specialty for ${id} → ${res.status()}`).toBeTruthy();
}

/**
 * The admin app is a hash-routed SPA — the doctors list lives at
 * `#/admin/doctors`, NOT `/admin/doctors`.
 */
async function gotoDoctors(page: Page): Promise<void> {
  await page.goto('/#/admin/doctors');
  await expect(
    page.getByRole('heading', { name: 'Doctors' }).first(),
    'the doctors page rendered',
  ).toBeVisible({ timeout: 15_000 });
}

test.describe.serial('admin doctor specialty', () => {
  test('the admin can set a specialty on a doctor card', async ({ page }) => {
    await gotoDoctors(page);

    const doctors = await listAdminDoctors(page);
    expect(doctors.length, 'the clinic has doctors').toBeGreaterThan(0);
    const target = doctors[0]!;
    const original = target.specialty;

    // Open the card's Edit modal.
    await page.locator(`[data-testid="doc-edit-btn-${target.id}"]`).click();

    const input = page.locator('[data-testid="doc-specialty-input"]');
    await expect(input, 'the Edit modal has a specialty field').toBeVisible({
      timeout: 10_000,
    });

    // The field opens pre-filled with the current value.
    await expect(input).toHaveValue(original ?? '');

    const NEW = 'E2e Specialty';
    await input.fill(NEW);
    await page.locator('[data-testid="doc-modal-save-btn"]').click();

    // The card tile reflects the new value…
    await expect(
      page.locator(`[data-testid="doc-specialty-${target.id}"]`),
      'the card tile shows the new specialty',
    ).toHaveText(NEW, { timeout: 15_000 });

    // …and the server agrees.
    const after = await listAdminDoctors(page);
    const updated = after.find((d) => d.id === target.id);
    expect(updated, 'the doctor is still in the list').toBeTruthy();
    expect(updated!.specialty, 'the server stored the new specialty').toBe(
      NEW,
    );

    // Leave the dev database as we found it.
    await patchSpecialty(page, target.id, original);
  });

  test('the admin can clear a specialty back to "Not set"', async ({ page }) => {
    await gotoDoctors(page);

    const doctors = await listAdminDoctors(page);
    const target = doctors[0]!;
    const original = target.specialty;

    // Give the doctor a specialty to clear.
    await patchSpecialty(page, target.id, 'E2e Specialty To Clear');
    await page.reload();
    await expect(
      page.locator(`[data-testid="doc-specialty-${target.id}"]`),
      'the card shows the specialty we just set',
    ).toHaveText('E2e Specialty To Clear', { timeout: 15_000 });

    // Clear it through the UI.
    await page.locator(`[data-testid="doc-edit-btn-${target.id}"]`).click();
    const input = page.locator('[data-testid="doc-specialty-input"]');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('E2e Specialty To Clear');
    await input.fill('');
    await page.locator('[data-testid="doc-modal-save-btn"]').click();

    await expect(
      page.locator(`[data-testid="doc-specialty-${target.id}"]`),
      'the card falls back to "Not set"',
    ).toHaveText('Not set', { timeout: 15_000 });

    const after = await listAdminDoctors(page);
    const updated = after.find((d) => d.id === target.id);
    expect(updated!.specialty, 'the server stored NULL').toBeNull();

    // Leave the dev database as we found it.
    await patchSpecialty(page, target.id, original);
  });

  test('the admin sees the specialty on the patient-facing doctor list', async ({
    page,
  }) => {
    await gotoDoctors(page);

    const doctors = await listAdminDoctors(page);
    const target = doctors[0]!;
    const original = target.specialty;

    const NEW = 'E2e Shared Specialty';
    await patchSpecialty(page, target.id, NEW);

    // The patient's doctor picker reads the same column.
    const token = await adminToken(page);
    const res = await page.request.get(
      'http://localhost:3001/public/doctors',
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      doctors: Array<{ id: string; specialty: string | null }>;
    };
    const pub = body.doctors.find((d) => d.id === target.id);
    expect(pub, 'the doctor is in the public catalog').toBeTruthy();
    expect(pub!.specialty, 'the public catalog shows the specialty').toBe(
      NEW,
    );

    await patchSpecialty(page, target.id, original);
  });
});
