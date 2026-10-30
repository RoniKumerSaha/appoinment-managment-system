/**
 * db-demo-seed.ts — the DEMO dataset.
 *
 * Run on top of a migrated + baseline-seeded database:
 *
 *   pnpm --filter @clinic/api exec tsx scripts/db-demo-seed.ts
 *
 * Two jobs:
 *
 *   1. Promote three accounts to the memorable demo credentials. The
 *      seed uses `*@clinic.local` addresses (`admin-main@clinic.local`
 *      etc.) which are fine for tests but painful to type on stage.
 *      This renames them to `admin@clinic.com`, `doctor@clinic.com`
 *      and `reception@clinic.com`, and sets a single shared password.
 *
 *   2. Load a realistic week of appointments — today, yesterday,
 *      tomorrow — spread across the three branches and every
 *      appointment status, so each role's dashboard has something to
 *      show the moment you sign in.
 *
 * Idempotent: re-running replaces the demo appointments rather than
 * stacking duplicates, and the credential update is a plain UPDATE.
 */
import './_load-env.js';
import { getPool, closePool } from '../src/db/pool.js';
import { staffCreatedBy, patientCreatedBy } from '../src/routes/created-by.js';
import type { PoolClient } from 'pg';

const DEMO_PASSWORD = 'Clinic@12345678';

/** bcrypt hash of DEMO_PASSWORD, produced by pgcrypto (cost 10). */
const PASSWORD_SQL = `pgcrypto.crypt('${DEMO_PASSWORD}', pgcrypto.gen_salt('bf', 10))`;

interface DemoAccount {
  table: 'admin_user' | 'doctor' | 'receptionist';
  from: string;
  to: string;
  fullName: string;
}

const ACCOUNTS: DemoAccount[] = [
  {
    table: 'admin_user',
    from: 'admin-main@clinic.local',
    to: 'admin@clinic.com',
    fullName: 'Aisha Rahman',
  },
  {
    table: 'doctor',
    from: 'dr.-east-lead@clinic.local',
    to: 'doctor@clinic.com',
    fullName: 'Dr. Yara Haddad',
  },
  {
    table: 'receptionist',
    from: 'receptionist-east@clinic.local',
    to: 'reception@clinic.com',
    fullName: 'Layla Mansour',
  },
];

interface DemoPatient {
  phone: string;
  name: string;
}

const PATIENTS: DemoPatient[] = [
  { phone: '+15550000001', name: 'Fatima Noor' },
  { phone: '+15550000002', name: 'Omar Khalid' },
  { phone: '+15550000003', name: 'Sara Aziz' },
  { phone: '+15550000004', name: 'Yusuf Ibrahim' },
  { phone: '+15550000005', name: 'Nadia Farouk' },
  { phone: '+966501110001', name: 'Hassan Ali' },
  { phone: '+966501110002', name: 'Mariam Salem' },
  { phone: '+966501110003', name: 'Tariq Aziz' },
  { phone: '+966501110004', name: 'Rania Fares' },
  { phone: '+966501110005', name: 'Bilal Nassar' },
];

/**
 * The demo appointments.
 *
 * `day` is an offset from today: -1 yesterday, 0 today, +1 tomorrow,
 * +7 next week. `hour` is a local hour in the branch's timezone —
 * the seed converts it to a UTC instant so the times read correctly
 * for whoever opens the app.
 *
 * `outsideHours` marks a row that deliberately falls OUTSIDE the
 * branch's `branch_weekly_hours`. Those rows are what the doctor's
 * "Affected" queue (E6-S3) lists — without them the queue is always
 * empty and the demo shows a doctor with nothing to resolve. See the
 * AFFECTED section below for how the offset is chosen.
 */
interface DemoAppointment {
  day: number;
  hour: number;
  durationMin: number;
  patient: string;
  doctorEmail: string;
  branchName: string;
  typeName: string;
  status: 'Scheduled' | 'Completed' | 'Cancelled' | 'No-show';
  /** The staff email or patient phone that made the booking. */
  actor: string;
  /** Whether the actor is staff or the patient themselves. */
  actorKind: 'staff' | 'patient';
  /**
   * When true, the row is placed outside the branch's opening hours
   * so it lands in the doctor's affected queue.
   *
   * `day` then means "days from today, skipping to the NEXT Sunday"
   * — a Sunday is closed at every branch, which is the cleanest way
   * to produce an out-of-hours row (see the AFFECTED section).
   */
  outsideHours?: boolean;
}

const APPOINTMENTS: DemoAppointment[] = [
  // ── Today: a busy clinic day at East Branch ────────────────────
  { day: 0, hour: 9, durationMin: 30, patient: '+15550000001', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Completed', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 0, hour: 9, durationMin: 45, patient: '+966501110001', doctorEmail: 'dr.-east-support@clinic.local', branchName: 'East Branch', typeName: 'Specialist Consult', status: 'Completed', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 0, hour: 10, durationMin: 30, patient: '+15550000002', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 0, hour: 10, durationMin: 15, patient: '+15550000003', doctorEmail: 'dr.-zoya-rahman@clinic.local', branchName: 'East Branch', typeName: 'Follow-up', status: 'Scheduled', actor: '+15550000003', actorKind: 'patient' },
  { day: 0, hour: 11, durationMin: 30, patient: '+966501110002', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+966501110002', actorKind: 'patient' },
  { day: 0, hour: 11, durationMin: 45, patient: '+966501110003', doctorEmail: 'dr.-zoe-adler@clinic.local', branchName: 'East Branch', typeName: 'Specialist Consult', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 0, hour: 13, durationMin: 30, patient: '+15550000004', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+15550000004', actorKind: 'patient' },
  { day: 0, hour: 14, durationMin: 15, patient: '+15550000005', doctorEmail: 'dr.-yara-haddad@clinic.local', branchName: 'East Branch', typeName: 'Follow-up', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 0, hour: 15, durationMin: 30, patient: '+966501110004', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+966501110004', actorKind: 'patient' },
  { day: 0, hour: 16, durationMin: 30, patient: '+966501110005', doctorEmail: 'dr.-east-support@clinic.local', branchName: 'East Branch', typeName: 'General Consultation', status: 'No-show', actor: 'reception@clinic.com', actorKind: 'staff' },

  // ── Today: West Branch, a lighter list ──────────────────────────
  { day: 0, hour: 9, durationMin: 45, patient: '+966501110001', doctorEmail: 'dr.-west-lead@clinic.local', branchName: 'West Branch', typeName: 'Specialist Consult', status: 'Completed', actor: 'reception-west@clinic.local', actorKind: 'staff' },
  { day: 0, hour: 11, durationMin: 30, patient: '+966501110002', doctorEmail: 'dr.-west-lead@clinic.local', branchName: 'West Branch', typeName: 'General Consultation', status: 'Scheduled', actor: 'reception-west@clinic.local', actorKind: 'staff' },
  { day: 0, hour: 14, durationMin: 30, patient: '+966501110003', doctorEmail: 'dr.-west-lead@clinic.local', branchName: 'West Branch', typeName: 'General Consultation', status: 'Cancelled', actor: '+966501110003', actorKind: 'patient' },

  // ── Yesterday: completed history ────────────────────────────────
  { day: -1, hour: 9, durationMin: 30, patient: '+15550000001', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Completed', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: -1, hour: 10, durationMin: 15, patient: '+15550000002', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'Follow-up', status: 'Completed', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: -1, hour: 11, durationMin: 45, patient: '+966501110004', doctorEmail: 'dr.-east-support@clinic.local', branchName: 'East Branch', typeName: 'Specialist Consult', status: 'Completed', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: -1, hour: 13, durationMin: 30, patient: '+966501110005', doctorEmail: 'dr.-west-lead@clinic.local', branchName: 'West Branch', typeName: 'General Consultation', status: 'Cancelled', actor: '+966501110005', actorKind: 'patient' },

  // ── Tomorrow: the look-ahead ────────────────────────────────────
  { day: 1, hour: 9, durationMin: 30, patient: '+15550000003', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+15550000003', actorKind: 'patient' },
  { day: 1, hour: 10, durationMin: 45, patient: '+966501110001', doctorEmail: 'dr.-east-support@clinic.local', branchName: 'East Branch', typeName: 'Specialist Consult', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 1, hour: 11, durationMin: 30, patient: '+15550000004', doctorEmail: 'dr.-yara-haddad@clinic.local', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 1, hour: 14, durationMin: 30, patient: '+966501110004', doctorEmail: 'dr.-west-lead@clinic.local', branchName: 'West Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+966501110004', actorKind: 'patient' },

  // ── Next week: shows the recurring / forward view ─────────────────
  { day: 7, hour: 9, durationMin: 30, patient: '+15550000005', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff' },
  { day: 7, hour: 11, durationMin: 30, patient: '+966501110003', doctorEmail: 'dr.-west-lead@clinic.local', branchName: 'West Branch', typeName: 'General Consultation', status: 'Scheduled', actor: 'reception-west@clinic.local', actorKind: 'staff' },
  // `+15550000001` is the patient the login screen names first, so it
  // needs an UPCOMING booking or the demo lands on an empty
  // "My appointments" screen. `dr.-yara-haddad` is free at day 2.
  { day: 2, hour: 10, durationMin: 30, patient: '+15550000001', doctorEmail: 'dr.-yara-haddad@clinic.local', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+15550000001', actorKind: 'patient' },

  // ── Affected: the doctor's "Resolve" queue ───────────────────────
  //
  // Every row above sits inside the branch's opening hours (Mon–Sat
  // 09:00–17:00), so `GET /doctor/affected` returns an empty list and
  // the doctor's Resolve board is blank on a fresh demo. These four
  // rows deliberately land OUTSIDE those hours, which is exactly the
  // condition the affected queue selects on (see
  // `doctor-affected-helpers.ts` — `closed_day` /
  // `before_open_or_after_close`).
  //
  // They are placed on a SUNDAY, when every branch is closed. A
  // Sunday is the cleanest out-of-hours day: the reason is
  // unambiguous ("closed_day"), it does not depend on the doctor's
  // own `doctor_schedule` rows, and it cannot collide with the
  // in-hours rows above.
  //
  // `day` on an `outsideHours` row means "the n-th Sunday from
  // today" — 0 is the coming Sunday, 1 the one after. The seed
  // resolves it in SQL so the demo stays correct no matter which day
  // it is run on.
  //
  // All four belong to `doctor@clinic.com` (the demo login), so
  // signing in as the doctor shows a populated Resolve board.
  //
  // The patients are picked so that none of them already has a
  // Scheduled appointment with THIS doctor: the schema carries a
  // partial unique index
  //   idx_appointment_patient_doctor_scheduled
  //     ON (patient_phone, doctor_id) WHERE status = 'Scheduled'
  // so a second live booking for the same pair is rejected outright.
  { day: 0, hour: 10, durationMin: 30, patient: '+15550100101', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+15550100101', actorKind: 'patient', outsideHours: true },
  { day: 0, hour: 11, durationMin: 45, patient: '+15550100109', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'Follow-up', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff', outsideHours: true },
  { day: 1, hour: 10, durationMin: 30, patient: '+15550100112', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: 'reception@clinic.com', actorKind: 'staff', outsideHours: true },
  { day: 1, hour: 14, durationMin: 30, patient: '+966501110003', doctorEmail: 'doctor@clinic.com', branchName: 'East Branch', typeName: 'General Consultation', status: 'Scheduled', actor: '+966501110003', actorKind: 'patient', outsideHours: true },
];

/**
 * Promote the three baseline accounts to the memorable demo addresses
 * and give them the shared demo password.
 *
 * The lookup accepts EITHER the original seeded address or the already
 * -promoted one, so re-running the seed is idempotent: the first run
 * renames `admin-main@clinic.local` → `admin@clinic.com`, and the
 * second run finds `admin@clinic.com` and simply re-applies the
 * password. Without that, a second run would fail with "expected a
 * admin_user row with email admin-main@clinic.local".
 */
async function setDemoCredentials(c: PoolClient): Promise<void> {
  for (const acct of ACCOUNTS) {
    const res = await c.query(
      `UPDATE ${acct.table}
          SET email = $1,
              full_name = $2,
              password_hash = ${PASSWORD_SQL}
        WHERE email = $3::citext OR email = $4::citext
        RETURNING id`,
      [acct.to, acct.fullName, acct.from, acct.to],
    );
    if (res.rowCount === 0) {
      throw new Error(
        `demo-seed: expected a ${acct.table} row with email ${acct.from} — run db:reset first`,
      );
    }
  }
  console.log('demo-seed: credentials set');
}

async function seedPatients(c: PoolClient): Promise<void> {
  for (const p of PATIENTS) {
    await c.query(
      `INSERT INTO patient (phone_number, full_name)
       VALUES ($1, $2)
       ON CONFLICT (phone_number)
       DO UPDATE SET full_name = EXCLUDED.full_name`,
      [p.phone, p.name],
    );
  }
  console.log(`demo-seed: ${PATIENTS.length} patients ready`);
}

async function seedAppointments(c: PoolClient): Promise<void> {
  const clinic = await c.query<{ id: string }>(
    `SELECT id FROM clinic LIMIT 1`,
  );
  const clinicId = clinic.rows[0]!.id;

  const branches = await c.query<{ id: string; name: string; tz: string }>(
    `SELECT id, name, tz FROM branch`,
  );
  const branchByName = new Map(branches.rows.map((b) => [b.name, b]));

  const doctors = await c.query<{ id: string; email: string }>(
    `SELECT id, email FROM doctor`,
  );
  const doctorByEmail = new Map(doctors.rows.map((d) => [d.email, d.id]));

  const types = await c.query<{ id: string; name: string }>(
    `SELECT id, name FROM appointment_type`,
  );
  const typeByName = new Map(types.rows.map((t) => [t.name, t.id]));

  // Clear the demo window before inserting, so re-running the seed
  // replaces the demo set instead of stacking duplicates.
  //
  // Two things are removed:
  //
  //   1. Rows this seed owns, matched by their `created_by` token. The
  //      token is a constrained encoding, not free-form text: the `@`
  //      in a staff email is escaped to `.40`, so the stored value is
  //      `staff:reception.40clinic.com`.
  //   2. Any other Scheduled row that falls inside the demo window on
  //      a demo branch. The baseline/rich seeds and stray API traffic
  //      also book into the current week; without this, the `appointment
  //      _no_overlap` exclusion constraint rejects the demo rows and
  //      the whole seed rolls back.
  const ownedActors = [
    ...ACCOUNTS.map((a) => staffCreatedBy(a.to)),
    ...PATIENTS.map((p) => patientCreatedBy(p.phone)),
  ];
  const demoBranchIds = [...branchByName.values()].map((b) => b.id);

  // `appointment_audit` is append-only by trigger, and its FK to
  // `appointment` is `ON DELETE NO ACTION` — so an appointment that has
  // audit rows cannot be deleted at all. The demo seed needs to remove
  // the appointments it is replacing, so it lifts the guard for the
  // duration of the transaction and restores it before COMMIT. The
  // ALTER is transactional: a rollback leaves the trigger enabled.
  await c.query(
    `ALTER TABLE appointment_audit DISABLE TRIGGER trg_appointment_audit_no_delete`,
  );

  // The window runs to +14 days so it covers the demo's out-of-hours
  // rows, which land on the next and the one-after SUNDAY — up to 13
  // days out, past the old +8 cutoff. Without the widening, a re-run
  // would leave the second Sunday's rows in place and the
  // `appointment_no_overlap` exclusion constraint would then reject
  // the fresh insert.
  const doomed = await c.query<{ id: string }>(
    `SELECT id FROM appointment
      WHERE created_by = ANY($1::text[])
         OR (
              status = 'Scheduled'
          AND branch_id = ANY($2::uuid[])
          AND start_datetime <  (CURRENT_DATE + 15)::date AT TIME ZONE 'UTC'
          AND end_datetime   > ((CURRENT_DATE - 1)::date AT TIME ZONE 'UTC')
         )`,
    [ownedActors, demoBranchIds],
  );

  if (doomed.rowCount && doomed.rowCount > 0) {
    const ids = doomed.rows.map((r) => r.id);
    await c.query(`DELETE FROM appointment_audit WHERE appointment_id = ANY($1::uuid[])`, [ids]);
    await c.query(`DELETE FROM appointment WHERE id = ANY($1::uuid[])`, [ids]);
  }

  await c.query(
    `ALTER TABLE appointment_audit ENABLE TRIGGER trg_appointment_audit_no_delete`,
  );

  let inserted = 0;
  for (const appt of APPOINTMENTS) {
    const branch = branchByName.get(appt.branchName);
    if (!branch) {
      throw new Error(`demo-seed: unknown branch "${appt.branchName}"`);
    }
    const doctorId = doctorByEmail.get(appt.doctorEmail);
    if (!doctorId) {
      throw new Error(`demo-seed: unknown doctor "${appt.doctorEmail}"`);
    }
    const typeId = typeByName.get(appt.typeName);
    if (!typeId) {
      throw new Error(`demo-seed: unknown appointment type "${appt.typeName}"`);
    }

    // Build the start instant in the BRANCH's timezone, then convert
    // to UTC. `AT TIME ZONE <zone>` on a local wall-clock timestamp
    // performs exactly that conversion: it reads the naive timestamp
    // as local time in the named zone and yields the UTC instant.
    //
    // An `outsideHours` row lands on a SUNDAY instead of a plain day
    // offset: `CURRENT_DATE + n weeks` lands on the same weekday as
    // today, so the n-th Sunday is computed as
    //   CURRENT_DATE + ((7 - dow(today)) % 7) days  +  n weeks
    // with `dow(today)` in Postgres' 0=Sunday convention. That makes
    // the demo's affected rows land on a real Sunday whatever day the
    // seed is run on, instead of depending on a hardcoded offset.
    //
    // Both variants reference ALL FOUR parameters, so Postgres can
    // infer every type in either branch. (A variant that left a
    // parameter unreferenced would fail with "could not determine
    // data type of parameter $n".) The mapping is:
    //   $1 = day offset (days, or whole weeks for the Sunday case)
    //   $2 = extra day offset (always 0 here, kept for shape parity)
    //   $3 = hour of day
    //   $4 = branch timezone
    const startSql = appt.outsideHours
      ? `
        (((CURRENT_DATE + ((7 - EXTRACT(dow FROM CURRENT_DATE)::int) % 7)::int)::date
            + $1::int * 7 * interval '1 day'
            + $2::int * interval '1 day')
          + $3::int * interval '1 hour') AT TIME ZONE $4::text`
      : `
        (((CURRENT_DATE + $1::int)::date + $2::int * interval '1 day')
          + $3::int * interval '1 hour') AT TIME ZONE $4::text`;
    const start = await c.query<{ start: Date }>(
      `SELECT ${startSql} AS start`,
      [appt.day, 0, appt.hour, branch.tz],
    );
    const startDate = start.rows[0]!.start;

    const end = new Date(
      startDate.getTime() + appt.durationMin * 60 * 1000,
    );

    try {
      await c.query(
        `INSERT INTO appointment (
           clinic_id, branch_id, doctor_id, patient_phone,
           appointment_type_id, start_datetime, end_datetime,
           status, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          clinicId,
          branch.id,
          doctorId,
          appt.patient,
          typeId,
          startDate,
          end,
          appt.status,
          appt.actorKind === 'staff'
            ? staffCreatedBy(appt.actor)
            : patientCreatedBy(appt.actor),
        ],
      );
      inserted++;
    } catch (err) {
      // The schema has an exclusion constraint preventing overlapping
      // Scheduled appointments for the same doctor+branch. A demo row
      // that violates it is a seed bug — fail loudly rather than
      // silently dropping it.
      throw new Error(
        `demo-seed: could not insert appointment for ${appt.patient} at day=${appt.day} hour=${appt.hour}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(`demo-seed: ${inserted} appointments inserted`);
}

async function main(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await setDemoCredentials(c);
    await seedPatients(c);
    await seedAppointments(c);
    await c.query('COMMIT');
    console.log('\ndemo-seed: done');
    console.log('  admin        admin@clinic.com');
    console.log('  doctor       doctor@clinic.com');
    console.log('  receptionist reception@clinic.com');
    console.log(`  password     ${DEMO_PASSWORD}`);
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
    await closePool();
  }
}

main().catch(async (err) => {
  console.error('demo-seed: fatal', err);
  await closePool();
  process.exit(1);
});
