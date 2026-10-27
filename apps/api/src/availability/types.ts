/**
 * Availability engine — shared types.
 *
 * Per spec-3-1 + architecture §3.2, the availability engine is a pure
 * server-side function `availability(doctor, branch, date, appointment_type)`
 * that returns a list of valid slots for booking. The function is split
 * into a pure slot-list builder (slots.ts) and an orchestrator that
 * reads inputs from the DB (engine.ts). This file defines the
 * vocabulary shared between them.
 */

/** A half-open interval in minutes-of-day `[startMin, endMin)`.
 *  Matches the half-open semantics used by the GIST exclusion
 *  constraint in 0008 (range `[start, end)`). */
export interface Interval {
  startMin: number;
  endMin: number;
}

/** A bookable slot, expressed in minutes-of-day for the slot-list
 *  builder and as ISO timestamps for the route response. The
 *  engine maps between the two. */
export interface Slot {
  startMin: number;
  endMin: number;
  /** UTC epoch ms of the slot's start. Set by the engine once the
   *  slot's branch-local minutes-of-day have been anchored to the
   *  branch's timezone. */
  startMs?: number;
  /** UTC epoch ms of the slot's end. */
  endMs?: number;
}

/** The 30-day fixed window (FR-018). Both bounds are inclusive.
 *
 *  The window is a range of CALENDAR DAYS, not instants: `dateMs` is
 *  the UTC midnight of the requested date, while `nowMs` is an instant.
 *  Comparing them directly rejected every date before `now + 24h` —
 *  which made tomorrow (whose midnight falls earlier in the day than
 *  `now + 24h`) unbookable for the whole day.
 *
 *  Both sides are therefore floored to UTC midnight before comparison:
 *  the requested date must be within `today+1 … today+30` inclusive.
 *  Same-day (FR-019 / BR-021) is excluded. */
export function isWithin30DayWindow(dateMs: number, nowMs: number): boolean {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const todayMidnight = Math.floor(nowMs / ONE_DAY_MS) * ONE_DAY_MS;
  const dateMidnight = Math.floor(dateMs / ONE_DAY_MS) * ONE_DAY_MS;
  const min = todayMidnight + ONE_DAY_MS; // today+1
  const max = todayMidnight + 30 * ONE_DAY_MS; // today+30 (inclusive)
  return dateMidnight >= min && dateMidnight <= max;
}

/** Convert a Date (UTC midnight of the requested date) + minutes-of-day
 *  to a UTC Date for SQL queries / JSON responses. */
export function datePlusMinutes(dateMs: number, minutes: number): Date {
  return new Date(dateMs + minutes * 60 * 1000);
}

/** Convert ISO `YYYY-MM-DD` to UTC midnight `Date`. Returns `null`
 *  on parse failure. */
export function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Day-of-week (0=Sunday..6=Saturday) in UTC for a Date. Matches
 *  Postgres EXTRACT(DOW FROM ...) which also returns 0=Sunday. */
export function utcDayOfWeek(d: Date): number {
  return d.getUTCDay();
}

/** Render the calendar date (`YYYY-MM-DD`) of `utcMs` in `tz`. */
export function localDateInTz(utcMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(utcMs));
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/** Wall-clock hours/minutes of `utcMs` in `tz`. */
function localHmInTz(utcMs: number, tz: string): { hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  return {
    hh: Number(parts.find((p) => p.type === 'hour')?.value ?? '0'),
    mm: Number(parts.find((p) => p.type === 'minute')?.value ?? '0'),
  };
}

/** Offset of `tz` from UTC at the instant `utcMs`, in minutes
 *  (positive east of UTC, i.e. `offset = utc - local`).
 *
 *  Derived from the time-of-day only: the local clock is compared
 *  against the UTC clock, and any calendar-day difference is folded
 *  in separately so a date-line shift cannot corrupt the offset. */
function offsetMinutesAt(utcMs: number, tz: string): number {
  const local = localHmInTz(utcMs, tz);
  const d = new Date(utcMs);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const localMin = local.hh * 60 + local.mm;
  let offset = utcMin - localMin;
  // The local date may be a day ahead of or behind the UTC date; the
  // offset must be within ±24h, so shift by whole days until it is.
  while (offset > 720) offset -= 1440;
  while (offset < -720) offset += 1440;
  return offset;
}

/** UTC ms epoch of `isoDate` (YYYY-MM-DD) at local midnight in `tz`.
 *  DST-safe: the offset is probed at the candidate instant and
 *  re-probed once, which resolves the two candidate offsets around a
 *  DST transition.
 *
 *  This is the anchor every availability computation uses: branch
 *  hours and doctor schedules are wall-clock values, so minutes-of-day
 *  must be measured from the branch's local midnight, not UTC
 *  midnight. */
export function localMidnightMs(isoDate: string, tz: string): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7)) - 1;
  const day = Number(isoDate.slice(8, 10));
  const wallMs = Date.UTC(year, month, day);

  // Guess with the offset at the wall-clock instant, then correct with
  // the offset that actually applies at the candidate.
  let candidate = wallMs + offsetMinutesAt(wallMs, tz) * 60_000;
  for (let i = 0; i < 3; i++) {
    const offset = offsetMinutesAt(candidate, tz);
    const next = wallMs + offset * 60_000;
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
}

/** UTC ms epoch of `isoDate` at wall-clock (hh, mm) in `tz`. DST-safe:
 *  the offset is re-probed at the candidate until the rendered local
 *  clock matches the target. */
export function localWallClockToUtcMs(
  isoDate: string,
  hh: number,
  mm: number,
  tz: string,
): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7)) - 1;
  const day = Number(isoDate.slice(8, 10));
  const wallMs = Date.UTC(year, month, day) + (hh * 60 + mm) * 60_000;

  let candidate = wallMs + offsetMinutesAt(wallMs, tz) * 60_000;
  for (let i = 0; i < 3; i++) {
    const rendered = localHmInTz(candidate, tz);
    const renderedDate = localDateInTz(candidate, tz);
    if (renderedDate !== isoDate) {
      // The instant fell outside the requested calendar day in local
      // time (rare, near a date-line shift) — re-anchor and retry.
      const offset = offsetMinutesAt(candidate, tz);
      candidate = wallMs + offset * 60_000;
      continue;
    }
    const deltaMin = hh * 60 + mm - (rendered.hh * 60 + rendered.mm);
    if (deltaMin === 0) return candidate;
    candidate += deltaMin * 60_000;
  }
  return candidate;
}

/** Branch-local day-of-week (0=Sun..6=Sat) of the UTC instant
 *  `utcMs` in `tz`. Matches Postgres
 *  `EXTRACT(dow FROM (ts AT TIME ZONE tz))::int`. */
export function localDayOfWeek(utcMs: number, tz: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(new Date(utcMs));
  switch (weekday) {
    case 'Sun':
      return 0;
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      throw new Error(`unexpected weekday: ${weekday}`);
  }
}

/** Minutes-of-day of `utcMs` measured from branch-local midnight of
 *  the same branch-local calendar day. */
export function localMinutesOfDay(utcMs: number, tz: string): number {
  const isoDate = localDateInTz(utcMs, tz);
  const anchor = localMidnightMs(isoDate, tz);
  return Math.round((utcMs - anchor) / 60_000);
}

/** Minutes-of-day of `utcMs` measured from the branch-local midnight
 *  of the *given* calendar day. Use this when the day is already
 *  known (the availability engine's requested date) so the value is
 *  always anchored to that day, even for instants that land just
 *  outside it. */
export function localMinutesOfDayOn(
  utcMs: number,
  isoDate: string,
  tz: string,
): number {
  const anchor = localMidnightMs(isoDate, tz);
  return Math.round((utcMs - anchor) / 60_000);
}

/** Convert a Postgres `time` value (e.g. `'09:30:00'`, `'09:30'`)
 *  to minutes-of-day. Returns `null` on parse failure. */
export function timeStringToMinutes(t: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Reason for empty slot list. When `slots.length === 0`, the route
 *  surfaces this to the UI so it can render an explanatory message. */
export type EmptyReason =
  | 'doctor_unavailable'
  | 'branch_closed'
  | 'all_blocked'
  | 'all_booked'
  | 'no_fit'
  | 'patient_has_future_with_doctor';

export interface AvailabilityResult {
  slots: Slot[];
  /** When `slots.length === 0`, this is non-null with a human-readable
   *  explanation. When `slots.length > 0`, this is null. */
  reason: EmptyReason | null;
}

/** Inputs to the engine. `patientPhone` is optional — when supplied,
 *  FR-027 (no future appt for same patient+doctor) and FR-029 (no
 *  patient time overlap) filters apply.
 *
 *  `excludeAppointmentId` is the row the caller is *moving* (a
 *  reschedule preview). The row being moved is itself a future
 *  Scheduled appointment for this patient+doctor, so without the
 *  exclusion FR-027 fires against the caller's own appointment and
 *  the preview returns zero slots — the patient is told to cancel
 *  first. The commit-time recheck in `routes/patient-reschedule.ts`
 *  already excludes it (`id <> $3`); the preview must agree. */
export interface AvailabilityQuery {
  doctorId: string;
  branchId: string;
  appointmentTypeId: string;
  date: Date;
  durationMinutes: number;
  patientPhone: string | null;
  nowMs: number;
  /** The appointment being rescheduled — excluded from the FR-027
   *  and FR-029 checks. Null for a normal availability lookup. */
  excludeAppointmentId: string | null;
}