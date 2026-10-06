/**
 * Receptionist view helpers — date / time / string formatting.
 *
 * Mirrors `booking-utils.ts` (E3-ui) but for the receptionist context.
 * Times are rendered in the branch.tz (per E7-S6 + spec-5-4). The
 * backend returns UTC ISO strings; we format with Intl.DateTimeFormat
 * to project them into the branch-local wall clock.
 */

/** YYYY-MM-DD "today" in the given IANA tz. */
export function todayIsoLocalIn(tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/** Format an ISO UTC string as HH:MM (24h) in the branch's local time. */
export function formatTimeLocal(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

/** Format a YYYY-MM-DD string as "Aug 20" (branch-local month/day). */
export function formatMonthDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map((s) => Number(s));
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Format a YYYY-MM-DD string as the long form "August 20" / "Aug 20". */
export function formatDateHeader(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map((s) => Number(s));
  if (!y || !m || !d) return isoDate;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Initials for an avatar (e.g. "AR" for "Dr. Ahmed Al-Rashid"). */
export function initialsOf(fullName: string, fallback: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return fallback.slice(0, 2).toUpperCase();
  // Drop a leading honorific if present.
  const meaningful = parts.filter((p) => !/^dr\.?$/i.test(p));
  const first = meaningful[0]?.[0] ?? parts[0]?.[0] ?? '';
  const last =
    meaningful.length > 1
      ? meaningful[meaningful.length - 1]?.[0] ?? ''
      : '';
  return (first + last).toUpperCase() || fallback.slice(0, 2).toUpperCase();
}

/** Mask an E.164 phone for display, keeping the country code. */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return e164;
  // e.g. +966 5XX XXX 1234
  const cc = e164.slice(0, 4);
  const tail = e164.slice(-4);
  return `${cc} XXX XXX ${tail}`;
}

/** Surname from a full name. Drops a leading honorific (Dr., Dr). */
export function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return fullName;
  if (/^dr\.?$/i.test(parts[0] ?? '') && parts.length > 1) {
    return parts.slice(1).join(' ');
  }
  return parts.length > 1 ? (parts[parts.length - 1] ?? fullName) : fullName;
}
