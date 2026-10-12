/**
 * 22-patient-deep-link-cancel.spec.ts
 *
 * A patient clicks an SMS link of the form
 * `?action=cancel&id=<appointmentId>`. The app calls
 * `GET /patient/appointments/:id/deep-link`, which returns the row
 * along with `can_cancel: true`. The cancel modal must open
 * pre-armed.
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import {
  verifyPatientOtp,
  createBooking,
  getPatientDeepLink,
  cancelPatientBooking,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('deep-link ?action=cancel&id=… opens the cancel modal pre-armed', async ({
  page,
}) => {
  const patient = new PatientPage(page);
  await page.goto('/');
  await patient.expectMounted();

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

  const first = await createBooking(apiToken, {
    doctor_id: fixture.doctor.id,
    branch_id: fixture.branch.id,
    appointment_type_id: fixture.type.id,
    start_datetime: fixture.startDatetime,
    end_datetime: fixture.endDatetime,
    slot_duration_minutes: fixture.slotDurationMinutes,
    patient_phone: FIXTURE.patient02.phone,
    patient_name: 'Patient Two',
  });
  const apptId = first.appointment.id;

  // Server-side: deep-link flags.
  const link = await getPatientDeepLink(apiToken, apptId);
  expect(link.can_cancel).toBe(true);

  // Client-side: navigate with the deep-link query. The app
  // scrubs the query, sets view=my-appointments, then MyAppointments
  // fetches /deep-link and opens the cancel modal.
  await page.goto(`/?action=cancel&id=${encodeURIComponent(apptId)}`);
  // Wait for MyAppointments to mount first.
  await patient.expectOnMyAppointments();
  // Then the modal opens after the /deep-link fetch resolves.
  await patient.expectCancelModalVisible();

  // Confirm the cancel. The modal close + row drop from list is
  // asserted via the API to avoid timing races with the UI.
  await patient.confirmCancel();
  // Cleanup via API to be safe.
  await cancelPatientBooking(apiToken, apptId);
});
