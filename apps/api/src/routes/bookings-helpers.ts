/**
 * bookings-helpers.ts — pure validators for POST /bookings.
 *
 * Validation order mirrors E1-S1 / E1-S3 / E2-S1 / E2-S2:
 *   1. UUID parse on (doctor_id, branch_id, appointment_type_id).
 *   2. ISO datetime parse on start_datetime (strict: must carry a TZ).
 *   3. slot_duration_minutes integer 5..480 (matches 0005 CHECK).
 *   4. patient_phone E.164 format.
 *   5. patient_name 1..120 chars (trim-then-length).
 *   6. unknown_field detection.
 *
 * All validators return booleans / parsed values (no tagged unions —
 * `validateCreateBookingBody` returns a discriminated `CreateBookingBody`
 * on success or `null` on failure). The route layer maps each failure
 * to a 400 envelope, matching E1-S3's `unknown_field` convention.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO 8601 with TZ: either `Z` or `±HH:MM` / `±HHMM` offset.
const ISO_DATETIME_WITH_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const E164_PHONE_RE = /^\+[1-9]\d{6,14}$/;
const NAME_MAX = 120;
const DURATION_MIN = 5;
const DURATION_MAX = 480;

export interface CreateBookingBody {
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  slot_duration_minutes: number;
  patient_phone: string;
  patient_name: string;
}

export type CreateBookingValidationError =
  | 'unknown_field'
  | 'invalid_doctor_id'
  | 'invalid_branch_id'
  | 'invalid_appointment_type_id'
  | 'invalid_start_datetime'
  | 'invalid_end_datetime'
  | 'invalid_slot_duration_minutes'
  | 'invalid_patient_phone'
  | 'invalid_patient_name';

export const ALLOWED_POST_KEYS = new Set([
  'doctor_id',
  'branch_id',
  'appointment_type_id',
  'start_datetime',
  'end_datetime',
  'slot_duration_minutes',
  'patient_phone',
  'patient_name',
]);

export function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Parses an ISO 8601 string with explicit TZ; returns a Date or null.
 *  Rejects naive timestamps (no Z / no offset) per spec Always: "Slot
 *  UTC no TZ → 400 invalid_start_datetime". The regex enforces that the
 *  TZ designator exists; the Date.parse call enforces parseability. */
export function isValidIsoDateTime(s: string): Date | null {
  if (!ISO_DATETIME_WITH_TZ_RE.test(s)) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

export function isValidDurationMinutes(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  if (n < DURATION_MIN || n > DURATION_MAX) return null;
  return n;
}

export function isValidE164Phone(s: string): boolean {
  return E164_PHONE_RE.test(s);
}

export function isValidPatientName(s: string): boolean {
  const trimmed = s.trim();
  return trimmed.length >= 1 && trimmed.length <= NAME_MAX;
}

/** Parses `req.body` into a `CreateBookingBody` or returns the first
 *  validation error encountered. Validators run in fixed order to keep
 *  error envelopes deterministic across runs. */
export function validateCreateBookingBody(
  body: unknown,
): { ok: true; value: CreateBookingBody } | { ok: false; error: CreateBookingValidationError } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'unknown_field' };
  }
  const b = body as Record<string, unknown>;

  // Unknown-field check (after shape — every key must be in ALLOWED_POST_KEYS).
  for (const k of Object.keys(b)) {
    if (!ALLOWED_POST_KEYS.has(k)) return { ok: false, error: 'unknown_field' };
  }

  if (typeof b['doctor_id'] !== 'string' || !isValidUuid(b['doctor_id'])) {
    return { ok: false, error: 'invalid_doctor_id' };
  }
  if (typeof b['branch_id'] !== 'string' || !isValidUuid(b['branch_id'])) {
    return { ok: false, error: 'invalid_branch_id' };
  }
  if (
    typeof b['appointment_type_id'] !== 'string' ||
    !isValidUuid(b['appointment_type_id'])
  ) {
    return { ok: false, error: 'invalid_appointment_type_id' };
  }
  if (
    typeof b['start_datetime'] !== 'string' ||
    isValidIsoDateTime(b['start_datetime']) === null
  ) {
    return { ok: false, error: 'invalid_start_datetime' };
  }
  if (
    typeof b['end_datetime'] !== 'string' ||
    isValidIsoDateTime(b['end_datetime']) === null
  ) {
    return { ok: false, error: 'invalid_end_datetime' };
  }
  const duration = isValidDurationMinutes(b['slot_duration_minutes']);
  if (duration === null) {
    return { ok: false, error: 'invalid_slot_duration_minutes' };
  }
  if (
    typeof b['patient_phone'] !== 'string' ||
    !isValidE164Phone(b['patient_phone'])
  ) {
    return { ok: false, error: 'invalid_patient_phone' };
  }
  if (typeof b['patient_name'] !== 'string' || !isValidPatientName(b['patient_name'])) {
    return { ok: false, error: 'invalid_patient_name' };
  }

  return {
    ok: true,
    value: {
      doctor_id: b['doctor_id'] as string,
      branch_id: b['branch_id'] as string,
      appointment_type_id: b['appointment_type_id'] as string,
      start_datetime: b['start_datetime'] as string,
      end_datetime: b['end_datetime'] as string,
      slot_duration_minutes: duration,
      patient_phone: b['patient_phone'] as string,
      patient_name: (b['patient_name'] as string).trim(),
    },
  };
}

/** 30-day window check used by both /availability and /bookings:
 *  `date` must be in `[tomorrow, today+30]` UTC. Returns the failure
 *  reason as a tagged union. Mirrors `isWithin30DayWindow` in
 *  availability/types.ts but returns a richer error (this is a route
 *  helper, not a pure util). */
export function checkBookingWindow(
  startMs: number,
  nowMs: number,
): { ok: true } | { ok: false; code: 'slot_in_past' | 'outside_30d_window' } {
  const now = new Date(nowMs);
  const startDate = new Date(startMs);

  // Day-aligned comparison: take the date portion only (UTC).
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startUtc = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  );
  const tomorrowUtc = todayUtc + 24 * 60 * 60 * 1000;
  const maxUtc = todayUtc + 30 * 24 * 60 * 60 * 1000;

  if (startUtc < tomorrowUtc) return { ok: false, code: 'slot_in_past' };
  if (startUtc > maxUtc) return { ok: false, code: 'outside_30d_window' };
  return { ok: true };
}