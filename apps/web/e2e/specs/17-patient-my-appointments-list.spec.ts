/**
 * 17-patient-my-appointments-list.spec.ts
 *
 * /patient/appointments returns only Scheduled + future rows
 * (cancelled/past rows are filtered server-side). We book one
 * appointment, list it (asserts 1 row in API + UI), then cancel it
 * (asserts it disappears from the list).
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import {
  verifyPatientOtp,
  createBooking,
  listPatientAppointments,
  cancelPatientBooking,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('My appointments: list shows only Scheduled+future; cancelled rows drop out', async ({
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

  // Snapshot the patient's current list (so we can assert the
  // before/after delta without knowing the seed state).
  const before = await listPatientAppointments(apiToken);

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

  // API now has +1 row.
  const during = await listPatientAppointments(apiToken);
  expect(during.appointments.length).toBe(before.appointments.length + 1);
  expect(
    during.appointments.find((a) => a.id === apptId),
    'new booking appears in API list',
  ).toBeDefined();

  // UI: navigate to MyAppointments, row visible.
  await patient.goToMyAppointments();
  await patient.expectOnMyAppointments();
  await patient.expectApptRowVisible(apptId);

  // Cancel via the API.
  await cancelPatientBooking(apiToken, apptId);

  // API now has the original count again.
  const after = await listPatientAppointments(apiToken);
  expect(after.appointments.length).toBe(before.appointments.length);
  expect(
    after.appointments.find((a) => a.id === apptId),
    'cancelled row drops out of the Scheduled+future list',
  ).toBeUndefined();
});
