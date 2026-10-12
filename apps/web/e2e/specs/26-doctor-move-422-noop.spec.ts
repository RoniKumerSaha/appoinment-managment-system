/**
 * 26-doctor-move-422-noop.spec.ts
 *
 * `POST /doctor/affected/:id/move` with the same slot it already
 * occupies returns 422 `no_op_move` (the server rejects moves that
 * change nothing).
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  moveAffectedAppointment,
  cancelPatientBooking,
  ApiProbeError,
} from '../helpers/api.ts';
import { loginStaff } from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('move with identical body → 422 no_op_move', async () => {
  // Seed: book a future appointment via the patient API.
  const patientAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );

  // We need the booking context. Reuse the booking fixture logic
  // by hitting the public catalog. The token here is the patient
  // token (works for /public/* and /bookings).
  const { listPublicDoctors } = await import('../helpers/api.ts');
  const { listPublicBranches } = await import('../helpers/api.ts');
  const { listPublicAppointmentTypes } = await import('../helpers/api.ts');

  const { doctors } = await listPublicDoctors(patientAuth.token);
  const doctor = doctors.find((d) => d.full_name.includes('East Lead'))!;
  const { branches } = await listPublicBranches(patientAuth.token, doctor.id);
  const branch = branches[0]!;
  const { appointment_types: types } = await listPublicAppointmentTypes(
    patientAuth.token,
  );
  const type = types.find((t) => t.name.includes('Follow-up')) ?? types[0]!;

  // Pick a mid-day slot 2 days from now.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 2);
  const date = d.toISOString().slice(0, 10);
  const start = `${date}T14:00:00.000Z`;
  const end = `${date}T14:15:00.000Z`;

  const booking = await createBooking(patientAuth.token, {
    doctor_id: doctor.id,
    branch_id: branch.id,
    appointment_type_id: type.id,
    start_datetime: start,
    end_datetime: end,
    slot_duration_minutes: type.duration_minutes,
    patient_phone: FIXTURE.patient02.phone,
    patient_name: 'Patient Two',
  });
  const apptId = booking.appointment.id;

  // Doctor tries to move the appointment to the slot it already
  // occupies. Server returns 422 no_op_move.
  const doctorAuth = await loginStaff(
    FIXTURE.doctorEastLead.role,
    FIXTURE.doctorEastLead.email,
  );

  let err: unknown;
  try {
    await moveAffectedAppointment(doctorAuth.token, apptId, {
      new_branch_id: branch.id,
      new_start_datetime: start,
      new_end_datetime: end,
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(422);
  expect(((err as ApiProbeError).payload as { error?: string }).error).toBe(
    'no_op_move',
  );

  // Cleanup.
  await cancelPatientBooking(patientAuth.token, apptId);
});
