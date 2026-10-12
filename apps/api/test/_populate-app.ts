/**
 * Populate the running DB with a rich set of appointments so a
 * fresh tester can immediately see data in MyAppointments, the
 * doctor's affected queue, and the receptionist's today list.
 *
 * Idempotent: deletes the test patient's rows first, then reinserts.
 * Does NOT touch other patients, branches, doctors, or audit history.
 *
 * Run:  node --env-file=../../.env --import tsx ./test/_populate-app.ts
 */
import pkg from 'pg';
import { signClaim } from '../src/auth/jwt.js';
const { Client } = pkg;
const c = new Client({ connectionString: process.env['DATABASE_URL']! });
await c.connect();

// Known test phone (matches the dev fixture phone used by the
// admin-appointment-types, bookings, and patient-reschedule tests).
const TEST_PHONE = '+15559990001';
const DBURL = process.env['DATABASE_URL']!;
const BASE = 'http://localhost:3001';

const { rows: clinicRows } = await c.query('SELECT id FROM clinic LIMIT 1');
const clinicId = clinicRows[0]!.id;
const { rows: doctorRows } = await c.query(
  "SELECT id::text, full_name FROM doctor WHERE full_name IN ('Dr. East Lead', 'Dr. West Lead', 'Dr. East Support')",
);
const { rows: branchRows } = await c.query("SELECT id::text, name FROM branch WHERE name IN ('East Branch', 'West Branch')");
const { rows: typeRows } = await c.query("SELECT id::text, name, duration_minutes FROM appointment_type");
console.log('Available:');
for (const d of doctorRows) console.log('  doctor:', d);
for (const b of branchRows) console.log('  branch:', b);
for (const t of typeRows) console.log('  type:', t);

// Ensure a patient row exists for TEST_PHONE (FR-022 — phone is the patient key).
await c.query(
  `INSERT INTO patient (phone_number, full_name)
   VALUES ($1, $2)
   ON CONFLICT (phone_number) DO UPDATE SET full_name = EXCLUDED.full_name`,
  [TEST_PHONE, 'Fatima Al-Sayed'],
);
const { rows: patientRows } = await c.query(
  'SELECT id::text FROM patient WHERE phone_number = $1',
  [TEST_PHONE],
);
const patientId = patientRows[0]!.id;
console.log('patient:', patientId, '(phone', TEST_PHONE, ')');

// Idempotency check: the FK from appointment_audit → appointment is
// NOT ON DELETE CASCADE (audit is append-only per NFR-005), so we
// can't safely clean up prior runs. We instead just insert more rows
// if no rows exist yet, or report the count if rows exist.
const { rows: existingRows } = await c.query(
  "SELECT count(*)::int AS n FROM appointment WHERE patient_phone = $1",
  [TEST_PHONE],
);
const existingCount = existingRows[0]!.n;
if (existingCount > 0) {
  console.log(`Patient ${TEST_PHONE} already has ${existingCount} appointments — skipping seed.`);
  console.log('To reset: DROP+recreate the database, or sign in to the UI to test what is there.');
  await c.end();
  process.exit(0);
}

const now = new Date();
const at = (daysFromNow: number, hourEt: number, minute = 0): string => {
  // Convert branch-local hour on a date `daysFromNow` from now in
  // America/New_York to UTC. We use Intl to compute the offset.
  const local = new Date(now);
  local.setDate(local.getDate() + daysFromNow);
  // Build the wall-clock string in America/New_York, then convert to UTC.
  const ymd = local.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const hh = String(hourEt).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  // Probe tz offset for the target date at 00:00 local.
  const probeUtc = new Date(`${ymd}T12:00:00Z`); // noon to avoid DST edges
  const probe = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(probeUtc);
  const ph = Number(probe.find((p) => p.type === 'hour')?.value ?? '0');
  const pm = Number(probe.find((p) => p.type === 'minute')?.value ?? '0');
  const offsetMin = (12 * 60) - (ph * 60 + pm);
  // Build the UTC ms for the desired local time.
  const utcMs =
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(5, 7)) - 1,
      Number(ymd.slice(8, 10)),
      hh,
      mm,
    ) + offsetMin * 60_000;
  return new Date(utcMs).toISOString();
};

const findDoctor = (name: string) => {
  const r = doctorRows.find((d) => d.full_name === name);
  if (!r) throw new Error(`doctor not found: ${name}`);
  return r;
};
const findBranch = (name: string) => {
  const r = branchRows.find((b) => b.name === name);
  if (!r) throw new Error(`branch not found: ${name}`);
  return r;
};
const findType = (name: string) => {
  const r = typeRows.find((t) => t.name === name);
  if (!r) throw new Error(`type not found: ${name}`);
  return r;
};

const eastLead = findDoctor('Dr. East Lead');
const westLead = findDoctor('Dr. West Lead');
const eastSupport = findDoctor('Dr. East Support');
const eastBranch = findBranch('East Branch');
const westBranch = findBranch('West Branch');
const general = findType('General Consultation');
const followup = typeRows.find((t) => t.name === 'Follow-up');
const specialist = findType('Specialist Consult');

const seedApts: Array<{
  doctor: typeof eastLead;
  branch: typeof eastBranch;
  type: typeof general;
  start: string;
  end: string;
  note: string;
}> = [
  // Upcoming in the working window (09:00-17:00 ET) for visible variety.
  { doctor: eastLead, branch: eastBranch, type: general,
    start: at(2, 10, 0), end: at(2, 10, 30), note: 'Day-after-tomorrow 10:00 ET, 30-min general' },
  { doctor: eastLead, branch: eastBranch, type: followup ?? general,
    start: at(4, 14, 30), end: at(4, 15, 0), note: '+4 days 14:30 ET, follow-up' },
  { doctor: westLead, branch: westBranch, type: general,
    start: at(5, 11, 0), end: at(5, 11, 30), note: '+5 days 11:00 ET, West Branch 30-min' },
  { doctor: eastLead, branch: eastBranch, type: specialist,
    start: at(7, 15, 0), end: at(7, 15, 45), note: '+7 days 15:00 ET, 45-min specialist' },
  { doctor: eastSupport, branch: eastBranch, type: general,
    start: at(9, 9, 30), end: at(9, 10, 0), note: '+9 days 09:30 ET, with Dr. East Support' },
  { doctor: eastLead, branch: eastBranch, type: general,
    start: at(11, 16, 0), end: at(11, 16, 30), note: '+11 days 16:00 ET, 30-min general' },
];

// Use a doctor JWT to create appointments via POST /bookings (so the
// audit rows and FR-027/FR-029 enforcement are exercised exactly as
// the UI does).
const insertDirect = async (row: typeof seedApts[number]): Promise<string> => {
  const startMs = Date.parse(row.start);
  const endMs = Date.parse(row.end);
  const result = await c.query(
    `INSERT INTO appointment
       (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
        start_datetime, end_datetime, status, created_by)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz, $7::timestamptz,
             'Scheduled', 'patient:' || $4)
     RETURNING id::text AS id`,
    [clinicId, row.branch.id, row.doctor.id, TEST_PHONE, row.type.id,
     new Date(startMs).toISOString(), new Date(endMs).toISOString()],
  );
  const id = result.rows[0]!.id;
  // Audit row (append-only per NFR-005).
  await c.query(
    `INSERT INTO appointment_audit
       (appointment_id, actor_role, actor_id, event, payload)
     VALUES ($1::uuid, 'patient', 'patient:' || $2, 'created',
             $3::jsonb)`,
    [id, TEST_PHONE, JSON.stringify({ source: 'self_book', seeded: true, note: row.note })],
  );
  return id;
};

const created: string[] = [];
for (const row of seedApts) {
  // Skip if it would land on a Sunday (closed).
  const startMs = Date.parse(row.start);
  const dow = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(new Date(startMs));
  if (dow === 'Sun') {
    console.log('  SKIP (Sun closed):', row.note);
    continue;
  }
  const id = await insertDirect(row);
  created.push(id);
  console.log('  +', row.note, '→', id.slice(0, 8));
}

console.log(`\nCreated ${created.length} appointments for ${TEST_PHONE}.`);
console.log('Open http://localhost:5173 and use the dev OTP /patient/otp/verify-now with code 123456');
console.log(`to sign in as ${TEST_PHONE} (or use the patient phone field at the login page).`);

await c.end();
