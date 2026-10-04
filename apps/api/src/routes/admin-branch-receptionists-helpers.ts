/**
 * Pure validation helpers for admin-branch-receptionists routes.
 *
 * No I/O, no DB. Mirrors the admin-branch-doctors-helpers.ts validator
 * style (E1-S3). Receptionists have exactly ONE branch_id (BR-004),
 * so the validator surface is single-branch rather than list-of-branches.
 *
 * Spec-1-4 §Boundaries:
 *   - full_name: 1..120 chars, trimmed.
 *   - email: 3..254 chars, basic RFC-ish format, lowercased for storage.
 *   - branch_id: single valid UUID.
 *   - active: typeof boolean.
 *   - The validator returns a discriminated union so a single 400 envelope
 *     can disambiguate WHICH field failed (invalid_full_name /
 *     invalid_email / invalid_branch_id / invalid_active).
 */

const NAME_MIN = 1;
const NAME_MAX = 120;
const EMAIL_MIN = 3;
const EMAIL_MAX = 254;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidFullName(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  return trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX;
}

export function normalizeFullName(s: string): string {
  return s.trim();
}

export function isValidEmail(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length < EMAIL_MIN || s.length > EMAIL_MAX) return false;
  return EMAIL_RE.test(s);
}

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function isValidActive(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export type CreateReceptionistError =
  | 'invalid_full_name'
  | 'invalid_email'
  | 'invalid_branch_id';

export type CreateReceptionistResult =
  | {
      ok: true;
      fullName: string;
      email: string;
      branchId: string;
    }
  | { ok: false; error: CreateReceptionistError };

export function validateCreateReceptionistBody(
  body: unknown,
): CreateReceptionistResult {
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
  if (!('branch_id' in r) || !isValidUuid(r['branch_id'])) {
    return { ok: false, error: 'invalid_branch_id' };
  }
  return {
    ok: true,
    fullName: normalizeFullName(r['full_name'] as string),
    email: normalizeEmail(r['email'] as string),
    branchId: r['branch_id'] as string,
  };
}

export type PatchReceptionistError =
  | 'invalid_full_name'
  | 'invalid_active'
  | 'invalid_branch_id';

export type PatchReceptionistResult =
  | {
      ok: true;
      fullName: string | null;
      active: boolean | null;
      branchId: string | null;
    }
  | { ok: false; error: PatchReceptionistError };

export function validatePatchReceptionistBody(
  body: unknown,
): PatchReceptionistResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'invalid_full_name' };
  }
  const r = body as Record<string, unknown>;
  let fullName: string | null = null;
  let active: boolean | null = null;
  let branchId: string | null = null;
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
  if ('branch_id' in r) {
    if (!isValidUuid(r['branch_id'])) {
      return { ok: false, error: 'invalid_branch_id' };
    }
    branchId = r['branch_id'] as string;
  }
  return { ok: true, fullName, active, branchId };
}

export function parseActiveFilter(raw: unknown):
  | { ok: true; value: boolean | null }
  | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false };
}