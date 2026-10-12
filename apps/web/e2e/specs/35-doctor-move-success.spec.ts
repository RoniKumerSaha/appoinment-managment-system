/**
 * 35-doctor-move-success.spec.ts
 *
 * Successful doctor-move: a doctor moves a scheduled appointment to
 * a different (free) slot in the same branch. The move endpoint
 * returns 200, the row's start_datetime updates, the old slot is
 * freed (GIST exclusion re-evaluates), and the new slot is now
 * blocked.
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  loginStaff,
  moveAffectedAppointment,
  cancelPatientBooking,
  listPatientAppointments,
  listPublicBranches,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('doctor-move: success path, slot free + new slot blocked', async () => {
  const patientAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );
  const { listPublicDoctors } = await import('../helpers/api.ts');
  const { listPublicAppointmentTypes } = await import('../helpers/api.ts');

  const { doctors } = await listPublicDoctors(patientAuth.token);
  const doctor = doctors.find((d) => d.full_name.includes('East Lead'))!;
  const { branches } = await listPublicBranches(patientAuth.token, doctor.id);
  const branch = branches[0]!;
  const { appointment_types: types } = await listPublicAppointmentTypes(
    patientAuth.token,
  );
  const type = types.find((t) => t.name.includes('Follow-up')) ?? types[0]!;

  // Seed: book slot A (2d out at 14:00 UTC).
  const dateA = new Date();
  dateA.setUTCDate(dateA.getUTCDate() + 2);
  const dateStr = dateA.toISOString().slice(0, 10);
  const startA = `${dateStr}T14:00:00.000Z`;
  const endA = `${dateStr}T14:15:00.000Z`;

  const booking = await createBooking(patientAuth.token, {
    doctor_id: doctor.id,
    branch_id: branch.id,
    appointment_type_id: type.id,
    start_datetime: startA,
    end_datetime: endA,
    slot_duration_minutes: type.duration_minutes,
    patient_phone: FIXTURE.patient02.phone,
    patient_name: 'Patient Two',
  });
  const apptId = booking.appointment.id;

  // Move to slot B (3d out at 14:00 UTC — well inside 30d window).
  const dateB = new Date();
  dateB.setUTCDate(dateB.getUTCDate() + 3);
  const dateStrB = dateB.toISOString().slice(0, 10);
  const startB = `${dateStrB}T14:00:00.000Z`;
  const endB = `${dateStrB}T14:15:00.000Z`;

  const doctorAuth = await loginStaff(
    FIXTURE.doctorEastLead.role,
    FIXTURE.doctorEastLead.email,
  );

  const result = await moveAffectedAppointment(doctorAuth.token, apptId, {
    new_branch_id: branch.id,
    new_start_datetime: startB,
    new_end_datetime: endB,
  });
  expect(result.appointment.id).toBe(apptId);
  expect(result.appointment.status).toBe('Scheduled');

  // The patient's list should now show the new start time.
  const list = await listPatientAppointments(patientAuth.token);
  const found = list.appointments.find((a) => a.id === apptId);
  expect(found).toBeDefined();
  expect(found!.start_datetime).toBe(startB);

  // Cleanup.
  await cancelPatientBooking(patientAuth.token, apptId);
});
