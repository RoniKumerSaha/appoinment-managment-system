/**
 * 27-doctor-move-type-locked.spec.ts
 *
 * BR-058: doctor-move is type-locked. The body must NOT include
 * `new_appointment_type_id`. Including it returns 400 `unknown_field`.
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  loginStaff,
  cancelPatientBooking,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('move with new_appointment_type_id → 400 unknown_field', async () => {
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

  // Move with an extra `new_appointment_type_id` field.
  const res = await fetch(
    `http://localhost:3001/doctor/affected/${encodeURIComponent(apptId)}/move`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${doctorAuth.token}`,
      },
      body: JSON.stringify({
        new_branch_id: branch.id,
        new_start_datetime: start,
        new_end_datetime: end,
        new_appointment_type_id: type.id, // BR-058: rejected
      }),
    },
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe('unknown_field');

  await cancelPatientBooking(patientAuth.token, apptId);
});
