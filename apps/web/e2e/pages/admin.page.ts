/**
 * e2e/pages/admin.page.ts — selectors for the admin AppShell + sections.
 *
 * The admin surface is the only one with a router (a tiny custom
 * hash router — see apps/web/src/router/usePathRoute.tsx). URLs look
 * like `http://localhost:5173/#/admin/clinic`.
 *
 * The AppShell (apps/web/src/AppShell.tsx) renders:
 *   - a row of section `<button>`s with class `nav__link`
 *     (the active one is a `<span class="nav__link--active">`)
 *   - a `<button class="nav__signout">Sign out</button>`
 *
 * Sub-pages (e.g. doctor-assign) are reached by navigating to a
 * hash URL directly via `page.goto()`; the hash router parses it.
 */
import { expect, type Page } from '@playwright/test';

const SECTION_TITLES = {
  clinic: 'Clinic',
  branches: 'Branches',
  doctors: 'Doctors',
  receptionists: 'Receptionists',
  types: 'Appointment types',
  audit: 'Audit log',
} as const;

export type AdminSection = keyof typeof SECTION_TITLES;

export class AdminPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** The AppShell root used as a mount probe. */
  get shell() {
    return this.page.locator('.shell');
  }

  async expectMounted() {
    await expect(this.shell).toBeVisible();
  }

  /**
   * Click a section in the AppShell. The router navigates via the
   * `onNavigate` callback, which updates `window.location.hash`.
   */
  async gotoSection(section: AdminSection) {
    const label = SECTION_TITLES[section];
    const button = this.page.locator(`.nav__link[title="${label}"]`);
    await button.click();
    await this.expectHash(section);
  }

  /**
   * Wait for the URL hash to match `#/admin/<section>`. Used after
   * an explicit navigation (a section click in the AppShell, or a
   * direct hash assignment).
   *
   * Note: the initial render after login lands on the clinic
   * section but the URL hash is empty (the hash router's default).
   * To assert the *initial* state, use `expectActiveSection`
   * instead.
   */
  async expectHash(section: AdminSection) {
    const want = `#/admin/${section}`;
    await this.page.waitForURL(
      (url) => url.hash === want,
      { timeout: 5_000 },
    );
  }

  /**
   * Asserts the visible "active section" indicator in the AppShell
   * matches the given section. The active section is rendered as a
   * `<span class="nav__link--active" aria-current="page">` whose
   * text is the human label (e.g. "Clinic").
   *
   * Use this for the post-login state, where the URL hash is empty
   * even though the clinic section is active.
   */
  async expectActiveSection(section: AdminSection) {
    const label = SECTION_TITLES[section];
    const active = this.page.locator(
      'span.nav__link--active[aria-current="page"]',
    );
    await expect(active).toBeVisible();
    await expect(active).toHaveText(new RegExp(`^${label}$`));
  }

  /**
   * Open a doctor's sub-page via direct navigation. Cheaper than a
   * long click chain (find this row → click the kebab → click
   * "assign"), and the hash router supports deep links.
   */
  async openDoctorSubPage(
    doctorId: string,
    sub: 'assign' | 'schedule' | 'blocks',
  ) {
    const target = `#/admin/doctors/${doctorId}/${sub}`;
    await this.page.evaluate((h) => {
      window.location.hash = h;
    }, target);
    await this.page.waitForURL((url) => url.hash === target, { timeout: 5_000 });
  }

  get signOutButton() {
    return this.page.locator('button.nav__signout');
  }

  async signOut() {
    await this.signOutButton.click();
  }
}
