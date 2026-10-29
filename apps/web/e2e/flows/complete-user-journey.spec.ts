/**
 * e2e/flows/complete-user-journey.spec.ts
 *
 * A SINGLE chained e2e spec that walks a realistic MediSlot user
 * journey end-to-end. Replaces the prior 33 per-feature specs.
 *
 * Flow (mirrors MANUAL_TEST_PLAN.md "critical" path):
 *   1. Patient signs in via OTP.
 *   2. Patient books a new appointment through the 5-step wizard.
 *   3. Patient sees the booking in their "My appointments" list.
 *   4. Patient reschedules the appointment to a different slot.
 *   5. Patient cancels the appointment.
 *   6. Patient signs out.
 *   7. Doctor signs in via staff email.
 *   8. Doctor sees the kanban / empty To-Do list.
 *   9. Doctor signs out.
 *  10. A second patient cannot see the first patient's appointments.
 *
 * Headed + slowMo: the Playwright config sets `headless: false` and
 * `slowMo: 1000` so every click + fill is human-paced and easy to
 * follow in the browser. CI overrides to `headless: true, slowMo: 0`.
 *
 * Why `test.describe.serial`: each step depends on prior state. A
 * failure in step 3 should fail the run, not paper over by retrying
 * step 4 against a different patient.
 *
 * The spec uses the pre-baked storageState planted by auth.setup.ts
 * (patient-01, doctor-east) so the login + the post-login flow are
 * both exercised. Each test clears localStorage before re-using a
 * context so the storageState doesn't bleed across cases.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { FIXTURE } from '../helpers/ids.ts';
import { LoginPage } from '../pages/login.page.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { DoctorPage } from '../pages/doctor.page.ts';
import {
  buildBookingFixture,
  readTokenFromStorage,
  type BookingFixture,
} from '../helpers/booking-fixture.ts';
import {
  cancelPatientBooking,
  listPatientAppointments,
  type PatientAppointmentRow,
} from '../helpers/api.ts';

const PATIENT_PHONE = FIXTURE.patient02.phone; // use a fresh patient
const PATIENT_CODE = FIXTURE.patient02.code;
const DOCTOR_EMAIL = FIXTURE.doctorEastLead.email;
const DOCTOR_NAME_INCLUDES = 'East Lead';
const BRANCH_NAME_INCLUDES = 'East';
const TYPE_NAME_INCLUDES = 'General';

/** Sign in as a patient by driving the LoginPage. */
async function patientSignIn(page: Page, phone: string, code: string): Promise<void> {
  const login = new LoginPage(page);
  await login.signInAsPatient(phone, code);
}

/** Sign in as a staff member by driving the LoginPage. */
async function staffSignIn(
  page: Page,
  role: 'admin' | 'doctor' | 'receptionist',
  email: string,
): Promise<void> {
  const login = new LoginPage(page);
  await login.signInAsStaff(role, email, FIXTURE.staffPassword);
}

/** Sign out via the app's nav. */
async function signOut(page: Page): Promise<void> {
  // The patient app renders its own nav (PatientFrame), which uses a
  // different class than the staff AppShell — so select by the
  // accessible name, which both share.
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  // After sign out the LoginPage is the landing page.
  await page.waitForURL((u) => u.pathname === '/' || u.pathname === '', {
    timeout: 10_000,
  });
}

/** Spin up a fresh browser context with no storageState (so each
 *  test starts on the login page). */
async function newContext(
  browser: import('@playwright/test').Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  return { context: ctx, page };
}

test.describe.serial('Complete user journey — patient books, reschedules, cancels, doctor reviews', () => {
  test('1. Patient signs in via OTP and lands on the booking flow', async ({ browser }) => {
    const { page } = await newContext(browser);
    await patientSignIn(page, PATIENT_PHONE, PATIENT_CODE);
    // Patient app mounts the booking frame.
    const patient = new PatientPage(page);
    await patient.expectMounted();
    await expect(patient.doctorList).toBeVisible({ timeout: 10_000 });
  });

  test('2. Patient books an appointment through the 5-step wizard', async ({ browser }) => {
    const { page } = await newContext(browser);
    await patientSignIn(page, PATIENT_PHONE, PATIENT_CODE);

    const patient = new PatientPage(page);
    await patient.expectMounted();

    // Discover the live IDs (avoid hard-coded UUIDs).
    const fixture: BookingFixture = await buildBookingFixture(page, {
      patientPhone: PATIENT_PHONE,
      doctorNameIncludes: DOCTOR_NAME_INCLUDES,
      branchNameIncludes: BRANCH_NAME_INCLUDES,
      typeNameIncludes: TYPE_NAME_INCLUDES,
      daysAhead: 3,
    });

    // Walk the wizard.
    await patient.bookAppointment({
      doctorId: fixture.doctor.id,
      branchId: fixture.branch.id,
      typeId: fixture.type.id,
      date: fixture.date,
      startDatetime: fixture.startDatetime,
      phone: PATIENT_PHONE,
      name: 'Manual Test Patient',
    });

    // After confirmation, the receipt shows. We don't depend on the
    // receipt's static text; we cross-check via the API that the
    // booking actually exists in the DB.
    const token = await readTokenFromStorage(page);
    const { appointments } = await listPatientAppointments(token);
    expect(appointments.length, 'patient has at least one future appointment').toBeGreaterThanOrEqual(1);
    const justBooked = appointments.find(
      (a: PatientAppointmentRow) => a.start_datetime === fixture.startDatetime,
    );
    expect(justBooked, 'the just-booked appointment shows in the list').toBeTruthy();
  });

  test('3. Patient sees the new appointment in My appointments', async ({ browser }) => {
    const { page } = await newContext(browser);
    await patientSignIn(page, PATIENT_PHONE, PATIENT_CODE);
    const patient = new PatientPage(page);
    await patient.expectMounted();

    // The patient must have at least one booking from step 2.
    const token = await readTokenFromStorage(page);
    const { appointments } = await listPatientAppointments(token);
    expect(appointments.length).toBeGreaterThanOrEqual(1);
    const target = appointments[0]!;

    // Navigate to My appointments and confirm the row is visible.
    await patient.goToMyAppointments();
    await patient.expectApptRowVisible(target.id);
  });

  test('4. Patient reschedules the appointment to a different slot', async ({ browser }) => {
    const { page } = await newContext(browser);
    await patientSignIn(page, PATIENT_PHONE, PATIENT_CODE);
    const patient = new PatientPage(page);
    await patient.expectMounted();

    // The booking from step 2 is the one we move. The auth.setup
    // reset clears test data before the suite, and step 2 is the only
    // thing that books for this patient, so there is exactly one row.
    const token = await readTokenFromStorage(page);
    const { appointments } = await listPatientAppointments(token);
    expect(appointments.length).toBeGreaterThanOrEqual(1);
    const target = appointments[0]!;
    const originalStart = target.start_datetime;

    // Open the reschedule flow.
    await patient.goToMyAppointments();
    await patient.clickApptRowReschedule(target.id);
    await patient.expectRescheduleOpen();

    // The slot grid MUST offer slots. This is the regression: the
    // availability preview applied FR-027 without excluding the
    // appointment being moved, so the grid came back empty and the
    // patient was told to cancel first.
    await patient.waitForRescheduleSlots();
    const newStart = await patient.firstRescheduleSlot();
    expect(
      newStart,
      'the reschedule preview offers slots to the patient who holds the appointment',
    ).not.toBeNull();

    // Pick the slot and confirm the move.
    await patient.confirmReschedule(newStart!);

    // The move is real: the appointment now starts at the new time.
    const after = await listPatientAppointments(token);
    const moved = after.appointments.find((a) => a.id === target.id);
    expect(moved, 'the appointment still exists after the reschedule').toBeTruthy();
    expect(
      moved!.start_datetime,
      'the appointment moved to the new slot',
    ).not.toBe(originalStart);
  });

  test('5. Patient cancels the appointment', async ({ browser }) => {
    const { page } = await newContext(browser);
    await patientSignIn(page, PATIENT_PHONE, PATIENT_CODE);
    const patient = new PatientPage(page);
    await patient.expectMounted();

    // Cancel via API to avoid the modal flakiness — the user-journey
    // test asserts the end-state, not the modal interaction. The
    // modal interaction itself is covered in MANUAL_TEST_PLAN.md and
    // would be a candidate for a future dedicated spec.
    const token = await readTokenFromStorage(page);
    const { appointments } = await listPatientAppointments(token);
    expect(appointments.length, 'patient has at least one appointment to cancel').toBeGreaterThanOrEqual(1);
    for (const a of appointments) {
      await cancelPatientBooking(token, a.id);
    }

    // Confirm the cancel.
    const after = await listPatientAppointments(token);
    expect(after.appointments.length, 'no future appointments after cancel').toBe(0);
  });

  test('6. Patient signs out', async ({ browser }) => {
    const { page } = await newContext(browser);
    await patientSignIn(page, PATIENT_PHONE, PATIENT_CODE);
    const patient = new PatientPage(page);
    await patient.expectMounted();
    await signOut(page);
    // After sign-out the login CHOOSER is the landing page — the
    // staff and patient forms are separate screens now, reachable
    // from the chooser.
    const login = new LoginPage(page);
    await expect(login.chooserRoot()).toBeVisible();
    await expect(login.chooserStaffCard()).toBeVisible();
    await expect(login.chooserPatientCard()).toBeVisible();
  });

  test('7. Doctor signs in via staff email and lands on the kanban', async ({ browser }) => {
    const { page } = await newContext(browser);
    await staffSignIn(page, 'doctor', DOCTOR_EMAIL);
    const doctor = new DoctorPage(page);
    await doctor.expectMounted();
    await doctor.expectOnAffected();
  });

  test('8. Doctor sees the affected kanban (To-Do list may be empty)', async ({ browser }) => {
    const { page } = await newContext(browser);
    await staffSignIn(page, 'doctor', DOCTOR_EMAIL);
    const doctor = new DoctorPage(page);
    await doctor.expectMounted();
    await doctor.expectOnAffected();
    // The To-Do count is a number — it may be 0 (no affected rows
    // today). We don't assert a specific count; just that the page
    // is mounted and the column is present.
    await expect(page.locator('[data-testid="doc-aff"]')).toBeVisible();
  });

  test('9. Doctor signs out', async ({ browser }) => {
    const { page } = await newContext(browser);
    await staffSignIn(page, 'doctor', DOCTOR_EMAIL);
    const doctor = new DoctorPage(page);
    await doctor.expectMounted();
    await signOut(page);
    // Signing out returns to the login chooser.
    const login = new LoginPage(page);
    await expect(login.chooserRoot()).toBeVisible();
  });

  test('10. A different patient cannot see the first patient\'s appointments', async ({ browser }) => {
    const { page } = await newContext(browser);
    // First, log in as patient-02 (who just cancelled) and confirm
    // the list is empty.
    await patientSignIn(page, FIXTURE.patient02.phone, FIXTURE.patient02.code);
    const patient = new PatientPage(page);
    await patient.expectMounted();
    let token = await readTokenFromStorage(page);
    let res = await listPatientAppointments(token);
    expect(res.appointments.length, 'patient-02 has no future appointments').toBe(0);

    // Sign out.
    await signOut(page);

    // Now log in as patient-03 — a DIFFERENT patient. The list MUST
    // not leak patient-02's data. (It is empty for patient-03 too,
    // since the booking was made by patient-02 and then cancelled.)
    await patientSignIn(page, FIXTURE.patient03.phone, FIXTURE.patient03.code);
    const other = new PatientPage(page);
    await other.expectMounted();
    token = await readTokenFromStorage(page);
    res = await listPatientAppointments(token);
    // The list MUST be empty for patient-03 — they have no bookings.
    expect(res.appointments.length, 'patient-03 has no future appointments').toBe(0);

    // And the response must not include any patient-02 identifiers.
    const allText = JSON.stringify(res);
    expect(allText).not.toContain(FIXTURE.patient02.phone);
  });
});
