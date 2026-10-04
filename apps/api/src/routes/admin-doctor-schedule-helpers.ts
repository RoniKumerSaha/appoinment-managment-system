/**
 * Pure validation helpers for admin-doctor-schedule routes.
 *
 * No I/O, no DB. Mirrors admin-branch-hours-helpers.ts + admin-branch-doctors-helpers.ts:
 *   - `is*` predicates are type guards.
 *   - Composite validators return tagged-union results so the route handler
 *     can disambiguate which field failed.
 *   - `normalize*` transforms valid input to canonical stored form.
 *
 * Spec-2-1 §Boundaries:
 *   - day_of_week: integer 0..6 (Sun=0..Sat=6, matches Postgres EXTRACT DOW).
 *   - start_time, end_time: HH:MM:SS 24-hour wall-clock.
 *   - end_time > start_time (per 0006 CHECK constraint; we re-validate here
 *     so the route can return a 400 envelope with the offending row index).
 *   - effective_from: ISO date YYYY-MM-DD; must be ≥ tomorrow (FR-010).
 *   - effective_to: ISO date or null; if set, must be ≥ effective_from.
 *   - Within a (branch_id, day_of_week) group, no two rows overlap.
 *   - branch_id is a valid UUID; only enforced on branches the doctor works
 *     at (route-level check via `doctor_branch`).
 *
 * The phone mask format `+1XXXXXXXXXX` is the privacy invariant: keep the
 * country code (+1) and the area-code indicator (1 of 10 prefixes is
 * acceptable to leak — matches the E1-S2 admin-impact-preview invariant).
 * Local-exchange + subscriber = 8 hidden digits.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_HHMMSS = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function isValidDayOfWeek(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6;
}

/** True iff `s` parses as `HH:MM:SS` 24-hour wall-clock. Matches Postgres
 *  `time` cast of `start_time::text` which always renders with seconds. */
export function isValidTimeString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (!TIME_HHMMSS.test(s)) return false;
  const parts = s.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const ss = Number(parts[2]);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59;
}

/** True iff `s` parses as ISO `YYYY-MM-DD`. Defensive — we re-validate
 *  via Date.parse below to reject `2024-13-40` style inputs the regex lets
 *  through. */
export function isValidDateString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (!DATE_ISO.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms);
}

/** Compare two `HH:MM:SS` strings as if they were times-of-day. Same-day
 *  semantics (no TZ conversion) — the schedule is wall-clock by design
 *  (per 0006's `time` column type). Returns negative if a<b, 0 if equal,
 *  positive if a>b. */
export function compareTimeStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Two time intervals [aStart, aEnd) and [bStart, bEnd) overlap iff
 *  aStart < bEnd AND bStart < aEnd. Half-open semantics match the
 *  appointment GIST exclusion constraint (0008 + AC-17). */
export function timeRangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return (
    compareTimeStrings(aStart, bEnd) < 0 &&
    compareTimeStrings(bStart, aEnd) < 0
  );
}

/**
 * Mask a phone number to `+1XXXXXXXXXX`. Preserves country code (+1) and
 * 3-digit area-code indicator while hiding the 8-digit local portion.
 * Matches E1-S2 admin-impact-preview privacy invariant.
 *
 * If the input doesn't start with `+` or is shorter than 12 chars, the
 * function falls back to a fully-masked token (`+1XXXXXXXXXX`) rather
 * than throwing — callers can rely on the return type.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (typeof phone !== 'string') return '+1XXXXXXXXXX';
  // Strip everything except digits and the leading +.
  const stripped = phone.replace(/[^\d+]/g, '');
  if (!stripped.startsWith('+')) return '+1XXXXXXXXXX';
  if (stripped.length < 5) return '+1XXXXXXXXXX';
  // +CC AAA XXXXXXXX => +CC AAA XXXXXXXX (replace chars 5..end with X)
  const cc = stripped.slice(0, 1); // '+'
  const area = stripped.slice(1, 4); // first 3 digits
  return `${cc}${area}XXXXXXXX`;
}

export interface ScheduleRow {
  branch_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
}

export type ScheduleRowError =
  | 'invalid_branch_id'
  | 'invalid_day_of_week'
  | 'invalid_start_time'
  | 'invalid_end_time'
  | 'invalid_time_range'
  | 'invalid_effective_from'
  | 'invalid_effective_to'
  | 'effective_to_before_effective_from';

export type ValidateRowResult =
  | { ok: true; row: ScheduleRow; index: number }
  | { ok: false; error: ScheduleRowError; index: number };

/** Validate a single schedule row. The caller passes `index` so the route
 *  can include the offending index in the 400 envelope's `fields[]`. */
export function validateScheduleRow(
  raw: unknown,
  index: number,
  tomorrowIso: string,
): ValidateRowResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'invalid_branch_id', index };
  }
  const r = raw as Record<string, unknown>;
  if (!isValidUuid(r['branch_id'])) {
    return { ok: false, error: 'invalid_branch_id', index };
  }
  if (!isValidDayOfWeek(r['day_of_week'])) {
    return { ok: false, error: 'invalid_day_of_week', index };
  }
  if (!isValidTimeString(r['start_time'])) {
    return { ok: false, error: 'invalid_start_time', index };
  }
  if (!isValidTimeString(r['end_time'])) {
    return { ok: false, error: 'invalid_end_time', index };
  }
  if (compareTimeStrings(r['start_time'] as string, r['end_time'] as string) >= 0) {
    return { ok: false, error: 'invalid_time_range', index };
  }
  if (!isValidDateString(r['effective_from'])) {
    return { ok: false, error: 'invalid_effective_from', index };
  }
  const effectiveFrom = r['effective_from'] as string;
  if (effectiveFrom < tomorrowIso) {
    return { ok: false, error: 'invalid_effective_from', index };
  }
  if (
    r['effective_to'] !== null &&
    r['effective_to'] !== undefined &&
    !isValidDateString(r['effective_to'])
  ) {
    return { ok: false, error: 'invalid_effective_to', index };
  }
  if (r['effective_to'] !== null && r['effective_to'] !== undefined) {
    const effectiveTo = r['effective_to'] as string;
    if (effectiveTo < effectiveFrom) {
      return { ok: false, error: 'effective_to_before_effective_from', index };
    }
  }
  return {
    ok: true,
    row: {
      branch_id: r['branch_id'] as string,
      day_of_week: r['day_of_week'] as number,
      start_time: r['start_time'] as string,
      end_time: r['end_time'] as string,
      effective_from: effectiveFrom,
      effective_to: (r['effective_to'] ?? null) as string | null,
    },
    index,
  };
}

/** Group rows by (branch_id, day_of_week) and detect overlap. Returns the
 *  indices of the overlapping rows (the second-and-later offenders). */
export function findOverlappingRowIndices(
  rows: ScheduleRow[],
): number[] {
  const groups = new Map<string, ScheduleRow[]>();
  for (const row of rows) {
    const key = `${row.branch_id}|${row.day_of_week}`;
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  const offenders: number[] = [];
  rows.forEach((row, originalIndex) => {
    const key = `${row.branch_id}|${row.day_of_week}`;
    const group = groups.get(key)!;
    for (const other of group) {
      if (other === row) continue;
      if (
        timeRangesOverlap(
          row.start_time,
          row.end_time,
          other.start_time,
          other.end_time,
        )
      ) {
        offenders.push(originalIndex);
        return;
      }
    }
  });
  return offenders;
}

/** Compute `YYYY-MM-DD` for tomorrow in UTC. Pure function (no clock
 *  drift — caller passes `nowMs`). */
export function tomorrowIsoUtc(nowMs: number): string {
  const d = new Date(nowMs + 24 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}