/**
 * Pure validation helpers for admin-doctor-block routes.
 *
 * No I/O, no DB. Mirrors admin-doctor-schedule-helpers.ts shape.
 *
 * Spec-2-2 §Boundaries:
 *   - branch_id: valid UUID; must be in doctor's branches (route-level check).
 *   - start_datetime, end_datetime: ISO 8601 with TZ; `end > start`.
 *   - reason: optional; if provided, 1..500 chars after trim.
 *   - start_datetime must be > now() (blocks can only be future-dated).
 *
 * The phone mask format `+1XXXXXXXXXX` matches the E1-S2/E2-S1 admin-impact
 * privacy invariant.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

export function isValidUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Mask a phone number to `+1XXXXXXXXXX`. Preserves country code (+1) and
 *  3-digit area-code indicator while hiding the 8-digit local portion.
 *  Matches E1-S2/E2-S1 admin-impact-preview privacy invariant. */
export function maskPhone(phone: string | null | undefined): string {
  if (typeof phone !== 'string') return '+1XXXXXXXXXX';
  const stripped = phone.replace(/[^\d+]/g, '');
  if (!stripped.startsWith('+')) return '+1XXXXXXXXXX';
  if (stripped.length < 5) return '+1XXXXXXXXXX';
  const cc = stripped.slice(0, 1);
  const area = stripped.slice(1, 4);
  return `${cc}${area}XXXXXXXX`;
}

/** True iff `s` parses as an ISO 8601 timestamp. Defensive — accept both
 *  `2026-10-04T12:00:00Z` and `2026-10-04T12:00:00.000Z` etc. The route
 *  passes the parsed Date to Postgres `::timestamptz`, which accepts
 *  any well-formed ISO string. */
export function isValidDateTimeString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  // Reject strings without TZ info — Postgres would interpret as local
  // time, which is ambiguous and not what we want.
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms);
}

export interface CreateBlockBody {
  branchId: string;
  startDatetime: string;
  endDatetime: string;
  reason: string | null;
}

export type CreateBlockError =
  | 'invalid_branch_id'
  | 'invalid_start_datetime'
  | 'invalid_end_datetime'
  | 'invalid_time_range'
  | 'start_in_past'
  | 'invalid_reason';

export type ValidateBlockResult =
  | { ok: true; body: CreateBlockBody }
  | { ok: false; error: CreateBlockError };

/** Trim and clamp reason to 1..500 chars. NULL passthrough for absent. */
export function normalizeReason(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > REASON_MAX ? trimmed.slice(0, REASON_MAX) : trimmed;
}

export function validateCreateBlockBody(
  raw: unknown,
  nowMs: number,
): ValidateBlockResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'invalid_branch_id' };
  }
  const r = raw as Record<string, unknown>;
  if (!isValidUuid(r['branch_id'])) {
    return { ok: false, error: 'invalid_branch_id' };
  }
  if (!isValidDateTimeString(r['start_datetime'])) {
    return { ok: false, error: 'invalid_start_datetime' };
  }
  if (!isValidDateTimeString(r['end_datetime'])) {
    return { ok: false, error: 'invalid_end_datetime' };
  }
  const startMs = Date.parse(r['start_datetime'] as string);
  const endMs = Date.parse(r['end_datetime'] as string);
  if (endMs <= startMs) {
    return { ok: false, error: 'invalid_time_range' };
  }
  if (startMs <= nowMs) {
    return { ok: false, error: 'start_in_past' };
  }
  if (r['reason'] !== undefined && r['reason'] !== null) {
    if (typeof r['reason'] !== 'string') {
      return { ok: false, error: 'invalid_reason' };
    }
    const trimmed = (r['reason'] as string).trim();
    if (trimmed.length > REASON_MAX) {
      return { ok: false, error: 'invalid_reason' };
    }
  }
  return {
    ok: true,
    body: {
      branchId: r['branch_id'] as string,
      startDatetime: r['start_datetime'] as string,
      endDatetime: r['end_datetime'] as string,
      reason: normalizeReason(r['reason']),
    },
  };
}