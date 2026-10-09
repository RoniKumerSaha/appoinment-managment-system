/**
 * Pure validation helpers for admin-appointment-types routes.
 *
 * No I/O, no DB. Mirrors admin-branch-doctors-helpers.ts shape:
 *   - `is*` predicates are type guards.
 *   - `normalize*` transforms a valid input into the canonical stored form.
 *   - Composite validators return tagged unions so the route handler can
 *     map a single failing field to a specific 400 envelope.
 *
 * Spec-2-3 §Boundaries:
 *   - name: 1..120 chars after trim.
 *   - duration_minutes: integer, 5..480 (matches 0005 CHECK constraint).
 *   - is_active: typeof boolean.
 *   - The validator returns a discriminated union so a single 400 envelope
 *     can disambiguate WHICH field failed (invalid_name /
 *     invalid_duration_minutes).
 */

const NAME_MIN = 1;
const NAME_MAX = 120;
const DURATION_MIN = 5;
const DURATION_MAX = 480;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `s` parses as a syntactically valid UUID. */
export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** True iff `s` is a non-empty string 1..120 chars after trim. */
export function isValidName(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}

/** Trim a valid name into its canonical stored form. */
export function normalizeName(s: string): string {
  return s.trim();
}

/** True iff `n` is a JSON integer in the closed range [5, 480].
 *  Rejects: floats (5.5), strings ('30'), NaN, Infinity, out-of-range. */
export function isValidDurationMinutes(n: unknown): n is number {
  if (typeof n !== 'number') return false;
  if (!Number.isInteger(n)) return false;
  if (n < DURATION_MIN || n > DURATION_MAX) return false;
  return true;
}

/** True iff `v` is a JSON boolean (not 'maybe' / 'true' / 1 / 0). */
export function isValidActive(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export type CreateTypeError =
  | 'invalid_name'
  | 'invalid_duration_minutes';

export type CreateTypeResult =
  | {
      ok: true;
      name: string;
      durationMinutes: number;
    }
  | { ok: false; error: CreateTypeError };

/** Tagged validator for the POST /admin/appointment-types body. Both
 *  fields required; returns canonical normalized values on success. */
export function validateCreateTypeBody(body: unknown): CreateTypeResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'invalid_name' };
  }
  const r = body as Record<string, unknown>;
  if (!('name' in r) || !isValidName(r['name'])) {
    return { ok: false, error: 'invalid_name' };
  }
  if (!('duration_minutes' in r) || !isValidDurationMinutes(r['duration_minutes'])) {
    return { ok: false, error: 'invalid_duration_minutes' };
  }
  return {
    ok: true,
    name: normalizeName(r['name'] as string),
    durationMinutes: r['duration_minutes'] as number,
  };
}

export type PatchTypeError =
  | 'invalid_name'
  | 'invalid_is_active'
  | 'invalid_description'
  | 'invalid_duration_minutes';

export type PatchTypeResult =
  | {
      ok: true;
      name: string | null;
      isActive: boolean | null;
      description: string | null;
      durationMinutes: number | null;
    }
  | { ok: false; error: PatchTypeError };

/** True iff `s` is a valid appointment-type description. The DB column
 *  is nullable; we accept `null` to clear it, or a string up to 500
 *  characters (trimmed). */
export function isValidDescription(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  return s.trim().length <= 500;
}

const DESCRIPTION_MAX = 500;

/** Tagged validator for the PATCH /admin/appointment-types/:id body.
 *  Each field is optional; at least one must be present (the route
 *  rejects empty bodies separately with `no_fields_to_update`).
 *
 *  `duration_minutes` is NOT a PATCH field — types are immutable once
 *  created (per spec §Never). The route's ALLOWED_KEYS set excludes
 *  `duration_minutes` so sending it falls through to `unknown_field`
 *  rather than being silently accepted. To change duration, the admin
 *  must DELETE + INSERT — DELETE is also out of scope for E2-S3. */
export function validatePatchTypeBody(body: unknown): PatchTypeResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'invalid_name' };
  }
  const r = body as Record<string, unknown>;
  let name: string | null = null;
  let isActive: boolean | null = null;
  let description: string | null = null;
  let durationMinutes: number | null = null;
  if ('name' in r) {
    if (!isValidName(r['name'])) {
      return { ok: false, error: 'invalid_name' };
    }
    name = normalizeName(r['name'] as string);
  }
  if ('is_active' in r) {
    if (!isValidActive(r['is_active'])) {
      return { ok: false, error: 'invalid_is_active' };
    }
    isActive = r['is_active'] as boolean;
  }
  if ('description' in r) {
    const v = r['description'];
    // null clears the description; string must pass the length cap.
    if (v === null) {
      description = null;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > DESCRIPTION_MAX) {
        return { ok: false, error: 'invalid_description' };
      }
      description = trimmed.length === 0 ? null : trimmed;
    } else {
      return { ok: false, error: 'invalid_description' };
    }
  }
  if ('duration_minutes' in r) {
    if (!isValidDurationMinutes(r['duration_minutes'])) {
      return { ok: false, error: 'invalid_duration_minutes' };
    }
    durationMinutes = r['duration_minutes'] as number;
  }
  return { ok: true, name, isActive, description, durationMinutes };
}

/** Parse `?active=true|false` query filter. Returns `null` when unset,
 *  `true`/`false` for valid values, or `{ ok: false }` for invalid.
 *  Mirrors admin-branch-doctors-helpers.parseActiveFilter. */
export function parseActiveFilter(raw: unknown):
  | { ok: true; value: boolean | null }
  | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false };
}