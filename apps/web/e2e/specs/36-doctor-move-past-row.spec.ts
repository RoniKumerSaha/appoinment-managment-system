/**
 * 36-doctor-move-past-row.spec.ts
 *
 * Doctor-move is only valid for future rows. Trying to move a row
 * whose `start_datetime < now()` returns 422 `appointment_in_past`.
 *
 * We can't seed a "past" row through the public booking API
 * (the `checkBookingWindow` helper rejects anything earlier than
 * tomorrow UTC). We can however:
 *   1. Book a row via the public API (this is the only legal path).
 *   2. UPDATE the row's start_datetime directly in the DB so it
 *      ends up in the past, bypassing the booking-window check.
 *   3. Call doctor-move on the now-past row.
 *
 * (The server-side past check uses `start_datetime < now()` per
 * staff-doctor-move.ts:242.)
 */
import { test, expect } from '../fixtures.ts';
import {
  verifyPatientOtp,
  createBooking,
  loginStaff,
  moveAffectedAppointment,
  cancelPatientBooking,
  ApiProbeError,
  listPublicDoctors,
  listPublicBranches,
  listPublicAppointmentTypes,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';
import { makeRowPast } from '../helpers/clock-shift.ts';

test('doctor-move: row whose start is in the past → 422 appointment_in_past', async () => {
  const patientAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );
  const { doctors } = await listPublicDoctors(patientAuth.token);
  const doctor = doctors.find((d) => d.full_name.includes('East Lead'))!;
  const { branches } = await listPublicBranches(patientAuth.token, doctor.id);
  const branch = branches[0]!;
  const { appointment_types: types } = await listPublicAppointmentTypes(
    patientAuth.token,
  );
  const type = types.find((t) => t.name.includes('Follow-up')) ?? types[0]!;

  // Book a row 2 days out at 14:00 UTC. This is the only legal
  // way to seed a row (the API blocks past slots).
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

  // Bypass the booking-window guard by writing the row directly
  // in the DB: set start_datetime to 1h ago, end_datetime to 45m
  // ago (still status='Scheduled' so the doctor-move past check is
  // what rejects it).
  const startMs = Date.now() - 60 * 60 * 1000;
  const endMs = startMs + 15 * 60 * 1000;
  makeRowPast(apptId, startMs, endMs);

  const doctorAuth = await loginStaff(
    FIXTURE.doctorEastLead.role,
    FIXTURE.doctorEastLead.email,
  );

  // Try to move. The server should reject with 422
  // `appointment_in_past`.
  let err: unknown;
  try {
    // Pick any future target slot (5 days out at 14:00 UTC).
    const target = new Date();
    target.setUTCDate(target.getUTCDate() + 5);
    const targetStr = target.toISOString().slice(0, 10);
    const targetStart = `${targetStr}T14:00:00.000Z`;
    const targetEnd = `${targetStr}T14:15:00.000Z`;
    await moveAffectedAppointment(doctorAuth.token, apptId, {
      new_branch_id: branch.id,
      new_start_datetime: targetStart,
      new_end_datetime: targetEnd,
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiProbeError);
  expect((err as ApiProbeError).status).toBe(422);
  expect(((err as ApiProbeError).payload as { error?: string }).error).toBe(
    'appointment_in_past',
  );

  // Cleanup.
  await cancelPatientBooking(patientAuth.token, apptId);
});
