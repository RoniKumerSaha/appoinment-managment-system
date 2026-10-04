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
}

/** The 30-day fixed window (FR-018). Both bounds are inclusive.
 *  Returns true iff `dateMs` is in `[nowMs + 1d, nowMs + 30d]`
 *  measured in UTC. Same-day (FR-019 / BR-021) is excluded. */
export function isWithin30DayWindow(dateMs: number, nowMs: number): boolean {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const min = nowMs + ONE_DAY_MS; // today+1
  const max = nowMs + 30 * ONE_DAY_MS; // today+30 (inclusive)
  return dateMs >= min && dateMs <= max;
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
 *  patient time overlap) filters apply. */
export interface AvailabilityQuery {
  doctorId: string;
  branchId: string;
  appointmentTypeId: string;
  date: Date;
  durationMinutes: number;
  patientPhone: string | null;
  nowMs: number;
}