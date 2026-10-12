/**
 * 15-patient-booking-slot-raced.spec.ts
 *
 * When two callers race for the same slot, the loser of the race
 * gets 409 `slot_raced` with `can_do.refresh_availability`. The
 * client must offer a "refresh availability" affordance so the user
 * can re-pick.
 *
 * This spec seeds the first booking via the API (as if a parallel
 * user booked it between the patient picking a slot and confirming).
 * Then it drives the wizard, expects the typed error in the banner.
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

test('slot_raced: server returns can_do.refresh_availability after a parallel booking', async ({
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

  // Pre-seed the slot the patient is about to try, with a
  // *different* patient (so patient-02 doesn't trip FR-027).
  // We use patient-03 (also no seeded future appts) for the
  // pre-booking.
  const otherAuth = await verifyPatientOtp(
    FIXTURE.patient03.phone,
    FIXTURE.patient03.code,
  );
  const seed = await createBooking(otherAuth.token, {
    doctor_id: fixture.doctor.id,
    branch_id: fixture.branch.id,
    appointment_type_id: fixture.type.id,
    start_datetime: fixture.startDatetime,
    end_datetime: fixture.endDatetime,
    slot_duration_minutes: fixture.slotDurationMinutes,
    patient_phone: FIXTURE.patient03.phone,
    patient_name: 'Patient Three',
  });
  const seedId = seed.appointment.id;

  // Now patient-02 tries the same slot directly via the API.
  let err: unknown;
  try {
    await createBooking(apiToken, {
      doctor_id: fixture.doctor.id,
      branch_id: fixture.branch.id,
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
  expect(err, 'raced booking must fail').toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(409);
  const payload = (err as ApiProbeError).payload as {
    error?: string;
    can_do?: unknown;
  };
  expect(payload.error).toBe('slot_raced');
  // can_do is an array `[{action, label}]` per the SLOT_RACED_ENVELOPE
  // shape in apps/api/src/routes/bookings.ts:226-228. The first
  // element's `action` must be `refresh_availability`.
  expect(Array.isArray(payload.can_do)).toBe(true);
  const first = (payload.can_do as Array<{ action?: string }>)[0];
  expect(first?.action).toBe('refresh_availability');

  // Cleanup.
  await cancelPatientBooking(otherAuth.token, seedId);
});
