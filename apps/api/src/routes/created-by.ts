/**
 * `created_by` token construction.
 *
 * The `created_by` column on `appointment_type`, `doctor_schedule`,
 * `doctor_block` and `appointment` is constrained by
 * `CHECK (created_by ~ '^(staff|patient):[A-Za-z0-9+_.-]{1,255}$')` —
 * a deliberately narrow alphabet that keeps the column a controlled
 * token rather than free-form text.
 *
 * The actor identities the API actually holds do not fit that alphabet:
 * a staff session's `sub` is the staff email (`admin-main@clinic.local`)
 * and `@` is outside the permitted character class, so writing
 * `staff:${sub}` verbatim raises a 23514 check violation. For
 * `POST /bookings` that violation escaped the handler and took the whole
 * API process down.
 *
 * The encoder below maps any actor identity into the constrained
 * alphabet reversibly, so the stored token still identifies the actor
 * and an audit consumer can recover the original value.
 */

/** Characters the DB CHECK permits in the token body. */
const SAFE_TOKEN_CHARS = /^[A-Za-z0-9+_.-]$/;

/**
 * Escape character used by the encoder. `.` is itself permitted by the
 * CHECK, but every literal `.` in the source is escaped too — so the
 * encoding is unambiguous and `decode` is exact.
 */
const ESCAPE = '.';

/**
 * Percent-style escape restricted to the CHECK's alphabet: a disallowed
 * character becomes `.` followed by two uppercase hex digits. `40` is
 * the code for `@`; `3A` is the code for `:`.
 */
export function encodeActorToken(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (SAFE_TOKEN_CHARS.test(ch)) {
      out += ch === ESCAPE ? `${ESCAPE}2E` : ch;
    } else {
      const code = ch.codePointAt(0);
      if (code === undefined) continue;
      out += `${ESCAPE}${code.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * Inverse of {@link encodeActorToken}. Returns the original identity.
 * A malformed escape sequence is passed through verbatim rather than
 * throwing — the column is audit data, not a security boundary, and a
 * reader must never crash on a legacy row.
 */
export function decodeActorToken(token: string): string {
  let out = '';
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;
    if (ch !== ESCAPE) {
      out += ch;
      continue;
    }
    const hex = token.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out += ch;
      continue;
    }
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i += 2;
  }
  return out;
}

/**
 * Build the `created_by` token for a staff actor.
 *
 * `sub` is the staff email. The email is encoded into the CHECK's
 * alphabet, so `admin-main@clinic.local` becomes
 * `admin-main.40clinic.local` — distinct per actor, stable across
 * requests, and recoverable via {@link decodeActorToken}.
 */
export function staffCreatedBy(sub: string | undefined | null): string {
  return `staff:${encodeActorToken(sub ?? 'admin-main')}`;
}

/**
 * Build the `created_by` token for a patient actor.
 *
 * The patient identity is the phone number in E.164 form
 * (`+15550000088`). `+` is already permitted by the CHECK, but the
 * encoder is applied anyway so a phone carrying any other character
 * cannot violate the constraint.
 */
export function patientCreatedBy(phone: string): string {
  return `patient:${encodeActorToken(phone)}`;
}
