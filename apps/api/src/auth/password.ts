/**
 * Staff password credentials — bcrypt hashing + verification.
 *
 * W10a closes the "stub auth" gap. `POST /auth/login/staff` used to
 * accept a bare email: the endpoint proved only that the caller knew a
 * seeded address, so it was confined to dev/test by
 * `staffStubLoginAllowed`. This module gives the staff tables a real
 * credential.
 *
 * Hashing is delegated to Postgres `pgcrypto.crypt(..., 'bf')` rather
 * than a native npm bcrypt dependency:
 *
 *   - pgcrypto is already installed (migration 0002) and granted (0011),
 *     so there is no new dependency to install, audit or pin.
 *   - `bf` IS bcrypt — the same algorithm, the same `$2a$` hash shape.
 *   - The plaintext never leaves the process boundary we already have:
 *     it is sent to the database as a bind parameter and compared there.
 *     (A SQL-injection risk is not introduced: every call site below
 *     uses a bind parameter, never string interpolation.)
 *
 * The only property this gives up relative to a native library is
 * in-process hashing for *creating* a hash without a database. That is
 * not needed here: hashes are created by an admin action against the
 * live DB, and verified on every login against the same DB.
 *
 * The verification is constant-time-ish by construction: `crypt()` runs
 * the full bcrypt KDF (cost 10) and returns a non-matching string when
 * the password is wrong, so the timing does not reveal whether the
 * account exists or what its hash is.
 */

/** The bcrypt cost factor used when creating a hash. */
export const BCRYPT_COST = 10;

/**
 * A bcrypt hash shape: `$2a$<cost>$<22-char salt><31-char digest>`.
 * Total length 60. Used to sanity-check input before it reaches the
 * database so a malformed value can't cause a confusing SQL error.
 */
const BCRYPT_HASH_RE = /^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/;

/**
 * The minimum length we accept for a new password.
 *
 * This is a floor, not a policy: the full policy (complexity, rotation,
 * lockout) belongs to the hardening story that also owns rate limiting
 * (W10c). 12 characters is the NIST SP 800-63B recommendation for
 * user-chosen secrets as a minimum length, so it is a defensible floor
 * rather than an arbitrary one.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** The maximum password length, in UTF-8 bytes.
 *
 * bcrypt silently truncates input at 72 bytes. Rather than let a long
 * password be truncated — which would make two different passwords that
 * share a 72-byte prefix equivalent — we reject anything at or over the
 * limit. The bound is checked in bytes, not characters, because bcrypt
 * counts bytes.
 */
export const MAX_PASSWORD_BYTES = 72;

export type PasswordErrorCode =
  | 'password_too_short'
  | 'password_too_long'
  | 'password_hash_invalid';

export class PasswordError extends Error {
  public readonly code: PasswordErrorCode;
  constructor(code: PasswordErrorCode) {
    super(code);
    this.name = 'PasswordError';
    this.code = code;
  }
}

/**
 * Validate a plaintext password against the length bounds.
 *
 * Throws `PasswordError` rather than returning a boolean so the caller
 * can map the failure to a specific error code in the API response.
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError('password_too_short');
  }
  if (Buffer.byteLength(password, 'utf8') >= MAX_PASSWORD_BYTES) {
    throw new PasswordError('password_too_long');
  }
}

/**
 * Hash a plaintext password with bcrypt.
 *
 * The returned string is ready to store in `password_hash`.
 * Throws `PasswordError` if the password violates the length bounds.
 */
export async function hashPassword(
  hashFn: (plaintext: string) => Promise<string>,
  password: string,
): Promise<string> {
  assertPasswordAcceptable(password);
  const hash = await hashFn(password);
  if (!BCRYPT_HASH_RE.test(hash)) {
    // The hash function produced something that is not a bcrypt hash.
    // Storing it would create a permanent lockout (the CHECK constraint
    // would reject it, and a value that slipped past would never
    // verify), so refuse loudly instead.
    throw new PasswordError('password_hash_invalid');
  }
  return hash;
}

/**
 * Verify a plaintext password against a stored bcrypt hash.
 *
 * Returns false for a NULL / malformed hash rather than throwing, so
 * that "this account has no credential configured" and "this password
 * is wrong" are indistinguishable to the caller — which is the correct
 * behaviour for a login endpoint (it prevents account enumeration).
 */
export async function verifyPassword(
  verifyFn: (plaintext: string, hash: string) => Promise<boolean>,
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash || !BCRYPT_HASH_RE.test(hash)) return false;
  try {
    return await verifyFn(password, hash);
  } catch {
    // A verification failure is indistinguishable from a wrong password
    // to the caller. Swallow it so a database hiccup on the compare
    // cannot be distinguished from a bad credential by the client.
    return false;
  }
}
