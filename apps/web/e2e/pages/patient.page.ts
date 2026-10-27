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

  /**
   * The receipt only renders once the POST /bookings has resolved and
   * the response has been folded into the draft. Clicking the confirm
   * button and returning immediately races the request — the caller
   * would query the appointments list before the row is committed and
   * see an empty list.
   */
  get receipt() {
    return this.page.locator('[data-testid="patient-booking-receipt"]');
  }

  async confirmBooking() {
    await this.step5Confirm.click();
    // Wait for the booking to land. The receipt is the app's own
    // "the POST resolved" signal.
    await this.receipt.waitFor({ state: 'visible', timeout: 15_000 });
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

  // ─── ReschedulePage ────────────────────────────────────────────

  get rescheduleDialog() {
    return this.page.locator('[data-testid="reschedule-dialog"]');
  }

  get rescheduleSlotGrid() {
    return this.page.locator('[data-testid="reschedule-slots"]');
  }

  get rescheduleNoSlots() {
    return this.page.locator('[data-testid="reschedule-no-slots"]');
  }

  get rescheduleConfirmBtn() {
    return this.page.locator('[data-testid="reschedule-confirm-btn"]');
  }

  get rescheduleError() {
    return this.page.locator('[data-testid="reschedule-error"]');
  }

  rescheduleDateCell(date: string) {
    return this.page.locator(`[data-testid="reschedule-date-${date}"]`);
  }

  rescheduleSlot(startDatetime: string) {
    return this.page.locator(
      `[data-testid="reschedule-slot-${startDatetime}"]`,
    );
  }

  /** Wait for the reschedule dialog to mount. */
  async expectRescheduleOpen() {
    await expect(this.rescheduleDialog).toBeVisible();
  }

  /**
   * The slot grid is populated by an async GET /availability. Wait for
   * a slot button to actually appear — waiting for the grid to be
   * visible is not enough, because the grid renders before the fetch
   * starts (the "Loading slots…" text only appears once the effect
   * runs, which is a tick later).
   */
  async waitForRescheduleSlots() {
    await expect(this.rescheduleSlotGrid).toBeVisible();
    await expect(this.rescheduleSlotButtons().first()).toBeVisible({
      timeout: 15_000,
    });
  }

  /** The slot buttons. Scoped to `button` so the grid container (which
   *  shares the `reschedule-slot-` prefix) can never be picked up. */
  rescheduleSlotButtons() {
    return this.page.locator('button[data-testid^="reschedule-slot-"]');
  }

  /** The first slot the server offered, as its start datetime. */
  async firstRescheduleSlot(): Promise<string | null> {
    const slot = this.rescheduleSlotButtons().first();
    if ((await slot.count()) === 0) return null;
    const testId = await slot.getAttribute('data-testid');
    return testId?.replace('reschedule-slot-', '') ?? null;
  }

  /**
   * Pick a slot and confirm the move.
   *
   * Clicking "Confirm move" kicks off POST
   * /patient/appointments/:id/reschedule. The click returns long before
   * the POST resolves, so a caller that immediately re-reads the
   * appointments list sees the OLD start time and concludes the move
   * failed. Wait for the dialog to close (the parent's `onDone` closes
   * it once the move has landed) before returning.
   */
  async confirmReschedule(startDatetime: string) {
    await this.rescheduleSlot(startDatetime).click();
    await expect(this.rescheduleConfirmBtn).toBeEnabled();
    await this.rescheduleConfirmBtn.click();
    // The dialog unmounts when the move succeeds. If the move fails,
    // an inline error appears instead and the dialog stays open —
    // surface that rather than timing out with no explanation.
    await expect(this.rescheduleDialog).toHaveCount(0, { timeout: 15_000 });
  }

  /**
   * The inline error the dialog shows when the move was rejected
   * (e.g. `slot_raced`). Empty string when there is no error.
   */
  async rescheduleErrorText(): Promise<string> {
    if ((await this.rescheduleError.count()) === 0) return '';
    return (await this.rescheduleError.innerText()) ?? '';
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
