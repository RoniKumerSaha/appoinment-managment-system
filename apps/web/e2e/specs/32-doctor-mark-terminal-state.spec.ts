/**
 * 32-doctor-mark-terminal-state.spec.ts
 *
 * Once an appointment is in a terminal state (Cancelled, Completed,
 * No-Show), mark-status returns 422 `already_in_terminal_state`.
 *
 * We cancel a row, then try to mark it Completed. The second call
 * must 422 with `already_in_terminal_state`.
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  loginStaff,
  cancelPatientBooking,
  markAppointmentStatus,
  ApiProbeError,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('mark-status: cancelled row → 422 already_in_terminal_state', async () => {
  const patientAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );
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

  // Cancel first.
  await cancelPatientBooking(patientAuth.token, apptId);

  // Mark Completed → 422.
  const doctorAuth = await loginStaff(
    FIXTURE.doctorEastLead.role,
    FIXTURE.doctorEastLead.email,
  );
  let err: unknown;
  try {
    await markAppointmentStatus(doctorAuth.token, apptId, 'Completed');
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(422);
  expect(((err as ApiProbeError).payload as { error?: string }).error).toBe(
    'already_in_terminal_state',
  );
});
