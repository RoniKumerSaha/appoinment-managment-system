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
import {
  ALL_COUNTRIES,
  findCountry,
} from './phone-countries';

export {
  DEFAULT_COUNTRY_CODE,
  findCountry,
} from './phone-countries';

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
// Country-code splitting — the phone field is a country chip + a
// national number, but the API only ever sees one E.164 string.
//

/** Join a country code + national number into the E.164 string the
 *  API expects.
 *
 *  The patient is allowed to type the WHOLE international number —
 *  `+8801684960808` — without touching the country chip. When the
 *  typed value carries its own `+CC` prefix, that prefix wins and
 *  the chip is only a display convenience; we never blindly glue
 *  the selected dial code onto a number that already declares one.
 *  (`OTHER` contributes no prefix — the patient types their own full
 *  international number in the national field.) */
export function joinPhone(countryCode: string, nationalNumber: string): string {
  const digits = nationalNumber.replace(/[\s\-().]/g, '');
  if (digits === '') return '';
  if (countryCode === 'OTHER') return digits.startsWith('+') ? digits : `+${digits}`;
  // The patient typed (or pasted) a complete international number.
  // Trust it as-is: the chip is a fallback, not an override.
  if (digits.startsWith('+')) {
    return `+${digits.slice(1).replace(/^0+/, '')}`;
  }
  const country = findCountry(countryCode);
  if (country === undefined || country.dial === '') return digits;
  // The patient may have pasted the number including the prefix but
  // without the `+`. Strip it so the prefix is not doubled.
  const bare = digits;
  const national = bare.startsWith(country.dial.slice(1))
    ? bare.slice(country.dial.length - 1)
    : bare;
  return `${country.dial}${national}`;
}

/** Split a full phone string back into a country code + national
 *  number.
 *
 *  A number whose `+CC` prefix is not in the catalogue (Bangladesh
 *  `+880`, say) is still a perfectly good international number, so
 *  it splits as `OTHER` + the digits after the country code rather
 *  than being rejected. Only a string with no `+` at all returns
 *  null — the caller then treats it as a raw national number. */
export function splitPhone(
  full: string,
): { countryCode: string; nationalNumber: string } | null {
  const bare = full.replace(/[\s\-().]/g, '');
  if (!bare.startsWith('+')) return null;
  // Longest dial code first: +1 is a prefix of nothing, but +7 would
  // shadow +971 if the list were unordered.
  const candidates = ALL_COUNTRIES.filter((c) => c.dial !== '').sort(
    (a, b) => b.dial.length - a.dial.length,
  );
  for (const c of candidates) {
    if (bare.startsWith(c.dial)) {
      return {
        countryCode: c.code,
        nationalNumber: bare.slice(c.dial.length),
      };
    }
  }
  // Unknown country code: hand the whole international number to the
  // `OTHER` escape hatch, which contributes no prefix of its own.
  // We do not guess where the country code ends — the digits after
  // the `+` are all the patient typed, and `joinPhone('OTHER', …)`
  // puts the `+` back in front of them.
  return { countryCode: 'OTHER', nationalNumber: bare };
}

/** The country the chip should show for a value the patient typed.
 *
 *  Returns null when the value carries no country code of its own
 *  (a bare national number), in which case the chip keeps whatever
 *  the patient picked. */
export function detectCountryCode(typed: string): string | null {
  const split = splitPhone(typed);
  return split === null ? null : split.countryCode;
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