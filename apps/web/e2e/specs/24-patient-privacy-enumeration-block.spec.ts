/**
 * 24-patient-privacy-enumeration-block.spec.ts
 *
 * A patient can only see their OWN appointments. Calling
 * `GET /patient/appointments` returns rows bound to the JWT's
 * `claim.sub` (the patient phone). A different patient cannot
 * enumerate another patient's appointments.
 *
 * Test: book an appointment as patient-02. Then call
 * `/patient/appointments` with patient-03's token. patient-03 must
 * see no row for that appointment.
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

test('privacy: patient-03 cannot enumerate patient-02 appointments', async ({
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

  // Mint patient-03's token. Call /patient/appointments with it.
  const otherAuth = await verifyPatientOtp(
    FIXTURE.patient03.phone,
    FIXTURE.patient03.code,
  );
  const otherList = await listPatientAppointments(otherAuth.token);
  // patient-03 must NOT see patient-02's appointment in their list.
  expect(
    otherList.appointments.find((a) => a.id === apptId),
    'patient-03 cannot see patient-02 appointment',
  ).toBeUndefined();

  // Cleanup.
  await cancelPatientBooking(apiToken, apptId);
});
