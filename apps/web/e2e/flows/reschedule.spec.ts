/**
 * e2e/flows/reschedule.spec.ts
 *
 * The patient reschedule flow.
 *
 * The bug this pins: a patient who already held an appointment could
 * not reschedule it — the only way forward was to cancel and rebook.
 *
 * The cause was on the server: `GET /availability` applied FR-027
 * ("this patient already has a future appointment with this doctor →
 * zero slots") WITHOUT excluding the appointment being moved. The row
 * being rescheduled IS a future Scheduled row for that patient+doctor,
 * so the preview returned zero slots to exactly the patient who was
 * trying to reschedule, and the UI told them to cancel first.
 *
 * The commit-time recheck in `routes/patient-reschedule.ts` has always
 * excluded the row (`id <> $3`). The preview now excludes it too
 * (`id IS DISTINCT FROM $3`, with the same id passed through as the
 * `exclude_appointment_id` query param).
 *
 * These tests drive the real widget in a real browser and assert the
 * appointment actually MOVED — not merely that the button rendered.
 */
import { test, expect, type Page } from '@playwright/test';
import { PatientPage } from '../pages/patient.page.ts';
import { LoginPage } from '../pages/login.page.ts';
import { FIXTURE } from '../helpers/ids.ts';
import {
  buildBookingFixture,
  readTokenFromStorage,
} from '../helpers/booking-fixture.ts';
import {
  cancelPatientBooking,
  listPatientAppointments,
} from '../helpers/api.ts';

/**
 * This spec owns patient-05 exclusively. The other flow specs use
 * patient-02 (journey) and patient-04 (phone-number); a shared
 * patient would let one spec's Scheduled booking trip FR-027
 * ("one future appointment per patient per doctor") in another.
 */
const PATIENT_PHONE = FIXTURE.patient05.phone;
const PATIENT_CODE = FIXTURE.patient05.code;

/** Sign in as a patient so "My appointments" is reachable. */
async function signIn(page: Page): Promise<void> {
  const login = new LoginPage(page);
  await login.signInAsPatient(PATIENT_PHONE, PATIENT_CODE);
}

/**
 * Sign in and book one appointment through the 5-step wizard, so the
 * reschedule flow has something to move. The spec is self-contained:
 * it does not depend on another spec having run first.
 *
 * Any booking this patient already holds is cancelled first. FR-027
 * allows only ONE future Scheduled appointment per (patient, doctor),
 * and this spec books with the same doctor on every test — without
 * the cleanup, the second test's booking would be rejected outright.
 */
async function signInAndBook(page: Page): Promise<PatientPage> {
  await signIn(page);
  const patient = new PatientPage(page);
  await patient.expectMounted();

  // Clear the decks: cancel whatever this patient already holds.
  const token = await readTokenFromStorage(page);
  const existing = await listPatientAppointments(token);
  for (const a of existing.appointments) {
    await cancelPatientBooking(token, a.id);
  }

  const fixture = await buildBookingFixture(page, {
    patientPhone: PATIENT_PHONE,
    doctorNameIncludes: 'East Lead',
    branchNameIncludes: 'East',
    typeNameIncludes: 'General',
    daysAhead: 3,
  });

  await patient.bookAppointment({
    doctorId: fixture.doctor.id,
    branchId: fixture.branch.id,
    typeId: fixture.type.id,
    date: fixture.date,
    startDatetime: fixture.startDatetime,
    phone: PATIENT_PHONE,
    name: 'Reschedule Patient',
  });

  return patient;
}

/** The patient's future appointments, straight from the API. */
async function appointmentsFor(page: Page) {
  const token = await readTokenFromStorage(page);
  return listPatientAppointments(token);
}

test.describe.serial('patient reschedule', () => {
  test('the reschedule preview offers slots to the patient who holds the appointment', async ({
    page,
  }) => {
    const patient = await signInAndBook(page);

    const { appointments } = await appointmentsFor(page);
    expect(
      appointments.length,
      'the patient has a booking to reschedule',
    ).toBeGreaterThanOrEqual(1);
    const target = appointments[0]!;

    await patient.goToMyAppointments();
    await patient.clickApptRowReschedule(target.id);
    await patient.expectRescheduleOpen();

    // The grid is populated by an async GET /availability — wait for
    // the loading state to clear before asserting.
    await patient.waitForRescheduleSlots();

    // THE REGRESSION: the grid used to be empty, and the copy told the
    // patient to cancel first.
    await expect(
      patient.rescheduleNoSlots,
      'the reschedule preview must not be empty for the patient who holds the appointment',
    ).toHaveCount(0);

    const slots = await patient.rescheduleSlotButtons().count();
    expect(
      slots,
      'the reschedule preview offers at least one slot',
    ).toBeGreaterThan(0);
  });

  test('the patient can move the appointment without cancelling it first', async ({
    page,
  }) => {
    const patient = await signInAndBook(page);

    const before = await appointmentsFor(page);
    expect(before.appointments.length).toBeGreaterThanOrEqual(1);
    const target = before.appointments[0]!;
    const originalStart = target.start_datetime;

    await patient.goToMyAppointments();
    await patient.clickApptRowReschedule(target.id);
    await patient.expectRescheduleOpen();
    await patient.waitForRescheduleSlots();

    const newStart = await patient.firstRescheduleSlot();
    expect(newStart, 'a slot was offered').not.toBeNull();

    // Pick the slot and confirm the move — all through the UI.
    await patient.confirmReschedule(newStart!);

    // The move landed: the same appointment id, a new start time, and
    // the appointment was NOT cancelled (still Scheduled, still there).
    const after = await appointmentsFor(page);
    const moved = after.appointments.find((a) => a.id === target.id);
    expect(moved, 'the appointment still exists after the move').toBeTruthy();
    expect(moved!.status).toBe('Scheduled');
    expect(
      moved!.start_datetime,
      'the appointment moved to the new slot',
    ).not.toBe(originalStart);
    expect(moved!.start_datetime).toBe(newStart);
  });

  test('the reschedule dialog does not tell the patient to cancel first', async ({
    page,
  }) => {
    const patient = await signInAndBook(page);

    const { appointments } = await appointmentsFor(page);
    expect(appointments.length).toBeGreaterThanOrEqual(1);
    const target = appointments[0]!;

    await patient.goToMyAppointments();
    await patient.clickApptRowReschedule(target.id);
    await patient.expectRescheduleOpen();
    await patient.waitForRescheduleSlots();

    // The old copy was "Cancel it first or pick a different doctor.",
    // which is wrong: the patient CAN move this appointment. If the
    // grid is empty for another reason the copy may legitimately
    // mention another appointment — but it must not tell this patient
    // to cancel the appointment they are moving.
    const emptyText = await patient.rescheduleNoSlots.count()
      ? await patient.rescheduleNoSlots.innerText()
      : '';
    expect(emptyText).not.toContain('Cancel it first');
  });

  test('a broken session signs the patient out instead of impersonating admin', async ({
    page,
  }) => {
    // The second bug this pins: when the stored session is unusable
    // (expired / malformed), the API client used to fall back to the
    // dev-only ADMIN claim header. The preview then ran as an admin
    // (no patient filter → a full slot grid) while the commit ran as
    // an admin too → 403 `forbidden_role`, shown to the patient as
    // "Could not reschedule (forbidden_role)."
    //
    // The fix: a session that EXISTS but is unusable must NOT fall
    // back to the admin claim. Send no credential; the API answers
    // 401 and the app clears the session and re-routes to the login
    // page. The patient is told to sign in again — never handed a
    // privileged identity they did not ask for.
    const patient = await signInAndBook(page);
    const { appointments } = await appointmentsFor(page);
    const target = appointments[0]!;

    // Break the session: an expired token in the stored blob.
    await page.evaluate(() => {
      const raw = window.localStorage.getItem('medislot.auth');
      if (!raw) throw new Error('no auth in localStorage');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed['expires_at'] = new Date(Date.now() - 3_600_000).toISOString();
      window.localStorage.setItem('medislot.auth', JSON.stringify(parsed));
    });

    // The next call carries no usable credential, so the API answers
    // 401 and the app signs the patient out.
    await patient.goToMyAppointments();

    const login = new LoginPage(page);
    await expect(
      login.chooserRoot(),
      'the patient is routed back to the sign-in screen',
    ).toBeVisible({ timeout: 15_000 });

    // The session is gone — not silently replaced by an admin claim.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('medislot.auth'),
    );
    expect(stored, 'the broken session is cleared').toBeNull();

    // And the reschedule button is gone with the signed-out session.
    await expect(
      page.locator(
        `[data-testid="my-appts-row-${target.id}-reschedule-btn"]`,
      ),
      'no reschedule affordance survives a signed-out session',
    ).toHaveCount(0);
  });
});
