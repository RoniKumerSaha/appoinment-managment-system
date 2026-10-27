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

// ----------------------------------------------------------------------------
// Phone normalisation — the field is a single input and the API only
// ever sees one E.164 string.
//

/** Normalise a typed phone number into the E.164 string the API
 *  expects.
 *
 *  The patient types the whole international number — `+966512345678`,
 *  `+880 1684 960808`, `+1 (555) 123-4567`. We strip the cosmetic
 *  separators, drop a leading `00` (the international prefix written
 *  longhand), and keep the `+` the patient typed.
 *
 *  A bare national number (`512345678`) is NOT given a country code:
 *  we do not guess one. The API rejects it, and the field shows the
 *  patient what is missing. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[\s\-().]/g, '');
  if (digits === '') return '';
  // `00` is the longhand international prefix — `00966…` means
  // `+966…`. Strip it so the number is not silently invalid.
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('+')) return `+${digits.slice(1).replace(/^0+/, '')}`;
  return digits;
}

// ----------------------------------------------------------------------------
// iconForType — derive an emoji glyph from an appointment-type name.
//
// Mockup 35 (and the booking step-2 type cards) shows a small emoji at the
// top-left of each type card. The API doesn't carry an icon column today,
// so we pattern-match on the name. New / unrecognized names fall back to a
// generic clipboard so the UI never breaks.
//
// Reused by PatientBooking.tsx, ReschedulePage.tsx, and the receipt
// surfaces — kept here so all three share the same rules.
// ----------------------------------------------------------------------------
const TYPE_ICON_RULES: Array<[RegExp, string]> = [
  [/consult|general|checkup|follow.?up/i, '💚'],
  [/vaccin|immuniz|booster|flu|covid/i, '💉'],
  [/follow/i, '📋'],
  [/lab|blood|test|result|panel/i, '🧪'],
  [/x.?ray|imaging|scan|mammo/i, '🩻'],
  [/screen|annual|wellness/i, '📈'],
  [/return|revisit/i, '📋'],
  [/new|initial|first/i, '✨'],
  [/pediatric|child|kid|baby/i, '🧸'],
  [/derma|skin/i, '🧴'],
  [/dental|teeth|oral/i, '🦷'],
  [/eye|vision|opt/i, '👁'],
];

export function iconForType(name: string): string {
  for (const [re, icon] of TYPE_ICON_RULES) {
    if (re.test(name)) return icon;
  }
  return '📋';
}