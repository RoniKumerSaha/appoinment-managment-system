/**
 * Pure validation helpers for admin-branch-doctors routes.
 *
 * No I/O, no DB. Mirrors the admin-branches.ts and admin-branch-hours-helpers.ts
 * validator style:
 *   - `is*` predicates are type guards (`name is string`).
 *   - `normalize*` transforms a valid input into the canonical stored form.
 *   - Composite validators return tagged unions so the route handler can
 *     map a single failing field to a specific 400 envelope.
 *
 * Spec-1-3 §Boundaries:
 *   - full_name: 1..120 chars, trimmed.
 *   - email: 1..254 chars, basic RFC-ish format, lowercased for storage.
 *   - branch_ids: non-empty array of UUID strings.
 *   - active: typeof boolean.
 *   - The validator returns a discriminated union so a single 400 envelope
 *     can disambiguate WHICH field failed (invalid_full_name /
 *     invalid_email / invalid_branch_ids / invalid_active).
 */

const NAME_MIN = 1;
const NAME_MAX = 120;
const EMAIL_MIN = 3;
const EMAIL_MAX = 254;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Basic email format: non-empty local part, '@', non-empty domain, '.',
// non-empty TLD. Rejects 'not-an-email', 'foo@', 'foo@bar', '@bar.com',
// 'a@b@c.d'. Matches the existing 0004 citext behavior (case-insensitive
// storage via normalizeEmail).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True iff `s` parses as 1..120 chars after trim. */
export function isValidFullName(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}

/** Trim a valid full_name into its canonical stored form. */
export function normalizeFullName(s: string): string {
  return s.trim();
}

/** True iff `s` parses as a basic email (3..254 chars, EMAIL_RE). */
export function isValidEmail(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length < EMAIL_MIN || s.length > EMAIL_MAX) return false;
  return EMAIL_RE.test(s);
}

/** Lowercase + trim a valid email into its canonical stored form. */
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

/** True iff `s` is a syntactically valid UUID. */
export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** True iff `v` is a JSON boolean (not 'maybe' / 'true' / 1 / 0). */
export function isValidActive(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

// doctor.specialty — E7-UX (migration 0019). Nullable text, shown on
// the patient doctor picker, the booking receipt, and the admin
// doctor card.
//
// The admin surface allows setting it to '' (clear it) — that is a
// legitimate state, not an error. `null` is accepted too and means
// "no change" (the field is optional on PATCH); an explicit `null`
// clears it.
const SPECIALTY_MAX = 120;

/** True iff `s` is a usable specialty: a string of at most
 *  SPECIALTY_MAX characters once trimmed. An empty string is valid
 *  (it means "clear the specialty"). */
export function isValidSpecialty(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  return s.trim().length <= SPECIALTY_MAX;
}

/** Trim a valid specialty into its canonical stored form. An empty
 *  string is stored as NULL — the column is nullable and the UI
 *  renders "Not set" for NULL. */
export function normalizeSpecialty(s: string): string | null {
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface BranchIdCheck {
  ok: boolean;
  /** Non-UUID values from the input array (in original form). */
  invalid: string[];
}

/** Validate that `arr` is a non-empty array of valid UUID strings.
 *  Returns `ok: false` if the array itself is malformed (not an array or
 *  empty). When `ok: true`, `invalid` is the list of non-UUID entries.
 *  When `ok: false`, the list is empty (the array shape itself failed). */
export function checkBranchIdList(arr: unknown): BranchIdCheck {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, invalid: [] };
  }
  const invalid: string[] = [];
  for (const v of arr) {
    if (!isValidUuid(v)) invalid.push(typeof v === 'string' ? v : String(v));
  }
  return { ok: invalid.length === 0, invalid };
}

/** True iff `arr` is a non-empty array of UUIDs (no per-element check). */
export function isValidBranchIdsList(arr: unknown): arr is string[] {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  for (const v of arr) {
    if (!isValidUuid(v)) return false;
  }
  return true;
}

/** Compose `isValidBranchIdsList` + a non-empty check; returns the
 *  array unchanged on success or null on failure. */
export function normalizeBranchIds(arr: unknown): string[] | null {
  if (!isValidBranchIdsList(arr)) return null;
  return arr as string[];
}

export type CreateDoctorError =
  | 'invalid_full_name'
  | 'invalid_email'
  | 'invalid_branch_ids'
  | 'invalid_specialty';

export type CreateDoctorResult =
  | {
      ok: true;
      fullName: string;
      email: string;
      branchIds: string[];
      /** Optional — null when not supplied. */
      specialty: string | null;
    }
  | { ok: false; error: CreateDoctorError };

/** Tagged validator for the POST /admin/doctors body shape. Validates
 *  full_name + email + branch_ids; returns the canonical normalized
 *  values on success. `specialty` is optional (E7-UX). */
export function validateCreateDoctorBody(
  body: unknown,
): CreateDoctorResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'invalid_full_name' };
  }
  const r = body as Record<string, unknown>;
  if (!('full_name' in r) || !isValidFullName(r['full_name'])) {
    return { ok: false, error: 'invalid_full_name' };
  }
  if (!('email' in r) || !isValidEmail(r['email'])) {
    return { ok: false, error: 'invalid_email' };
  }
  if (!('branch_ids' in r) || !isValidBranchIdsList(r['branch_ids'])) {
    return { ok: false, error: 'invalid_branch_ids' };
  }
  let specialty: string | null = null;
  if ('specialty' in r) {
    const raw = r['specialty'];
    if (raw === null) {
      specialty = null;
    } else if (isValidSpecialty(raw)) {
      specialty = normalizeSpecialty(raw);
    } else {
      return { ok: false, error: 'invalid_specialty' };
    }
  }
  return {
    ok: true,
    fullName: normalizeFullName(r['full_name'] as string),
    email: normalizeEmail(r['email'] as string),
    branchIds: r['branch_ids'] as string[],
    specialty,
  };
}

export type PatchDoctorError =
  | 'invalid_full_name'
  | 'invalid_active'
  | 'invalid_specialty';

export type PatchDoctorResult =
  | {
      ok: true;
      fullName: string | null;
      active: boolean | null;
      /** `undefined` = "not present in the body, leave alone".
       *  `null` = "explicitly clear it". A string = the new value. */
      specialty: string | null | undefined;
    }
  | { ok: false; error: PatchDoctorError };

/** Tagged validator for the PATCH /admin/doctors/:id body. Each field is
 *  optional; at least one must be present (the route rejects empty
 *  bodies separately with `no_fields_to_update`). */
export function validatePatchDoctorBody(body: unknown): PatchDoctorResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'invalid_full_name' };
  }
  const r = body as Record<string, unknown>;
  let fullName: string | null = null;
  let active: boolean | null = null;
  let specialty: string | null | undefined = undefined;
  if ('full_name' in r) {
    if (!isValidFullName(r['full_name'])) {
      return { ok: false, error: 'invalid_full_name' };
    }
    fullName = normalizeFullName(r['full_name'] as string);
  }
  if ('active' in r) {
    if (!isValidActive(r['active'])) {
      return { ok: false, error: 'invalid_active' };
    }
    active = r['active'] as boolean;
  }
  if ('specialty' in r) {
    // `null` clears the specialty; a string sets it (an empty string
    // also clears it). Anything else is a shape error.
    const raw = r['specialty'];
    if (raw === null) {
      specialty = null;
    } else if (isValidSpecialty(raw)) {
      specialty = normalizeSpecialty(raw);
    } else {
      return { ok: false, error: 'invalid_specialty' };
    }
  }
  return { ok: true, fullName, active, specialty };
}

export type PutBranchesError = 'invalid_branch_ids';

export type PutBranchesResult =
  | { ok: true; branchIds: string[] }
  | { ok: false; error: PutBranchesError };

/** Tagged validator for the PUT /admin/doctors/:id/branches body. Empty
 *  arrays are rejected as `doctor_must_work_at_least_one_branch` (this
 *  validator only handles the malformed/UUID cases; the empty case is
 *  handled by the route so it can emit the specific error code). */
export function validatePutBranchesBody(body: unknown): PutBranchesResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'invalid_branch_ids' };
  }
  const r = body as Record<string, unknown>;
  if (!('branch_ids' in r)) {
    return { ok: false, error: 'invalid_branch_ids' };
  }
  // Empty arrays are a *shape* error (not a malformed-UUID error), so
  // we check for it separately; the route maps it to
  // `doctor_must_work_at_least_one_branch`.
  if (Array.isArray(r['branch_ids']) && r['branch_ids'].length === 0) {
    return { ok: false, error: 'invalid_branch_ids' };
  }
  if (!isValidBranchIdsList(r['branch_ids'])) {
    return { ok: false, error: 'invalid_branch_ids' };
  }
  return { ok: true, branchIds: r['branch_ids'] as string[] };
}

/** Parse `?active=true|false` query filter. Returns `null` when unset,
 *  `true`/`false` for valid values, or throws a tagged error for invalid
 *  values. The route catches and emits `invalid_active_filter`. */
export function parseActiveFilter(raw: unknown):
  | { ok: true; value: boolean | null }
  | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false };
}