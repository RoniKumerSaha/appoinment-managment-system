/**
 * E0-S5 — 02_role_ids.ts
 *
 * Single source of truth for the canonical role fixture identifiers used by
 * the seed (`db/seeds/01_minimum.ts`) and every JSON fixture file under
 * `apps/api/test/fixtures/`. Every value is a literal `as const` so a broken
 * drift between the seed and a fixture file fails at the import step, not
 * deep in a SQL assertion.
 *
 * These IDs are NOT the database primary keys — they are deterministic,
 * human-readable keys (`'clinic-main'`, `'branch-east'`, etc.) that the
 * fixture JSON files reference and the seed uses to lookup its own rows.
 * The DB primary keys are still `gen_random_uuid()` — see `seedWith()` in
 * `01_minimum.ts` for the actual SELECT-then-INSERT logic.
 *
 * Phone numbers follow the `+1555…` test range per `sms-otp.test.ts`
 * convention (E0-S4).
 */

export const CLINIC_ID = 'clinic-main' as const;
export const BRANCH_EAST_ID = 'branch-east' as const;
export const BRANCH_WEST_ID = 'branch-west' as const;
export const DOCTOR_EAST_LEAD_ID = 'doctor-east-lead' as const;
export const DOCTOR_EAST_SUPPORT_ID = 'doctor-east-support' as const;
export const DOCTOR_WEST_LEAD_ID = 'doctor-west-lead' as const;
export const APPOINTMENT_TYPE_GENERAL_ID = 'appointment-type-general' as const;
export const APPOINTMENT_TYPE_FOLLOWUP_ID = 'appointment-type-followup' as const;
export const APPOINTMENT_TYPE_CONSULT_ID = 'appointment-type-consult' as const;
export const RECEPTIONIST_EAST_ID = 'receptionist-east' as const;
export const RECEPTIONIST_WEST_ID = 'receptionist-west' as const;
export const ADMIN_MAIN_ID = 'admin-main' as const;
export const PATIENT_0001_PHONE = '+15550000001' as const;
export const PATIENT_0002_PHONE = '+15550000002' as const;
export const PATIENT_0003_PHONE = '+15550000003' as const;
export const PATIENT_0004_PHONE = '+15550000004' as const;
export const PATIENT_0005_PHONE = '+15550000005' as const;

export const ALL_DOCTOR_IDS = [
  DOCTOR_EAST_LEAD_ID,
  DOCTOR_EAST_SUPPORT_ID,
  DOCTOR_WEST_LEAD_ID,
] as const;

export const ALL_PATIENT_PHONES = [
  PATIENT_0001_PHONE,
  PATIENT_0002_PHONE,
  PATIENT_0003_PHONE,
  PATIENT_0004_PHONE,
  PATIENT_0005_PHONE,
] as const;
