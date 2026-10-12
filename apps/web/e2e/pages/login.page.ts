/**
 * e2e/pages/login.page.ts — selectors for LoginPage + its two cards.
 *
 * The login page renders two forms side-by-side on the same frame
 * (see apps/web/src/pages/LoginPage.tsx):
 *   - StaffCard:  `<select id="staff-role">` + `<input id="staff-email">`
 *                 + submit button. Submits via role+email (no password).
 *   - PatientCard: `<input id="patient-phone">` + six `<input>` OTP
 *                  cells (`.otp__cell` x 6) + submit.
 *
 * Selectors are kept here so a future rename only touches one file.
 */
import { expect, type Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── staff form ──────────────────────────────────────────────────────

  get staffRoleSelect() {
    return this.page.locator('#staff-role');
  }

  get staffEmailInput() {
    return this.page.locator('#staff-email');
  }

  get staffSubmit() {
    return this.page.getByRole('button', { name: /sign in/i });
  }

  async signInAsStaff(role: 'admin' | 'doctor' | 'receptionist', email: string) {
    await this.staffRoleSelect.selectOption(role);
    await this.staffEmailInput.fill(email);
    await this.staffSubmit.click();
  }

  // ─── patient form ───────────────────────────────────────────────────

  get patientPhoneInput() {
    return this.page.locator('#patient-phone');
  }

  /**
   * The 6 OTP cells. Each cell carries an `aria-label` of
   * "Digit N of 6" (see apps/web/src/pages/LoginPage.tsx), so we
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
   * Returns the visible error banner text (or null if absent).
   * The LoginPage uses `<div role="alert">` for the failure banner
   * (see apps/web/src/pages/LoginPage.tsx `error-banner`).
   */
  async errorBannerText(): Promise<string | null> {
    const banner = this.page.locator('[role="alert"]').first();
    if ((await banner.count()) === 0) return null;
    const visible = await banner.isVisible().catch(() => false);
    return visible ? banner.innerText() : null;
  }

  async expectErrorBanner(expectedSubstring: string) {
    const banner = this.page.locator('[role="alert"]').first();
    await expect(banner).toBeVisible();
    const text = (await banner.innerText()) ?? '';
    expect(text.toLowerCase()).toContain(expectedSubstring.toLowerCase());
  }
}
