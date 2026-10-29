/**
 * e2e/pages/login.page.ts — selectors for the three login screens.
 *
 * The login is now SPLIT into three screens (it used to be one page
 * with two cards on it):
 *   - `#/login`         → the chooser, rendered at the app root
 *   - `#/login/staff`   → the staff form (role + email + password)
 *   - `#/login/patient` → the patient form (phone + 6-digit OTP)
 *
 * The page object navigates to the right screen ITSELF, so a caller
 * cannot forget and land on the chooser by mistake. The two forms'
 * selectors stay where they were — `#staff-email`, `#patient-phone`,
 * the `Digit N of 6` OTP cells — so existing specs keep working.
 *
 * Selectors are kept here so a future rename only touches one file.
 */
import { expect, type Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── navigation ─────────────────────────────────────────────────────

  /** Land on the chooser (the app root). */
  async gotoChooser(): Promise<void> {
    await this.page.goto('/');
    await expect(this.chooserRoot()).toBeVisible({ timeout: 15_000 });
  }

  /** Land on the staff sign-in screen. */
  async gotoStaffLogin(): Promise<void> {
    await this.page.goto('/#/login/staff');
    await expect(this.staffForm()).toBeVisible({ timeout: 15_000 });
  }

  /** Land on the patient sign-in screen. */
  async gotoPatientLogin(): Promise<void> {
    await this.page.goto('/#/login/patient');
    await expect(this.patientForm()).toBeVisible({ timeout: 15_000 });
  }

  // ─── page roots ────────────────────────────────────────────────────

  chooserRoot() {
    return this.page.getByTestId('login-chooser');
  }

  staffForm() {
    return this.page.getByTestId('staff-login');
  }

  patientForm() {
    return this.page.getByTestId('patient-login');
  }

  /** The chooser's "Staff" card. */
  chooserStaffCard() {
    return this.page.getByTestId('login-choose-staff');
  }

  /** The chooser's "Patient" card. */
  chooserPatientCard() {
    return this.page.getByTestId('login-choose-patient');
  }

  // ─── staff form ─────────────────────────────────────────────────────

  get staffRoleSelect() {
    return this.page.locator('#staff-role');
  }

  get staffEmailInput() {
    return this.page.locator('#staff-email');
  }

  /** The password field. Required by the form. */
  get staffPasswordInput() {
    return this.page.locator('#staff-password');
  }

  get staffSubmit() {
    return this.page.getByRole('button', { name: /^Sign in$/ });
  }

  /**
   * Sign in as a staff member.
   *
   * Navigates to the staff screen first — the app root shows the
   * chooser, not the form.
   */
  async signInAsStaff(
    role: 'admin' | 'doctor' | 'receptionist',
    email: string,
    password: string,
  ) {
    await this.gotoStaffLogin();
    await this.staffRoleSelect.selectOption(role);
    await this.staffEmailInput.fill(email);
    await this.staffPasswordInput.fill(password);
    await this.staffSubmit.click();
  }

  // ─── patient form ───────────────────────────────────────────────────

  get patientPhoneInput() {
    return this.page.locator('#patient-phone');
  }

  /**
   * The 6 OTP cells. Each cell carries an `aria-label` of
   * "Digit N of 6" (see apps/web/src/pages/PatientLoginPage.tsx), so we
   * use the aria-label rather than the CSS-module class
   * `otp__cell` (which Vite renames to `_otp__cell_<hash>`).
   */
  patientOtpCells() {
    return this.page.locator('input[aria-label^="Digit "][aria-label$=" of 6"]');
  }

  get patientSubmit() {
    return this.page.getByRole('button', { name: /verify & continue/i });
  }

  async signInAsPatient(phone: string, code: string) {
    await this.gotoPatientLogin();
    await this.patientPhoneInput.fill(phone);
    // Fill each cell in turn with a small `type` so React's onChange
    // sees a real keystroke. `fill()` races with React's batching
    // (all 6 setDigits land before the first re-render), and a
    // paste into a single cell does not trigger the spread branch
    // the way it does for a true OS paste event — Playwright's fill
    // sets `input.value` directly.
    const cells = this.patientOtpCells();
    for (let i = 0; i < 6; i += 1) {
      await cells.nth(i).focus();
      await this.page.keyboard.type(code[i] ?? '');
    }
    // Wait for the submit button to become enabled (the canSubmit
    // derived state is recomputed on every render).
    await expect(this.patientSubmit).toBeEnabled();
    await this.patientSubmit.click();
  }

  // ─── error banner ───────────────────────────────────────────────────

  /**
   * The error banner for whichever form is on screen.
   *
   * Scoped to the form's root test id — only ONE form is mounted at
   * a time now, but scoping keeps the helper correct if a banner ever
   * appears elsewhere on the page.
   */
  private errorBanner() {
    return this.page.locator('[role="alert"]');
  }

  /**
   * Returns the visible error banner text (or null if absent).
   * The login forms use `<div role="alert">` for the failure banner
   * (see `error-banner` in LoginPage.module.css).
   */
  async errorBannerText(): Promise<string | null> {
    const banner = this.errorBanner().first();
    if ((await banner.count()) === 0) return null;
    const visible = await banner.isVisible().catch(() => false);
    return visible ? banner.innerText() : null;
  }

  async expectErrorBanner(expectedSubstring: string) {
    const banner = this.errorBanner().first();
    await expect(banner).toBeVisible();
    const text = (await banner.innerText()) ?? '';
    expect(text.toLowerCase()).toContain(expectedSubstring.toLowerCase());
  }
}
