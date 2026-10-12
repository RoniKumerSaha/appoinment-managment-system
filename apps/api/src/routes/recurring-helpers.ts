/**
 * recurring-helpers.ts — shared logic for the recurring routes.
 *
 * Per spec-6-1 (E6-S1) + PRD F-11 + BR-047…053 + FR-044…050.
 *
 * Exports:
 *   - validateRecurringBody: parses + validates the POST /recurring/preview
 *     body. The /recurring/confirm route looks up the snapshot by
 *     `preview_id`, so it does not re-validate from scratch.
 *   - expandOccurrences: pure function that derives the list of
 *     `(startMs, endMs)` candidate occurrences from a recurrence shape
 *     and the branch tz.
 *   - validateOccurrenceInTxn: per-occurrence validation pipeline
 *     (FR-046). Runs inside an open transaction.
 *   - previewStore: server-stateful preview-id → snapshot handle
 *     (an in-process Map keyed on uuid; sufficient for the spec's
 *     single-process dev/test target).
 *   - formatLocalDate: branch-tz-aware YYYY-MM-DD helper (also used
 *     by `recurring-preview` and `recurring-confirm`).
 *   - localDateToUtcMs: branch-tz-aware inverse — converts a
 *     (YYYY-MM-DD, HH:MM) tuple to a UTC ms epoch.
 *
 * SC2 documents a deliberate duplication of the in-txn slot-recheck
 * subset (`validateOccurrenceInTxn` here vs
 * `bookings.ts:recheckSlotInTxn`). The recurring pipeline answers a
 * one-slot question with a richer reason code, so the duplication is
 * contained and the tests pin the contract. A future cleanup story
 * could factor a shared `validateOneSlotInTxn(client, args)` helper.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  intersect,
  clampToDay,
} from '../availability/slots.js';
import {
  timeStringToMinutes,
  utcDayOfWeek,
} from '../availability/types.js';

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const E164_PHONE_RE = /^\+[1-9]\d{6,14}$/;

export type RecurrenceKind = 'weekly' | 'every_two_weeks' | 'custom_days';
export const RECURRENCE_KINDS: readonly RecurrenceKind[] = [
  'weekly',
  'every_two_weeks',
  'custom_days',
] as const;

const DURATION_MIN = 5;
const DURATION_MAX = 480;
const MAX_OCCURRENCES = 60;
const MAX_INTERVAL_DAYS = 60;

export interface RecurringBody {
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  patient_phone: string;
  patient_first_name: string | null;
  recurrence_kind: RecurrenceKind;
  recurrence_interval_days: number;
  start_date: string; // YYYY-MM-DD in branch tz
  time_of_day: string; // HH:MM in branch tz
  duration_minutes: number;
  occurrences_or_until_date: number;
}

export type RecurringValidationError =
  | 'unknown_field'
  | 'invalid_doctor_id'
  | 'invalid_branch_id'
  | 'invalid_appointment_type_id'
  | 'invalid_patient_phone'
  | 'invalid_patient_first_name'
  | 'invalid_recurrence_kind'
  | 'invalid_recurrence_interval_days'
  | 'invalid_start_date'
  | 'invalid_time_of_day'
  | 'invalid_duration_minutes'
  | 'invalid_occurrences_or_until_date';

export const ALLOWED_RECURRING_KEYS = new Set([
  'doctor_id',
  'branch_id',
  'appointment_type_id',
  'patient_phone',
  'patient_first_name',
  'recurrence_kind',
  'recurrence_interval_days',
  'start_date',
  'time_of_day',
  'duration_minutes',
  'occurrences_or_until_date',
]);

/** Returns the parsed body or the first validation error encountered. */
export function validateRecurringBody(
  body: unknown,
):
  | { ok: true; value: RecurringBody }
  | { ok: false; error: RecurringValidationError } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'unknown_field' };
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!ALLOWED_RECURRING_KEYS.has(k)) {
      return { ok: false, error: 'unknown_field' };
    }
  }

  if (typeof b['doctor_id'] !== 'string' || !UUID_RE.test(b['doctor_id'])) {
    return { ok: false, error: 'invalid_doctor_id' };
  }
  if (typeof b['branch_id'] !== 'string' || !UUID_RE.test(b['branch_id'])) {
    return { ok: false, error: 'invalid_branch_id' };
  }
  if (
    typeof b['appointment_type_id'] !== 'string' ||
    !UUID_RE.test(b['appointment_type_id'])
  ) {
    return { ok: false, error: 'invalid_appointment_type_id' };
  }
  if (
    typeof b['patient_phone'] !== 'string' ||
    !E164_PHONE_RE.test(b['patient_phone'])
  ) {
    return { ok: false, error: 'invalid_patient_phone' };
  }
  let patientFirstName: string | null = null;
  if (b['patient_first_name'] !== undefined && b['patient_first_name'] !== null) {
    if (typeof b['patient_first_name'] !== 'string') {
      return { ok: false, error: 'invalid_patient_first_name' };
    }
    if (b['patient_first_name'].length > 120) {
      return { ok: false, error: 'invalid_patient_first_name' };
    }
    patientFirstName = b['patient_first_name'];
  }
  if (
    typeof b['recurrence_kind'] !== 'string' ||
    !RECURRENCE_KINDS.includes(b['recurrence_kind'] as RecurrenceKind)
  ) {
    return { ok: false, error: 'invalid_recurrence_kind' };
  }
  const kind = b['recurrence_kind'] as RecurrenceKind;

  // recurrence_interval_days: sugar for weekly (7) and every_two_weeks
  // (14). For custom_days, the caller MUST supply an explicit value >= 1.
  let intervalDays: number;
  if (kind === 'weekly') {
    intervalDays = 7;
  } else if (kind === 'every_two_weeks') {
    intervalDays = 14;
  } else {
    if (typeof b['recurrence_interval_days'] !== 'number') {
      return { ok: false, error: 'invalid_recurrence_interval_days' };
    }
    if (
      !Number.isInteger(b['recurrence_interval_days']) ||
      (b['recurrence_interval_days'] as number) < 1 ||
      (b['recurrence_interval_days'] as number) > MAX_INTERVAL_DAYS
    ) {
      return { ok: false, error: 'invalid_recurrence_interval_days' };
    }
    intervalDays = b['recurrence_interval_days'] as number;
  }
  if (typeof b['start_date'] !== 'string' || !ISO_DATE_RE.test(b['start_date'])) {
    return { ok: false, error: 'invalid_start_date' };
  }
  if (typeof b['time_of_day'] !== 'string' || !TIME_OF_DAY_RE.test(b['time_of_day'])) {
    return { ok: false, error: 'invalid_time_of_day' };
  }
  if (typeof b['duration_minutes'] !== 'number') {
    return { ok: false, error: 'invalid_duration_minutes' };
  }
  if (
    !Number.isInteger(b['duration_minutes']) ||
    (b['duration_minutes'] as number) < DURATION_MIN ||
    (b['duration_minutes'] as number) > DURATION_MAX
  ) {
    return { ok: false, error: 'invalid_duration_minutes' };
  }
  if (typeof b['occurrences_or_until_date'] !== 'number') {
    return { ok: false, error: 'invalid_occurrences_or_until_date' };
  }
  if (
    !Number.isInteger(b['occurrences_or_until_date']) ||
    (b['occurrences_or_until_date'] as number) < 1 ||
    (b['occurrences_or_until_date'] as number) > MAX_OCCURRENCES
  ) {
    return { ok: false, error: 'invalid_occurrences_or_until_date' };
  }

  return {
    ok: true,
    value: {
      doctor_id: b['doctor_id'] as string,
      branch_id: b['branch_id'] as string,
      appointment_type_id: b['appointment_type_id'] as string,
      patient_phone: b['patient_phone'] as string,
      patient_first_name: patientFirstName,
      recurrence_kind: kind,
      recurrence_interval_days: intervalDays,
      start_date: b['start_date'] as string,
      time_of_day: b['time_of_day'] as string,
      duration_minutes: b['duration_minutes'] as number,
      occurrences_or_until_date: b['occurrences_or_until_date'] as number,
    },
  };
}

// ---------------------------------------------------------------------------
// Occurrence expansion (pure)
// ---------------------------------------------------------------------------

export interface Occurrence {
  /** 1-based index in the series. */
  index: number;
  /** UTC start of the slot (ms epoch). */
  startMs: number;
  /** UTC end of the slot (ms epoch). */
  endMs: number;
  /** YYYY-MM-DD in the branch tz. Echoed in the preview/confirm
   *  response so the UI can show "Wed 2026-10-08" without re-deriving
   *  the date in the client. */
  localDate: string;
}

/** Compute the candidate occurrence list from a parsed body and the
 *  branch's tz. Pure function (no I/O). The expansion produces the
 *  list of slots whose calendar day (in branch tz) is on or after
 *  `start_date`, stepping by `recurrence_interval_days`. The 30-day
 *  window + same-day exclusion is enforced by the per-occurrence
 *  validator (FR-018, FR-019), not here — the expansion surfaces
 *  every candidate so the response can carry the skip reason. */
export function expandOccurrences(
  body: RecurringBody,
  args: { branchTz: string },
): Occurrence[] {
  const startDate = parseLocalDate(body.start_date);
  const [hh, mm] = body.time_of_day.split(':').map((s) => parseInt(s, 10));
  const durationMs = body.duration_minutes * 60_000;

  const out: Occurrence[] = [];
  for (let i = 0; i < body.occurrences_or_until_date; i++) {
    const dayOffset = i * body.recurrence_interval_days;
    const occurrenceLocalDayMs = Date.UTC(
      startDate.year,
      startDate.month - 1,
      startDate.day,
    ) + dayOffset * 24 * 60 * 60 * 1000;
    const startMs = localToUtcMs(
      occurrenceLocalDayMs,
      hh!,
      mm!,
      args.branchTz,
    );
    const endMs = startMs + durationMs;
    const localDate = formatLocalDate(new Date(startMs), args.branchTz);
    out.push({
      index: i + 1,
      startMs,
      endMs,
      localDate,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-occurrence validation (FR-046)
// ---------------------------------------------------------------------------

export type SkipReason =
  | 'outside_branch_hours'
  | 'doctor_unavailable'
  | 'doctor_blocked'
  | 'doctor_inactive'
  | 'branch_inactive'
  | 'appointment_type_inactive'
  | 'slot_raced'
  | 'patient_has_future_with_doctor'
  | 'patient_time_conflict'
  | 'outside_30d_window'
  | 'same_day_exclusion';

const SELECT_DOCTOR_BRANCH_HOURS_SQL = `
  SELECT d.active AS doctor_active,
         b.tz, b.active AS branch_active,
         bw.open_time, bw.close_time, bw.is_closed
    FROM doctor d
    JOIN doctor_branch db ON db.doctor_id = d.id AND db.branch_id = $2
    JOIN branch b ON b.id = db.branch_id
    LEFT JOIN branch_weekly_hours bw
      ON bw.branch_id = b.id AND bw.day_of_week = $4
   WHERE d.id = $1 AND d.clinic_id = $3;
`;

const SELECT_APPOINTMENT_TYPE_SQL = `
  SELECT id, name, duration_minutes, is_active
    FROM appointment_type
   WHERE id = $1 AND clinic_id = $2;
`;

const SELECT_DOCTOR_SCHEDULE_SQL = `
  SELECT start_time, end_time
    FROM doctor_schedule
   WHERE doctor_id = $1 AND branch_id = $2
     AND day_of_week = $3
     AND effective_from <= ($4::date)
     AND (effective_to IS NULL OR effective_to >= ($4::date));
`;

const SELECT_DOCTOR_BLOCKS_SQL = `
  SELECT 1 FROM doctor_block
   WHERE doctor_id = $1 AND branch_id = $2
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)')
   LIMIT 1;
`;

const SELECT_EXISTING_APPOINTMENTS_SQL = `
  SELECT 1 FROM appointment
   WHERE doctor_id = $1 AND branch_id = $2
     AND status = 'Scheduled'
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)')
   LIMIT 1;
`;

const SELECT_PATIENT_DOCTOR_FUTURE_SQL = `
  SELECT 1 FROM appointment
   WHERE patient_phone = $1 AND doctor_id = $2
     AND status = 'Scheduled' AND start_datetime > now()
     AND ($3::uuid IS NULL OR id <> $3::uuid)
   LIMIT 1;
`;

const SELECT_PATIENT_TIME_OVERLAP_SQL = `
  SELECT 1 FROM appointment
   WHERE patient_phone = $1
     AND status = 'Scheduled'
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($2::timestamptz, $3::timestamptz, '[)')
   LIMIT 1;
`;

const SELECT_PATIENT_BY_PHONE_SQL = `
  SELECT id::text AS id FROM patient WHERE phone_number = $1;
`;

interface DoctorBranchRow {
  doctor_active: boolean;
  tz: string;
  branch_active: boolean;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean | null;
}

export type RecheckResult =
  | {
      ok: true;
      tz: string;
      patientId: string;
    }
  | { ok: false; reason: SkipReason };

export interface RecheckArgs {
  clinicId: string;
  doctorId: string;
  branchId: string;
  appointmentTypeId: string;
  patientPhone: string;
  startMs: number;
  endMs: number;
  submittedDuration: number;
  /** Branch-local calendar day of the slot (YYYY-MM-DD), pre-derived
   *  by the caller from `startMs` + the branch tz. */
  branchLocalDate: string;
  /** Today's branch-local date (YYYY-MM-DD). */
  todayLocalDate: string;
  /** When set, exclude this appointment id from FR-027 + FR-029 checks
   *  so the row being moved/rescheduled is not counted as its own
   *  sibling. Used by the doctor-move route (E6-S2) and the
   *  recurring-confirm path for the source row. */
  excludeAppointmentId?: string | null;
  /** IANA tz name (e.g. 'America/New_York'). When supplied, the
   *  validator anchors the slot's minutes-of-day in branch-local
   *  time and queries `branch_weekly_hours` / `doctor_schedule`
   *  for the branch-local DOW — so a 14:00 ET slot is correctly
   *  compared against the branch's 09:00–17:00 wall-clock window.
   *
   *  E7-S6 partial fix: the engine still uses UTC as the working
   *  plane (see its docstring); this argument brings the write
   *  side into spec for the doctor-move / bookings /
   *  patient-reschedule / recurring routes. When null, the
   *  validator falls back to the legacy UTC behavior. */
  branchTz?: string | null;
}

/** Run the per-occurrence FR-046 pipeline inside an open transaction.
 *  Returns either `{ok: true, ...}` (slot is bookable) or
 *  `{ok: false, reason}` (the skip reason surfaced to the user). */
export async function validateOccurrenceInTxn(
  client: PoolClient,
  args: RecheckArgs,
): Promise<RecheckResult> {
  // 1. Doctor + branch + branch_hours for the slot's DOW.
  //    When `args.branchTz` is set, use the branch-local DOW so a
  //    23:30 ET slot on Sun (Mon UTC) is correctly compared
  //    against the Sun hours row. Falls back to UTC DOW for
  //    legacy callers.
  const dow =
    args.branchTz !== undefined && args.branchTz !== null
      ? branchLocalDayOfWeek(args.startMs, args.branchTz)
      : utcDayOfWeek(new Date(args.startMs));
  const { rows: docRows } = await client.query<DoctorBranchRow>(
    SELECT_DOCTOR_BRANCH_HOURS_SQL,
    [args.doctorId, args.branchId, args.clinicId, dow],
  );
  if (docRows.length === 0) {
    return { ok: false, reason: 'doctor_inactive' };
  }
  const docInfo = docRows[0]!;
  if (!docInfo.doctor_active) {
    return { ok: false, reason: 'doctor_inactive' };
  }
  if (!docInfo.branch_active) {
    return { ok: false, reason: 'branch_inactive' };
  }
  const branchHours = {
    open_time: docInfo.open_time,
    close_time: docInfo.close_time,
    is_closed: docInfo.is_closed,
  };

  // 2. Type (active + duration match).
  const { rows: typeRows } = await client.query<{
    id: string;
    duration_minutes: number;
    is_active: boolean;
  }>(SELECT_APPOINTMENT_TYPE_SQL, [args.appointmentTypeId, args.clinicId]);
  if (typeRows.length === 0 || !typeRows[0]!.is_active) {
    return { ok: false, reason: 'appointment_type_inactive' };
  }
  if (typeRows[0]!.duration_minutes !== args.submittedDuration) {
    return { ok: false, reason: 'outside_branch_hours' };
  }

  // 3. Patient row existence. The route layer already 400'd an
  //    unknown phone; the in-txn check is a race-safety net.
  const { rows: patRows } = await client.query<{ id: string }>(
    SELECT_PATIENT_BY_PHONE_SQL,
    [args.patientPhone],
  );
  if (patRows.length === 0) {
    return { ok: false, reason: 'patient_time_conflict' };
  }
  const patientId = patRows[0]!.id;

  // 4. 30-day window (FR-018) + same-day exclusion (FR-019).
  //    Window: [today+1, today+30] in branch-local date.
  //    Same-day: skip if branchLocalDate == todayLocalDate.
  if (args.branchLocalDate === args.todayLocalDate) {
    return { ok: false, reason: 'same_day_exclusion' };
  }
  const todayMs = Date.UTC(
    Number(args.todayLocalDate.slice(0, 4)),
    Number(args.todayLocalDate.slice(5, 7)) - 1,
    Number(args.todayLocalDate.slice(8, 10)),
  );
  const startDayMs = Date.UTC(
    Number(args.branchLocalDate.slice(0, 4)),
    Number(args.branchLocalDate.slice(5, 7)) - 1,
    Number(args.branchLocalDate.slice(8, 10)),
  );
  const windowUpperMs = todayMs + 30 * 24 * 60 * 60 * 1000;
  if (startDayMs > windowUpperMs) {
    return { ok: false, reason: 'outside_30d_window' };
  }

  // 5. Branch hours disambiguation (P0-3 from E3-S2 review pattern).
  const h = branchHours;
  if (h.is_closed === true) {
    return { ok: false, reason: 'outside_branch_hours' };
  }
  const openMin =
    h.is_closed === null ? null : h.open_time ? timeStringToMinutes(h.open_time) : null;
  const closeMin =
    h.is_closed === null ? null : h.close_time ? timeStringToMinutes(h.close_time) : null;
  if (openMin === null || closeMin === null || closeMin <= openMin) {
    return { ok: false, reason: 'outside_branch_hours' };
  }

  // 6. Doctor schedule (effective_from / effective_to).
  const startDate = new Date(args.startMs);
  const { rows: scheduleRows } = await client.query<{
    start_time: string;
    end_time: string;
  }>(
    SELECT_DOCTOR_SCHEDULE_SQL,
    [args.doctorId, args.branchId, dow, startDate],
  );
  if (scheduleRows.length === 0) {
    return { ok: false, reason: 'doctor_unavailable' };
  }
  const doctorIntervals: Array<{ startMin: number; endMin: number }> = [];
  for (const r of scheduleRows) {
    const s = timeStringToMinutes(r.start_time);
    const e = timeStringToMinutes(r.end_time);
    if (s === null || e === null || e <= s) continue;
    doctorIntervals.push({ startMin: s, endMin: e });
  }
  if (doctorIntervals.length === 0) {
    return { ok: false, reason: 'doctor_unavailable' };
  }
  const branchIntervals = [{ startMin: openMin, endMin: closeMin }];
  const working = intersect(branchIntervals, doctorIntervals);
  if (working.length === 0) {
    return { ok: false, reason: 'doctor_unavailable' };
  }

  // 7. Slot's minutes-of-day must fit inside the working interval set.
  //    When `args.branchTz` is set, anchor to branch-local midnight
  //    so a 14:00 ET slot on East Branch is 14*60=840 min, which
  //    fits the 09:00-17:00 (540-1020) working window. Without
  //    the tz, anchor to UTC midnight (legacy behavior; works
  //    only for UTC branches).
  const dayStartMs =
    args.branchTz !== undefined && args.branchTz !== null
      ? branchLocalMidnightMs(args.startMs, args.branchTz)
      : Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
        );
  const startMin = Math.floor((args.startMs - dayStartMs) / 60000);
  const endMin = Math.floor((args.endMs - dayStartMs) / 60000);
  const slotIv = clampToDay(startMin, endMin);
  if (slotIv === null) {
    return { ok: false, reason: 'outside_branch_hours' };
  }
  const fits = intersect(working, [slotIv]);
  if (fits.length === 0) {
    return { ok: false, reason: 'outside_branch_hours' };
  }

  // 8. Doctor blocks.
  const startDt = new Date(args.startMs);
  const endDt = new Date(args.endMs);
  const { rows: blockRows } = await client.query<{ exists: boolean }>(
    SELECT_DOCTOR_BLOCKS_SQL,
    [args.doctorId, args.branchId, startDt, endDt],
  );
  if (blockRows.length > 0) {
    return { ok: false, reason: 'doctor_blocked' };
  }

  // 9. Existing Scheduled appointments at (doctor, branch) overlapping.
  const { rows: existingRows } = await client.query<{ exists: boolean }>(
    SELECT_EXISTING_APPOINTMENTS_SQL,
    [args.doctorId, args.branchId, startDt, endDt],
  );
  if (existingRows.length > 0) {
    return { ok: false, reason: 'slot_raced' };
  }

  // 10. FR-027: same (patient, doctor) future Scheduled.
  const { rows: pdRows } = await client.query<{ exists: boolean }>(
    SELECT_PATIENT_DOCTOR_FUTURE_SQL,
    [args.patientPhone, args.doctorId, args.excludeAppointmentId ?? null],
  );
  if (pdRows.length > 0) {
    return { ok: false, reason: 'patient_has_future_with_doctor' };
  }

  // 11. FR-029: patient time overlap.
  const { rows: poRows } = await client.query<{ exists: boolean }>(
    SELECT_PATIENT_TIME_OVERLAP_SQL,
    [args.patientPhone, startDt, endDt],
  );
  if (poRows.length > 0) {
    return { ok: false, reason: 'patient_time_conflict' };
  }

  return {
    ok: true,
    tz: docInfo.tz,
    patientId,
  };
}

// ---------------------------------------------------------------------------
// Preview state (server-stateful, in-process)
// ---------------------------------------------------------------------------

export interface PreviewSnapshot {
  body: RecurringBody;
  branchTz: string;
  occurrences: Occurrence[];
  createdAtMs: number;
}

const previewStore: Map<string, PreviewSnapshot> = new Map();

/** Persist a preview snapshot under a fresh uuid. Returns the id. */
export function savePreview(snapshot: PreviewSnapshot): string {
  const id = randomUUID();
  previewStore.set(id, snapshot);
  return id;
}

/** Look up a preview snapshot by id. Returns null if unknown. */
export function getPreview(id: string): PreviewSnapshot | null {
  return previewStore.get(id) ?? null;
}

/** Test-only reset (the test suite uses one process; the production
 *  module is short-lived per request). */
export function __resetPreviewsForTests(): void {
  previewStore.clear();
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseLocalDate(s: string): { year: number; month: number; day: number } {
  return {
    year: Number(s.slice(0, 4)),
    month: Number(s.slice(5, 7)),
    day: Number(s.slice(8, 10)),
  };
}

/** Format a UTC instant as the calendar date in `tz` (IANA name).
 *  Uses Intl.DateTimeFormat to handle DST correctly. Returns
 *  `YYYY-MM-DD`. */
export function formatLocalDate(utc: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(utc);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/** Returns the UTC ms epoch of branch-local midnight on the same
 *  branch-local calendar day as `utcMs`. DST-safe (uses
 *  Intl.DateTimeFormat for the probe).
 *
 *  E7-S6 partial: the write-side validators (recurring,
 *  bookings, patient-reschedule, staff-doctor-move) need to
 *  anchor the slot's minutes-of-day in branch-local time so a
 *  14:00 ET slot on East Branch is correctly compared against
 *  the branch's 09:00–17:00 working window. The engine itself
 *  still uses UTC as the working plane (per its docstring);
 *  the boundary-range divergence is contained and E7-S6
 *  reconciles it globally.
 *
 *  Algorithm: compute the tz offset (local→UTC) of `utcMs`
 *  itself, then build `Date.UTC(year, month, day) + offset` as
 *  the initial guess. One correction pass handles the
 *  near-midnight boundary (e.g. 23:30 ET where the day shifts). */
export function branchLocalMidnightMs(utcMs: number, tz: string): number {
  const renderedYmd = formatLocalDate(new Date(utcMs), tz);
  const year = Number(renderedYmd.slice(0, 4));
  const month = Number(renderedYmd.slice(5, 7)) - 1;
  const day = Number(renderedYmd.slice(8, 10));

  // Probe the tz offset (local→UTC) of `utcMs` by comparing the
  // rendered wall clock to the UTC clock at the same instant.
  // For EDT (UTC-4): 18:00 UTC renders 14:00 local →
  //   offset = utc - local = 18:00 - 14:00 = +4h = +240 min.
  // For EST (UTC-5): 17:00 UTC renders 12:00 local →
  //   offset = 17:00 - 12:00 = +5h = +300 min.
  const probeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const probeHh = Number(probeParts.find((p) => p.type === 'hour')?.value ?? '0');
  const probeMm = Number(probeParts.find((p) => p.type === 'minute')?.value ?? '0');
  const probeUtcH = new Date(utcMs).getUTCHours();
  const probeUtcM = new Date(utcMs).getUTCMinutes();
  const offsetMin =
    (probeUtcH * 60 + probeUtcM) - (probeHh * 60 + probeMm);

  // Initial guess: midnight on the rendered YMD in UTC, then
  // shift by the offset. For 18:00 UTC on Oct 19 in NY (offset
  // = +240 min), this is Date.UTC(2026,9,19) + 240 min =
  // 2026-10-19T04:00:00Z = 00:00 EDT on Oct 19.
  let candidate = Date.UTC(year, month, day) + offsetMin * 60_000;

  // Up to 3 correction passes for the near-midnight boundary
  // where the rendered YMD shifts between the probe and the
  // candidate.
  for (let i = 0; i < 3; i++) {
    const ymd = formatLocalDate(new Date(candidate), tz);
    if (ymd === renderedYmd) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(candidate));
      const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
      if (hh === 0 && mm === 0) return candidate;
      // Off by a few minutes — adjust.
      candidate -= (hh * 60 + mm) * 60_000;
    } else {
      // Day shifted. Re-probe offset at the candidate and try
      // again.
      const p = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(candidate));
      const phh = Number(p.find((x) => x.type === 'hour')?.value ?? '0');
      const pmm = Number(p.find((x) => x.type === 'minute')?.value ?? '0');
      const utcH = new Date(candidate).getUTCHours();
      const utcM = new Date(candidate).getUTCMinutes();
      const off = (utcH * 60 + utcM) - (phh * 60 + pmm);
      const shiftedYmd = formatLocalDate(new Date(candidate), tz);
      const sy = Number(shiftedYmd.slice(0, 4));
      const sm = Number(shiftedYmd.slice(5, 7)) - 1;
      const sd = Number(shiftedYmd.slice(8, 10));
      candidate = Date.UTC(sy, sm, sd) + off * 60_000;
    }
  }
  return candidate;
}

/** Returns the branch-local day-of-week (0=Sun..6=Sat) for `utcMs`
 *  in tz. Matches Postgres `EXTRACT(dow FROM (a.start_datetime AT
 *  TIME ZONE tz))::int` (also 0=Sun). */
export function branchLocalDayOfWeek(utcMs: number, tz: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(new Date(utcMs));
  switch (weekday) {
    case 'Sun': return 0;
    case 'Mon': return 1;
    case 'Tue': return 2;
    case 'Wed': return 3;
    case 'Thu': return 4;
    case 'Fri': return 5;
    case 'Sat': return 6;
    default:
      throw new Error(`unexpected weekday: ${weekday}`);
  }
}

/** Returns the UTC ms epoch of "the calendar day represented by
 *  `dayMs` (a UTC ms for midnight) at (hh, mm) local time in `tz`".
 *  Converges in two passes for any tz (with or without DST).
 *  Used by `expandOccurrences` to compute the slot's UTC start. */
function localToUtcMs(dayMs: number, hh: number, mm: number, tz: string): number {
  const targetYmd = formatLocalDate(new Date(dayMs), 'UTC');
  const targetMonth = Number(targetYmd.slice(5, 7)) - 1;
  const targetDay = Number(targetYmd.slice(8, 10));
  const targetYear = Number(targetYmd.slice(0, 4));

  // First guess: treat the wall clock as UTC.
  let candidate = dayMs + (hh * 60 + mm) * 60_000;
  for (let i = 0; i < 3; i++) {
    const renderedYmd = formatLocalDate(new Date(candidate), tz);
    if (renderedYmd === targetYmd) {
      const timeParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(candidate));
      const renderedHh = Number(timeParts.find((p) => p.type === 'hour')?.value ?? '0');
      const renderedMm = Number(timeParts.find((p) => p.type === 'minute')?.value ?? '0');
      const renderedMin = renderedHh * 60 + renderedMm;
      const targetMin = hh * 60 + mm;
      if (renderedMin === targetMin) return candidate;
      candidate += (targetMin - renderedMin) * 60_000;
    } else {
      // Day mismatch — recompute from the offset between the
      // rendered day and the target day.
      const offsetMs = candidate - Date.UTC(
        Number(renderedYmd.slice(0, 4)),
        Number(renderedYmd.slice(5, 7)) - 1,
        Number(renderedYmd.slice(8, 10)),
      ) - (hh * 60 + mm) * 60_000;
      candidate = Date.UTC(targetYear, targetMonth, targetDay) + (hh * 60 + mm) * 60_000 - offsetMs;
    }
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Strip the `Router`/`express` imports that were removed during the
 *  SC2 cleanup so we don't leave a leaky file-level import. This
 *  re-export is a no-op marker; never imported elsewhere. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _noExports: undefined = undefined;