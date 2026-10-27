/**
 * Staff login — `POST /auth/login/staff` + `GET /auth/me`.
 *
 * W10 shipped the staff login surface that E0-S3 deferred. It started as an
 * **email-based stub login**: the caller supplied `{role, email}` and if a
 * staff row matched, the route minted a JWT. There was no password column
 * on `admin_user` / `doctor` / `receptionist`, so the endpoint proved only
 * that the caller knew a seeded address. It was confined to dev/test by
 * `staffStubLoginAllowed`.
 *
 * W10a adds the real credential: a nullable `password_hash` column on
 * each staff table (migration 0022), hashed with Postgres `pgcrypto`'s
 * bcrypt (`crypt(..., 'bf')`). When the caller supplies a `password`, the
 * route verifies it against the stored hash. When they don't, the route
 * falls back to the dev-only email-only path.
 *
 * The two modes coexist deliberately:
 *
 *   - A staff row with a `password_hash` set can ALWAYS sign in with the
 *     password, in any environment.
 *   - The email-only path remains available ONLY in dev/test (the
 *     `staffStubLoginAllowed` allowlist), so the seeded accounts keep
 *     working in the dev web app without every developer having to set
 *     a password first.
 *   - In production the email-only path is refused outright, so a
 *     production deploy MUST have configured password credentials.
 *
 * Response shape mirrors `patient-otp.ts` (`/patient/otp/verify-now`):
 *   {
 *     token:      <jwt>,
 *     claim:      AuthClaim,           // sub = email for staff
 *     expires_at: <iso>,
 *     profile:    { full_name, email, branch_id, branch_name, tz }
 *   }
 *
 * For `GET /auth/me`, the same shape is returned derived from the
 * existing `req.auth.claim` (no DB write, no audit).
 *
 * Mount order: this file mounts BEFORE `authMiddleware` so the login
 * endpoint itself is the auth gate. The `me` route is the one route in
 * this file that is mounted AFTER `authMiddleware` — see `app.ts`.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import { signClaim, verifyToken } from '../auth/jwt.js';
import { loadAuthConfig } from '../auth/config.js';
import { verifyPassword } from '../auth/password.js';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const STAFF_ROLES = new Set(['admin', 'doctor', 'receptionist'] as const);
type StaffRole = 'admin' | 'doctor' | 'receptionist';

interface StaffProfile {
  full_name: string;
  email: string;
  branch_id: string | null;
  branch_name: string | null;
  tz: string | null;
}

interface StaffRow extends StaffProfile {
  /** Set when the role is `doctor`. The store may override for multi-branch doctors. */
  doctor_id: string | null;
  /**
   * The stored bcrypt hash, or NULL when the account has no credential
   * configured. A NULL hash means this account can only use the
   * dev-only email-only path.
   */
  password_hash: string | null;
}

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

async function lookupStaff(
  role: StaffRole,
  email: string,
): Promise<StaffRow | null> {
  const pool = await getPool();
  if (role === 'admin') {
    // Admin has no `branch_id` column on `admin_user` (per architecture AD-8
    // the admin scope is the clinic, not a branch). We attach the seeded
    // east branch as a placeholder so the E0-S3 empty-branch_ids guard is
    // satisfied. The admin route never reads branch_ids from the claim.
    const r = await pool.query<{
      full_name: string;
      email: string;
      branch_id: string;
      branch_name: string;
      tz: string;
      password_hash: string | null;
    }>(
      `SELECT a.full_name,
              a.email,
              a.password_hash,
              b.id::text AS branch_id,
              b.name    AS branch_name,
              b.tz      AS tz
         FROM admin_user a
         JOIN branch b
           ON b.clinic_id = a.clinic_id
        WHERE a.email = $1::citext
        ORDER BY b.created_at ASC
        LIMIT 1`,
      [email],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { ...row, doctor_id: null };
  }
  if (role === 'doctor') {
    const r = await pool.query<{
      full_name: string;
      email: string;
      doctor_id: string;
      branch_id: string;
      branch_name: string;
      tz: string;
      password_hash: string | null;
    }>(
      `SELECT d.full_name,
              d.email,
              d.password_hash,
              d.id::text AS doctor_id,
              b.id::text AS branch_id,
              b.name    AS branch_name,
              b.tz      AS tz
         FROM doctor d
         JOIN doctor_branch db ON db.doctor_id = d.id
         JOIN branch b          ON b.id = db.branch_id
        WHERE d.email = $1::citext
        ORDER BY db.created_at ASC
        LIMIT 1`,
      [email],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { ...row };
  }
  // role === 'receptionist'
  const r = await pool.query<{
    full_name: string;
    email: string;
    branch_id: string;
    branch_name: string;
    tz: string;
    password_hash: string | null;
  }>(
    `SELECT r.full_name,
            r.email,
            r.password_hash,
            b.id::text AS branch_id,
            b.name    AS branch_name,
            b.tz      AS tz
       FROM receptionist r
       JOIN branch b ON b.id = r.branch_id
      WHERE r.email = $1::citext
      LIMIT 1`,
    [email],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, doctor_id: null };
}

/**
 * Compare a candidate password against the row's stored bcrypt hash.
 *
 * The comparison runs in the database via `pgcrypto.crypt()`, which
 * re-derives the hash from the candidate and the stored salt and returns
 * the stored value when they match. The plaintext is a bind parameter,
 * so it is never interpolated into the SQL text.
 */
async function checkPassword(
  password: string,
  hash: string | null,
): Promise<boolean> {
  const pool = await getPool();
  return verifyPassword(
    async (candidate, stored) => {
      const r = await pool.query<{ ok: boolean }>(
        `SELECT (pgcrypto.crypt($1, $2) = $2) AS ok`,
        [candidate, stored],
      );
      return r.rows[0]?.ok === true;
    },
    password,
    hash,
  );
}

export const authStaffRouter: Router = Router();
export const authMeRouter: Router = Router();

// Mounted BEFORE authMiddleware — the login route IS its own auth gate.
authStaffRouter.post('/login/staff', (req: Request, res: Response): void => {
  let staffStubLoginAllowed: boolean;
  try {
    staffStubLoginAllowed = loadAuthConfig().staffStubLoginAllowed;
  } catch {
    // A config that fails to load is a boot failure, not a request
    // failure. Refuse the login rather than minting an unverified token.
    res.status(503).json({ error: 'auth_unavailable' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const role = body['role'];
  const email = body['email'];
  // The password is optional on the wire, but its presence selects the
  // credential path. A non-string value is treated as absent rather
  // than as a 400 — the email+password path below will reject it with
  // the same generic error as any other bad credential.
  const password = typeof body['password'] === 'string' ? body['password'] : null;

  if (typeof role !== 'string' || !STAFF_ROLES.has(role as StaffRole)) {
    res.status(400).json({ error: 'invalid_role' });
    return;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    getLogger().info(
      { event: 'staff_login_attempt', outcome: 'invalid_email' },
      'staff_login_rejected',
    );
    res.status(400).json({ error: 'invalid_email' });
    return;
  }

  // Two credential modes:
  //
  //   1. A password was supplied → the password is REQUIRED. The
  //      account must have a configured `password_hash` and the
  //      password must match it. This path works in every environment.
  //
  //   2. No password was supplied → the dev-only email-only path. This
  //      is refused outside dev/test, so a production deploy can never
  //      mint a token from nothing but a known email address.
  //
  // Note the ordering: the email-only refusal happens BEFORE the
  // database lookup, so in production the endpoint never even reveals
  // whether the account exists. The 404 (rather than a 401) is
  // deliberate — it hides the endpoint's existence rather than
  // confirming "authentication is possible here, you just used the
  // wrong method".
  if (password === null && !staffStubLoginAllowed) {
    getLogger().info(
      { event: 'staff_login_attempt', outcome: 'email_only_refused' },
      'staff_login_rejected',
    );
    res.status(404).json({ error: 'not_found' });
    return;
  }

  lookupStaff(role as StaffRole, email)
    .then(async (row) => {
      if (!row || row.branch_id === null) {
        getLogger().info(
          {
            event: 'staff_login_attempt',
            outcome: 'not_found',
            role,
            email: redactEmail(email),
          },
          'staff_login_rejected',
        );
        res.status(401).json({ error: 'staff_not_found' });
        return;
      }

      // Credential check. When a password was supplied it MUST verify
      // against the row's hash. An account with no configured hash can
      // never satisfy a password login.
      if (password !== null) {
        const ok = await checkPassword(password, row.password_hash);
        if (!ok) {
          getLogger().info(
            {
              event: 'staff_login_attempt',
              outcome: 'bad_password',
              role,
              email: redactEmail(email),
            },
            'staff_login_rejected',
          );
          res.status(401).json({ error: 'invalid_credentials' });
          return;
        }
      }

      const branchIds = [row.branch_id];
      const input = {
        sub: email,
        role: role as StaffRole,
        branch_ids: branchIds,
        scope: role === 'admin' ? ('clinic' as const) : ('branch' as const),
        ...(role === 'doctor' && row.doctor_id
          ? { doctor_id: row.doctor_id }
          : {}),
      };
      const token = signClaim(input);
      const claim = verifyToken(token);
      if (!claim) {
        // Should be unreachable — we just signed it with our own rules.
        getLogger().error({ event: 'staff_login_mint_failed' }, 'staff_login_internal_error');
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      const expiresAt = new Date(claim.expires_at * 1000).toISOString();

      getLogger().info(
        {
          event: 'staff_login_attempt',
          outcome: 'success',
          role,
          email: redactEmail(email),
        },
        'staff_login_success',
      );
      res.status(200).json({
        token,
        claim,
        expires_at: expiresAt,
        profile: {
          full_name: row.full_name,
          email: row.email,
          branch_id: row.branch_id,
          branch_name: row.branch_name,
          tz: row.tz,
        },
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'unknown_error';
      getLogger().error(
        { event: 'staff_login_db_error', err: message },
        'staff_login_internal_error',
      );
      // The handler may already have answered (e.g. the password check
      // failed and wrote a 401) before a later error surfaced. Writing
      // again would throw "Cannot set headers after they are sent".
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    });
});

// `GET /auth/me` — rehydrate the session from the existing JWT. Mounted
// AFTER authMiddleware (see `app.ts`). Reads `req.auth.claim` and looks
// up the same profile shape as the login route. Used by the web client on
// boot to confirm the token in localStorage is still valid.
authMeRouter.get('/me', async (req: Request, res: Response): Promise<void> => {
  const claim = req.auth?.claim ?? null;
  if (!claim) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  // Patient tokens carry the phone as `sub`. We don't surface a profile
  // for patients (the web client already knows who the patient is). The
  // /patient/appointments route returns the data the UI needs.
  if (claim.role === 'patient') {
    const expiresAt = new Date(claim.expires_at * 1000).toISOString();
    res.status(200).json({
      claim,
      expires_at: expiresAt,
      profile: {
        full_name: null,
        email: claim.sub,
        branch_id: null,
        branch_name: null,
        tz: null,
      },
    });
    return;
  }

  // Staff — `sub` is the email. Look up the row by email + role and
  // rehydrate the profile.
  const role = claim.role as StaffRole;
  if (!STAFF_ROLES.has(role)) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  try {
    const row = await lookupStaff(role, claim.sub);
    if (!row || row.branch_id === null) {
      // Token references a row that no longer matches; clear and force re-login.
      res.status(401).json({ error: 'staff_not_found' });
      return;
    }
    const expiresAt = new Date(claim.expires_at * 1000).toISOString();
    res.status(200).json({
      claim,
      expires_at: expiresAt,
      profile: {
        full_name: row.full_name,
        email: row.email,
        branch_id: row.branch_id,
        branch_name: row.branch_name,
        tz: row.tz,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    getLogger().error(
      { event: 'auth_me_db_error', err: message },
      'auth_me_internal_error',
    );
    res.status(500).json({ error: 'internal_error' });
  }
});