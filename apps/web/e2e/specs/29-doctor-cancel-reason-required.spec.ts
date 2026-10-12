/**
 * 29-doctor-cancel-reason-required.spec.ts
 *
 * FR-035: doctor-cancel requires a non-empty `reason` ≤ 500 chars.
 * Empty → 400 `reason_required`. > 500 → 400 `reason_too_long`.
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  loginStaff,
  cancelPatientBooking,
  doctorCancel,
  ApiProbeError,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('doctor-cancel rejects empty reason (400 reason_required)', async () => {
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

  const doctorAuth = await loginStaff(
    FIXTURE.doctorEastLead.role,
    FIXTURE.doctorEastLead.email,
  );

  // Empty reason.
  let err: unknown;
  try {
    await doctorCancel(doctorAuth.token, apptId, '');
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(400);
  expect(((err as ApiProbeError).payload as { error?: string }).error).toBe(
    'reason_required',
  );

  // > 500 chars.
  try {
    await doctorCancel(doctorAuth.token, apptId, 'x'.repeat(501));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(400);
  expect(((err as ApiProbeError).payload as { error?: string }).error).toBe(
    'reason_too_long',
  );

  // Now cancel successfully (for cleanup). But the spec cleanup
  // path is the patient route. Use that.
  await cancelPatientBooking(patientAuth.token, apptId);
});
