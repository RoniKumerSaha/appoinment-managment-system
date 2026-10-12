/**
 * 18-patient-cancel-no-reason.spec.ts
 *
 * FR-035: the patient-cancel route requires no `reason` payload
 * (it's optional for patient self-cancel). The slot is freed again
 * (the GIST exclusion is scoped to status='Scheduled').
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import {
  verifyPatientOtp,
  createBooking,
  listPatientAppointments,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('cancel from My appointments: status flips, slot becomes free', async ({
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

  // Drive the UI cancel flow: open MyAppointments, click the row's
  // Cancel button, confirm in the modal.
  await patient.goToMyAppointments();
  await patient.expectOnMyAppointments();
  await patient.clickApptRowCancel(apptId);
  await patient.expectCancelModalVisible();
  await patient.confirmCancel();

  // Wait for the UI row to disappear — the cancel + refetch is async
  // (CancelModal → patientCancel API → onDone → refresh()). A direct
  // API call immediately after confirmCancel can race the in-flight
  // DELETE before the row is filtered out of /patient/appointments.
  await expect(patient.myApptRow(apptId)).toHaveCount(0, { timeout: 5_000 });

  // Server-side: row is no longer in the Scheduled+future list.
  const after = await listPatientAppointments(apiToken);
  expect(
    after.appointments.find((a) => a.id === apptId),
    'cancelled row is filtered out of /patient/appointments',
  ).toBeUndefined();
});
