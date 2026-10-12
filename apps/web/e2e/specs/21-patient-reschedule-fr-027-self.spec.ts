/**
 * 21-patient-reschedule-fr-027-self.spec.ts
 *
 * A patient rescheduling their OWN appointment must not trip FR-027
 * (the same doctor + same patient pair is excluded from the
 * `patient_has_future_with_doctor` check). The reschedule succeeds.
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import {
  verifyPatientOtp,
  createBooking,
  reschedulePatientAppointment,
  listPatientAppointments,
  cancelPatientBooking,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('FR-027 self-exclusion: rescheduling own appt with same doctor succeeds', async ({
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

  // Pick a new slot one day later, same time, same doctor. The
  // server returns `start_datetime` in ISO with milliseconds; we
  // match that format.
  const d = new Date(fixture.startDatetime);
  d.setUTCDate(d.getUTCDate() + 1);
  const start = d.toISOString();
  const endDate = new Date(d);
  endDate.setUTCMinutes(endDate.getUTCMinutes() + fixture.slotDurationMinutes);
  const end = endDate.toISOString();

  const result = await reschedulePatientAppointment(apiToken, apptId, {
    new_branch_id: fixture.branch.id,
    new_appointment_type_id: fixture.type.id,
    new_start_datetime: start,
    new_end_datetime: end,
    new_slot_duration_minutes: fixture.slotDurationMinutes,
  });
  expect(result.appointment.id).toBe(apptId);
  expect(result.appointment.start_datetime).toBe(start);

  // List should still have 1 row (the rescheduled one).
  const list = await listPatientAppointments(apiToken);
  const found = list.appointments.find((a) => a.id === apptId);
  expect(found).toBeDefined();
  expect(found!.start_datetime).toBe(start);

  await cancelPatientBooking(apiToken, apptId);
});
