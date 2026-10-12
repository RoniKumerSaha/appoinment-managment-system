/**
 * 19-patient-cancel-terminal-state.spec.ts
 *
 * Cancelling a row that is already in a terminal state (Cancelled /
 * Completed / No-Show) returns 404
 * `not_found_appointment_in_terminal_state`. This is idempotent from
 * the client's perspective.
 */
import { test, expect } from '../fixtures.ts';
import { PatientPage } from '../pages/patient.page.ts';
import { buildBookingFixture } from '../helpers/booking-fixture.ts';
import {
  verifyPatientOtp,
  createBooking,
  cancelPatientBooking,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/patient-02.json' });

test('second cancel: 404 not_found_appointment_in_terminal_state', async ({
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

  // First cancel: success.
  await cancelPatientBooking(apiToken, apptId);

  // The helper `cancelPatientBooking` swallows the terminal-state
  // error (returns null) because cleanup should be idempotent. To
  // assert the typed 404 envelope, call the API directly.
  const res = await fetch(
    `http://localhost:3001/patient/appointments/${encodeURIComponent(apptId)}/cancel`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({}),
    },
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe('not_found_appointment_in_terminal_state');
});
