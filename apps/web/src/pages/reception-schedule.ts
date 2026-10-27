/**
 * reception-schedule.ts — merge the two halves of the receptionist's
 * day calendar.
 *
 * `GET /availability` returns the OPEN slots for a doctor / type /
 * day. `GET /reception/branch/schedule` returns the BOOKED slots for
 * the branch's day. The calendar shows both, so the two lists have to
 * be joined into one timeline.
 *
 * The join key is the UTC instant: the availability route returns
 * UTC ISO strings and the schedule route returns the appointment's
 * own UTC start. An open slot and a booked slot can never share an
 * instant — the availability engine subtracts the existing
 * appointments before answering — so the merge is a union, and the
 * result is sorted by start instant.
 */
import type { ReceptionScheduleBooked } from '../api/client';

export interface CalendarSlot {
  /** UTC ISO instant. */
  start: string;
  /** UTC ISO instant. */
  end: string;
  state: 'open' | 'booked';
  /** First-name initial for a booked slot (F-15). */
  initial?: string;
}

/** Build the calendar for one day.
 *
 *  @param openStarts UTC ISO start instants of the open slots.
 *  @param booked     The branch's booked appointments for the day.
 *  @param durationMinutes The appointment type's duration — used to
 *         close an open slot, which the availability route does not
 *         report.
 */
export function mergeDaySlots(
  openStarts: string[],
  booked: ReceptionScheduleBooked[],
  durationMinutes: number,
): CalendarSlot[] {
  const slots: CalendarSlot[] = [
    ...openStarts.map((start) => ({
      start,
      end: new Date(
        new Date(start).getTime() + durationMinutes * 60_000,
      ).toISOString(),
      state: 'open' as const,
    })),
    ...booked.map((b) => ({
      start: b.start_datetime,
      end: b.end_datetime,
      state: 'booked' as const,
      initial: b.patient_initial,
    })),
  ];
  slots.sort((a, b) => a.start.localeCompare(b.start));
  return slots;
}

/** The inclusive list of calendar days in a range. `maxDays` caps
 *  the fan-out — the availability route is called once per day, so
 *  an unbounded range would be a request storm. */
export function daysInRange(
  from: string,
  to: string,
  maxDays: number,
): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < maxDays; d = addDays(d, 1)) {
    out.push(d);
  }
  return out;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((s) => Number(s));
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** YYYY-MM-DD "today" in the given IANA tz. */
export function todayLocalIn(tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}
