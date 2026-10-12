/**
 * e2e/pages/receptionist.page.ts — selectors for the receptionist app.
 *
 * ReceptionistApp renders <ReceptionistToday /> by default. For
 * PR-1 we only assert the frame mounts after login; PR-2 will
 * drive the cancel flow.
 */
import { expect, type Page } from '@playwright/test';

export class ReceptionistPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get frame() {
    return this.page.locator('.recep-frame__root');
  }

  async expectMounted() {
    await expect(this.frame).toBeVisible();
  }
}
