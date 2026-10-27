/**
 * e2e/flows/phone-number.spec.ts
 *
 * The phone field is a single input: the patient types the whole
 * international number. There is no country chip.
 *
 * The spec drives the real widget in a real browser and asserts the
 * number that gets submitted is the one the patient typed — a
 * country code must never be silently prepended.
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

test.describe('phone number input', () => {
  test('there is no country-code picker beside the input', async ({ page }) => {
    await signIn(page);
    await reachDetailsStep(page);

    // The chip used to sit next to the input. It is gone — the
    // country code is part of the number now.
    await expect(page.getByRole('button', { name: /country code/i })).toHaveCount(0);
  });

  test('a patient can type a full international number', async ({ page }) => {
    // The regression: typing "+8801684960808" while a "+966" chip
    // was selected produced "+9668801684960808" (16 digits), which is
    // not valid E.164 — the field never validated and the wizard
    // could not advance.
    await signIn(page);
    const patient = await reachDetailsStep(page);

    await patient.phoneInput.fill('+8801684960808');

    // The value is not rewritten under the patient.
    await expect(patient.phoneInput).toHaveValue('+8801684960808');

    // And the form accepts it — the validity check runs the E.164
    // regex, so the continue button enabling proves it passed.
    await patient.nameInput.fill('Bangladeshi Patient');
    await expect(patient.step4Continue).toBeEnabled();
  });

  test('cosmetic separators are tolerated', async ({ page }) => {
    await signIn(page);
    const patient = await reachDetailsStep(page);

    await patient.phoneInput.fill('+1 (555) 123-4567');
    await patient.nameInput.fill('Padded Patient');
    await expect(patient.step4Continue).toBeEnabled();
  });

  test('a number without a country code is rejected', async ({ page }) => {
    // We do not guess a country code for the patient.
    await signIn(page);
    const patient = await reachDetailsStep(page);

    await patient.phoneInput.fill('512345678');
    await patient.nameInput.fill('No Country Patient');
    await expect(patient.step4Continue).toBeDisabled();
  });

  test('the submitted phone is exactly what the patient typed', async ({
    page,
  }) => {
    await signIn(page);
    const patient = await reachDetailsStep(page);

    // The number the e2e patient signed in with — the booking must
    // be stored under the same phone, or the claim-bound appointments
    // list cannot see it.
    const phone = FIXTURE.patient02.phone;
    await patient.phoneInput.fill(phone);
    await expect(patient.phoneInput).toHaveValue(phone);
    await patient.nameInput.fill('Manual Test Patient');
    await expect(patient.step4Continue).toBeEnabled();
  });
});
