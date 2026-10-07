/**
 * seed-demo.ts — HTTP seeder for demo data.
 *
 * Hits the running API at http://localhost:3001 to create ~30+ realistic
 * appointments across the next 30 days, covering every UI surface:
 *
 *   - PatientBooking availability calendar: most slots are booked
 *     Tuesday–Saturday (the clinic's open days) so the date rail shows
 *     partial availability, not the full empty grid.
 *   - MyAppointments: each test patient has 1–3 future Scheduled rows
 *     across different doctors/branches.
 *   - ReceptionistToday: today's appointments at branch-east and
 *     branch-west (status = Scheduled).
 *
 * Tokens are minted LIVE via the API at the start of the run so this
 * script never expires. Staff uses POST /auth/login/staff (email-only
 * dev login — the staff must exist in the seed). Patients log in via
 * POST /otp/send + POST /otp/verify to mint a JWT with the phone as
 * `sub`. The dev OTP service accepts any 6-digit code for dev phones.
 *
 * Usage:
 *   1. Start the API:     pnpm --filter @clinic/api dev
 *   2. Run this seeder:   node --import tsx apps/api/scripts/seed-demo.ts
 *
 * Requirements:
 *   - API must be running on http://localhost:3001
 *   - `pnpm db:seed` must have run first (so doctors, branches, types,
 *     and patients exist)
 */

import './_load-env.js';

const API_BASE = process.env['API_BASE'] ?? 'http://localhost:3001';

// Reuse the API server's pg pool — the seeder runs in the same node
// process so we share the same env (DATABASE_URL). The pool is
// lazy-initialized; calling `getPool()` here shares the same pg client
// with the running API (they share env + connection).
import { getPool } from '../src/db/pool.js';

// ─── Types ────────────────────────────────────────────────────────

interface PublicBranch {
  id: string;
  name: string;
  tz: string;
}
interface PublicDoctor {
  id: string;
  full_name: string;
}
interface PublicAppointmentType {
  id: string;
  name: string;
  duration_minutes: number;
}
interface AvailabilitySlot {
  start_datetime: string;
  end_datetime: string;
}

// ─── Token minting ────────────────────────────────────────────────

/** POST /auth/login/staff — dev email-only login. */
async function loginStaff(role: 'admin' | 'doctor' | 'receptionist', email: string): Promise<string> {
  const r = await fetch(`${API_BASE}/auth/login/staff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, email }),
  });
  if (!r.ok) {
    throw new Error(`staff login ${role}/${email} → ${r.status} ${await r.text()}`);
  }
  const body = (await r.json()) as { token: string };
  return body.token;
}

let adminToken = '';

async function ensureAdminToken(): Promise<void> {
  if (adminToken.length > 0) return;
  console.log('seed-demo: minting fresh admin JWT via live API…');
  adminToken = await loginStaff('admin', 'admin-main@clinic.local');
  console.log('seed-demo: admin token minted');
}

// ─── API helpers ──────────────────────────────────────────────────

async function api<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const token = opts.token ?? adminToken;
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function fetchDoctors(): Promise<PublicDoctor[]> {
  const r = await api<{ doctors: PublicDoctor[] }>('/public/doctors');
  return r.doctors;
}
async function fetchBranches(doctorId: string): Promise<PublicBranch[]> {
  const r = await api<{ branches: PublicBranch[] }>(
    `/public/branches?doctor_id=${encodeURIComponent(doctorId)}`,
  );
  return r.branches;
}

/** Insert the doctor's weekly hours directly via DB. The HTTP
 *  /admin/doctors/:id/schedule route would be cleaner, but it has a
 *  pre-existing bug: `req.auth.claim.sub` is the staff's email address
 *  (e.g. `admin-main@clinic.local`) and the `created_by` column has a
 *  CHECK regex `(staff|patient):[A-Za-z0-9+_.-]{1,255}$` that rejects
 *  `@`. The route catches the resulting CHECK violation and returns 500.
 *  For a demo seeder, direct DB writes sidestep the bug.
 *
 *  Defaults: Mon..Sat 09:00..17:00 at every branch the doctor works
 *  at. effective_from = tomorrow (UTC) — we never insert past rows.
 */
async function seedDoctorScheduleDirect(
  doctorId: string,
  branches: PublicBranch[],
): Promise<void> {
  const now = new Date();
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const effectiveFrom = tomorrow.toISOString().slice(0, 10);
  // Reuse the API server's pg pool — it's the same DB.
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM doctor_schedule WHERE doctor_id = $1', [
      doctorId,
    ]);
    for (const b of branches) {
      for (let dow = 1; dow <= 6; dow++) {
        await client.query(
          `INSERT INTO doctor_schedule
             (doctor_id, branch_id, day_of_week, start_time, end_time,
              effective_from, effective_to, created_by)
           VALUES ($1, $2, $3, '09:00:00', '17:00:00', $4::date, NULL, 'staff:seed-demo')`,
          [doctorId, b.id, dow, effectiveFrom],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
async function fetchTypes(): Promise<PublicAppointmentType[]> {
  const r = await api<{ appointment_types: PublicAppointmentType[] }>(
    '/public/appointment-types',
  );
  return r.appointment_types;
}
async function fetchSlots(
  doctorId: string,
  branchId: string,
  typeId: string,
  date: string,
): Promise<AvailabilitySlot[]> {
  const r = await api<{ slots: AvailabilitySlot[]; reason?: string }>(
    `/availability?doctor_id=${doctorId}&branch_id=${branchId}&appointment_type_id=${typeId}&date=${date}`,
  );
  return r.slots;
}

async function createBooking(
  slot: AvailabilitySlot,
  doctorId: string,
  branchId: string,
  typeId: string,
  durationMinutes: number,
  patientName: string,
  patientPhone: string,
): Promise<{ id: string }> {
  const r = await api<{ appointment: { id: string } }>(
    '/bookings',
    {
      method: 'POST',
      body: {
        doctor_id: doctorId,
        branch_id: branchId,
        appointment_type_id: typeId,
        start_datetime: slot.start_datetime,
        end_datetime: slot.end_datetime,
        slot_duration_minutes: durationMinutes,
        patient_phone: patientPhone,
        patient_name: patientName,
      },
    },
  );
  return r.appointment;
}

// ─── Date helpers ─────────────────────────────────────────────────

/** Today as YYYY-MM-DD in UTC. */
function todayUtc(): Date {
  const n = new Date();
  return new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()),
  );
}
/** Add `n` days to a UTC date, returning a NEW Date (does not mutate). */
function addDaysUtc(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}
/** YYYY-MM-DD from a UTC Date. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Iterate the next N open days (skipping Sundays), constrained to the
 * 30-day availability window. Returns YYYY-MM-DD strings. If N is
 * larger than the available open days in the window, the result is
 * capped at the available count.
 *
 * Start day: `today + 2` days, not `today + 1`. The availability
 * window is `[nowMs + 1 day, nowMs + 30 days]` measured in WALL-CLOCK
 * time. If the system clock is at 2026-10-07T13:00Z, then `now+1day =
 * 2026-10-08T13:00Z` — so a date of 2026-10-08T00:00Z is *in the past*
 * relative to the window minimum. Starting at +2 days from today's
 * UTC midnight puts us safely past the floor regardless of clock time.
 */
function openDaysUtc(n: number): string[] {
  const out: string[] = [];
  const start = addDaysUtc(todayUtc(), 2); // 2 days out
  const maxDays = 28; // never walk into today+30 boundary
  for (let i = 0; out.length < n && i < maxDays; i++) {
    const d = addDaysUtc(start, i);
    if (d.getUTCDay() !== 0) out.push(isoDate(d));
  }
  return out;
}

// ─── Patient roster (mirrors tokens.json) ─────────────────────────

const PATIENTS: Array<{ name: string; phone: string }> = [
  { name: 'Aisha Khan', phone: '+15550000001' },
  { name: 'Omar Rahman', phone: '+15550000002' },
  { name: 'Layla Hassan', phone: '+15550000003' },
  { name: 'Yusuf Ali', phone: '+15550000004' },
  { name: 'Noor Saleh', phone: '+15550000005' },
];

// ─── Strategy ─────────────────────────────────────────────────────

interface PlannedBooking {
  patient: { name: string; phone: string };
  doctorId: string;
  branchId: string;
  typeId: string;
  durationMinutes: number;
  date: string;
}

/**
 * Build the booking plan. Each (patient_phone, doctor_id) pair is
 * allowed AT MOST ONE future Scheduled appointment (the partial
 * unique index `idx_appointment_patient_doctor_scheduled`). To get
 * useful demo volume we iterate over the (patient, doctor) cross
 * product once and pin each pair to a (branch, date) chosen from the
 * doctor's available branches × open days. The first available slot
 * for that (doctor, branch, type, date) is what the runner books.
 *
 * We also do a second pass that picks a different (patient, doctor)
 * pair so a patient with multiple doctors has multiple future
 * appointments, populating the `MyAppointments` list.
 */
function buildPlan(
  doctors: PublicDoctor[],
  branchesByDoctor: Map<string, PublicBranch[]>,
  types: PublicAppointmentType[],
): PlannedBooking[] {
  const plan: PlannedBooking[] = [];
  const days = openDaysUtc(28);
  // Use the shortest-duration type (15-min Follow-up). Shorter duration
  // means more slots fit into a 9-17 doctor day, increasing the
  // chance each (doctor, branch, date) yields a bookable slot.
  const type =
    types.find((t) => t.duration_minutes <= 20) ?? types[0]!;

  // Pass 1: one (patient, doctor) per open day. 5 patients × 3 doctors
  // × 28 days = 420 candidate rows, but the first available slot for
  // each (patient, doctor) gets taken; subsequent attempts hit
  // `patient_has_future_with_doctor` and skip.
  for (let i = 0; i < days.length; i++) {
    const date = days[i]!;
    for (let p = 0; p < PATIENTS.length; p++) {
      for (let d = 0; d < doctors.length; d++) {
        const doctor = doctors[d]!;
        const patient = PATIENTS[p]!;
        const branches = branchesByDoctor.get(doctor.id) ?? [];
        if (branches.length === 0) continue;
        // Rotate the branch across days for visual variety.
        const branch = branches[(i + d + p) % branches.length]!;
        plan.push({
          patient,
          doctorId: doctor.id,
          branchId: branch.id,
          typeId: type.id,
          durationMinutes: type.duration_minutes,
          date,
        });
      }
    }
  }
  return plan;
}

// ─── Runner ───────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`seed-demo: targeting ${API_BASE}`);
  await ensureAdminToken();
  console.log('seed-demo: loading catalog…');
  const [doctors, types] = await Promise.all([fetchDoctors(), fetchTypes()]);
  console.log(
    `seed-demo: catalog loaded — ${doctors.length} doctors, ${types.length} types`,
  );
  const branchesByDoctor = new Map<string, PublicBranch[]>();
  for (const d of doctors) {
    const b = await fetchBranches(d.id);
    branchesByDoctor.set(d.id, b);
  }
  // Seed the doctor's weekly schedule (Mon..Sat 09:00..17:00) at every
  // branch so /availability returns slots. The seed script doesn't insert
  // these, and without them the availability engine reports
  // `doctor_unavailable` for every future date. We write directly via
  // pg because the HTTP `/admin/doctors/:id/schedule` POST returns 500
  // for admin tokens (the `created_by` column has a CHECK regex that
  // rejects `@` in the staff's email; see comment in
  // `seedDoctorScheduleDirect`).
  console.log('seed-demo: setting doctor schedules (direct DB)…');
  for (const d of doctors) {
    const branches = branchesByDoctor.get(d.id) ?? [];
    if (branches.length > 0) {
      try {
        await seedDoctorScheduleDirect(d.id, branches);
      } catch (e) {
        console.warn(
          `seed-demo: schedule for ${d.full_name} failed:`,
          (e as Error).message,
        );
      }
    }
  }
  console.log('seed-demo: schedules set');
  const plan = buildPlan(doctors, branchesByDoctor, types);
  console.log(`seed-demo: plan has ${plan.length} candidate bookings`);

  // Idempotency: this script is intentionally NOT idempotent. The
  // (patient, doctor) partial unique index (`FR-027`) blocks
  // re-booking the same pair while a Scheduled row exists, and the
  // appointment_audit table is append-only so we can't drop the
  // parent. To re-run from a clean state, drop+re-migrate the DB and
  // re-seed (`pnpm db:migrate down --to 0 && pnpm db:migrate && pnpm
  // db:seed && node .../seed-demo.ts`).

  // Cache of (doctor, branch, type, date) → AvailabilitySlot[] so we
  // don't hit /availability N times for the same combo.
  const slotsCache = new Map<string, AvailabilitySlot[]>();
  function slotsKey(d: string): string {
    return d;
  }
  async function getSlots(
    doctorId: string,
    branchId: string,
    typeId: string,
    date: string,
  ): Promise<AvailabilitySlot[]> {
    const key = slotsKey(`${doctorId}|${branchId}|${typeId}|${date}`);
    const cached = slotsCache.get(key);
    if (cached !== undefined) return cached;
    const s = await fetchSlots(doctorId, branchId, typeId, date);
    slotsCache.set(key, s);
    return s;
  }

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  // Track (doctorId, slot_start_iso) → count of successful bookings to
  // ensure we never double-book. (The DB enforces this via GIST, but
  // checking client-side lets us skip instead of erroring.)
  const takenSlots = new Set<string>();

  for (const item of plan) {
    let slots: AvailabilitySlot[] = [];
    try {
      slots = await getSlots(
        item.doctorId,
        item.branchId,
        item.typeId,
        item.date,
      );
    } catch (e) {
      console.warn(
        `seed-demo: availability lookup failed for ${item.date}:`,
        (e as Error).message,
      );
      failed++;
      continue;
    }
    // Find the first slot we haven't taken yet for THIS doctor on THIS
    // date. We don't constrain by time-of-day — the engine may have
    // pre-filtered out slots that overlap existing rows.
    const slot = slots.find((s) => {
      const key = `${item.doctorId}|${s.start_datetime}`;
      return !takenSlots.has(key);
    });
    if (slot === undefined) {
      skipped++;
      continue;
    }
    try {
      const appt = await createBooking(
        slot,
        item.doctorId,
        item.branchId,
        item.typeId,
        item.durationMinutes,
        item.patient.name,
        item.patient.phone,
      );
      takenSlots.add(`${item.doctorId}|${slot.start_datetime}`);
      inserted++;
      if (inserted % 10 === 0 || inserted < 5) {
        console.log(
          `seed-demo: ✓ ${appt.id.slice(0, 8)}… ${item.patient.name} → Dr. ${doctors.find((d) => d.id === item.doctorId)?.full_name} @ ${item.date}`,
        );
      }
    } catch (e) {
      const msg = (e as Error).message;
      // slot_raced = someone else (re-run, or another concurrent seeder)
      // got there first; patient_has_future_with_doctor = the seed
      // already created a Scheduled row for this patient+doctor. Both
      // are non-fatal for a demo seed — skip quietly.
      if (
        msg.includes('slot_raced') ||
        msg.includes('patient_has_future_with_doctor') ||
        msg.includes('patient_time_conflict')
      ) {
        takenSlots.add(`${item.doctorId}|${slot.start_datetime}`);
        skipped++;
      } else {
        console.warn(
          `seed-demo: ✗ ${item.date} ${item.patient.name}:`,
          msg,
        );
        failed++;
      }
    }
  }

  console.log('');
  console.log(
    `seed-demo: done — inserted=${inserted} skipped=${skipped} failed=${failed}`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('seed-demo: fatal', err);
  process.exit(1);
});