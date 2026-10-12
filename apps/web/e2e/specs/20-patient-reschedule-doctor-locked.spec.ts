/**
 * 20-patient-reschedule-doctor-locked.spec.ts
 *
 * FR-040: a patient may not change the doctor on a reschedule. The
 * server rejects `new_doctor_id` with 400 `unknown_field`.
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

test('FR-040: reschedule rejects new_doctor_id with 400 unknown_field', async ({
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

  // Try to reschedule to a different doctor. The API rejects the
  // field outright.
  const { doctors } = await listPublicDoctors(apiToken);
  const otherDoctor = doctors.find((d) => d.id !== fixture.doctor.id)!;

  // Pick a new slot one day later, same time. The server returns
  // `start_datetime` in ISO with milliseconds; we match that.
  const d = new Date(fixture.startDatetime);
  d.setUTCDate(d.getUTCDate() + 1);
  const start = d.toISOString();
  const endDate = new Date(d);
  endDate.setUTCMinutes(endDate.getUTCMinutes() + fixture.slotDurationMinutes);
  const end = endDate.toISOString();

  let err: unknown;
  try {
    const res = await fetch(
      `http://localhost:3001/patient/appointments/${encodeURIComponent(apptId)}/reschedule`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          new_branch_id: fixture.branch.id,
          new_appointment_type_id: fixture.type.id,
          new_start_datetime: start,
          new_end_datetime: end,
          new_slot_duration_minutes: fixture.slotDurationMinutes,
          new_doctor_id: otherDoctor.id, // FR-040: rejected
        }),
      },
    );
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe('unknown_field');
  } catch (e) {
    err = e;
  }
  // (No throw expected above; err stays undefined.)
  expect(err).toBeUndefined();
  // Reference ApiProbeError to keep the import side-effect consistent.
  expect(typeof ApiProbeError).toBe('function');

  await cancelPatientBooking(apiToken, apptId);
});
