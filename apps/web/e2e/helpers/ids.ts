/**
 * e2e/helpers/ids.ts — fixture rotation helpers.
 *
 * The dev API seeds a fixed roster: 5 patients (5 phones), 3 doctors,
 * 2 receptionists, 1 admin. To keep specs independent, we rotate
 * through the roster per test so two specs that both want a patient
 * don't both try to log in as `+15550000001` and step on each other.
 *
 * The rotation is deterministic (process-singleton, not RNG) so a
 * failing spec keeps failing on the same fixture for triage.
 */

const PATIENT_PHONES = [
  '+15550000001',
  '+15550000002',
  '+15550000003',
  '+15550000004',
  '+15550000005',
] as const;

const DOCTOR_IDS = [
  'doctor-east-lead',
  'doctor-east-support',
  'doctor-west-lead',
] as const;

/** Per-process counter. `process` is global in Node, so this works
 *  for `node --test` runners; the Playwright runner uses a single
 *  worker so the counter is global within a run. */
let _counter = 0;

function next(): number {
  _counter += 1;
  return _counter;
}

export function pickPatientPhone(): string {
  const i = (next() - 1) % PATIENT_PHONES.length;
  return PATIENT_PHONES[i]!;
}

export function pickDoctorId(): string {
  const i = (next() - 1) % DOCTOR_IDS.length;
  return DOCTOR_IDS[i]!;
}

/**
 * Returns an ISO datetime `n` days from now at `hour:00` local time.
 * Used to pick a future slot the patient can book.
 */
export function pickFutureSlotIso(daysAhead = 7, hour = 10): string {
  const n = next();
  const d = new Date();
  d.setDate(d.getDate() + daysAhead + (n % 5));
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export const FIXTURE = {
  admin: { role: 'admin', email: 'admin-main@clinic.local' },
  doctorEastLead: { role: 'doctor', email: 'dr.-east-lead@clinic.local' },
  doctorEastSupport: { role: 'doctor', email: 'dr.-east-support@clinic.local' },
  doctorWestLead: { role: 'doctor', email: 'dr.-west-lead@clinic.local' },
  receptionistEast: {
    role: 'receptionist',
    email: 'receptionist-east@clinic.local',
  },
  receptionistWest: {
    role: 'receptionist',
    email: 'receptionist-west@clinic.local',
  },
  patient01: { phone: '+15550000001', code: '123456' },
  patient02: { phone: '+15550000002', code: '123456' },
  patient03: { phone: '+15550000003', code: '123456' },
  patient04: { phone: '+15550000004', code: '123456' },
  patient05: { phone: '+15550000005', code: '123456' },
} as const;
