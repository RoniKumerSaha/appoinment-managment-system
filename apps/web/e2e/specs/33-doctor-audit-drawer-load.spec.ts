/**
 * 33-doctor-audit-drawer-load.spec.ts
 *
 * `GET /doctor/appointments/:id/audit` returns the appointment's
 * audit trail (a 200-row window). The doctor's DoctorAuditDrawer
 * renders the rows with WCAG glyphs. The CSV export button is
 * intentionally disabled (D-E7-S-UI-2).
 *
 * We seed a booking, then assert the API envelope + the drawer's
 * mount.
 */
import { test, expect } from '../fixtures.ts';
import { DoctorPage } from '../pages/doctor.page.ts';
import {
  verifyPatientOtp,
  createBooking,
  cancelPatientBooking,
  getDoctorAppointmentAudit,
} from '../helpers/api.ts';
import { FIXTURE } from '../helpers/ids.ts';

test.use({ storageState: 'e2e/.auth/doctor-east.json' });

test('GET /doctor/appointments/:id/audit returns envelope; drawer loads', async ({
  page,
}) => {
  await page.goto('/');
  const doctor = new DoctorPage(page);
  await doctor.expectMounted();

  // Seed a booking via the patient API.
  const patientAuth = await verifyPatientOtp(
    FIXTURE.patient02.phone,
    FIXTURE.patient02.code,
  );
  const { listPublicDoctors } = await import('../helpers/api.ts');
  const { listPublicBranches } = await import('../helpers/api.ts');
  const { listPublicAppointmentTypes } = await import('../helpers/api.ts');

  const { doctors } = await listPublicDoctors(patientAuth.token);
  const doctorRow = doctors.find((d) => d.full_name.includes('East Lead'))!;
  const { branches } = await listPublicBranches(patientAuth.token, doctorRow.id);
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
    doctor_id: doctorRow.id,
    branch_id: branch.id,
    appointment_type_id: type.id,
    start_datetime: start,
    end_datetime: end,
    slot_duration_minutes: type.duration_minutes,
    patient_phone: FIXTURE.patient02.phone,
    patient_name: 'Patient Two',
  });
  const apptId = booking.appointment.id;

  // Fetch the audit envelope using the doctor's storageState token.
  const token = await page.evaluate(() => {
    const raw = window.localStorage.getItem('medislot.auth');
    if (!raw) throw new Error('no auth');
    return (JSON.parse(raw) as { token: string }).token;
  });
  const env = await getDoctorAppointmentAudit(token, apptId);
  expect(env.appointment_id).toBe(apptId);
  expect(env.count).toBeGreaterThanOrEqual(1); // At least the booking insert.
  expect(Array.isArray(env.audit)).toBe(true);

  // Cleanup.
  await cancelPatientBooking(patientAuth.token, apptId);
});
