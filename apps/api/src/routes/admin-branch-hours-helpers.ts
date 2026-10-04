/**
 * Pure validation helpers for admin-branch-hours routes.
 *
 * No I/O, no DB. Mirrors the admin-branches.ts validator style:
 *   - `is*` predicates are type guards (`name is string`).
 *   - `normalize*` transforms a valid input into the canonical stored form.
 *   - Composite validators (`isValidHoursArray`) compose the per-field
 *     predicates and return a uniform boolean so the route handler can
 *     map a single failing field to a specific 400 envelope.
 *
 * Spec-1-2 §Boundaries:
 *   - Hours are wall-clock `HH:MM` (24h); interpreted in `branch.tz`.
 *   - 7 rows exactly (Sun=0..Sat=6).
 *   - `is_closed=true` allows NULL `open_time` / `close_time`.
 *   - `is_closed=false` requires both times AND `open_time < close_time`.
 *   - `tz` must be a valid IANA name (`Intl.DateTimeFormat` round-trip).
 */

const HOURS_LEN = 7;
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HoursRow {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
}

/** True iff `s` parses as `HH:MM` 24-hour. Rejects `25:00`, `9:00`, `9:0`. */
export function isValidTime(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (!TIME_HHMM.test(s)) return false;
  // Belt-and-suspenders: confirm the parsed hour/minute round-trip. The
  // regex already enforces the [00..23][00..59] range, but a future lax
  // regex would still fail here.
  const parts = s.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

export function isValidDayOfWeek(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6;
}

/** True iff `tz` is a valid IANA timezone name. Uses `Intl.DateTimeFormat`
 *  — invalid zones raise RangeError. We catch and return false. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string') return false;
  try {
    // Round-trip a fixed date through the named zone. If `tz` is bogus,
    // the constructor throws RangeError. A valid zone yields a non-throwing
    // format; we don't compare the formatted string — just probe validity.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True iff `id` is a syntactically valid UUID. Rejects before any DB call. */
export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/**
 * Validate the full 7-row hours array. Order does not have to match
 * Sun..Sat — the route normalizes ordering via `normalizeHoursArray`.
 * However, days must be unique and cover exactly the 7-day set.
 */
export function isValidHoursArray(arr: unknown): arr is HoursRow[] {
  return validateHoursArray(arr).ok;
}

/**
 * Tagged validation result. `ok: true` returns the validated array in
 * `value`; `ok: false` returns a specific error code so the route can
 * emit the spec-mandated envelope (`invalid_hours_length`,
 * `invalid_day_of_week`, `invalid_time_range`).
 *
 * Per spec-1-2 I/O matrix, the three error codes are:
 *   - `invalid_hours_length`  — array length ≠ 7
 *   - `invalid_day_of_week`   — day_of_week outside 0..6 (or duplicated/missing)
 *   - `invalid_time_range`    — open_time >= close_time on an open day,
 *                                or missing times on an open day
 */
export type HoursValidationError =
  | 'invalid_hours_length'
  | 'invalid_day_of_week'
  | 'invalid_time_range';

export type HoursValidationResult =
  | { ok: true; value: HoursRow[] }
  | { ok: false; error: HoursValidationError };

export function validateHoursArray(arr: unknown): HoursValidationResult {
  if (!Array.isArray(arr)) {
    return { ok: false, error: 'invalid_hours_length' };
  }
  if (arr.length !== HOURS_LEN) {
    return { ok: false, error: 'invalid_hours_length' };
  }
  const seen = new Set<number>();
  for (const row of arr) {
    if (typeof row !== 'object' || row === null) {
      return { ok: false, error: 'invalid_day_of_week' };
    }
    const r = row as Record<string, unknown>;
    if (!isValidDayOfWeek(r['day_of_week'])) {
      return { ok: false, error: 'invalid_day_of_week' };
    }
    const dow = r['day_of_week'] as number;
    if (seen.has(dow)) {
      return { ok: false, error: 'invalid_day_of_week' };
    }
    seen.add(dow);
    if (typeof r['is_closed'] !== 'boolean') {
      return { ok: false, error: 'invalid_day_of_week' };
    }
    const open = r['open_time'];
    const close = r['close_time'];
    const openOk = open === null || open === undefined || isValidTime(open);
    const closeOk = close === null || close === undefined || isValidTime(close);
    if (!openOk || !closeOk) {
      // Either a non-string non-null time value, or an out-of-range
      // HH:MM like 25:00 or 9:00. Treat as invalid_time_range (the spec
      // doesn't have a separate "invalid_time_format" code; the closest
      // semantic match is invalid_time_range because the value can't be
      // used to compute a valid [open, close) interval).
      return { ok: false, error: 'invalid_time_range' };
    }
    if (r['is_closed']) continue;
    // is_closed === false requires BOTH times AND open < close.
    if (!isValidTime(open) || !isValidTime(close)) {
      return { ok: false, error: 'invalid_time_range' };
    }
    if (!((open as string) < (close as string))) {
      return { ok: false, error: 'invalid_time_range' };
    }
  }
  // All 0..6 must be present.
  for (let d = 0; d < HOURS_LEN; d++) {
    if (!seen.has(d)) {
      return { ok: false, error: 'invalid_day_of_week' };
    }
  }
  return { ok: true, value: arr as HoursRow[] };
}

/** Sort the array by `day_of_week` so the response is canonical Sun..Sat. */
export function normalizeHoursArray(arr: HoursRow[]): HoursRow[] {
  return [...arr].sort((a, b) => a.day_of_week - b.day_of_week);
}