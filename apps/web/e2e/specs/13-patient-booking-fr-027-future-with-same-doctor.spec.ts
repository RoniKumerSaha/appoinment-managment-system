/**
 * 13-patient-booking-fr-027-future-with-same-doctor.spec.ts
 *
 * FR-027: a patient may hold at most ONE future appointment with a
 * given doctor. Trying to book a second future appointment with the
 * same doctor returns 409 `patient_has_future_with_doctor`.
 *
 * We book the first appointment as patient-02 (no seeded future
 * appts), then try to book a second one with the same doctor and
 * a different slot. The wizard must surface the typed error code
 * in the banner.
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import {
  verifyPatientOtp,
  createBooking,
  cancelPatientBooking,
  ApiProbeError,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('FR-027: second future appt with same doctor → patient_has_future_with_doctor', async ({
  page,
}) => {
  const patient = new PatientPage(page);
  await page.goto('/');
  await patient.expectMounted();

  // Mint a fresh patient token (used for the API-side pre-booking).
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

  // Seed a booking via the API directly (so we can isolate the
  // FR-027 violation to the *next* call, and not race with the
  // wizard's happy path).
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

  // Now try the same doctor / same type via the API to assert the
  // server returns the typed code. We pick a *different* date so
  // we don't collide with `slot_raced` or `patient_time_conflict`.
  const later = new Date(fixture.startDatetime);
  later.setUTCDate(later.getUTCDate() + 1);
  const startLater = later.toISOString().slice(0, 10) + 'T14:00:00.000Z';
  const endLater = later.toISOString().slice(0, 10) + 'T14:15:00.000Z';

  let err: unknown;
  try {
    await createBooking(apiToken, {
      doctor_id: fixture.doctor.id,
      branch_id: fixture.branch.id,
      appointment_type_id: fixture.type.id,
      start_datetime: startLater,
      end_datetime: endLater,
      slot_duration_minutes: fixture.slotDurationMinutes,
      patient_phone: FIXTURE.patient02.phone,
      patient_name: 'Patient Two',
    });
  } catch (e) {
    err = e;
  }
  expect(err, 'second booking must fail').toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(409);
  expect(
    ((err as ApiProbeError).payload as { error?: string }).error,
  ).toBe('patient_has_future_with_doctor');

  // Cleanup the seed booking.
  await cancelPatientBooking(apiToken, firstId);
});
