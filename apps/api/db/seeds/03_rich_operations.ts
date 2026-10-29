/**
 * 03_rich_operations.ts — comprehensive operational seed data.
 *
 * Sits on top of `01_minimum.ts` and adds a realistic, feature-exercising
 * dataset covering EVERY operation the product supports:
 *
 *   1. Extra catalog entities (appointment types, doctors, a third branch).
 *   2. Doctor weekly schedules with split / multi-period days.
 *   3. Doctor time-off blocks (past + future, on open days).
 *   4. Appointments in EVERY status (Scheduled / Completed / Cancelled /
 *      No-show), in the past and the future.
 *   5. A recurring series (multi-occurrence, shared `recurring_series_id`).
 *   6. Rescheduled appointments (with a `rescheduled` audit trail).
 *   7. A full `appointment_audit` trail for every seeded appointment.
 *   8. Staff password credentials (bcrypt via pgcrypto).
 *   9. Inactive / deactivated catalog rows (lifecycle surfaces).
 *  10. Patients with a rich profile (returning patients, many visits).
 *
 * ── CONSTRAINTS THIS FILE HONOURS ─────────────────────────────────────
 *
 * (a) NO SUNDAYS. Every branch closes on DOW 0 and no doctor has a
 *     Sunday schedule, so an appointment on a Sunday would be reported
 *     as `outside_branch_hours` by the API. All dates are picked to
 *     land on Mon–Sat.
 *
 * (b) NO SLOT OVERLAPS. The GIST exclusion `appointment_no_overlap`
 *     forbids two `Scheduled` rows for the same (doctor, branch) whose
 *     tstzranges overlap. Every Scheduled row below is given a distinct
 *     30-minute slot on a distinct (doctor, branch, day).
 *
 * (c) FR-027 / FR-029 FRIENDLY. The partial unique index
 *     `idx_appointment_patient_doctor_scheduled` allows only ONE
 *     future Scheduled row per (patient_phone, doctor_id) — EXCEPT for
 *     rows that carry a `recurring_series_id` (migration 0020). Each
 *     seeded patient therefore holds at most one future Scheduled
 *     appointment per doctor.
 *
 * (d) THE E2E SUITE IS NOT DISTURBED. `apps/web/e2e/auth.setup.ts`
 *     runs `scripts/reset-test-appointments.ts`, which DELETEs every
 *     appointment whose `patient_phone LIKE '+1555000%'`. Every seeded
 *     patient below therefore uses a phone OUTSIDE that prefix
 *     (`+15550100xx` …), so the rich dataset survives the E2E wipe and
 *     the E2E fixtures (`+15550000001`…`05`) are left untouched.
 *
 * (e) THE ADMIN LIST ORDER IS PRESERVED. `GET /admin/doctors` sorts by
 *     `full_name ASC` and the E2E spec `admin-doctor-specialty.spec.ts`
 *     patches `doctors[0]`. Every doctor seeded here is named so it
 *     sorts AFTER "Dr. East Lead" (the current first row) — the new
 *     names start with "Dr. Z…", so `doctors[0]` is unchanged.
 *
 * (f) BRANCH HOURS + DOCTOR SCHEDULE. Every appointment falls inside
 *     09:00–17:00 **branch-local** time on a Mon–Sat day, matching the
 *     `branch_weekly_hours` rows and the doctor's `doctor_schedule`
 *     rows for that branch.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────
 *
 * Every INSERT is either `ON CONFLICT DO NOTHING` (tables with a UNIQUE
 * constraint) or guarded by a SELECT-then-INSERT existence check keyed
 * on a deterministic natural key. Re-running the seed inserts nothing
 * new and raises nothing.
 */
import type { PoolClient } from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
import { seedWith } from './01_minimum.js';
import {
  CLINIC_ID,
  BRANCH_EAST_ID,
  BRANCH_WEST_ID,
  DOCTOR_EAST_LEAD_ID,
  DOCTOR_EAST_SUPPORT_ID,
  DOCTOR_WEST_LEAD_ID,
  APPOINTMENT_TYPE_GENERAL_ID,
  APPOINTMENT_TYPE_FOLLOWUP_ID,
  APPOINTMENT_TYPE_CONSULT_ID,
  RECEPTIONIST_EAST_ID,
  RECEPTIONIST_WEST_ID,
  ADMIN_MAIN_ID,
} from './02_role_ids.js';

export interface RichSeedResult {
  /** True iff at least one row was inserted by this run. */
  inserted: boolean;
  /** Rows inserted per table (informational). */
  counts: Record<string, number>;
}

// ─── Shared dev password ────────────────────────────────────────────────
// 14 chars — satisfies the API's MIN_PASSWORD_LENGTH = 12. Stored as a
// bcrypt hash produced by `pgcrypto.crypt(password, gen_salt('bf', 10))`,
// matching migration 0022's `password_hash_format` CHECK.
const DEV_PASSWORD = 'Clinic@12345678';

/**
 * SQL fragment that produces a bcrypt hash of the dev password.
 *
 * Interpolated into a statement, NOT bound as a parameter — the
 * password itself is passed as `$1` by the caller:
 *
 *   `UPDATE doctor SET password_hash = ${DEV_PASSWORD_SQL} WHERE email = $1`
 *
 * `pgcrypto.crypt(password, gen_salt('bf', 10))` is bcrypt with cost
 * 10 — the same shape migration 0022's `password_hash_format` CHECK
 * (`^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$`) accepts.
 */
const DEV_PASSWORD_SQL = `pgcrypto.crypt('${DEV_PASSWORD}', pgcrypto.gen_salt('bf', 10))`;

// ─── Phone roster ───────────────────────────────────────────────────────
// `+15550100xx` — deliberately OUTSIDE the `+1555000%` prefix that the
// E2E reset script wipes. Each phone maps to one seeded patient.
const PATIENT_PHONES = [
  '+15550100101',
  '+15550100102',
  '+15550100103',
  '+15550100104',
  '+15550100105',
  '+15550100106',
  '+15550100107',
  '+15550100108',
  '+15550100109',
  '+15550100110',
  '+15550100111',
  '+15550100112',
] as const;

const PATIENT_NAMES: Record<string, string> = {
  '+15550100101': 'Amina Yusuf',
  '+15550100102': 'Bilal Chaudhry',
  '+15550100103': 'Chen Wei',
  '+15550100104': 'Dana Kowalski',
  '+15550100105': 'Elena Petrov',
  '+15550100106': 'Farhan Qureshi',
  '+15550100107': 'Grace Mbeki',
  '+15550100108': 'Hassan Alami',
  '+15550100109': 'Ingrid Larsen',
  '+15550100110': 'Jamal Ndiaye',
  '+15550100111': 'Karin Vogel',
  '+15550100112': 'Luis Moreno',
};

// ─── Date helpers (UTC calendar arithmetic) ────────────────────────────

const DAY_MS = 86_400_000;

/** UTC midnight of `days` days from today (negative = past). */
function utcMidnightPlusDays(days: number): Date {
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(today + days * DAY_MS);
}

/**
 * Find the `offset`-th day (0 = today) that is NOT a Sunday.
 *
 * The branch hours close on DOW 0 and no doctor has a Sunday schedule,
 * so every seeded date must avoid Sunday. `offset` counts only
 * non-Sunday days, which makes the generated dates stable and
 * reproducible regardless of what day of the week the seed runs on.
 *
 * A NEGATIVE offset walks BACKWARD from today (past dates); a positive
 * offset walks FORWARD (future dates). Offset 0 is today itself when
 * today is not a Sunday, otherwise the next non-Sunday day.
 */
function openDay(offset: number): Date {
  if (offset === 0) {
    const today = utcMidnightPlusDays(0);
    if (today.getUTCDay() !== 0) return today;
    return utcMidnightPlusDays(1);
  }
  const step = offset > 0 ? 1 : -1;
  let remaining = Math.abs(offset);
  let cursor = 0;
  for (let i = 0; i < 800; i++) {
    cursor += step;
    const d = utcMidnightPlusDays(cursor);
    if (d.getUTCDay() === 0) continue;
    remaining -= 1;
    if (remaining === 0) return d;
  }
  throw new Error('openDay: could not find an open day');
}

/** YYYY-MM-DD in UTC for a Date. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build a branch-local wall-clock instant for a given date + HH:MM.
 *
 * The branch time zones are `America/New_York` (UTC-4 in EDT / UTC-5
 * in EST) and `America/Los_Angeles` (UTC-7 in PDT / UTC-8 in PST).
 * A fixed offset would drift across a DST boundary, so the offset is
 * derived from the standard-time assumption and then corrected for
 * DST by re-deriving it from the candidate instant.
 *
 * Implementation: use `Intl.DateTimeFormat` with the `timeZone` option
 * to read back the wall clock of a candidate instant, and nudge the
 * candidate until the rendered local clock matches the target. This is
 * the same technique `src/availability/types.ts:localWallClockToUtcMs`
 * uses, so the seeded instants land exactly on the wall-clock slot the
 * API's own availability engine would have produced.
 */
function localWallClockToUtc(isoDay: string, hh: number, mm: number, tz: string): Date {
  const wallMs =
    Date.UTC(
      Number(isoDay.slice(0, 4)),
      Number(isoDay.slice(5, 7)) - 1,
      Number(isoDay.slice(8, 10)),
    ) +
    (hh * 60 + mm) * 60_000;

  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  let candidate = wallMs;
  for (let i = 0; i < 4; i++) {
    const parts = fmt.formatToParts(new Date(candidate));
    const gotH = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const gotM = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const gotDay = dayFmt.format(new Date(candidate));
    if (gotDay !== isoDay) {
      // The instant fell on the wrong local calendar day (rare, near a
      // date-line shift). Re-anchor one day and retry.
      candidate = wallMs + 24 * 60 * 60 * 1000;
      continue;
    }
    const deltaMin = hh * 60 + mm - (gotH * 60 + gotM);
    if (deltaMin === 0) return new Date(candidate);
    candidate += deltaMin * 60_000;
  }
  return new Date(candidate);
}

// ─── Seed plan types ───────────────────────────────────────────────────

type ApptStatus = 'Scheduled' | 'Completed' | 'Cancelled' | 'No-show';

interface SeedAppointment {
  /** Stable natural key used for the idempotency check. */
  key: string;
  phone: string;
  doctorRole:
    | typeof DOCTOR_EAST_LEAD_ID
    | typeof DOCTOR_EAST_SUPPORT_ID
    | typeof DOCTOR_WEST_LEAD_ID
    | 'doctor-north'
    | 'doctor-therapy';
  branchRole:
    | typeof BRANCH_EAST_ID
    | typeof BRANCH_WEST_ID
    | 'branch-north';
  typeRole:
    | typeof APPOINTMENT_TYPE_GENERAL_ID
    | typeof APPOINTMENT_TYPE_FOLLOWUP_ID
    | typeof APPOINTMENT_TYPE_CONSULT_ID
    | 'appointment-type-telehealth'
    | 'appointment-type-therapy';
  /** YYYY-MM-DD (UTC calendar date of the appointment). */
  date: string;
  /** Branch-local wall clock, HH:MM. */
  hh: number;
  mm: number;
  /** Duration in minutes — must match the appointment type's duration. */
  duration: number;
  status: ApptStatus;
  /** Actor that created the row. */
  createdBy: string;
  /** Audit trail to write for this appointment. */
  audit: Array<{
    actorRole: string;
    actorId: string;
    event: string;
    payload: Record<string, unknown>;
    /** Minutes after the appointment start that the audit row was written. */
    offsetMinutes: number;
  }>;
  /** Non-null when the row belongs to a recurring series. */
  seriesKey?: string;
  /** 1-based occurrence index within the series. */
  occurrenceIndex?: number;
}

// ─── Recurring series definitions ──────────────────────────────────────

interface SeriesSpec {
  key: string;
  phone: string;
  doctorRole: SeedAppointment['doctorRole'];
  branchRole: SeedAppointment['branchRole'];
  typeRole: SeedAppointment['typeRole'];
  duration: number;
  /** Weekday the series lands on (1=Mon … 6=Sat). */
  weekday: number;
  /** First occurrence, counted as an offset in open (non-Sunday) days. */
  startOffset: number;
  /** Gap between occurrences, in days. */
  intervalDays: number;
  occurrences: number;
  hh: number;
  mm: number;
  recurrenceKind: 'weekly' | 'every_two_weeks' | 'custom_days';
  /** The series' series_id — fixed so re-runs find the same rows. */
  seriesId: string;
}

/**
 * The `offset`-th day that falls on `weekday` (0 = today is the first
 * candidate).
 *
 * Combines the "no Sundays" rule with a fixed weekday so a recurring
 * series keeps a stable cadence (e.g. every Tuesday). Only forward
 * offsets are used by the seeded series.
 */
function openDayWithWeekday(weekday: number, offset: number): Date {
  if (offset < 0) {
    throw new Error('openDayWithWeekday: negative offsets are not supported');
  }
  let remaining = offset;
  let cursor = 0;
  for (let i = 0; i < 800; i++) {
    const d = utcMidnightPlusDays(cursor);
    if (d.getUTCDay() === weekday) {
      if (remaining === 0) return d;
      remaining -= 1;
    }
    cursor += 1;
  }
  throw new Error('openDayWithWeekday: could not find an open day');
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply the rich operational seed against an open transaction on
 * `client`.
 *
 * The caller owns the transaction lifecycle (BEGIN before, COMMIT or
 * ROLLBACK after) — matching `seedWith()` in `01_minimum.ts`.
 */
export async function seedRichWith(client: PoolClient): Promise<RichSeedResult> {
  let inserted = false;
  const counts: Record<string, number> = {
    patients: 0,
    doctors: 0,
    branches: 0,
    appointment_types: 0,
    receptionists: 0,
    doctor_schedules: 0,
    doctor_blocks: 0,
    appointments: 0,
    appointment_audits: 0,
  };

  const bump = (table: string, n: number): void => {
    counts[table] = (counts[table] ?? 0) + n;
    if (n > 0) inserted = true;
  };

  // ── Clinic + baseline ids ────────────────────────────────────────────
  const clinicRes = await client.query<{ id: string }>(
    `SELECT id FROM clinic WHERE name = $1`,
    ['Test Clinic'],
  );
  if (!clinicRes.rows[0]) {
    throw new Error('rich_seed: baseline clinic missing — run 01_minimum first');
  }
  const clinicId = clinicRes.rows[0]!.id;

  const branchByRole: Record<string, string> = {};
  const doctorByRole: Record<string, string> = {};
  const typeByRole: Record<string, string> = {};

  const lookupBranch = async (name: string): Promise<string> => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM branch WHERE clinic_id = $1 AND name = $2`,
      [clinicId, name],
    );
    return r.rows[0]!.id;
  };
  const lookupDoctor = async (name: string): Promise<string> => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM doctor WHERE clinic_id = $1 AND full_name = $2`,
      [clinicId, name],
    );
    return r.rows[0]!.id;
  };
  const lookupType = async (name: string): Promise<string> => {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM appointment_type WHERE clinic_id = $1 AND name = $2`,
      [clinicId, name],
    );
    return r.rows[0]!.id;
  };

  branchByRole[BRANCH_EAST_ID] = await lookupBranch('East Branch');
  branchByRole[BRANCH_WEST_ID] = await lookupBranch('West Branch');
  doctorByRole[DOCTOR_EAST_LEAD_ID] = await lookupDoctor('Dr. East Lead');
  doctorByRole[DOCTOR_EAST_SUPPORT_ID] = await lookupDoctor('Dr. East Support');
  doctorByRole[DOCTOR_WEST_LEAD_ID] = await lookupDoctor('Dr. West Lead');
  typeByRole[APPOINTMENT_TYPE_GENERAL_ID] = await lookupType('General Consultation');
  typeByRole[APPOINTMENT_TYPE_FOLLOWUP_ID] = await lookupType('Follow-up');
  typeByRole[APPOINTMENT_TYPE_CONSULT_ID] = await lookupType('Specialist Consult');

  // ── 1. A third branch: North Branch (UTC tz) ─────────────────────────
  // A third IANA tz exercises the branch-local wall-clock math for a
  // zone that is NOT behind UTC. Its hours are Mon–Sat 08:00–18:00 so
  // it is visibly distinct from the other two branches' 09:00–17:00.
  {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM branch WHERE clinic_id = $1 AND name = $2`,
      [clinicId, 'North Branch'],
    );
    if (r.rows[0]) {
      branchByRole['branch-north'] = r.rows[0]!.id;
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO branch (clinic_id, name, tz, address, active)
         VALUES ($1, 'North Branch', 'Europe/London', '77 Kingsway\nLevel 4', true)
         RETURNING id`,
        [clinicId],
      );
      branchByRole['branch-north'] = ins.rows[0]!.id;
      bump('branches', 1);
    }
    // Branch hours — Mon–Sat 08:00–18:00, closed Sunday.
    for (let dow = 0; dow < 7; dow++) {
      const isClosed = dow === 0;
      const res = await client.query(
        `INSERT INTO branch_weekly_hours
           (branch_id, day_of_week, open_time, close_time, is_closed)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (branch_id, day_of_week) DO NOTHING`,
        [
          branchByRole['branch-north'],
          dow,
          isClosed ? null : '08:00:00',
          isClosed ? null : '18:00:00',
          isClosed,
        ],
      );
      if ((res.rowCount ?? 0) > 0) bump('branches', 1);
    }
  }

  // ── 2. Extra appointment types ───────────────────────────────────────
  //   - Telehealth (20 min, active) — a short remote visit.
  //   - Physical Therapy (60 min, active) — a long in-person visit.
  //   - Wellness Screening (30 min, INACTIVE) — exercises the
  //     `appointment_type_inactive` / `appointment_type_not_found`
  //     branches of the availability + booking engines.
  const extraTypes = [
    {
      roleId: 'appointment-type-telehealth',
      name: 'Telehealth Check-in',
      duration: 20,
      active: true,
      description: 'Short remote video consultation.',
    },
    {
      roleId: 'appointment-type-therapy',
      name: 'Physical Therapy',
      duration: 60,
      active: true,
      description: 'Extended in-person rehabilitation session.',
    },
    {
      roleId: 'appointment-type-screening',
      name: 'Wellness Screening',
      duration: 30,
      active: false,
      description: 'Retired seasonal screening service (inactive).',
    },
  ] as const;
  for (const t of extraTypes) {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM appointment_type WHERE clinic_id = $1 AND name = $2`,
      [clinicId, t.name],
    );
    if (r.rows[0]) {
      typeByRole[t.roleId] = r.rows[0]!.id;
      await client.query(
        `UPDATE appointment_type
            SET duration_minutes = $1, is_active = $2,
                description = COALESCE(description, $3)
          WHERE id = $4`,
        [t.duration, t.active, t.description, r.rows[0]!.id],
      );
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO appointment_type
           (clinic_id, name, duration_minutes, is_active, created_by, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          clinicId,
          t.name,
          t.duration,
          t.active,
          `staff:${ADMIN_MAIN_ID}`,
          t.description,
        ],
      );
      typeByRole[t.roleId] = ins.rows[0]!.id;
      bump('appointment_types', 1);
    }
  }

  // ── 3. Extra doctors ─────────────────────────────────────────────────
  // All names sort AFTER "Dr. East Lead" so `GET /admin/doctors`' first
  // row (and therefore the E2E specialty spec's target) is unchanged.
  //
  // NOTE the deliberate "Dr. Z…" naming: "Dr. Aaron …" would sort
  // BEFORE "Dr. East Lead" and would silently become the first row of
  // the admin doctor list — changing which doctor the E2E specialty
  // spec patches. Every seeded doctor therefore starts with a letter
  // that sorts after "E".
  //
  //   - Dr. Zoya Rahman — East + North Branch, split Tuesday schedule.
  //   - Dr. Aaron Beck — North Branch only, INACTIVE (lifecycle surface).
  //   - Dr. Yara Haddad — East Branch, physical-therapy specialist.
  const extraDoctors = [
    {
      roleId: 'doctor-north',
      name: 'Dr. Zoya Rahman',
      email: 'dr.-zoya-rahman@clinic.local',
      specialty: 'Neurology',
      active: true,
      branches: [BRANCH_EAST_ID, 'branch-north'],
    },
    {
      roleId: 'doctor-inactive',
      name: 'Dr. Zoe Adler',
      email: 'dr.-zoe-adler@clinic.local',
      specialty: 'Dermatology',
      active: false,
      branches: ['branch-north'],
    },
    {
      roleId: 'doctor-therapy',
      name: 'Dr. Yara Haddad',
      email: 'dr.-yara-haddad@clinic.local',
      specialty: 'Orthopedics',
      active: true,
      branches: [BRANCH_EAST_ID],
    },
  ] as const;
  for (const d of extraDoctors) {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM doctor WHERE clinic_id = $1 AND full_name = $2`,
      [clinicId, d.name],
    );
    let doctorId: string;
    if (r.rows[0]) {
      doctorId = r.rows[0]!.id;
      await client.query(
        `UPDATE doctor
            SET specialty = COALESCE(specialty, $1), active = $2
          WHERE id = $3`,
        [d.specialty, d.active, doctorId],
      );
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO doctor (clinic_id, full_name, email, active, specialty, password_hash)
         VALUES ($1, $2, $3, $4, $5, ${DEV_PASSWORD_SQL})
         RETURNING id`,
        [clinicId, d.name, d.email, d.active, d.specialty],
      );
      doctorId = ins.rows[0]!.id;
      bump('doctors', 1);
    }
    doctorByRole[d.roleId] = doctorId;

    for (const brRole of d.branches) {
      const res = await client.query(
        `INSERT INTO doctor_branch (doctor_id, branch_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [doctorId, branchByRole[brRole]],
      );
      if ((res.rowCount ?? 0) > 0) bump('doctors', 1);
    }
  }

  // ── 4. Doctor schedules ──────────────────────────────────────────────
  // The extra doctors get a Mon–Sat 09:00–17:00 schedule (North Branch
  // 08:00–18:00 hours are a superset of it), EXCEPT Dr. Zoya Rahman,
  // who gets a SPLIT Tuesday (09:00–12:00 + 13:00–17:00) to exercise the
  // multi-period-day branch of the availability engine.
  const schedulePlans: Array<{
    doctorRole: string;
    branchRole: string;
    rows: Array<{ dow: number; start: string; end: string }>;
  }> = [
    {
      doctorRole: 'doctor-north',
      branchRole: BRANCH_EAST_ID,
      rows: Array.from({ length: 6 }, (_, i) => ({
        dow: i + 1,
        start: '09:00',
        end: '17:00',
      })),
    },
    {
      doctorRole: 'doctor-north',
      branchRole: 'branch-north',
      rows: Array.from({ length: 6 }, (_, i) => ({
        dow: i + 1,
        start: '09:00',
        end: '17:00',
      })),
    },
    {
      doctorRole: 'doctor-therapy',
      branchRole: BRANCH_EAST_ID,
      rows: [
        { dow: 1, start: '09:00', end: '12:00' },
        { dow: 1, start: '13:00', end: '17:00' },
        { dow: 2, start: '09:00', end: '17:00' },
        { dow: 4, start: '09:00', end: '17:00' },
        { dow: 6, start: '09:00', end: '13:00' },
      ],
    },
  ];
  for (const plan of schedulePlans) {
    for (const row of plan.rows) {
      // doctor_schedule has no UNIQUE constraint → SELECT-then-INSERT.
      const exists = await client.query(
        `SELECT id FROM doctor_schedule
          WHERE doctor_id = $1 AND branch_id = $2 AND day_of_week = $3
            AND start_time = $4 AND end_time = $5
            AND effective_from = '2020-01-01'::date
          LIMIT 1`,
        [
          doctorByRole[plan.doctorRole],
          branchByRole[plan.branchRole],
          row.dow,
          row.start,
          row.end,
        ],
      );
      if (exists.rows.length > 0) continue;
      await client.query(
        `INSERT INTO doctor_schedule
           (doctor_id, branch_id, day_of_week, start_time, end_time,
            effective_from, effective_to, created_by)
         VALUES ($1, $2, $3, $4, $5, '2020-01-01', NULL, $6)`,
        [
          doctorByRole[plan.doctorRole],
          branchByRole[plan.branchRole],
          row.dow,
          row.start,
          row.end,
          `staff:${ADMIN_MAIN_ID}`,
        ],
      );
      bump('doctor_schedules', 1);
    }
  }

  // ── 5. Patients ──────────────────────────────────────────────────────
  const patientIds: Record<string, string> = {};
  for (const phone of PATIENT_PHONES) {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM patient WHERE phone_number = $1`,
      [phone],
    );
    if (r.rows[0]) {
      patientIds[phone] = r.rows[0]!.id;
      continue;
    }
    const ins = await client.query<{ id: string }>(
      `INSERT INTO patient (phone_number, full_name) VALUES ($1, $2) RETURNING id`,
      [phone, PATIENT_NAMES[phone] ?? 'Seeded Patient'],
    );
    patientIds[phone] = ins.rows[0]!.id;
    bump('patients', 1);
  }

  // ── 6. Staff password credentials ────────────────────────────────────
  // The baseline seed leaves `password_hash` NULL (dev email-only
  // login). These UPDATEs give the baseline staff accounts a real
  // bcrypt credential WITHOUT touching any other column, so the
  // email-only dev login path (used by the E2E auth.setup) still works.
  //
  // The hash is recomputed on every run (bcrypt salts are random), so
  // this is idempotent in EFFECT — the stored value is always a valid
  // hash of the same dev password — and never touches a column the
  // tests depend on.
  const staffCredentialTargets: Array<[string, string]> = [
    ['admin_user', 'admin-main@clinic.local'],
    ['receptionist', 'receptionist-east@clinic.local'],
    ['receptionist', 'receptionist-west@clinic.local'],
    ['doctor', 'dr.-east-lead@clinic.local'],
    ['doctor', 'dr.-east-support@clinic.local'],
    ['doctor', 'dr.-west-lead@clinic.local'],
  ];
  for (const [table, email] of staffCredentialTargets) {
    await client.query(
      `UPDATE ${table} SET password_hash = ${DEV_PASSWORD_SQL} WHERE email = $1`,
      [email],
    );
  }

  // ── 7. A third receptionist at North Branch ───────────────────────────
  {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM receptionist WHERE email = $1`,
      ['receptionist-north@clinic.local'],
    );
    if (!r.rows[0]) {
      await client.query(
        `INSERT INTO receptionist (branch_id, full_name, email, active, password_hash)
         VALUES ($1, 'Receptionist North', 'receptionist-north@clinic.local', true, ${DEV_PASSWORD_SQL})`,
        [branchByRole['branch-north']],
      );
      bump('receptionists', 1);
    }
  }

  // ── 8. Doctor blocks (time off) ──────────────────────────────────────
  // A future block on a day where the doctor otherwise works: the
  // availability engine must subtract it and the booking route must
  // answer 409 `inside_doctor_block`.
  const blockPlans: Array<{
    doctorRole: string;
    branchRole: string;
    /** Offset in open (non-Sunday) days from today. */
    dayOffset: number;
    hh: number;
    mm: number;
    minutes: number;
    reason: string;
  }> = [
    {
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      dayOffset: 3,
      hh: 12,
      mm: 0,
      minutes: 120,
      reason: 'Cardiology conference',
    },
    {
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      dayOffset: 5,
      hh: 9,
      mm: 0,
      minutes: 90,
      reason: 'Clinical audit',
    },
    {
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      dayOffset: 4,
      hh: 15,
      mm: 0,
      minutes: 60,
      reason: 'Department meeting',
    },
    {
      doctorRole: 'doctor-north',
      branchRole: 'branch-north',
      dayOffset: 6,
      hh: 10,
      mm: 0,
      minutes: 180,
      reason: 'Leave',
    },
    // A PAST block — the retrospective time-off calendar.
    {
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      dayOffset: -12,
      hh: 9,
      mm: 0,
      minutes: 240,
      reason: 'Past clinic closure',
    },
  ];
  const branchTzByRole: Record<string, string> = {
    [BRANCH_EAST_ID]: 'America/New_York',
    [BRANCH_WEST_ID]: 'America/Los_Angeles',
    'branch-north': 'Europe/London',
  };
  for (const b of blockPlans) {
    const day = openDay(b.dayOffset);
    const tz = branchTzByRole[b.branchRole]!;
    const start = localWallClockToUtc(isoDate(day), b.hh, b.mm, tz);
    const end = new Date(start.getTime() + b.minutes * 60_000);
    const exists = await client.query(
      `SELECT id FROM doctor_block
        WHERE doctor_id = $1 AND branch_id = $2
          AND start_datetime = $3 AND end_datetime = $4
        LIMIT 1`,
      [doctorByRole[b.doctorRole], branchByRole[b.branchRole], start, end],
    );
    if (exists.rows.length > 0) continue;
    await client.query(
      `INSERT INTO doctor_block
         (doctor_id, branch_id, start_datetime, end_datetime, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        doctorByRole[b.doctorRole],
        branchByRole[b.branchRole],
        start,
        end,
        b.reason,
        `staff:${ADMIN_MAIN_ID}`,
      ],
    );
    bump('doctor_blocks', 1);
  }

  // ── 9. The appointment plan ──────────────────────────────────────────
  // Every entry below was chosen so that:
  //   - the date is a Mon–Sat day;
  //   - the (doctor, branch, day, slot) tuple is unique across the whole
  //     plan, so no two Scheduled rows overlap (the GIST exclusion);
  //   - each (patient, doctor) pair holds at most ONE future Scheduled
  //     row (FR-027 / the partial unique index).
  const P = PATIENT_PHONES;

  // Past days (relative to today) for the historical dataset.
  const dPast1 = isoDate(openDay(-40));
  const dPast2 = isoDate(openDay(-33));
  const dPast3 = isoDate(openDay(-25));
  const dPast4 = isoDate(openDay(-18));
  const dPast5 = isoDate(openDay(-11));
  const dPast6 = isoDate(openDay(-7));
  const dPast7 = isoDate(openDay(-3));
  // Future days (within the 30-day bookable window + a little beyond).
  const dFut1 = isoDate(openDay(2));
  const dFut2 = isoDate(openDay(4));
  const dFut3 = isoDate(openDay(6));
  const dFut4 = isoDate(openDay(8));
  const dFut5 = isoDate(openDay(10));
  const dFut6 = isoDate(openDay(13));
  const dFut7 = isoDate(openDay(16));
  const dFut8 = isoDate(openDay(20));
  const dFut9 = isoDate(openDay(24));

  const plan: SeedAppointment[] = [
    // ── Completed history ───────────────────────────────────────────────
    {
      key: 'completed-east-lead-am',
      phone: P[0],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dPast1,
      hh: 9,
      mm: 30,
      duration: 30,
      status: 'Completed',
      createdBy: `patient:${P[0]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[0]}`,
          event: 'created',
          payload: { source: 'self_book', patient_name_after: PATIENT_NAMES[P[0]] },
          offsetMinutes: -10080,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-east-lead@clinic.local',
          event: 'marked_completed',
          payload: {},
          offsetMinutes: 30,
        },
      ],
    },
    {
      key: 'completed-east-support-b',
      phone: P[1],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_FOLLOWUP_ID,
      date: dPast2,
      hh: 11,
      mm: 0,
      duration: 15,
      status: 'Completed',
      createdBy: `staff:${ADMIN_MAIN_ID}`,
      audit: [
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-east@clinic.local',
          event: 'created',
          payload: { source: 'receptionist_book' },
          offsetMinutes: -14400,
        },
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-east@clinic.local',
          event: 'marked_completed',
          payload: {},
          offsetMinutes: 15,
        },
      ],
    },
    {
      key: 'completed-west-lead-c',
      phone: P[2],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_CONSULT_ID,
      date: dPast3,
      hh: 14,
      mm: 0,
      duration: 45,
      status: 'Completed',
      createdBy: `patient:${P[2]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[2]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -20160,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-west-lead@clinic.local',
          event: 'marked_completed',
          payload: {},
          offsetMinutes: 45,
        },
      ],
    },
    {
      key: 'completed-east-lead-d',
      phone: P[3],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_FOLLOWUP_ID,
      date: dPast4,
      hh: 10,
      mm: 0,
      duration: 15,
      status: 'Completed',
      createdBy: `patient:${P[3]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[3]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -25920,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-east-lead@clinic.local',
          event: 'marked_completed',
          payload: {},
          offsetMinutes: 15,
        },
      ],
    },
    // A patient with MULTIPLE past visits (the "returning patient"
    // profile — the PatientAppointments history list renders one row
    // per visit).
    {
      key: 'completed-east-support-e1',
      phone: P[4],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dPast5,
      hh: 9,
      mm: 0,
      duration: 30,
      status: 'Completed',
      createdBy: `patient:${P[4]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[4]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -31680,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-east-support@clinic.local',
          event: 'marked_completed',
          payload: {},
          offsetMinutes: 30,
        },
      ],
    },
    {
      key: 'completed-east-support-e2',
      phone: P[4],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dPast2,
      hh: 9,
      mm: 0,
      duration: 30,
      status: 'Completed',
      createdBy: `patient:${P[4]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[4]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -31680,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-east-support@clinic.local',
          event: 'marked_completed',
          payload: {},
          offsetMinutes: 30,
        },
      ],
    },
    {
      key: 'completed-west-lead-f',
      phone: P[5],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dPast4,
      hh: 10,
      mm: 0,
      duration: 30,
      status: 'Completed',
      createdBy: `staff:${ADMIN_MAIN_ID}`,
      audit: [
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-west@clinic.local',
          event: 'created',
          payload: { source: 'receptionist_book' },
          offsetMinutes: -25920,
        },
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-west@clinic.local',
          event: 'marked_completed',
          payload: {},
          offsetMinutes: 30,
        },
      ],
    },

    // ── No-show history ────────────────────────────────────────────────
    {
      key: 'noshow-east-lead-g',
      phone: P[6],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dPast6,
      hh: 13,
      mm: 0,
      duration: 30,
      status: 'No-show',
      createdBy: `patient:${P[6]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[6]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -10080,
        },
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-east@clinic.local',
          event: 'marked_no_show',
          payload: {},
          offsetMinutes: 30,
        },
      ],
    },
    {
      key: 'noshow-west-lead-h',
      phone: P[7],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_FOLLOWUP_ID,
      date: dPast7,
      hh: 16,
      mm: 0,
      duration: 15,
      status: 'No-show',
      createdBy: `patient:${P[7]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[7]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -4320,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-west-lead@clinic.local',
          event: 'marked_no_show',
          payload: {},
          offsetMinutes: 15,
        },
      ],
    },

    // ── Cancelled (past + future) ──────────────────────────────────────
    {
      key: 'cancelled-past-i',
      phone: P[8],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dPast5,
      hh: 14,
      mm: 0,
      duration: 30,
      status: 'Cancelled',
      createdBy: `patient:${P[8]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[8]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -31680,
        },
        {
          actorRole: 'patient',
          actorId: `patient:${P[8]}`,
          event: 'cancelled',
          payload: {},
          offsetMinutes: -20160,
        },
      ],
    },
    {
      key: 'cancelled-by-doctor-j',
      phone: P[9],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_CONSULT_ID,
      date: dPast6,
      hh: 11,
      mm: 0,
      duration: 45,
      status: 'Cancelled',
      createdBy: `staff:${ADMIN_MAIN_ID}`,
      audit: [
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-east@clinic.local',
          event: 'created',
          payload: { source: 'receptionist_book' },
          offsetMinutes: -10080,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-east-support@clinic.local',
          event: 'cancelled',
          payload: { reason: 'Patient admitted to hospital' },
          offsetMinutes: -2880,
        },
      ],
    },
    {
      key: 'cancelled-future-k',
      phone: P[10],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut2,
      hh: 10,
      mm: 0,
      duration: 30,
      status: 'Cancelled',
      createdBy: `patient:${P[10]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[10]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-west@clinic.local',
          event: 'cancelled',
          payload: { reason: 'Patient rescheduled by phone' },
          offsetMinutes: -720,
        },
      ],
    },
    {
      key: 'cancelled-future-l',
      phone: P[11],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_FOLLOWUP_ID,
      date: dFut3,
      hh: 15,
      mm: 0,
      duration: 15,
      status: 'Cancelled',
      createdBy: `patient:${P[11]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[11]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -2880,
        },
        {
          actorRole: 'patient',
          actorId: `patient:${P[11]}`,
          event: 'cancelled',
          payload: {},
          offsetMinutes: -1440,
        },
      ],
    },

    // ── Rescheduled (a row that MOVED, with the `rescheduled` audit) ──
    {
      key: 'rescheduled-east-lead-m',
      phone: P[0],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut1,
      hh: 10,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[0]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[0]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -2880,
        },
        {
          actorRole: 'patient',
          actorId: `patient:${P[0]}`,
          event: 'rescheduled',
          payload: {
            from: { start_datetime: '09:00', end_datetime: '09:30' },
            to: { start_datetime: '10:00', end_datetime: '10:30' },
          },
          offsetMinutes: -1440,
        },
      ],
    },

    // ── Future Scheduled — the "bookable" surface ──────────────────────
    {
      key: 'sched-east-support-n',
      phone: P[1],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut1,
      hh: 10,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[1]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[1]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-west-lead-o',
      phone: P[2],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_CONSULT_ID,
      date: dFut1,
      hh: 11,
      mm: 0,
      duration: 45,
      status: 'Scheduled',
      createdBy: `staff:${ADMIN_MAIN_ID}`,
      audit: [
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-west@clinic.local',
          event: 'created',
          payload: { source: 'receptionist_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-east-lead-p',
      phone: P[3],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut4,
      hh: 9,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[3]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[3]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-east-support-q',
      phone: P[4],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_FOLLOWUP_ID,
      date: dFut4,
      hh: 14,
      mm: 0,
      duration: 15,
      status: 'Scheduled',
      createdBy: `patient:${P[4]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[4]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-west-lead-r',
      phone: P[5],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut4,
      hh: 9,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[5]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[5]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-east-lead-s',
      phone: P[6],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_CONSULT_ID,
      date: dFut5,
      hh: 11,
      mm: 0,
      duration: 45,
      status: 'Scheduled',
      createdBy: `patient:${P[6]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[6]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-east-support-t',
      phone: P[7],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut6,
      hh: 9,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `staff:${ADMIN_MAIN_ID}`,
      audit: [
        {
          actorRole: 'receptionist',
          actorId: 'staff:receptionist-east@clinic.local',
          event: 'created',
          payload: { source: 'receptionist_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-west-lead-u',
      phone: P[8],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut6,
      hh: 14,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[8]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[8]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-east-lead-v',
      phone: P[9],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut7,
      hh: 9,
      mm: 30,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[9]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[9]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-therapy-w',
      phone: P[10],
      doctorRole: 'doctor-therapy',
      branchRole: BRANCH_EAST_ID,
      typeRole: 'appointment-type-therapy',
      date: dFut7,
      hh: 9,
      mm: 0,
      duration: 60,
      status: 'Scheduled',
      createdBy: `patient:${P[10]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[10]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    {
      key: 'sched-east-support-x',
      phone: P[11],
      doctorRole: DOCTOR_EAST_SUPPORT_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut8,
      hh: 9,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[11]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[11]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    // A future appointment at the third branch (North Branch, London).
    {
      key: 'sched-north-y',
      phone: P[0],
      doctorRole: 'doctor-north',
      branchRole: 'branch-north',
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut9,
      hh: 10,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[0]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[0]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    // A Telehealth appointment (20-minute type) at the West Branch.
    {
      key: 'sched-telehealth-z',
      phone: P[1],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: 'appointment-type-telehealth',
      date: dFut8,
      hh: 11,
      mm: 0,
      duration: 20,
      status: 'Scheduled',
      createdBy: `patient:${P[1]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[1]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -1440,
        },
      ],
    },
    // A "moved by doctor" appointment — the conflict-resolution flow.
    {
      key: 'moved-east-lead-aa',
      phone: P[2],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      date: dFut9,
      hh: 9,
      mm: 0,
      duration: 30,
      status: 'Scheduled',
      createdBy: `patient:${P[2]}`,
      audit: [
        {
          actorRole: 'patient',
          actorId: `patient:${P[2]}`,
          event: 'created',
          payload: { source: 'self_book' },
          offsetMinutes: -2880,
        },
        {
          actorRole: 'doctor',
          actorId: 'staff:dr.-east-lead@clinic.local',
          event: 'moved_by_doctor',
          payload: {
            reason: 'conflict_resolution',
            branch_change: false,
            type_change: false,
          },
          offsetMinutes: -1440,
        },
      ],
    },
  ];

  // ── 10. Recurring series ────────────────────────────────────────────
  // Two series:
  //   - a WEEKLY series of 4 occurrences (same weekday, +7 days) for
  //     P[2] with Dr. East Lead;
  //   - an EVERY_TWO_WEEKS series of 3 occurrences (+14 days) for P[3]
  //     with Dr. West Lead.
  //
  // The occurrences carry a shared `recurring_series_id`, which the
  // partial unique index `idx_appointment_patient_doctor_scheduled`
  // EXCLUDES (migration 0020) — so a patient may hold several future
  // Scheduled rows with the same doctor, exactly as the recurring
  // confirm route produces.
  const seriesSpecs: SeriesSpec[] = [
    {
      key: 'series-weekly-east-lead',
      phone: P[2],
      doctorRole: DOCTOR_EAST_LEAD_ID,
      branchRole: BRANCH_EAST_ID,
      typeRole: APPOINTMENT_TYPE_GENERAL_ID,
      duration: 30,
      weekday: 2, // Tuesday
      startOffset: 1,
      intervalDays: 7,
      occurrences: 4,
      hh: 16,
      mm: 0,
      recurrenceKind: 'weekly',
      seriesId: '11111111-1111-4111-8111-000000000001',
    },
    {
      key: 'series-biweekly-west-lead',
      phone: P[3],
      doctorRole: DOCTOR_WEST_LEAD_ID,
      branchRole: BRANCH_WEST_ID,
      typeRole: APPOINTMENT_TYPE_FOLLOWUP_ID,
      duration: 15,
      weekday: 4, // Thursday
      startOffset: 1,
      intervalDays: 14,
      occurrences: 3,
      hh: 13,
      mm: 0,
      recurrenceKind: 'every_two_weeks',
      seriesId: '22222222-2222-4222-8222-000000000002',
    },
  ];

  for (const s of seriesSpecs) {
    let anchor = openDayWithWeekday(s.weekday, s.startOffset);
    for (let i = 0; i < s.occurrences; i++) {
      const date = isoDate(anchor);
      plan.push({
        key: `${s.key}-${i + 1}`,
        phone: s.phone,
        doctorRole: s.doctorRole,
        branchRole: s.branchRole,
        typeRole: s.typeRole,
        date,
        hh: s.hh,
        mm: s.mm,
        duration: s.duration,
        status: 'Scheduled',
        createdBy: `staff:${ADMIN_MAIN_ID}`,
        seriesKey: s.key,
        occurrenceIndex: i + 1,
        audit: [
          {
            actorRole: 'receptionist',
            actorId: 'staff:receptionist-east@clinic.local',
            event: 'recurring_created',
            payload: {
              series_id: s.seriesId,
              recurrence_kind: s.recurrenceKind,
              recurrence_interval_days: s.intervalDays,
              occurrence_index: i + 1,
            },
            offsetMinutes: -1440,
          },
        ],
      });
      anchor = new Date(anchor.getTime() + s.intervalDays * DAY_MS);
    }
  }

  // ── 11. Insert the appointments + their audit trails ────────────────
  for (const appt of plan) {
    const tz = branchTzByRole[appt.branchRole]!;
    const start = localWallClockToUtc(appt.date, appt.hh, appt.mm, tz);
    const end = new Date(start.getTime() + appt.duration * 60_000);

    // Idempotency: the (doctor, branch, start) triple is the natural
    // key for a seeded appointment. A second run finds the row and
    // skips it.
    const exists = await client.query<{ id: string }>(
      `SELECT id FROM appointment
        WHERE doctor_id = $1 AND branch_id = $2 AND start_datetime = $3
        LIMIT 1`,
      [doctorByRole[appt.doctorRole], branchByRole[appt.branchRole], start],
    );
    if (exists.rows[0]) {
      // The appointment is already there; make sure its audit trail is
      // in place too (a partially-applied earlier run).
      await ensureAuditTrail(client, exists.rows[0]!.id, appt, start, counts);
      continue;
    }

    const seriesId = appt.seriesKey
      ? seriesSpecs.find((s) => s.key === appt.seriesKey)!.seriesId
      : null;

    const ins = await client.query<{ id: string }>(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
          start_datetime, end_datetime, status, recurring_series_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        clinicId,
        branchByRole[appt.branchRole],
        doctorByRole[appt.doctorRole],
        appt.phone,
        typeByRole[appt.typeRole],
        start,
        end,
        appt.status,
        seriesId,
        appt.createdBy,
      ],
    );
    const appointmentId = ins.rows[0]!.id;
    bump('appointments', 1);

    for (const ev of appt.audit) {
      const createdAt = new Date(
        start.getTime() + ev.offsetMinutes * 60_000,
      );
      await client.query(
        `INSERT INTO appointment_audit
           (appointment_id, actor_role, actor_id, event, payload, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          appointmentId,
          ev.actorRole,
          ev.actorId,
          ev.event,
          JSON.stringify(ev.payload),
          createdAt,
        ],
      );
      bump('appointment_audits', 1);
    }
  }

  return { inserted, counts };
}

/**
 * Write the audit trail for an appointment that already exists.
 *
 * The audit table is append-only (migration 0009's `reject_audit_mutation`
 * trigger), so we can only INSERT — never UPDATE or DELETE. Each row is
 * therefore guarded by an existence check on (appointment_id, event,
 * created_at) so re-running the seed is a no-op.
 */
async function ensureAuditTrail(
  client: PoolClient,
  appointmentId: string,
  appt: SeedAppointment,
  start: Date,
  counts: Record<string, number>,
): Promise<void> {
  for (const ev of appt.audit) {
    const createdAt = new Date(start.getTime() + ev.offsetMinutes * 60_000);
    const exists = await client.query(
      `SELECT id FROM appointment_audit
        WHERE appointment_id = $1 AND event = $2 AND created_at = $3
        LIMIT 1`,
      [appointmentId, ev.event, createdAt],
    );
    if (exists.rows.length > 0) continue;
    await client.query(
      `INSERT INTO appointment_audit
         (appointment_id, actor_role, actor_id, event, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        appointmentId,
        ev.actorRole,
        ev.actorId,
        ev.event,
        JSON.stringify(ev.payload),
        createdAt,
      ],
    );
    counts['appointment_audits'] = (counts['appointment_audits'] ?? 0) + 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLI entry point — `pnpm --filter @clinic/api db:seed:rich`
// ═══════════════════════════════════════════════════════════════════════

/**
 * Production entry point: open a pool, run the baseline seed (so the
 * rich seed's baseline lookups resolve) and then the rich seed, both
 * inside ONE transaction. Close the pool.
 *
 * Logs a single JSON object so a log shipper indexes it as one event:
 *   `{"event":"seed_rich_complete","inserted":true,"counts":{…}}`
 */
export async function seedRich(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The rich seed looks up the baseline rows (clinic, branches,
    // doctors, types) by name, so the baseline seed must run first.
    await seedWith(client);
    const result = await seedRichWith(client);
    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: result.inserted ? 'seed_rich_complete' : 'seed_rich_unchanged',
        inserted: result.inserted,
        counts: result.counts,
      }),
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('03_rich_operations.ts');

if (invokedDirectly) {
  seedRich()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('seed_rich_failed', err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
