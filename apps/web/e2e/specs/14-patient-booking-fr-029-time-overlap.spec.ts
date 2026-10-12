/**
 * 14-patient-booking-fr-029-time-overlap.spec.ts
 *
 * FR-029: a patient may not hold two future appointments that overlap
 * in wall-clock time, even with a different doctor.
 *
 * We seed one booking via the API, then try to book another with a
 * different doctor at the same start time. The server returns 409
 * `patient_time_conflict`.
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import {
  verifyPatientOtp,
  createBooking,
  cancelPatientBooking,
  listPublicDoctors,
  ApiProbeError,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('FR-029: overlapping time with different doctor → patient_time_conflict', async ({
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

  // Seed the first booking (doctor A).
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
  const firstId = first.appointment.id;

  // Pick a DIFFERENT doctor (so we don't trip FR-027 first).
  const { doctors } = await listPublicDoctors(apiToken);
  const otherDoctor =
    doctors.find((d) => d.id !== fixture.doctor.id) ?? doctors[0]!;
  expect(otherDoctor.id).not.toBe(fixture.doctor.id);

  // The other doctor must also be at this branch. Pull their branches.
  const { listPublicBranches } = await import('../helpers/api.ts');
  const { branches: otherBranches } = await listPublicBranches(
    apiToken,
    otherDoctor.id,
  );
  // If the other doctor is not at the same branch, use the first
  // matching branch. The conflict check is wall-clock; branch
  // doesn't matter for FR-029.
  const otherBranch = otherBranches[0] ?? fixture.branch;

  // Try to book at the SAME start time with the other doctor.
  let err: unknown;
  try {
    await createBooking(apiToken, {
      doctor_id: otherDoctor.id,
      branch_id: otherBranch.id,
      appointment_type_id: fixture.type.id,
      start_datetime: fixture.startDatetime,
      end_datetime: fixture.endDatetime,
      slot_duration_minutes: fixture.slotDurationMinutes,
      patient_phone: FIXTURE.patient02.phone,
      patient_name: 'Patient Two',
    });
  } catch (e) {
    err = e;
  }
  expect(err, 'overlap booking must fail').toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(409);
  expect(
    ((err as ApiProbeError).payload as { error?: string }).error,
  ).toBe('patient_time_conflict');

  await cancelPatientBooking(apiToken, firstId);
});
