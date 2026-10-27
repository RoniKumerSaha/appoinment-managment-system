/**
 * Availability engine — orchestrator.
 *
 * Per spec-3-1 + architecture §3.2, `availability(doctor, branch, date,
 * appointment_type)` reads its inputs from the DB inside a transaction,
 * then delegates to the pure `buildSlots` (slots.ts) for filtering.
 *
 * Layered design:
 *   - validation (window, dates, UUID parse) — route layer (routes/availability.ts).
 *   - DB read snapshot (single transaction) — engine.ts (this file).
 *   - Pure filtering (intersect, subtract, build) — slots.ts.
 *   - Patient-specific filter (FR-027, FR-029) — engine.ts.
 *
 * The engine returns `AvailabilityResult { slots, reason }` — when
 * `slots` is empty, `reason` describes why (for UI rendering). The
 * route maps the result to a JSON response.
 *
 * TZ resolution: branch.hours and doctor_schedule are wall-clock
 * values expressed in the branch's local timezone. The engine
 * therefore anchors the requested day to branch-local midnight,
 * keys the schedule lookup on the branch-local day-of-week, and
 * measures every stored UTC timestamp as branch-local
 * minutes-of-day. The resulting slots carry absolute UTC instants so
 * the write-side validators (which apply the same anchoring) accept
 * them unchanged.
 *
 * Patient privacy: when `patientPhone` is null, FR-027/FR-029 filters
 * are skipped (a fresh patient). When supplied, the engine applies
 * both filters via the existing appointment table.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  type AvailabilityQuery,
  type AvailabilityResult,
  type Interval,
  isWithin30DayWindow,
  localDateInTz,
  localDayOfWeek,
  localMinutesOfDayOn,
  localWallClockToUtcMs,
  timeStringToMinutes,
} from './types.js';
import {
  buildSlots,
  clampToDay,
  intersect,
  mergeIntervals,
  subtractIntervals,
} from './slots.js';

const SELECT_CLINIC_ID_SQL = `SELECT id FROM clinic LIMIT 1`;

const SELECT_DOCTOR_AT_BRANCH_SQL = `
  SELECT d.id, d.full_name, d.active, b.active AS branch_active, b.tz
    FROM doctor d
    JOIN doctor_branch db ON db.doctor_id = d.id
    JOIN branch b ON b.id = db.branch_id
   WHERE d.id = $1 AND db.branch_id = $2 AND d.clinic_id = $3;
`;

const SELECT_APPOINTMENT_TYPE_SQL = `
  SELECT id, name, duration_minutes, is_active
    FROM appointment_type
   WHERE id = $1 AND clinic_id = $2;
`;

const SELECT_BRANCH_HOURS_SQL = `
  SELECT day_of_week, open_time, close_time, is_closed
    FROM branch_weekly_hours
   WHERE branch_id = $1 AND day_of_week = $2;
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
  SELECT start_datetime, end_datetime
    FROM doctor_block
   WHERE doctor_id = $1 AND branch_id = $2
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)');
`;

// Scheduled rows for this doctor + branch that overlap the candidate
// day. Excludes the row being moved (`$5 = excludeAppointmentId`) so
// the appointment does not collide with itself — the row is still in
// the table until the reschedule commits, and the commit-time
// recheck in routes/patient-reschedule.ts excludes it too.
// `IS DISTINCT FROM` so a NULL $5 leaves the check unchanged.
const SELECT_EXISTING_APPOINTMENTS_SQL = `
  SELECT start_datetime, end_datetime
    FROM appointment
   WHERE doctor_id = $1 AND branch_id = $2
     AND status = 'Scheduled'
     AND id IS DISTINCT FROM $5::uuid
     AND tstzrange(start_datetime, end_datetime, '[)') &&
         tstzrange($3::timestamptz, $4::timestamptz, '[)');
`;

// FR-027: any future Scheduled row for (patient, doctor)? The row
// being rescheduled is itself one, so `excludeAppointmentId` removes
// it from the check — otherwise the preview rejects the caller's own
// appointment.
//
// `IS DISTINCT FROM` (not `<>`) is essential: `id <> NULL::uuid`
// evaluates to NULL, which is not true, so every row would be
// filtered out and FR-027 would never fire at all for a plain
// (non-reschedule) lookup. `IS DISTINCT FROM` is true when the ids
// differ AND when one side is NULL, so passing NULL leaves the check
// exactly as it was.
//
// The commit-time recheck in routes/patient-reschedule.ts uses the
// same shape; the two must agree, or the preview shows slots that the
// commit then rejects (or, as before this fix, hides slots that the
// commit would happily accept).
const SELECT_PATIENT_DOCTOR_OVERLAP_SQL = `
  SELECT 1 FROM appointment
 WHERE patient_phone = $1 AND doctor_id = $2
   AND status = 'Scheduled' AND start_datetime > now()
   AND id IS DISTINCT FROM $3::uuid
 LIMIT 1;
`;

// FR-029: any Scheduled row for the patient overlapping the candidate
// slot? The row being moved must not overlap *itself* — same
// `IS DISTINCT FROM` exclusion as above ($4 is the excluded id; $2/$3
// are the candidate slot's start/end).
const SELECT_PATIENT_TIME_OVERLAP_SQL = `
  SELECT a.start_datetime, a.end_datetime
    FROM appointment a
   WHERE a.patient_phone = $1
     AND a.status = 'Scheduled'
     AND a.start_datetime > now()
     AND a.id IS DISTINCT FROM $4::uuid
     AND tstzrange(a.start_datetime, a.end_datetime, '[)') &&
         tstzrange($2::timestamptz, $3::timestamptz, '[)');
`;

interface DoctorRow {
  id: string;
  full_name: string;
  active: boolean;
  branch_active: boolean;
  tz: string;
}

interface AppointmentTypeRow {
  id: string;
  name: string;
  duration_minutes: number;
  is_active: boolean;
}

interface BranchHoursRow {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
}

interface TimeRangeRow {
  start_time: string;
  end_time: string;
}

interface TimestampRangeRow {
  start_datetime: Date;
  end_datetime: Date;
}

export type AvailabilityError =
  | { kind: 'doctor_not_found' }
  | { kind: 'branch_not_found' }
  | { kind: 'doctor_not_at_branch' }
  | { kind: 'doctor_inactive' }
  | { kind: 'branch_inactive' }
  | { kind: 'appointment_type_not_found' }
  | { kind: 'appointment_type_inactive' }
  | { kind: 'past_date' }
  | { kind: 'outside_30d_window' };

export type AvailabilityOutcome =
  | { kind: 'ok'; result: AvailabilityResult }
  | { kind: 'err'; error: AvailabilityError };

/** Build the branch-local midnight → next-day-midnight interval for
 *  the requested calendar date. The bounds are absolute UTC instants;
 *  their local span is exactly one calendar day in `tz` (23 or 25
 *  hours across a DST boundary). */
function localDayBounds(
  isoDate: string,
  tz: string,
): { startMs: number; endMs: number } {
  const startMs = localWallClockToUtcMs(isoDate, 0, 0, tz);
  const nextDate = addDays(isoDate, 1);
  const endMs = localWallClockToUtcMs(nextDate, 0, 0, tz);
  return { startMs, endMs };
}

/** Advance a `YYYY-MM-DD` date by `n` days. */
function addDays(isoDate: string, n: number): string {
  const ms = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  ) + n * 86_400_000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Convert a stored UTC timestamp to branch-local minutes-of-day,
 *  anchored on the requested calendar day. */
function timestampToLocalMinutes(
  t: Date,
  isoDate: string,
  tz: string,
): number {
  return localMinutesOfDayOn(t.getTime(), isoDate, tz);
}

/** Construct an `Interval` from a Postgres `time` row pair. Returns
 *  null on parse failure (corrupt data). */
function timeRangeToInterval(row: TimeRangeRow): Interval | null {
  const s = timeStringToMinutes(row.start_time);
  const e = timeStringToMinutes(row.end_time);
  if (s === null || e === null || e <= s) return null;
  return { startMin: s, endMin: e };
}

/** Compute availability for one (doctor, branch, date, type, patient?) query. */
export async function computeAvailability(
  query: AvailabilityQuery,
): Promise<AvailabilityOutcome> {
  // 1. 30-day window check (FR-018 + FR-019).
  if (!isWithin30DayWindow(query.date.getTime(), query.nowMs)) {
    const now = new Date(query.nowMs);
    if (query.date.getTime() <= now.getTime()) {
      return { kind: 'err', error: { kind: 'past_date' } };
    }
    return { kind: 'err', error: { kind: 'outside_30d_window' } };
  }

  const pool = await getPool();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    getLogger().error(
      { err: err instanceof Error ? err.message : String(err) },
      'availability_connect_failed',
    );
    throw err;
  }
  try {
    await client.query('BEGIN');
    const { rows: clinicRows } = await client.query<{ id: string }>(
      SELECT_CLINIC_ID_SQL,
    );
    if (clinicRows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('clinic_row_missing');
    }
    const clinicId = clinicRows[0]!.id;

    // 2. Verify doctor at branch + active + branch active.
    const { rows: docRows } = await client.query<DoctorRow>(
      SELECT_DOCTOR_AT_BRANCH_SQL,
      [query.doctorId, query.branchId, clinicId],
    );
    if (docRows.length === 0) {
      // Distinguish: doctor-not-at-branch vs doctor-not-found by a
      // second SELECT (cheap; single-row).
      const { rows: docOnly } = await client.query<{ id: string }>(
        `SELECT id FROM doctor WHERE id = $1 AND clinic_id = $2`,
        [query.doctorId, clinicId],
      );
      await client.query('COMMIT');
      if (docOnly.length === 0) {
        return { kind: 'err', error: { kind: 'doctor_not_found' } };
      }
      // Doctor exists but is not at this branch OR branch inactive.
      // Look up the branch to disambiguate.
      const { rows: branchRows } = await client.query<{ active: boolean }>(
        `SELECT active FROM branch WHERE id = $1 AND clinic_id = $2`,
        [query.branchId, clinicId],
      );
      if (branchRows.length === 0) {
        return { kind: 'err', error: { kind: 'branch_not_found' } };
      }
      return { kind: 'err', error: { kind: 'doctor_not_at_branch' } };
    }
    const doctor = docRows[0]!;
    if (!doctor.active) {
      await client.query('COMMIT');
      return { kind: 'err', error: { kind: 'doctor_inactive' } };
    }
    if (!doctor.branch_active) {
      await client.query('COMMIT');
      return { kind: 'err', error: { kind: 'branch_inactive' } };
    }

    // 3. Verify appointment type.
    const { rows: typeRows } = await client.query<AppointmentTypeRow>(
      SELECT_APPOINTMENT_TYPE_SQL,
      [query.appointmentTypeId, clinicId],
    );
    if (typeRows.length === 0) {
      await client.query('COMMIT');
      return { kind: 'err', error: { kind: 'appointment_type_not_found' } };
    }
    const type = typeRows[0]!;
    if (!type.is_active) {
      await client.query('COMMIT');
      return { kind: 'err', error: { kind: 'appointment_type_inactive' } };
    }
    if (type.duration_minutes !== query.durationMinutes) {
      // Caller-supplied duration disagrees with the stored type. The
      // type row is authoritative — overwrite the working copy.
      query = { ...query, durationMinutes: type.duration_minutes };
    }

    // 4. Read branch hours + doctor schedule for the date's DOW.
    //    The requested date is a calendar date in the branch's local
    //    timezone; every wall-clock value below is expressed in that
    //    same frame.
    const branchTz = doctor.tz;
    const isoDate = localDateInTz(query.date.getTime(), 'UTC');
    const dayStart = localDayBounds(isoDate, branchTz);
    const dow = localDayOfWeek(dayStart.startMs, branchTz);

    const { rows: hoursRows } = await client.query<BranchHoursRow>(
      SELECT_BRANCH_HOURS_SQL,
      [query.branchId, dow],
    );
    const baseIntervals: Interval[] = [];
    if (hoursRows.length > 0 && !hoursRows[0]!.is_closed) {
      const h = hoursRows[0]!;
      const openMin = h.open_time ? timeStringToMinutes(h.open_time) : null;
      const closeMin = h.close_time ? timeStringToMinutes(h.close_time) : null;
      if (openMin !== null && closeMin !== null && closeMin > openMin) {
        baseIntervals.push({ startMin: openMin, endMin: closeMin });
      }
    }
    if (baseIntervals.length === 0) {
      await client.query('COMMIT');
      return {
        kind: 'ok',
        result: { slots: [], reason: 'branch_closed' },
      };
    }

    const { rows: scheduleRows } = await client.query<TimeRangeRow>(
      SELECT_DOCTOR_SCHEDULE_SQL,
      [query.doctorId, query.branchId, dow, isoDate],
    );
    if (scheduleRows.length === 0) {
      await client.query('COMMIT');
      return {
        kind: 'ok',
        result: { slots: [], reason: 'doctor_unavailable' },
      };
    }
    const doctorIntervals: Interval[] = [];
    for (const r of scheduleRows) {
      const iv = timeRangeToInterval(r);
      if (iv !== null) doctorIntervals.push(iv);
    }
    if (doctorIntervals.length === 0) {
      await client.query('COMMIT');
      return {
        kind: 'ok',
        result: { slots: [], reason: 'doctor_unavailable' },
      };
    }

    // 5. Intersect branch ∩ doctor.
    const working = intersect(baseIntervals, doctorIntervals);
    if (working.length === 0) {
      await client.query('COMMIT');
      return {
        kind: 'ok',
        result: { slots: [], reason: 'doctor_unavailable' },
      };
    }

    // 6. Subtract blocks + existing appointments (within the day).
    const dayEndDate = new Date(dayStart.endMs);
    const { rows: blockRows } = await client.query<TimestampRangeRow>(
      SELECT_DOCTOR_BLOCKS_SQL,
      [
        query.doctorId,
        query.branchId,
        new Date(dayStart.startMs),
        dayEndDate,
      ],
    );
    const blockIntervals: Interval[] = [];
    for (const r of blockRows) {
      const iv = clampToDay(
        timestampToLocalMinutes(r.start_datetime, isoDate, branchTz),
        timestampToLocalMinutes(r.end_datetime, isoDate, branchTz),
      );
      if (iv !== null) blockIntervals.push(iv);
    }

    const { rows: existingRows } = await client.query<TimestampRangeRow>(
      SELECT_EXISTING_APPOINTMENTS_SQL,
      [
        query.doctorId,
        query.branchId,
        new Date(dayStart.startMs),
        dayEndDate,
        query.excludeAppointmentId,
      ],
    );
    const existingIntervals: Interval[] = [];
    for (const r of existingRows) {
      const iv = clampToDay(
        timestampToLocalMinutes(r.start_datetime, isoDate, branchTz),
        timestampToLocalMinutes(r.end_datetime, isoDate, branchTz),
      );
      if (iv !== null) existingIntervals.push(iv);
    }

    const afterBlocks = subtractIntervals(working, blockIntervals);
    let afterExisting = subtractIntervals(afterBlocks, existingIntervals);
    afterExisting = mergeIntervals(afterExisting);

    // 7. Patient filters.
    let patientSkip: Interval[] = [];
    if (query.patientPhone !== null) {
      // FR-027: same patient + same doctor + future Scheduled → empty.
      // The row being rescheduled is excluded — it is a future
      // Scheduled row for this same patient+doctor, and without the
      // exclusion the preview rejects the caller's own appointment
      // and the patient is told to cancel before they can reschedule.
      const { rows: pdRows } = await client.query<{ exists: boolean }>(
        SELECT_PATIENT_DOCTOR_OVERLAP_SQL,
        [query.patientPhone, query.doctorId, query.excludeAppointmentId],
      );
      if (pdRows.length > 0) {
        await client.query('COMMIT');
        return {
          kind: 'ok',
          result: { slots: [], reason: 'patient_has_future_with_doctor' },
        };
      }
      // FR-029: patient has overlapping appointment.
      const { rows: poRows } = await client.query<TimestampRangeRow>(
        SELECT_PATIENT_TIME_OVERLAP_SQL,
        [
          query.patientPhone,
          new Date(dayStart.startMs),
          dayEndDate,
          query.excludeAppointmentId,
        ],
      );
      patientSkip = [];
      for (const r of poRows) {
        const iv = clampToDay(
          timestampToLocalMinutes(r.start_datetime, isoDate, branchTz),
          timestampToLocalMinutes(r.end_datetime, isoDate, branchTz),
        );
        if (iv !== null) patientSkip.push(iv);
      }
    }

    let finalIntervals = afterExisting;
    if (patientSkip.length > 0) {
      finalIntervals = subtractIntervals(finalIntervals, patientSkip);
      finalIntervals = mergeIntervals(finalIntervals);
    }

    await client.query('COMMIT');

    const slots = buildSlots(finalIntervals, query.durationMinutes);
    // Anchor each slot's branch-local minutes-of-day to the branch's
    // timezone so the returned instants are the ones the write-side
    // validators will re-derive.
    for (const slot of slots) {
      slot.startMs = localWallClockToUtcMs(
        isoDate,
        Math.floor(slot.startMin / 60),
        slot.startMin % 60,
        branchTz,
      );
      slot.endMs = localWallClockToUtcMs(
        isoDate,
        Math.floor(slot.endMin / 60),
        slot.endMin % 60,
        branchTz,
      );
    }
    if (slots.length === 0) {
      // Distinguish "all booked" vs "no_fit" vs other empty reasons.
      // Simplest heuristic: if baseIntervals (branch ∩ doctor) had
      // any interval but no slots fit, return 'no_fit'. If
      // afterBlocks is empty → 'all_blocked'. If afterExisting is
      // empty → 'all_booked'.
      let reason: AvailabilityResult['reason'] = 'no_fit';
      if (afterExisting.length === 0 && afterBlocks.length > 0) {
        reason = 'all_booked';
      } else if (afterBlocks.length === 0) {
        reason = 'all_blocked';
      }
      return { kind: 'ok', result: { slots: [], reason } };
    }
    return { kind: 'ok', result: { slots, reason: null } };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    getLogger().error(
      { err: err instanceof Error ? err.message : String(err) },
      'availability_engine_failed',
    );
    throw err;
  } finally {
    client.release();
  }
}

/** Pure helpers live in slots.ts/types.ts and are re-imported here.
 *  This module owns the DB orchestrator only. */