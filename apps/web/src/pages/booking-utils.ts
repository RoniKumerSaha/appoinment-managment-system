/**
 * Shared booking-flow helpers.
 *
 * Date math used by the availability agenda view (mock 03) and the
 * confirmation summary (mock 04). All times are computed in UTC (the
 * API's working plane per spec-3-1 D2 deferral) and rendered with the
 * branch's IANA tz (mockup 02 shows the same — clients display local
 * time even though the engine runs in UTC).
 *
 * No timezone library: the engine returns ISO-with-TZ timestamps and
 * the branch.tz field is rendered as a hint, not used for math. The
 * spec pins this behavior (D2 deferral to E7-S6 for proper TZ math).
 */

export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase();
}

export function formatDateOnly(iso: string): string {
  // YYYY-MM-DD in UTC (engine's working plane).
  return iso.slice(0, 10);
}

/** Returns YYYY-MM-DD for today + N days (UTC). Used to bound the
 *  patient picker's day carousel to the FR-018 30-day window. */
export function isoDateOffset(daysFromToday: number): string {
  const now = new Date();
  const utc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysFromToday,
  );
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function formatDayOfWeek(iso: string): string {
  const d = new Date(iso);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] ?? '';
}

export function formatMonthDay(iso: string): string {
  const d = new Date(iso);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] ?? '';
  return `${month} ${d.getUTCDate()}`;
}

export function formatLongDate(iso: string): string {
  const d = new Date(iso);
  const weekday = ['Sunday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()] ?? '';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] ?? '';
  return `${weekday}, ${month} ${d.getUTCDate()}`;
}

export function formatTimeUtc(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatPhoneInput(raw: string): string {
  // Light formatting hint: spaces every 3 digits after the country code.
  // We don't actually rewrite the value — we just show it as the user
  // typed it. Used as `aria-describedby` copy.
  return raw;
}

export const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Strip the cosmetic separators people type while entering a phone
 *  number (spaces, dashes, dots, parens) so the strict E.164 regex
 *  accepts input the user formatted as `+966 5XX XXX 5555` or
 *  `+1 (555) 123-4567`. We do NOT strip the leading `+`. */
export function normalizePhoneE164(raw: string): string {
  return raw.replace(/[\s\-().]/g, '');
}

export function isValidPhone(s: string): boolean {
  return E164_RE.test(normalizePhoneE164(s));
}

export function isValidName(s: string): boolean {
  const trimmed = s.trim();
  return trimmed.length >= 1 && trimmed.length <= 120;
}

export function isValidOtpCode(s: string): boolean {
  return /^\d{6}$/.test(s);
}