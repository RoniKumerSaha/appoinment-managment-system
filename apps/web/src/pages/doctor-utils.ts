/**
 * Doctor-side formatters (E6-S2 / E6-S3 UI).
 *
 * Tz-aware helpers used by DoctorAffected (mock 06) and
 * DoctorResolve (mock 24). The doctor's branches carry their
 * own tz, and the UI MUST render slots in branch-local time so
 * the doctor's "I work Wed PM at Branch A" mental model lines up
 * with what they see. The doctor JWT carries branch_ids only;
 * the per-branch tz is fetched from the public catalogue.
 *
 * No date-fns / luxon dependency. We do the math in Intl.DateTimeFormat
 * + Intl.DateTimeFormat(tz) and rely on the underlying browser
 * Intl data.
 */

export interface AffectedDisplay
  extends Omit<
    import('../api/client').DoctorAffectedAppointment,
    'start_datetime' | 'end_datetime'
  > {
  startLocal: string; // HH:MM (24h)
  endLocal: string;
  startDowShort: string; // Mon, Tue, ...
  startMonthDay: string; // Aug 22
  startUtcIso: string;
  endUtcIso: string;
  fullDate: string; // "Mon, Aug 22"
}

/**
 * Format an ISO timestamp in a specific tz using the Intl API.
 * The browser's TZ database supplies the offsets, so DST is handled
 * automatically. UTC tz is passed through as `undefined` (the
 * browser already uses the system tz).
 */
export function formatTimeInTz(iso: string, tz: string): string {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tzOpt,
  });
}

export function formatDateInTz(iso: string, tz: string): string {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tzOpt,
  });
}

export function formatDowShort(iso: string, tz: string): string {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: tzOpt,
  });
}

export function formatMonthDay(iso: string, tz: string): string {
  const d = new Date(iso);
  const tzOpt = tz === 'UTC' ? undefined : tz;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: tzOpt,
  });
}

/**
 * Mask a phone number to +1XXXXXXXXXX (E1-S2 invariant).
 * Long enough to be useful, short enough to deny patient
 * identification at-a-glance.
 */
export function maskPhone(e164: string): string {
  if (typeof e164 !== 'string' || e164.length < 4) return e164;
  const tail = e164.slice(-4);
  return `+1 XXX XXX ${tail}`;
}

/**
 * Initials helper (mirrors booking-utils.initialsOf).
 */
export function initialsOf(fullName: string, fallback = '?'): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return fallback;
  const first = parts[0]!;
  if (/^Dr\.?$/i.test(first) && parts.length > 1) {
    return (first[0] ?? 'D') + (parts[1]?.[0] ?? '');
  }
  return first[0]! + (parts[1]?.[0] ?? '');
}

/**
 * Last-name helper. Strips a "Dr." prefix and returns the last
 * whitespace-separated word. Used in the Kanban card patient cell
 * (mock 06 cards: "Mohammed K." style).
 */
export function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return fullName;
  if (/^dr\.?$/i.test(parts[0] ?? '') && parts.length > 1) {
    return parts[parts.length - 1] ?? fullName;
  }
  return parts.length > 1 ? (parts[parts.length - 1] ?? fullName) : fullName;
}

/**
 * Capitalise a phone's last-name fallback for the masked display
 * when we don't have a real patient name. The E6-S3 backend does
 * NOT carry patient_name (the doctor sees only `patient_phone`).
 * The kanban renders a synthetic "Patient {maskedLast4}" label.
 */
export function patientLabelFromPhone(e164: string): string {
  const tail = e164.slice(-4);
  return `Patient ···${tail}`;
}