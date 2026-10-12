/**
 * 12-patient-booking-happy-path.spec.ts — patient books a slot end-to-end.
 *
 * Walks the 5-step PatientBooking wizard (doctor → branch+type → slot →
 * details → confirm), then asserts the new row shows in MyAppointments
 * with status=Scheduled. Cleanup: cancels the booking as the patient
 * at the end so the next run starts with a clean DB row.
 *
 * Uses patient-02 storageState (patient-01 has a seeded future
 * appointment with East Lead, which trips FR-027's "no slots" guard
 * and breaks the happy path).
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import {
  buildBookingFixture,
} from '../helpers/booking-fixture.ts';
import {
  listPatientAppointments,
  cancelPatientBooking,
  verifyPatientOtp,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('patient books a slot end-to-end and sees it in My appointments', async ({
  page,
}) => {
  const patient = new PatientPage(page);

  await page.goto('/');
  await patient.expectMounted();

  // Re-mint a fresh patient token at spec start. The storageState
  // token is used to drive the UI; the API token here is what we
  // send in `Authorization: Bearer …` for catalog reads + cleanup
  // calls. We use a freshly-minted token (not the storageState one)
  // so the cleanup POST at the end of the spec is guaranteed to be
  // accepted by the server even if the storageState token was
  // nearing its 60-minute TTL.
  const apiAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );
  const apiToken = apiAuth.token;

  const fixture = await buildBookingFixture(page, {
    patientPhone: FIXTURE.patient02.phone,
    doctorNameIncludes: 'East Lead',
    branchNameIncludes: 'East',
    typeNameIncludes: 'Follow-up',
    daysAhead: 2,
  });

  await patient.bookAppointment({
    doctorId: fixture.doctor.id,
    branchId: fixture.branch.id,
    typeId: fixture.type.id,
    date: fixture.date,
    startDatetime: fixture.startDatetime,
    phone: FIXTURE.patient02.phone,
    name: 'Patient Two',
  });

  // The wizard ends on the receipt card. Either a `recep-today` testid
  // (ConfirmationReceipt) or a `patient-booking-confirm-card` testid
  // is acceptable; we assert that something post-confirmation is
  // showing.
  await expect(
    page.locator(
      '[data-testid="recep-today"], [data-testid="patient-booking-confirm-card"]',
    ),
  ).toBeVisible({ timeout: 10_000 });

  // Server-side: assert the row is in the patient's list with
  // status=Scheduled. Use the freshly-minted API token.
  const { appointments } = await listPatientAppointments(apiToken);
  const booked = appointments.find(
    (a) => a.start_datetime === fixture.startDatetime,
  );
  expect(booked, 'new booking appears in /patient/appointments').toBeDefined();
  expect(booked!.status).toBe('Scheduled');
  const appointmentId = booked!.id;

  // Drive the UI to MyAppointments and confirm the row is visible.
  await patient.goToMyAppointments();
  await patient.expectOnMyAppointments();
  await patient.expectApptRowVisible(appointmentId);

  // Cleanup: soft-cancel. FR-038 — no DELETE on appointments.
  await cancelPatientBooking(apiToken, appointmentId);
});
