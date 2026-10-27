/**
 * e2e/pages/patient.page.ts — selectors for the patient app.
 *
 * The patient flow is a self-contained state machine inside
 * PatientApp (no router). After login we land on the booking flow
 * (`<PatientBooking />`) by default, which walks:
 *   Step 1: doctor picker
 *   Step 2: branch + appointment-type picker
 *   Step 3: date + slot picker
 *   Step 4: phone + name
 *   Step 5: review + confirm
 * Then either the static receipt (ConfirmationReceipt) or a
 * "back to my appointments" path.
 *
 * The cancel + reschedule flow lives in <MyAppointments>, which is
 * reachable via the top-nav "My appointments" link. The cancel
 * confirmation surface is the `<CancelModal>` component.
 *
 * All selectors target `data-testid` (added in the data-testid pass)
 * so they don't break on CSS-module renames.
 */
import { expect, type Page } from '@playwright/test';

export class PatientPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Mounting probes ────────────────────────────────────────────

  /** Root container for the patient shell. */
  get frame() {
    return this.page.locator('[data-testid="patient-frame"]');
  }

  async expectMounted() {
    await expect(this.frame).toBeVisible();
  }

  async expectNotMounted() {
    await expect(this.frame).toHaveCount(0);
  }

  // ─── PatientBooking step 1: doctor picker ─────────────────────

  get doctorList() {
    return this.page.locator('[data-testid="patient-booking-doctor-list"]');
  }

  doctorCard(doctorId: string) {
    return this.page.locator(
      `[data-testid="patient-booking-doctor-card-${doctorId}"]`,
    );
  }

  async pickDoctor(doctorId: string) {
    await this.doctorCard(doctorId).click();
  }

  // ─── PatientBooking step 2: branch + type picker ──────────────

  branchCard(branchId: string) {
    return this.page.locator(
      `[data-testid="patient-booking-branch-card-${branchId}"]`,
    );
  }

  typeCard(typeId: string) {
    return this.page.locator(
      `[data-testid="patient-booking-type-card-${typeId}"]`,
    );
  }

  get step2Continue() {
    return this.page.locator('[data-testid="patient-booking-step2-continue-btn"]');
  }

  async pickBranch(branchId: string) {
    await this.branchCard(branchId).click();
  }

  async pickType(typeId: string) {
    await this.typeCard(typeId).click();
  }

  // ─── PatientBooking step 3: date + slot picker ────────────────

  dateCell(date: string) {
    return this.page.locator(
      `[data-testid="patient-booking-date-cell-${date}"]`,
    );
  }

  slotButton(startDatetime: string) {
    return this.page.locator(
      `[data-testid="patient-booking-slot-btn-${startDatetime}"]`,
    );
  }

  get step3Continue() {
    return this.page.locator('[data-testid="patient-booking-step3-continue-btn"]');
  }

  async pickDate(date: string) {
    await this.dateCell(date).click();
  }

  async pickSlot(startDatetime: string) {
    await this.slotButton(startDatetime).click();
  }

  // ─── PatientBooking step 4: details ───────────────────────────

  get phoneInput() {
    return this.page.locator('[data-testid="patient-booking-phone-input"]');
  }

  get nameInput() {
    return this.page.locator('[data-testid="patient-booking-name-input"]');
  }

  get step4Continue() {
    return this.page.locator('[data-testid="patient-booking-step4-continue-btn"]');
  }

  async fillDetails(phone: string, name: string) {
    await this.phoneInput.fill(phone);
    await this.nameInput.fill(name);
  }

  // ─── PatientBooking step 5: confirm ───────────────────────────

  get step5Confirm() {
    return this.page.locator('[data-testid="patient-booking-step5-confirm-btn"]');
  }

  get step5Error() {
    return this.page.locator('[data-testid="patient-booking-step5-submit-error"]');
  }

  async confirmBooking() {
    await this.step5Confirm.click();
  }

  // ─── End-to-end booking helper ────────────────────────────────

  /**
   * Walks steps 1..5 and returns the new appointment id by reading
   * the receipt card's "Booking reference" line. The receipt renders
   * from the booking that was actually made, but the more reliable
   * way to capture the id is to call
   * `helpers/api.ts#fetchLatestPatientAppointment(token, phone)` from
   * the test itself.
   */
  async bookAppointment(input: {
    doctorId: string;
    branchId: string;
    typeId: string;
    date: string;
    startDatetime: string;
    phone: string;
    name: string;
  }) {
    await this.pickDoctor(input.doctorId);
    await this.pickBranch(input.branchId);
    await this.pickType(input.typeId);
    // Step 2 → 3: "Find available times" footer button.
    await this.step2Continue.click();
    await this.pickDate(input.date);
    await this.pickSlot(input.startDatetime);
    // Step 3 → 4: "Review" footer button.
    await this.step3Continue.click();
    await this.fillDetails(input.phone, input.name);
    await this.step4Continue.click();
    await this.confirmBooking();
  }

  // ─── Booking-error path (FR-027 / FR-029 etc.) ────────────────

  /**
   * The error banner carries the API's typed error code in bold,
   * followed by the human message. We expose two probes:
   *   - `expectErrorCode(code)`: the banner's <strong> matches `code`
   *   - `expectErrorBannerVisible()`: the banner is showing
   */
  get errorBanner() {
    return this.page.locator('[data-testid="patient-booking-error-banner"]');
  }

  async expectErrorBannerVisible() {
    await expect(this.errorBanner).toBeVisible();
  }

  async expectErrorCode(code: string) {
    const text = (await this.errorBanner.innerText()) ?? '';
    expect(text.toLowerCase()).toContain(code.toLowerCase());
  }

  // ─── MyAppointments view ──────────────────────────────────────

  get myApptsRoot() {
    return this.page.locator('[data-testid="my-appts"]');
  }

  async goToMyAppointments() {
    await this.page.locator('[data-testid="patient-frame-my-appts"]').first().click();
  }

  async expectOnMyAppointments() {
    await expect(this.myApptsRoot).toBeVisible();
  }

  myApptRow(appointmentId: string) {
    return this.page.locator(`[data-testid="my-appts-row-${appointmentId}"]`);
  }

  myApptRowCount(): Promise<number> {
    return this.page
      .locator('[data-testid^="my-appts-row-"]')
      .filter({ hasNot: this.page.locator('[data-testid$="-reschedule-btn"], [data-testid$="-cancel-btn"]') })
      .count();
  }

  async expectApptRowVisible(appointmentId: string) {
    await expect(this.myApptRow(appointmentId)).toBeVisible();
  }

  async clickApptRowCancel(appointmentId: string) {
    await this.page.locator(
      `[data-testid="my-appts-row-${appointmentId}-cancel-btn"]`,
    ).click();
  }

  async clickApptRowReschedule(appointmentId: string) {
    await this.page.locator(
      `[data-testid="my-appts-row-${appointmentId}-reschedule-btn"]`,
    ).click();
  }

  // ─── CancelModal ──────────────────────────────────────────────

  get cancelModal() {
    return this.page.locator('[data-testid="cancel-modal"]');
  }

  get cancelModalTitle() {
    return this.page.locator('[data-testid="cancel-modal-title"]');
  }

  get cancelModalConfirm() {
    return this.page.locator('[data-testid="cancel-modal-confirm-btn"]');
  }

  get cancelModalKeep() {
    return this.page.locator('[data-testid="cancel-modal-keep-btn"]');
  }

  get cancelModalError() {
    return this.page.locator('[data-testid="cancel-modal-error"]');
  }

  async expectCancelModalVisible() {
    await expect(this.cancelModal).toBeVisible();
  }

  async confirmCancel() {
    await this.cancelModalConfirm.click();
  }

  async keepAppointment() {
    await this.cancelModalKeep.click();
  }
}
