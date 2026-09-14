/**
 * E0-S5 — minimum seed, widened to the PRD §14 MVP fixture set.
 *
 * Provisions:
 *   - 1 clinic
 *   - 2 branches in distinct IANA time zones (East: America/New_York,
 *     West: America/Los_Angeles)
 *   - 3 doctors (east.lead, east.support, west.lead)
 *   - 3 doctor_branch rows (east.lead → branch-east; east.support → branch-east;
 *     west.lead → branch-west)
 *   - 3 appointment_types (general, followup, consult)
 *   - 2 receptionists (one per branch)
 *   - 1 admin
 *   - 5 patients (phones +15550000001..5, matching the existing
 *     `sms-otp.test.ts` convention)
 *   - 1 future appointment for patient +15550000001 with doctor east.lead
 *     at branch-east (status='Scheduled', starts 7 days from now)
 *
 * Idempotency:
 *   - SELECT-then-INSERT for entities that lack a UNIQUE constraint
 *     (`clinic`, `branch`, `doctor`, `appointment_type`).
 *   - `ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS` for entities that have
 *     one (`doctor_branch` composite PK, `receptionist.email`, `admin_user.email`,
 *     `patient.phone_number`).
 *   - The future `appointment` is a SELECT-then-INSERT (no natural UNIQUE on
 *     `(patient_phone, doctor_id, status='Scheduled')` covers the same slot
 *     twice; we key off the deterministic patient + doctor + start window).
 *
 * The `seedWith(client)` signature is stable — both the production CLI
 * (`pnpm db:seed`) and the test (`seed.test.ts`) call this with their own
 * client. The return value is `SeedResult` so `seed()` (the CLI entry point)
 * can decide whether to log `seed_complete` or `seed_unchanged`; tests that
 * don't read the return are unaffected.
 */
import type { PoolClient } from 'pg';
import { getPool, closePool } from '../../src/db/pool.js';
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
  PATIENT_0001_PHONE,
  PATIENT_0002_PHONE,
  PATIENT_0003_PHONE,
  PATIENT_0004_PHONE,
  PATIENT_0005_PHONE,
} from './02_role_ids.js';

export interface SeedResult {
  /** True iff at least one row was inserted by this run. */
  inserted: boolean;
  /** Total rows touched by the seed (informational). */
  rowCount: number;
}

const CLINIC_NAME = 'Test Clinic';
const BRANCH_EAST_NAME = 'East Branch';
const BRANCH_WEST_NAME = 'West Branch';
const BRANCH_EAST_TZ = 'America/New_York';
const BRANCH_WEST_TZ = 'America/Los_Angeles';
const DOCTOR_EAST_LEAD_NAME = 'Dr. East Lead';
const DOCTOR_EAST_SUPPORT_NAME = 'Dr. East Support';
const DOCTOR_WEST_LEAD_NAME = 'Dr. West Lead';
const APPOINTMENT_TYPE_GENERAL_NAME = 'General Consultation';
const APPOINTMENT_TYPE_FOLLOWUP_NAME = 'Follow-up';
const APPOINTMENT_TYPE_CONSULT_NAME = 'Specialist Consult';
const APPOINTMENT_TYPE_GENERAL_DURATION = 30;
const APPOINTMENT_TYPE_FOLLOWUP_DURATION = 15;
const APPOINTMENT_TYPE_CONSULT_DURATION = 45;
const RECEPTIONIST_EAST_NAME = 'Receptionist East';
const RECEPTIONIST_WEST_NAME = 'Receptionist West';
const RECEPTIONIST_EAST_EMAIL = 'receptionist-east@clinic.local';
const RECEPTIONIST_WEST_EMAIL = 'receptionist-west@clinic.local';
const ADMIN_MAIN_NAME = 'Admin Main';
const ADMIN_MAIN_EMAIL = 'admin-main@clinic.local';

interface SeededIds {
  clinicId: string;
  branchEastId: string;
  branchWestId: string;
  doctorEastLeadId: string;
  doctorEastSupportId: string;
  doctorWestLeadId: string;
  appointmentTypeGeneralId: string;
  appointmentTypeFollowupId: string;
  appointmentTypeConsultId: string;
  receptionistEastId: string;
  receptionistWestId: string;
  adminMainId: string;
  patientPhone1: string;
  patientPhone2: string;
  patientPhone3: string;
  patientPhone4: string;
  patientPhone5: string;
}

/**
 * Apply the E0-S5 minimum seed against an open transaction on `client`.
 *
 * The caller owns the transaction lifecycle: BEGIN before, COMMIT or
 * ROLLBACK after. The seed routine only issues INSERT/SELECT statements;
 * it does NOT call `client.query('BEGIN' | 'COMMIT' | 'ROLLBACK')` itself.
 *
 * Returns `SeedResult` so the CLI entry point (`seed()`) can pick between
 * `seed_complete` and `seed_unchanged`. Test callers ignore the return.
 */
export async function seedWith(client: PoolClient): Promise<SeedResult> {
  let inserted = false;

  // ===== Clinic =====
  // No UNIQUE on `clinic.name` — SELECT-then-INSERT.
  const clinicRes = await client.query<{ id: string }>(
    `SELECT id FROM clinic WHERE name = $1`,
    [CLINIC_NAME],
  );
  let clinicId: string;
  if (clinicRes.rows[0]) {
    clinicId = clinicRes.rows[0].id;
  } else {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO clinic (name) VALUES ($1) RETURNING id`,
      [CLINIC_NAME],
    );
    clinicId = ins.rows[0]!.id;
    inserted = true;
  }

  // ===== Branches (2) =====
  // No UNIQUE on `(clinic_id, name)` — SELECT-then-INSERT.
  const branches = [
    { name: BRANCH_EAST_NAME, tz: BRANCH_EAST_TZ, roleId: BRANCH_EAST_ID },
    { name: BRANCH_WEST_NAME, tz: BRANCH_WEST_TZ, roleId: BRANCH_WEST_ID },
  ] as const;

  const branchIds: Record<string, string> = {};
  for (const b of branches) {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM branch WHERE clinic_id = $1 AND name = $2`,
      [clinicId, b.name],
    );
    if (res.rows[0]) {
      branchIds[b.roleId] = res.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO branch (clinic_id, name, tz) VALUES ($1, $2, $3) RETURNING id`,
        [clinicId, b.name, b.tz],
      );
      branchIds[b.roleId] = ins.rows[0]!.id;
      inserted = true;
    }
  }

  // ===== Doctors (3) =====
  // No UNIQUE on `full_name` — SELECT-then-INSERT.
  const doctors = [
    { name: DOCTOR_EAST_LEAD_NAME, roleId: DOCTOR_EAST_LEAD_ID },
    { name: DOCTOR_EAST_SUPPORT_NAME, roleId: DOCTOR_EAST_SUPPORT_ID },
    { name: DOCTOR_WEST_LEAD_NAME, roleId: DOCTOR_WEST_LEAD_ID },
  ] as const;

  const doctorIds: Record<string, string> = {};
  for (const d of doctors) {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM doctor WHERE full_name = $1`,
      [d.name],
    );
    if (res.rows[0]) {
      doctorIds[d.roleId] = res.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO doctor (full_name) VALUES ($1) RETURNING id`,
        [d.name],
      );
      doctorIds[d.roleId] = ins.rows[0]!.id;
      inserted = true;
    }
  }

  // ===== doctor_branch =====
  // Composite PK (doctor_id, branch_id) is a unique constraint — ON CONFLICT
  // DO NOTHING is genuine idempotency.
  const doctorBranchPairs: Array<[string, string]> = [
    [DOCTOR_EAST_LEAD_ID, BRANCH_EAST_ID],
    [DOCTOR_EAST_SUPPORT_ID, BRANCH_EAST_ID],
    [DOCTOR_WEST_LEAD_ID, BRANCH_WEST_ID],
  ];
  for (const [docRole, brRole] of doctorBranchPairs) {
    const r = await client.query(
      `INSERT INTO doctor_branch (doctor_id, branch_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [doctorIds[docRole]!, branchIds[brRole]!],
    );
    if ((r.rowCount ?? 0) > 0) inserted = true;
  }

  // ===== Appointment types (3) =====
  // No UNIQUE on (clinic_id, name) — SELECT-then-INSERT.
  const appointmentTypes = [
    {
      name: APPOINTMENT_TYPE_GENERAL_NAME,
      duration: APPOINTMENT_TYPE_GENERAL_DURATION,
      roleId: APPOINTMENT_TYPE_GENERAL_ID,
    },
    {
      name: APPOINTMENT_TYPE_FOLLOWUP_NAME,
      duration: APPOINTMENT_TYPE_FOLLOWUP_DURATION,
      roleId: APPOINTMENT_TYPE_FOLLOWUP_ID,
    },
    {
      name: APPOINTMENT_TYPE_CONSULT_NAME,
      duration: APPOINTMENT_TYPE_CONSULT_DURATION,
      roleId: APPOINTMENT_TYPE_CONSULT_ID,
    },
  ] as const;

  const appointmentTypeIds: Record<string, string> = {};
  for (const at of appointmentTypes) {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM appointment_type WHERE clinic_id = $1 AND name = $2`,
      [clinicId, at.name],
    );
    if (res.rows[0]) {
      appointmentTypeIds[at.roleId] = res.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO appointment_type (clinic_id, name, duration_minutes, is_active, created_by)
         VALUES ($1, $2, $3, true, $4)
         RETURNING id`,
        [clinicId, at.name, at.duration, `staff:${ADMIN_MAIN_ID}`],
      );
      appointmentTypeIds[at.roleId] = ins.rows[0]!.id;
      inserted = true;
    }
  }

  // ===== Receptionists (2) =====
  // `email` is UNIQUE (citext). Use WHERE NOT EXISTS so a duplicate insert
  // is a no-op rather than a citext unique violation.
  const receptionists = [
    {
      roleId: RECEPTIONIST_EAST_ID,
      branchRoleId: BRANCH_EAST_ID,
      name: RECEPTIONIST_EAST_NAME,
      email: RECEPTIONIST_EAST_EMAIL,
    },
    {
      roleId: RECEPTIONIST_WEST_ID,
      branchRoleId: BRANCH_WEST_ID,
      name: RECEPTIONIST_WEST_NAME,
      email: RECEPTIONIST_WEST_EMAIL,
    },
  ] as const;

  const receptionistIds: Record<string, string> = {};
  for (const r of receptionists) {
    const lookup = await client.query<{ id: string }>(
      `SELECT id FROM receptionist WHERE email = $1`,
      [r.email],
    );
    if (lookup.rows[0]) {
      receptionistIds[r.roleId] = lookup.rows[0].id;
      continue;
    }
    const ins = await client.query<{ id: string }>(
      `INSERT INTO receptionist (branch_id, full_name, email) VALUES ($1, $2, $3)
       RETURNING id`,
      [branchIds[r.branchRoleId]!, r.name, r.email],
    );
    receptionistIds[r.roleId] = ins.rows[0]!.id;
    inserted = true;
  }

  // ===== Admin (1) =====
  // Post-migration 0013 (E1-S0a), admin_user.clinic_id is NOT NULL with
  // a FK to clinic(id) and the `clinic` table carries a partial unique
  // singleton index. The seed's admin row is anchored to the singleton
  // clinic created above; this matches the migration's backfill UPDATE
  // and keeps the seed runnable both pre-migration (NULL is allowed) and
  // post-migration (NOT NULL requires a value). The seed reuses the
  // already-inserted clinicId rather than a fresh lookup; the singleton
  // invariant already made sure there's only one clinic in the table.
  const adminLookup = await client.query<{ id: string }>(
    `SELECT id FROM admin_user WHERE email = $1`,
    [ADMIN_MAIN_EMAIL],
  );
  let adminId: string;
  if (adminLookup.rows[0]) {
    adminId = adminLookup.rows[0].id;
  } else {
    const adminIns = await client.query<{ id: string }>(
      `INSERT INTO admin_user (full_name, email, clinic_id) VALUES ($1, $2, $3) RETURNING id`,
      [ADMIN_MAIN_NAME, ADMIN_MAIN_EMAIL, clinicId],
    );
    adminId = adminIns.rows[0]!.id;
    inserted = true;
  }

  // ===== Patients (5) =====
  // `patient.phone_number` is UNIQUE — ON CONFLICT DO NOTHING is genuine.
  const patients: Array<{
    rolePhone: string;
    fullName: string;
  }> = [
    { rolePhone: PATIENT_0001_PHONE, fullName: 'Patient One' },
    { rolePhone: PATIENT_0002_PHONE, fullName: 'Patient Two' },
    { rolePhone: PATIENT_0003_PHONE, fullName: 'Patient Three' },
    { rolePhone: PATIENT_0004_PHONE, fullName: 'Patient Four' },
    { rolePhone: PATIENT_0005_PHONE, fullName: 'Patient Five' },
  ];

  const patientIds: Record<string, string> = {};
  for (const p of patients) {
    const lookup = await client.query<{ id: string }>(
      `SELECT id FROM patient WHERE phone_number = $1`,
      [p.rolePhone],
    );
    if (lookup.rows[0]) {
      patientIds[p.rolePhone] = lookup.rows[0].id;
      continue;
    }
    const ins = await client.query<{ id: string }>(
      `INSERT INTO patient (phone_number, full_name) VALUES ($1, $2) RETURNING id`,
      [p.rolePhone, p.fullName],
    );
    patientIds[p.rolePhone] = ins.rows[0]!.id;
    inserted = true;
  }

  // ===== Future appointment on patient 0001 =====
  // SELECT-then-INSERT: check for an existing Scheduled row keyed by
  // (patient_phone, doctor_id, start_datetime). If none, insert.
  // Partial unique idx_appointment_patient_doctor_scheduled covers
  // (patient_phone, doctor_id) WHERE status='Scheduled' so a duplicate
  // insert of the same (patient, doctor) Scheduled row would also fail at
  // the constraint layer. The deterministic start window makes this
  // idempotent.
  const existingFutureAppt = await client.query<{ id: string }>(
    `SELECT id FROM appointment
     WHERE patient_phone = $1
       AND doctor_id = $2
       AND branch_id = $3
       AND status = 'Scheduled'
     LIMIT 1`,
    [
      PATIENT_0001_PHONE,
      doctorIds[DOCTOR_EAST_LEAD_ID]!,
      branchIds[BRANCH_EAST_ID]!,
    ],
  );

  if (!existingFutureAppt.rows[0]) {
    // app_now() + 7 days for `start_datetime`, +30 minutes for `end_datetime`.
    // The created_by matches the patient phone (E0-S2 CHECK accepts
    // `patient:<phone>` form per the regex `^(staff|patient):[A-Za-z0-9+_.-]{1,255}$`).
    const apptRes = await client.query(
      `INSERT INTO appointment
         (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
          start_datetime, end_datetime, status, created_by)
       VALUES
         ($1, $2, $3, $4, $5,
          app_now() + INTERVAL '7 days',
          app_now() + INTERVAL '7 days' + INTERVAL '30 minutes',
          'Scheduled',
          $6)`,
      [
        clinicId,
        branchIds[BRANCH_EAST_ID]!,
        doctorIds[DOCTOR_EAST_LEAD_ID]!,
        PATIENT_0001_PHONE,
        appointmentTypeIds[APPOINTMENT_TYPE_GENERAL_ID]!,
        `patient:${PATIENT_0001_PHONE}`,
      ],
    );
    if ((apptRes.rowCount ?? 0) > 0) inserted = true;
  }

  // Sanity: capture all IDs into one struct so tests that want to import the
  // mapping (via a future helper) can. Currently unused externally — kept
  // as an internal anchor.
  const _ids: SeededIds = {
    clinicId,
    branchEastId: branchIds[BRANCH_EAST_ID]!,
    branchWestId: branchIds[BRANCH_WEST_ID]!,
    doctorEastLeadId: doctorIds[DOCTOR_EAST_LEAD_ID]!,
    doctorEastSupportId: doctorIds[DOCTOR_EAST_SUPPORT_ID]!,
    doctorWestLeadId: doctorIds[DOCTOR_WEST_LEAD_ID]!,
    appointmentTypeGeneralId: appointmentTypeIds[APPOINTMENT_TYPE_GENERAL_ID]!,
    appointmentTypeFollowupId: appointmentTypeIds[APPOINTMENT_TYPE_FOLLOWUP_ID]!,
    appointmentTypeConsultId: appointmentTypeIds[APPOINTMENT_TYPE_CONSULT_ID]!,
    receptionistEastId: receptionistIds[RECEPTIONIST_EAST_ID]!,
    receptionistWestId: receptionistIds[RECEPTIONIST_WEST_ID]!,
    adminMainId: adminId,
    patientPhone1: PATIENT_0001_PHONE,
    patientPhone2: PATIENT_0002_PHONE,
    patientPhone3: PATIENT_0003_PHONE,
    patientPhone4: PATIENT_0004_PHONE,
    patientPhone5: PATIENT_0005_PHONE,
  };
  void _ids;

  // Return an informational rowCount so the CLI can pick a log line.
  const total = await client.query<{ n: number }>(
    `SELECT
      (SELECT count(*) FROM clinic)
      + (SELECT count(*) FROM branch)
      + (SELECT count(*) FROM doctor)
      + (SELECT count(*) FROM doctor_branch)
      + (SELECT count(*) FROM appointment_type)
      + (SELECT count(*) FROM receptionist)
      + (SELECT count(*) FROM admin_user)
      + (SELECT count(*) FROM patient)
      + (SELECT count(*) FROM appointment) AS n`,
  );

  return {
    inserted,
    rowCount: total.rows[0]?.n ?? 0,
  };
}

/**
 * Build the single-line structured log entry emitted by the CLI `seed()`
 * after a successful COMMIT. Pure function (no I/O, no clock) — split out
 * from `seed()` so tests can pin the contract without standing up a pool.
 *
 * Format: a single JSON object `{event, rowCount}`. The `event` field is
 * `seed_complete` on a fresh insert, `seed_unchanged` on the idempotent
 * no-op path. The AC-2 contract requires the second-run log to be
 * `seed_unchanged`, not `seed_complete`.
 *
 * P2: previously the CLI emitted `console.log(event, JSON.stringify({...}))`,
 * which two log shippers index as two events. Wrapping both fields in a
 * single JSON object fixes that.
 */
export function formatSeedLog(result: SeedResult): string {
  return JSON.stringify({
    event: result.inserted ? 'seed_complete' : 'seed_unchanged',
    rowCount: result.rowCount,
  });
}

/**
 * Production entry point: open a pool, run `seedWith` inside a transaction,
 * close the pool. CLI usage: `pnpm db:seed`.
 *
 * Logs `seed_complete` when the seed inserted at least one row, or
 * `seed_unchanged` when every entity already existed (idempotent re-run).
 * The second-run path is critical: the spec matrix requires a non-duplicate
 * log line on the no-op path so tests can assert the contract.
 */
export async function seed(): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await seedWith(client);
    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log(formatSeedLog(result));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('01_minimum.ts');

if (invokedDirectly) {
  seed()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('seed_failed', err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
