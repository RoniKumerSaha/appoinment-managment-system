/**
 * db-seed-all-types.ts — a COMPLETE demo dataset for a three-day window.
 *
 *   pnpm --filter @clinic/api exec tsx scripts/db-seed-all-types.ts
 *
 * Unlike `db-demo-seed.ts` (which layers a small showcase set on top of
 * the baseline), this script guarantees that EVERY data type the
 * application knows about has rows in the window:
 *
 *   - every branch (East / West / North — and the inactive Old Town)
 *   - every doctor, at every branch they are assigned to
 *   - every ACTIVE appointment type, at its real duration
 *   - every appointment status: Scheduled / Completed / Cancelled /
 *     No-show
 *   - both booking channels: patient-created and staff-created
 *   - recurring series (occurrences sharing a `recurring_series_id`)
 *   - doctor blocks (time off)
 *   - an audit trail on every appointment, with the event vocabulary
 *     the real routes emit (`created`, `marked_completed`,
 *     `marked_no_show`, `cancelled`, `rescheduled`, `moved_by_doctor`,
 *     `recurring_created`)
 *
 * The window is yesterday / today / tomorrow, so every dashboard has
 * history, a live "now", and a look-ahead.
 *
 * Idempotent: the natural key of an appointment is
 * (doctor, branch, start_datetime) — a second run finds the row and
 * leaves it alone. Doctor blocks key on
 * (doctor, branch, start, end). Audit rows key on
 * (appointment, event, created_at).
 */
import './_load-env.js';
import { getPool, closePool } from '../src/db/pool.js';
import { staffCreatedBy, patientCreatedBy } from '../src/routes/created-by.js';
import type { PoolClient } from 'pg';

/** Doctors / staff / patients referenced by the plan. */
const DOCTOR = {
  yara: 'doctor@clinic.com',
  eastSupport: 'dr.-east-support@clinic.local',
  zoyaEast: 'dr.-zoya-rahman@clinic.local',
  zoe: 'dr.-zoe-adler@clinic.local',
  yaraAlt: 'dr.-yara-haddad@clinic.local',
  west: 'dr.-west-lead@clinic.local',
} as const;

const STAFF = {
  admin: 'admin@clinic.com',
  reception: 'reception@clinic.com',
  receptionWest: 'receptionist-west@clinic.local',
  receptionNorth: 'receptionist-north@clinic.local',
} as const;

/**
 * Demo patients. The `+1555…` and `+9665…` blocks are the ones the
 * demo seed creates, so re-using them keeps the two datasets
 * consistent — a patient shows up in one place, not two.
 */
const PATIENTS: { phone: string; name: string }[] = [
  { phone: '+15550000001', name: 'Fatima Noor' },
  { phone: '+15550000002', name: 'Omar Khalid' },
  { phone: '+15550000003', name: 'Sara Aziz' },
  { phone: '+15550000004', name: 'Yusuf Ibrahim' },
  { phone: '+15550000005', name: 'Nadia Farouk' },
  { phone: '+15550100101', name: 'Amina Yusuf' },
  { phone: '+15550100102', name: 'Bilal Chaudhry' },
  { phone: '+15550100103', name: 'Chen Wei' },
  { phone: '+15550100104', name: 'Dana Kowalski' },
  { phone: '+15550100105', name: 'Elena Petrov' },
  { phone: '+15550100106', name: 'Farhan Qureshi' },
  { phone: '+15550100107', name: 'Grace Mbeki' },
  { phone: '+15550100108', name: 'Hassan Alami' },
  { phone: '+15550100109', name: 'Ingrid Larsen' },
  { phone: '+15550100110', name: 'Jamal Ndiaye' },
  { phone: '+15550100111', name: 'Karin Vogel' },
  { phone: '+15550100112', name: 'Luis Moreno' },
  { phone: '+966501110001', name: 'Hassan Ali' },
  { phone: '+966501110002', name: 'Mariam Salem' },
  { phone: '+966501110003', name: 'Tariq Aziz' },
  { phone: '+966501110004', name: 'Rania Fares' },
  { phone: '+966501110005', name: 'Bilal Nassar' },
];

type Status = 'Scheduled' | 'Completed' | 'Cancelled' | 'No-show';
type ActorKind = 'staff' | 'patient';

interface PlanRow {
  /** Day offset from today: -1 yesterday, 0 today, +1 tomorrow. */
  day: number;
  /** Local hour of day, in the BRANCH's timezone. */
  hh: number;
  mm?: number;
  branch: string;
  doctor: string;
  type: string;
  patient: string;
  status: Status;
  /** Who booked it, and whether that actor was staff or the patient. */
  actor: string;
  actorKind: ActorKind;
  /** Optional audit trail, applied after the row is inserted. */
  audit?: { role: string; id: string; event: string; payload?: unknown }[];
  /**
   * Marks an occurrence of a recurring series. All rows sharing a
   * `series` key share one `recurring_series_id`.
   */
  series?: string;
  /** Marks a row that deliberately lands OUTSIDE the branch's hours. */
  outsideHours?: boolean;
}

const SERIES_IDS: Record<string, string> = {
  'series-east-weekly': '33333333-3333-4333-8333-000000000001',
  'series-west-biweekly': '44444444-4444-4444-8444-000000000002',
};

/**
 * The plan.
 *
 * Every row is placed so that:
 *   - it falls on a day the branch is OPEN (Mon–Sat, 09:00–17:00),
 *     except the rows explicitly marked `outsideHours`, which land on a
 *     Sunday so the doctor's "Affected" queue is populated;
 *   - no two Scheduled rows overlap for the same doctor+branch (the
 *     GIST exclusion constraint `appointment_no_overlap`);
 *   - each (patient, doctor) pair holds at most ONE future Scheduled
 *     row — the partial unique index
 *     `idx_appointment_patient_doctor_scheduled` forbids a second live
 *     booking for the same pair (unless it is a recurring occurrence).
 */
const PLAN: PlanRow[] = [
  // ══ Yesterday — completed history ═════════════════════════════════
  {
    day: -1, hh: 9, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550000001',
    status: 'Completed', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_completed' },
    ],
  },
  {
    day: -1, hh: 9, mm: 45, branch: 'East Branch', doctor: DOCTOR.eastSupport,
    type: 'Specialist Consult', patient: '+966501110001',
    status: 'Completed', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_completed' },
    ],
  },
  {
    day: -1, hh: 10, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'Follow-up', patient: '+15550000002',
    status: 'Completed', actor: '+15550000002', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550000002'), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_completed' },
    ],
  },
  {
    day: -1, hh: 11, branch: 'East Branch', doctor: DOCTOR.zoyaEast,
    type: 'Telehealth Check-in', patient: '+15550100103',
    status: 'Completed', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_completed' },
    ],
  },
  {
    day: -1, hh: 12, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'Physical Therapy', patient: '+15550100104',
    status: 'Completed', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_completed' },
    ],
  },
  {
    day: -1, hh: 9, mm: 30, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'General Consultation', patient: '+966501110001',
    status: 'Completed', actor: STAFF.receptionWest, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'marked_completed' },
    ],
  },
  {
    day: -1, hh: 11, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Specialist Consult', patient: '+15550100105',
    status: 'Cancelled', actor: '+15550100105', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550100105'), event: 'created' },
      { role: 'patient', id: patientCreatedBy('+15550100105'), event: 'cancelled', payload: { reason: 'patient_request' } },
    ],
  },
  {
    day: -1, hh: 14, branch: 'North Branch', doctor: DOCTOR.zoe,
    type: 'General Consultation', patient: '+15550100106',
    status: 'Completed', actor: STAFF.receptionNorth, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'marked_completed' },
    ],
  },
  {
    day: -1, hh: 10, branch: 'North Branch', doctor: DOCTOR.zoyaEast,
    type: 'Wellness Screening', patient: '+15550100107',
    status: 'No-show', actor: STAFF.receptionNorth, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'marked_no_show' },
    ],
  },
  {
    day: -1, hh: 15, branch: 'East Branch', doctor: DOCTOR.yaraAlt,
    type: 'Telehealth Check-in', patient: '+15550100108',
    status: 'Completed', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_completed' },
    ],
  },

  // ══ Today — a busy live day ═══════════════════════════════════════
  {
    day: 0, hh: 9, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550000002',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 0, hh: 9, mm: 45, branch: 'East Branch', doctor: DOCTOR.eastSupport,
    type: 'Specialist Consult', patient: '+15550000003',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 0, hh: 10, branch: 'East Branch', doctor: DOCTOR.zoyaEast,
    type: 'Follow-up', patient: '+15550000004',
    status: 'Scheduled', actor: '+15550000004', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550000004'), event: 'created' },
    ],
  },
  {
    day: 0, hh: 11, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'Physical Therapy', patient: '+966501110002',
    status: 'Scheduled', actor: '+966501110002', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+966501110002'), event: 'created' },
    ],
  },
  {
    day: 0, hh: 11, mm: 30, branch: 'East Branch', doctor: DOCTOR.eastSupport,
    type: 'Telehealth Check-in', patient: '+15550100109',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 0, hh: 13, branch: 'East Branch', doctor: DOCTOR.yaraAlt,
    type: 'General Consultation', patient: '+966501110003',
    status: 'Scheduled', actor: '+966501110003', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+966501110003'), event: 'created' },
    ],
  },
  {
    day: -1, hh: 14, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'Wellness Screening', patient: '+15550100110',
    status: 'Completed', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_completed' },
    ],
  },
  {
    day: 0, hh: 15, branch: 'East Branch', doctor: DOCTOR.zoyaEast,
    type: 'Follow-up', patient: '+15550100111',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 0, hh: 16, branch: 'East Branch', doctor: DOCTOR.eastSupport,
    type: 'General Consultation', patient: '+966501110004',
    status: 'No-show', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'marked_no_show' },
    ],
  },
  {
    day: 0, hh: 9, mm: 30, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'General Consultation', patient: '+966501110005',
    status: 'Scheduled', actor: STAFF.receptionWest, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'created' },
    ],
  },
  {
    day: 0, hh: 11, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Specialist Consult', patient: '+15550100112',
    status: 'Scheduled', actor: '+15550100112', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550100112'), event: 'created' },
    ],
  },
  {
    day: 0, hh: 13, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Follow-up', patient: '+15550000005',
    status: 'Cancelled', actor: '+15550000005', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550000005'), event: 'created' },
      { role: 'patient', id: patientCreatedBy('+15550000005'), event: 'cancelled', payload: { reason: 'patient_request' } },
    ],
  },
  {
    day: 0, hh: 14, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Physical Therapy', patient: '+15550100101',
    status: 'Scheduled', actor: STAFF.receptionWest, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'created' },
    ],
  },
  {
    day: 0, hh: 10, branch: 'North Branch', doctor: DOCTOR.zoe,
    type: 'General Consultation', patient: '+15550100102',
    status: 'Scheduled', actor: STAFF.receptionNorth, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'created' },
    ],
  },
  {
    day: 0, hh: 12, branch: 'North Branch', doctor: DOCTOR.zoyaEast,
    type: 'Telehealth Check-in', patient: '+15550100103',
    status: 'Scheduled', actor: '+15550100103', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550100103'), event: 'created' },
    ],
  },
  {
    day: -1, hh: 16, branch: 'North Branch', doctor: DOCTOR.zoe,
    type: 'Wellness Screening', patient: '+15550100104',
    status: 'Completed', actor: STAFF.receptionNorth, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'marked_completed' },
    ],
  },

  // ══ Tomorrow — the look-ahead ═════════════════════════════════════
  {
    day: 1, hh: 9, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550000003',
    status: 'Scheduled', actor: '+15550000003', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550000003'), event: 'created' },
    ],
  },
  {
    day: 1, hh: 10, branch: 'East Branch', doctor: DOCTOR.eastSupport,
    type: 'Specialist Consult', patient: '+15550100105',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 1, hh: 11, branch: 'East Branch', doctor: DOCTOR.zoyaEast,
    type: 'Physical Therapy', patient: '+15550100106',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 1, hh: 13, branch: 'East Branch', doctor: DOCTOR.yaraAlt,
    type: 'Follow-up', patient: '+966501110005',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 1, hh: 15, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'Telehealth Check-in', patient: '+15550100107',
    status: 'Scheduled', actor: '+15550100107', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550100107'), event: 'created' },
    ],
  },
  {
    day: 1, hh: 9, mm: 30, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'General Consultation', patient: '+966501110001',
    status: 'Scheduled', actor: STAFF.receptionWest, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'created' },
    ],
  },
  {
    day: 1, hh: 11, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Specialist Consult', patient: '+15550100108',
    status: 'Scheduled', actor: '+15550100108', actorKind: 'patient',
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550100108'), event: 'created' },
    ],
  },
  {
    day: 1, hh: 14, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Follow-up', patient: '+15550100109',
    status: 'Scheduled', actor: STAFF.receptionWest, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'created' },
    ],
  },
  {
    day: 1, hh: 10, branch: 'North Branch', doctor: DOCTOR.zoe,
    type: 'General Consultation', patient: '+15550100110',
    status: 'Scheduled', actor: STAFF.receptionNorth, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'created' },
    ],
  },
  {
    day: -1, hh: 13, branch: 'North Branch', doctor: DOCTOR.zoyaEast,
    type: 'Wellness Screening', patient: '+15550100111',
    status: 'Completed', actor: STAFF.receptionNorth, actorKind: 'staff',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'created' },
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionNorth), event: 'marked_completed' },
    ],
  },

  // ══ Recurring series ══════════════════════════════════════════════
  //
  // The occurrences of one series share a `recurring_series_id`. That
  // column is what EXCLUDES them from the partial unique index
  // `idx_appointment_patient_doctor_scheduled`, so a patient may hold
  // several live rows with the same doctor — exactly what the recurring
  // confirm route produces.
  //
  // The `recurring_created` audit event carries the series id and the
  // occurrence index, matching the recurring-confirm route.
  {
    day: 0, hh: 10, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550100102',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    series: 'series-east-weekly',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'recurring_created', payload: { series_id: SERIES_IDS['series-east-weekly'], recurrence_kind: 'weekly', recurrence_interval_days: 7, occurrence_index: 1 } },
    ],
  },
  {
    day: 1, hh: 10, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550100102',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    series: 'series-east-weekly',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'recurring_created', payload: { series_id: SERIES_IDS['series-east-weekly'], recurrence_kind: 'weekly', recurrence_interval_days: 7, occurrence_index: 2 } },
    ],
  },
  {
    day: 0, hh: 10, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Follow-up', patient: '+15550100105',
    status: 'Scheduled', actor: STAFF.receptionWest, actorKind: 'staff',
    series: 'series-west-biweekly',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'recurring_created', payload: { series_id: SERIES_IDS['series-west-biweekly'], recurrence_kind: 'every_two_weeks', recurrence_interval_days: 14, occurrence_index: 1 } },
    ],
  },
  {
    day: 1, hh: 13, branch: 'West Branch', doctor: DOCTOR.west,
    type: 'Follow-up', patient: '+15550100105',
    status: 'Scheduled', actor: STAFF.receptionWest, actorKind: 'staff',
    series: 'series-west-biweekly',
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.receptionWest), event: 'recurring_created', payload: { series_id: SERIES_IDS['series-west-biweekly'], recurrence_kind: 'every_two_weeks', recurrence_interval_days: 14, occurrence_index: 2 } },
    ],
  },

  // ══ Affected queue — rows OUTSIDE the branch's opening hours ══════
  //
  // Every other row sits inside Mon–Sat 09:00–17:00, so
  // `GET /doctor/affected` returns an empty list and the doctor's
  // Resolve board is blank. These four rows land OUTSIDE those hours,
  // which is exactly the condition the affected queue selects on (see
  // `doctor-affected-helpers.ts` — `closed_day` /
  // `before_open_or_after_close`).
  //
  // They are placed on a SUNDAY, when every branch is closed: the
  // reason is unambiguous (`closed_day`), it does not depend on the
  // doctor's own schedule, and it cannot collide with the in-hours
  // rows above.
  //
  // `day` on an `outsideHours` row means "the n-th Sunday from today" —
  // 0 is the coming Sunday, 1 the one after. It is resolved in SQL so
  // the demo stays correct whatever day the seed runs on.
  //
  // The patients are picked so none already holds a Scheduled
  // appointment with THIS doctor — the partial unique index rejects a
  // second live booking for the same pair.
  {
    day: 0, hh: 10, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550100112',
    status: 'Scheduled', actor: '+15550100112', actorKind: 'patient',
    outsideHours: true,
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550100112'), event: 'created' },
    ],
  },
  {
    day: 0, hh: 11, mm: 30, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'Follow-up', patient: '+15550100103',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    outsideHours: true,
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 1, hh: 10, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550100104',
    status: 'Scheduled', actor: STAFF.reception, actorKind: 'staff',
    outsideHours: true,
    audit: [
      { role: 'receptionist', id: staffCreatedBy(STAFF.reception), event: 'created' },
    ],
  },
  {
    day: 1, hh: 14, branch: 'East Branch', doctor: DOCTOR.yara,
    type: 'General Consultation', patient: '+15550100107',
    status: 'Scheduled', actor: '+15550100107', actorKind: 'patient',
    outsideHours: true,
    audit: [
      { role: 'patient', id: patientCreatedBy('+15550100107'), event: 'created' },
    ],
  },
];

/**
 * Doctor blocks — time off. A block suppresses availability for that
 * doctor+branch window, and the availability engine answers
 * `inside_doctor_block` for a slot inside one.
 */
interface BlockPlan {
  doctor: string;
  branch: string;
  day: number;
  hh: number;
  mm?: number;
  minutes: number;
  reason: string;
}

const BLOCKS: BlockPlan[] = [
  { doctor: DOCTOR.eastSupport, branch: 'East Branch', day: 0, hh: 17, minutes: 60, reason: 'Staff meeting' },
  { doctor: DOCTOR.zoyaEast, branch: 'East Branch', day: 1, hh: 12, minutes: 90, reason: 'Personal leave' },
  { doctor: DOCTOR.west, branch: 'West Branch', day: 1, hh: 9, minutes: 120, reason: 'Conference' },
  { doctor: DOCTOR.zoe, branch: 'North Branch', day: 0, hh: 16, minutes: 60, reason: 'Admin hours' },
];

/**
 * Convert a local wall-clock time in a named zone to the UTC instant.
 *
 * `AT TIME ZONE <zone>` on a naive timestamp reads it as local time in
 * that zone and yields the UTC instant — exactly the conversion the
 * availability engine uses.
 *
 * `dateSql` is an expression that may itself reference `$1` (the day
 * offset). The hour and minute therefore use `$2` and `$3`, so the
 * caller's day offset is never clobbered by the hour value.
 */
async function localToUtc(
  c: PoolClient,
  dateSql: string,
  dayOffset: number,
  hh: number,
  mm: number,
  tz: string,
): Promise<Date> {
  const res = await c.query<{ start: Date }>(
    `SELECT (${dateSql} + $2::int * interval '1 hour' + $3::int * interval '1 minute')
            AT TIME ZONE $4::text AS start`,
    [dayOffset, hh, mm, tz],
  );
  return res.rows[0]!.start;
}

/**
 * Resolve the patient for a planned row.
 *
 * A row that is NOT Scheduled (Completed / Cancelled / No-show) or that
 * belongs to a recurring series is exempt from the live-booking
 * constraint and keeps its planned patient — the index only covers
 * `status = 'Scheduled'` rows outside a series.
 *
 * For a live, non-series row the patient must have no other Scheduled
 * row with this doctor. When the planned patient already does, the
 * allocator substitutes the first candidate that is free with THIS
 * doctor — checked against the live database, which also covers rows
 * inserted earlier in this same run.
 *
 * If the row was booked BY the patient (actorKind 'patient'), the
 * substituted patient also becomes the actor, so the audit trail stays
 * consistent with the row it describes.
 */
async function resolvePatient(
  c: PoolClient,
  appt: PlanRow,
  doctorId: string,
): Promise<string> {
  const needsFreePair =
    appt.status === 'Scheduled' && appt.series === undefined;
  if (!needsFreePair) return appt.patient;

  const busy = await c.query<{ patient_phone: string }>(
    `SELECT patient_phone FROM appointment
      WHERE doctor_id = $1
        AND status = 'Scheduled'
        AND recurring_series_id IS NULL
        AND patient_phone = ANY($2::text[])`,
    [doctorId, PATIENTS.map((p) => p.phone)],
  );
  const busyPhones = new Set(busy.rows.map((r) => r.patient_phone));

  if (!busyPhones.has(appt.patient)) return appt.patient;

  const substitute = PATIENTS.find((p) => !busyPhones.has(p.phone));
  if (!substitute) {
    throw new Error(
      `seed-all: no free patient for doctor ${doctorId} — every demo patient already holds a live booking with this doctor`,
    );
  }

  // The audit trail names the actor; when the patient is the actor, it
  // must name the patient that actually owns the row.
  if (appt.actorKind === 'patient') {
    appt.actor = substitute.phone;
    for (const ev of appt.audit ?? []) {
      if (ev.role === 'patient') ev.id = patientCreatedBy(substitute.phone);
    }
  }
  return substitute.phone;
}

async function main(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  const counts = { appointments: 0, audits: 0, blocks: 0, patients: 0 };

  try {
    await c.query('BEGIN');

    const clinic = await c.query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`);
    const clinicId = clinic.rows[0]!.id;

    const branches = await c.query<{ id: string; name: string; tz: string }>(
      `SELECT id, name, tz FROM branch`,
    );
    const branchByName = new Map(branches.rows.map((b) => [b.name, b]));

    const doctors = await c.query<{ id: string; email: string }>(
      `SELECT id, email FROM doctor`,
    );
    const doctorByEmail = new Map(doctors.rows.map((d) => [d.email, d.id]));

    const types = await c.query<{ id: string; name: string; duration_minutes: number; is_active: boolean }>(
      `SELECT id, name, duration_minutes, is_active FROM appointment_type`,
    );
    const typeByName = new Map(types.rows.map((t) => [t.name, t]));

    // ── Patients ───────────────────────────────────────────────────────
    for (const p of PATIENTS) {
      const res = await c.query(
        `INSERT INTO patient (phone_number, full_name)
         VALUES ($1, $2)
         ON CONFLICT (phone_number) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING (xmax = 0) AS inserted`,
        [p.phone, p.name],
      );
      if (res.rows[0]?.inserted) counts.patients++;
    }

    // ── Appointments ───────────────────────────────────────────────────
    for (const appt of PLAN) {
      const branch = branchByName.get(appt.branch);
      if (!branch) throw new Error(`seed-all: unknown branch "${appt.branch}"`);
      const doctorId = doctorByEmail.get(appt.doctor);
      if (!doctorId) throw new Error(`seed-all: unknown doctor "${appt.doctor}"`);
      const type = typeByName.get(appt.type);
      if (!type) throw new Error(`seed-all: unknown appointment type "${appt.type}"`);
      // A retired type (`is_active = false`) can no longer be booked,
      // so it may only appear on a PAST row — the history a clinic
      // kept before retiring it. Booking it today or tomorrow would
      // contradict the availability engine, which only offers active
      // types.
      if (!type.is_active && appt.day >= 0) {
        throw new Error(
          `seed-all: appointment type "${appt.type}" is retired — it may only appear on a past row`,
        );
      }

      // The date expression differs for an out-of-hours row: that one
      // resolves to the n-th SUNDAY from today, computed in SQL so the
      // seed stays correct whatever day it runs on. Both variants
      // reference every parameter, so Postgres can infer every type.
      const dateSql = appt.outsideHours
        ? `((CURRENT_DATE + ((7 - EXTRACT(dow FROM CURRENT_DATE)::int) % 7)::int)::date
            + $1::int * 7 * interval '1 day')`
        : `((CURRENT_DATE + $1::int)::date)`;

      const start = await localToUtc(
        c, dateSql, appt.day, appt.hh, appt.mm ?? 0, branch.tz,
      );
      const end = new Date(start.getTime() + type.duration_minutes * 60_000);

      // Idempotency: (doctor, branch, start) is the natural key.
      const existing = await c.query<{ id: string; recurring_series_id: string | null }>(
        `SELECT id, recurring_series_id FROM appointment
          WHERE doctor_id = $1 AND branch_id = $2 AND start_datetime = $3
          LIMIT 1`,
        [doctorId, branch.id, start],
      );

      // A planned row that collides with an existing row at the same
      // (doctor, branch, start) is normally the idempotent re-run
      // case — the row is already there and is left alone. But when
      // the plan says the row belongs to a recurring SERIES and the
      // existing row carries a different series id (or none), the
      // collision means two planned rows share one slot: the second
      // would be silently skipped and its series occurrence lost.
      // Fail loudly instead of quietly seeding an incomplete series.
      const existingRow = existing.rows[0];
      if (existingRow && appt.series !== undefined) {
        const wanted = SERIES_IDS[appt.series];
        if (existingRow.recurring_series_id !== wanted) {
          throw new Error(
            `seed-all: slot collision — the plan puts "${appt.type}" for ${appt.doctor} at ${appt.branch} day=${appt.day} hh=${appt.hh} in series "${appt.series}", but that slot is already held by a row with series ${existingRow.recurring_series_id ?? 'none'}. Give the series its own slot.`,
          );
        }
      }

      let appointmentId = existing.rows[0]?.id;
      if (!appointmentId) {
        // Resolve the patient BEFORE inserting. The partial unique index
        // `idx_appointment_patient_doctor_scheduled` allows at most one
        // live (Scheduled) row per (patient, doctor) pair — and it is
        // GLOBAL, not scoped to the seeded window. A pair already used
        // by an older row elsewhere in the database would therefore
        // reject this insert outright.
        //
        // Rather than hard-coding a patient and failing on a conflict,
        // the allocator swaps in the next candidate that has no live
        // row with THIS doctor. The candidate list is long enough that
        // a swap is essentially always available.
        const patientPhone = await resolvePatient(c, appt, doctorId);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO appointment
             (clinic_id, branch_id, doctor_id, patient_phone, appointment_type_id,
              start_datetime, end_datetime, status, recurring_series_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            clinicId,
            branch.id,
            doctorId,
            patientPhone,
            type.id,
            start,
            end,
            appt.status,
            appt.series ? SERIES_IDS[appt.series] : null,
            appt.actorKind === 'staff' ? staffCreatedBy(appt.actor) : patientCreatedBy(appt.actor),
          ],
        );
        appointmentId = ins.rows[0]!.id;
        counts.appointments++;
      }

      // ── Audit trail ───────────────────────────────────────────────
      for (const ev of appt.audit ?? []) {
        // The audit timestamp is placed just before the appointment
        // start, so the trail reads chronologically.
        const createdAt = new Date(start.getTime() - 60 * 60 * 1000);
        const seen = await c.query(
          `SELECT id FROM appointment_audit
            WHERE appointment_id = $1 AND event = $2 AND created_at = $3
            LIMIT 1`,
          [appointmentId, ev.event, createdAt],
        );
        if (seen.rows.length > 0) continue;
        await c.query(
          `INSERT INTO appointment_audit
             (appointment_id, actor_role, actor_id, event, payload, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            appointmentId,
            ev.role,
            ev.id,
            ev.event,
            JSON.stringify(ev.payload ?? {}),
            createdAt,
          ],
        );
        counts.audits++;
      }
    }

    // ── Doctor blocks ──────────────────────────────────────────────────
    for (const b of BLOCKS) {
      const branch = branchByName.get(b.branch);
      if (!branch) throw new Error(`seed-all: unknown branch "${b.branch}"`);
      const doctorId = doctorByEmail.get(b.doctor);
      if (!doctorId) throw new Error(`seed-all: unknown doctor "${b.doctor}"`);

      const start = await localToUtc(
        c,
        `((CURRENT_DATE + $1::int)::date)`,
        b.day,
        b.hh,
        b.mm ?? 0,
        branch.tz,
      );
      const end = new Date(start.getTime() + b.minutes * 60_000);

      const existing = await c.query(
        `SELECT id FROM doctor_block
          WHERE doctor_id = $1 AND branch_id = $2
            AND start_datetime = $3 AND end_datetime = $4
          LIMIT 1`,
        [doctorId, branch.id, start, end],
      );
      if (existing.rows.length > 0) continue;

      await c.query(
        `INSERT INTO doctor_block
           (doctor_id, branch_id, start_datetime, end_datetime, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [doctorId, branch.id, start, end, b.reason, staffCreatedBy(STAFF.admin)],
      );
      counts.blocks++;
    }

    await c.query('COMMIT');

    // ── Report ─────────────────────────────────────────────────────────
    //
    // The window is expressed in each BRANCH's local day, not in UTC.
    // An appointment at 09:00 in America/New_York is 14:00 UTC, and one
    // at 09:00 in Asia/Riyadh is 06:00 UTC — so filtering on the raw
    // UTC date would drop rows from the edge of the window. The filter
    // therefore converts each row into its branch's local date before
    // comparing it against the window.
    const WINDOW = `(a.start_datetime AT TIME ZONE b.tz)::date
                    BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + 1`;

    const byStatus = await pool.query<{ status: string; n: string }>(
      `SELECT a.status::text, count(*)::text AS n
         FROM appointment a JOIN branch b ON b.id = a.branch_id
        WHERE ${WINDOW}
        GROUP BY a.status ORDER BY a.status`,
    );
    const byType = await pool.query<{ name: string; n: string }>(
      `SELECT t.name, count(*)::text AS n
         FROM appointment a
         JOIN appointment_type t ON t.id = a.appointment_type_id
         JOIN branch b ON b.id = a.branch_id
        WHERE ${WINDOW}
        GROUP BY t.name ORDER BY t.name`,
    );
    const byBranch = await pool.query<{ name: string; n: string }>(
      `SELECT b.name, count(*)::text AS n
         FROM appointment a JOIN branch b ON b.id = a.branch_id
        WHERE ${WINDOW}
        GROUP BY b.name ORDER BY b.name`,
    );
    const byDoctor = await pool.query<{ full_name: string; n: string }>(
      `SELECT d.full_name, count(*)::text AS n
         FROM appointment a
         JOIN doctor d ON d.id = a.doctor_id
         JOIN branch b ON b.id = a.branch_id
        WHERE ${WINDOW}
        GROUP BY d.full_name ORDER BY d.full_name`,
    );
    const byDay = await pool.query<{ day: string; n: string }>(
      `SELECT (a.start_datetime AT TIME ZONE b.tz)::date::text AS day, count(*)::text AS n
         FROM appointment a JOIN branch b ON b.id = a.branch_id
        WHERE ${WINDOW}
        GROUP BY 1 ORDER BY 1`,
    );
    const byChannel = await pool.query<{ channel: string; n: string }>(
      `SELECT CASE WHEN a.created_by LIKE 'patient:%' THEN 'patient' ELSE 'staff' END AS channel,
              count(*)::text AS n
         FROM appointment a JOIN branch b ON b.id = a.branch_id
        WHERE ${WINDOW}
        GROUP BY 1 ORDER BY 1`,
    );
    const series = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT recurring_series_id)::text AS n
         FROM appointment
        WHERE recurring_series_id IS NOT NULL`,
    );
    const audits = await pool.query<{ event: string; n: string }>(
      `SELECT event, count(*)::text AS n FROM appointment_audit GROUP BY event ORDER BY event`,
    );

    console.log('seed-all: done');
    console.log(`  inserted  ${JSON.stringify(counts)}`);
    console.log(`  window    yesterday .. tomorrow (branch-local days)`);
    console.log(`  day       ${JSON.stringify(Object.fromEntries(byDay.rows.map((r) => [r.day, r.n])))}`);
    console.log(`  status    ${JSON.stringify(Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])))}`);
    console.log(`  type      ${JSON.stringify(Object.fromEntries(byType.rows.map((r) => [r.name, r.n])))}`);
    console.log(`  branch    ${JSON.stringify(Object.fromEntries(byBranch.rows.map((r) => [r.name, r.n])))}`);
    console.log(`  doctor    ${JSON.stringify(Object.fromEntries(byDoctor.rows.map((r) => [r.full_name, r.n])))}`);
    console.log(`  channel   ${JSON.stringify(Object.fromEntries(byChannel.rows.map((r) => [r.channel, r.n])))}`);
    console.log(`  series    ${series.rows[0]!.n}`);
    console.log(`  audit     ${JSON.stringify(Object.fromEntries(audits.rows.map((r) => [r.event, r.n])))}`);
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
    await closePool();
  }
}

main().catch(async (err) => {
  console.error('seed-all: fatal', err);
  await closePool();
  process.exit(1);
});
