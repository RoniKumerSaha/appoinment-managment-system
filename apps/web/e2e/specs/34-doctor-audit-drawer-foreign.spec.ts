/**
 * 34-doctor-audit-drawer-foreign.spec.ts
 *
 * The audit endpoint is doubly-bound to the doctor's claim. A doctor
 * at the same branch trying to read another doctor's audit gets
 * 403 `outside_branch_scope`.
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  loginStaff,
  cancelPatientBooking,
  ApiProbeError,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test('audit: another doctor\'s row → 403 outside_branch_scope', async () => {
  const patientAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );
  const { listPublicDoctors } = await import('../helpers/api.ts');
  const { listPublicBranches } = await import('../helpers/api.ts');
  const { listPublicAppointmentTypes } = await import('../helpers/api.ts');

  // Booking owned by East Lead.
  const { doctors } = await listPublicDoctors(patientAuth.token);
  const eastLead = doctors.find((d) => d.full_name.includes('East Lead'))!;
  const { branches } = await listPublicBranches(patientAuth.token, eastLead.id);
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
    doctor_id: eastLead.id,
    branch_id: branch.id,
    appointment_type_id: type.id,
    start_datetime: start,
    end_datetime: end,
    slot_duration_minutes: type.duration_minutes,
    patient_phone: FIXTURE.patient02.phone,
    patient_name: 'Patient Two',
  });
  const apptId = booking.appointment.id;

  // East Support tries to read East Lead's audit.
  const otherDoctorAuth = await loginStaff(
    FIXTURE.doctorEastSupport.role,
    FIXTURE.doctorEastSupport.email,
  );

  let err: unknown;
  try {
    const res = await fetch(
      `http://localhost:3001/doctor/appointments/${encodeURIComponent(apptId)}/audit`,
      { headers: { authorization: `Bearer ${otherDoctorAuth.token}` } },
    );
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(403);
    expect(body.error).toBe('outside_branch_scope');
  } catch (e) {
    err = e;
  }
  expect(err).toBeUndefined();

  await cancelPatientBooking(patientAuth.token, apptId);
});
