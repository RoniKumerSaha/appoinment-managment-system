/**
 * e2e/pages/doctor.page.ts — selectors for the doctor app.
 *
 * The doctor flow lives in <DoctorApp> + <DoctorFrame> + <DoctorAffected>.
 * The "Resolve affected appointments" kanban is the entry surface
 * (`/doctor/affected`); each card has Move / Audit / Cancel / Mark
 * actions. The Move / Cancel / Mark modals are separate page
 * components mounted on top of the kanban.
 *
 * All selectors target `data-testid` so they don't break on CSS-module
 * renames. The frame and the affected-page testids were added in the
 * data-testid pass.
 */
import { expect, type Page } from '@playwright/test';

export class DoctorPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Mounting probes ────────────────────────────────────────────

  get app() {
    return this.page.locator('[data-testid="doctor-app"]');
  }

  get frame() {
    return this.page.locator('[data-testid="doctor-frame"]');
  }

  async expectMounted() {
    await expect(this.app).toBeVisible();
  }

  async expectOnAffected() {
    await expect(this.page.locator('[data-testid="doc-aff"]')).toBeVisible();
  }

  // ─── Kanban ─────────────────────────────────────────────────────

  todoPillCount(): Promise<number> {
    return this.page
      .locator('[data-testid="doc-aff-pill-todo"]')
      .innerText()
      .then((t) => {
        const m = t.match(/(\d+)/);
        return m ? Number(m[1]) : 0;
      });
  }

  colCount(tone: 'todo' | 'doing' | 'scheduling' | 'done'): Promise<number> {
    return this.page
      .locator(`[data-testid="doc-aff-col-${tone}-count"]`)
      .innerText()
      .then((t) => Number(t.trim()));
  }

  card(appointmentId: string) {
    return this.page.locator(`[data-testid="doc-aff-card-${appointmentId}"]`);
  }

  async expectCardVisible(appointmentId: string) {
    await expect(this.card(appointmentId)).toBeVisible();
  }

  async clickMove(appointmentId: string) {
    await this.page
      .locator(`[data-testid="doc-aff-card-${appointmentId}-move-btn"]`)
      .click();
  }

  async clickCancel(appointmentId: string) {
    await this.page
      .locator(`[data-testid="doc-aff-card-${appointmentId}-cancel-btn"]`)
      .click();
  }

  async clickMark(appointmentId: string) {
    await this.page
      .locator(`[data-testid="doc-aff-card-${appointmentId}-mark-btn"]`)
      .click();
  }

  async clickAudit(appointmentId: string) {
    await this.page
      .locator(`[data-testid="doc-aff-card-${appointmentId}-audit-btn"]`)
      .click();
  }

  // ─── DoctorResolve (move) ──────────────────────────────────────

  get resolveModal() {
    return this.page.locator('[data-testid="doc-resolve-modal"]');
  }

  get resolveBranchSelect() {
    return this.page.locator('[data-testid="doc-resolve-branch-select"]');
  }

  resolveDateCell(date: string) {
    return this.page.locator(`[data-testid="doc-resolve-date-cell-${date}"]`);
  }

  resolveSlotButton(startDatetime: string) {
    return this.page.locator(
      `[data-testid="doc-resolve-slot-btn-${startDatetime}"]`,
    );
  }

  get resolveMoveBtn() {
    return this.page.locator('[data-testid="doc-resolve-move-btn"]');
  }

  get resolveBackBtn() {
    return this.page.locator('[data-testid="doc-resolve-back-btn"]');
  }

  get resolveError() {
    return this.page.locator('[data-testid="doc-resolve-error"]');
  }

  async expectResolveModalVisible() {
    await expect(this.resolveModal).toBeVisible();
  }

  async resolveMove(input: {
    branchId: string;
    date: string;
    startDatetime: string;
  }) {
    await this.resolveBranchSelect.selectOption(input.branchId);
    await this.resolveDateCell(input.date).click();
    await this.resolveSlotButton(input.startDatetime).click();
    await this.resolveMoveBtn.click();
  }

  // ─── DoctorCancel ──────────────────────────────────────────────

  get cancelModal() {
    return this.page.locator('[data-testid="doc-cancel-modal"]');
  }

  cancelReasonPreset(key: string) {
    return this.page.locator(`[data-testid="doc-cancel-reason-${key}"]`);
  }

  get cancelReasonInput() {
    return this.page.locator('[data-testid="doc-cancel-reason-input"]');
  }

  get cancelConfirmBtn() {
    return this.page.locator('[data-testid="doc-cancel-confirm-btn"]');
  }

  get cancelKeepBtn() {
    return this.page.locator('[data-testid="doc-cancel-keep-btn"]');
  }

  get cancelError() {
    return this.page.locator('[data-testid="doc-cancel-error"]');
  }

  async expectCancelModalVisible() {
    await expect(this.cancelModal).toBeVisible();
  }

  async confirmCancelWithReason(reasonKey?: string, freeText?: string) {
    if (reasonKey) {
      await this.cancelReasonPreset(reasonKey).click();
    }
    if (freeText) {
      await this.cancelReasonInput.fill(freeText);
    }
    await this.cancelConfirmBtn.click();
  }

  // ─── DoctorMarkStatus ──────────────────────────────────────────

  get markModal() {
    return this.page.locator('[data-testid="doc-mark-modal"]');
  }

  get markCompletedBtn() {
    return this.page.locator('[data-testid="doc-mark-completed-btn"]');
  }

  get markNoShowBtn() {
    return this.page.locator('[data-testid="doc-mark-no-show-btn"]');
  }

  get markError() {
    return this.page.locator('[data-testid="doc-mark-error"]');
  }

  async expectMarkModalVisible() {
    await expect(this.markModal).toBeVisible();
  }

  async markCompleted() {
    await this.markCompletedBtn.click();
  }

  async markNoShow() {
    await this.markNoShowBtn.click();
  }

  // ─── DoctorAuditDrawer ─────────────────────────────────────────

  get auditModal() {
    return this.page.locator('[data-testid="doc-audit-modal"]');
  }

  get auditCloseBtn() {
    return this.page.locator('[data-testid="doc-audit-close-btn"]');
  }

  auditFilterChip(slug: string) {
    return this.page.locator(`[data-testid="doc-audit-filter-${slug}"]`);
  }

  auditRow(rowId: string) {
    return this.page.locator(`[data-testid="doc-audit-row-${rowId}"]`);
  }

  get auditEmpty() {
    return this.page.locator('[data-testid="doc-audit-empty"]');
  }

  get auditError() {
    return this.page.locator('[data-testid="doc-audit-error"]');
  }

  async expectAuditDrawerVisible() {
    await expect(this.auditModal).toBeVisible();
  }

  async closeAuditDrawer() {
    await this.auditCloseBtn.click();
  }
}