/**
 * 28-doctor-move-outside-30d-window.spec.ts
 *
 * Doctor move is bounded to the 30-day window. Picking a slot > 30
 * days out returns 409 `outside_30d_window`.
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  loginStaff,
  cancelPatientBooking,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('move to slot > 30d out → 409 outside_30d_window', async () => {
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

  // Seed a booking 2 days out.
  const seedDate = new Date();
  seedDate.setUTCDate(seedDate.getUTCDate() + 2);
  const seedDateStr = seedDate.toISOString().slice(0, 10);
  const seedStart = `${seedDateStr}T14:00:00.000Z`;
  const seedEnd = `${seedDateStr}T14:15:00.000Z`;

  const booking = await createBooking(patientAuth.token, {
    doctor_id: doctor.id,
    branch_id: branch.id,
    appointment_type_id: type.id,
    start_datetime: seedStart,
    end_datetime: seedEnd,
    slot_duration_minutes: type.duration_minutes,
    patient_phone: FIXTURE.patient02.phone,
    patient_name: 'Patient Two',
  });
  const apptId = booking.appointment.id;

  const doctorAuth = await loginStaff(
    FIXTURE.doctorEastLead.role,
    FIXTURE.doctorEastLead.email,
  );

  // Move 60 days out.
  const farDate = new Date();
  farDate.setUTCDate(farDate.getUTCDate() + 60);
  const farStr = farDate.toISOString().slice(0, 10);
  const farStart = `${farStr}T14:00:00.000Z`;
  const farEnd = `${farStr}T14:15:00.000Z`;

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
        new_start_datetime: farStart,
        new_end_datetime: farEnd,
      }),
    },
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe('outside_30d_window');

  await cancelPatientBooking(patientAuth.token, apptId);
});
