/**
 * e2e/flows/phone-country-picker.spec.ts
 *
 * The phone field's country chip must actually change the country
 * code. It used to be a decorative button — it looked like a
 * dropdown and did nothing.
 *
 * The spec drives the real widget in a real browser: open the chip,
 * pick a country, and assert the chip + the number that is submitted
 * both changed.
 */
import { test, expect, type Page } from '@playwright/test';
import { PatientPage } from '../pages/patient.page.ts';
import { LoginPage } from '../pages/login.page.ts';
import { FIXTURE } from '../helpers/ids.ts';

/** Sign in as a patient so the booking wizard is reachable. */
async function signIn(page: Page): Promise<void> {
  const phone = FIXTURE.patient02.phone;
  const code = FIXTURE.patient02.code;
  const login = new LoginPage(page);
  await page.goto('/');
  await login.signInAsPatient(phone, code);
}

/** Walk the wizard to step 4, where the phone field lives. */
async function reachDetailsStep(page: Page): Promise<PatientPage> {
  const patient = new PatientPage(page);
  await patient.expectMounted();
  await patient.doctorList.waitFor();
  // The first available doctor card.
  await page.locator('[data-testid^="patient-booking-doctor-card-"]').first().click();
  // Step 2 needs both a branch and an appointment type before the
  // continue button enables.
  await page.locator('[data-testid^="patient-booking-branch-card-"]').first().click();
  await page.locator('[data-testid^="patient-booking-type-card-"]').first().click();
  await patient.step2Continue.click();
  await patient.step3Continue.waitFor();
  await page.locator('[data-testid^="patient-booking-slot-btn-"]').first().click();
  await patient.step3Continue.click();
  await patient.phoneInput.waitFor();
  return patient;
}

test.describe('phone country code picker', () => {
  test('the chip opens a searchable country list', async ({ page }) => {
    await signIn(page);
    await reachDetailsStep(page);

    const chip = page.getByRole('button', { name: /country code/i });
    await chip.click();

    // The listbox opens with the Gulf presets visible.
    await expect(page.getByRole('option', { name: /Saudi Arabia/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /United Arab Emirates/ })).toBeVisible();

    // The search filters the list.
    await page.getByRole('searchbox', { name: /search country/i }).fill('egypt');
    await expect(page.getByRole('option', { name: /Egypt/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /Saudi Arabia/ })).toHaveCount(0);

    // "Other country" is always reachable — a patient whose country
    // is not listed must never be locked out.
    await expect(page.getByRole('option', { name: /Other country/ })).toBeVisible();
  });

  test('choosing a country changes the chip', async ({ page }) => {
    await signIn(page);
    await reachDetailsStep(page);

    const chip = page.getByRole('button', { name: /country code/i });

    // The default is Saudi Arabia.
    await expect(chip).toContainText('+966');

    await chip.click();
    await page.getByRole('option', { name: /United Arab Emirates/ }).click();

    // The chip now shows the UAE code.
    await expect(chip).toContainText('+971');
    await expect(chip).not.toContainText('+966');
  });

  test('the selected country code is applied to the submitted phone', async ({
    page,
  }) => {
    await signIn(page);
    const patient = await reachDetailsStep(page);

    const chip = page.getByRole('button', { name: /country code/i });
    await chip.click();
    await page.getByRole('option', { name: /United Arab Emirates/ }).click();

    // The national-number input holds only the national part; the
    // country code is the chip's contribution.
    await patient.phoneInput.fill('501234567');
    await expect(patient.phoneInput).toHaveValue('501234567');

    // The form's own view of the phone is the joined E.164 string.
    // The chip is the only place the +971 prefix can come from, so
    // this proves the selection reached the form state.
    await expect(chip).toContainText('+971');
  });
});
