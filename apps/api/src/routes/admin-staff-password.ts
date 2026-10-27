/**
 * Admin staff-password routes — set / clear a staff credential.
 *
 * W10a closes the "stub auth" P2 gap. Before this story the staff tables
 * had no credential at all: `POST /auth/login/staff` accepted a bare
 * email and minted a token, which was confined to dev/test by
 * `staffStubLoginAllowed`. This route is how a credential gets SET, so
 * a production deploy has a way to provision one.
 *
 * Routes:
 *   POST /admin/staff/:role/:id/password — set (or replace) the password
 *   DELETE /admin/staff/:role/:id/password — clear the credential, so the
 *                                            account reverts to the
 *                                            dev-only email-only path
 *
 * `:role` is one of `admin` | `doctor` | `receptionist` and selects the
 * table. `:id` is the staff row's uuid.
 *
 * There is deliberately NO read route that returns the hash — a hash is
 * a credential, and there is no reason for it to leave the database.
 * The only observable state is "is a credential configured", which the
 * `POST` response reports via `credential_configured`.
 *
 * Password policy (see `auth/password.ts`):
 *   - at least 12 characters (NIST SP 800-63B floor for user-chosen
 *     secrets)
 *   - under 72 UTF-8 bytes — bcrypt truncates at 72 bytes, so a longer
 *     password would silently collide with any other password sharing
 *     its first 72 bytes
 *
 * Audit: every attempt (success or failure) is logged with the email
 * redacted, matching the staff-login route's convention.
 */
import { Router, type Request, type Response } from 'express';
import { getPool } from '../db/pool.js';
import { getLogger } from '../middleware/log.js';
import {
  hashPassword,
  assertPasswordAcceptable,
  PasswordError,
} from '../auth/password.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STAFF_ROLES = ['admin', 'doctor', 'receptionist'] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

/** The table each role lives in. */
const ROLE_TABLE: Record<StaffRole, string> = {
  admin: 'admin_user',
  doctor: 'doctor',
  receptionist: 'receptionist',
};

function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export const adminStaffPasswordRouter: Router = Router();

/**
 * Look up the email for a staff row, so the audit log can identify the
 * account without the hash. Returns null when the row does not exist.
 */
async function lookupEmail(
  role: StaffRole,
  id: string,
): Promise<string | null> {
  const pool = await getPool();
  const table = ROLE_TABLE[role];
  // `role` is validated against a fixed allowlist above, so the table
  // name cannot be attacker-controlled — but it is still interpolated
  // rather than bound, because a table name cannot be a bind
  // parameter. The allowlist is what makes this safe.
  const r = await pool.query<{ email: string }>(
    `SELECT email::text AS email FROM ${table} WHERE id = $1::uuid`,
    [id],
  );
  return r.rows[0]?.email ?? null;
}

/**
 * Hash the password in the database.
 *
 * `pgcrypto.crypt($1, gen_salt('bf', cost))` produces the bcrypt hash.
 * `gen_salt`'s second argument is bcrypt's cost factor (the default is
 * 10, which is what `BCRYPT_COST` names).
 */
async function bcryptHash(password: string): Promise<string> {
  const pool = await getPool();
  const r = await pool.query<{ hash: string }>(
    `SELECT pgcrypto.crypt($1, pgcrypto.gen_salt('bf', $2)) AS hash`,
    [password, 10],
  );
  const hash = r.rows[0]?.hash;
  if (!hash) throw new PasswordError('password_hash_invalid');
  return hash;
}

adminStaffPasswordRouter.post(
  '/staff/:role/:id/password',
  async (req: Request, res: Response): Promise<void> => {
    const { role, id } = req.params as { role: string; id: string };

    if (!isStaffRole(role)) {
      res.status(400).json({ error: 'invalid_role' });
      return;
    }
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = body['password'];

    if (typeof password !== 'string') {
      res.status(400).json({ error: 'password_required' });
      return;
    }

    // Validate the policy BEFORE hashing so a bad password fails fast
    // and costs nothing.
    try {
      assertPasswordAcceptable(password);
    } catch (err) {
      if (err instanceof PasswordError) {
        res.status(400).json({ error: err.code });
        return;
      }
      throw err;
    }

    const email = await lookupEmail(role, id);
    if (email === null) {
      getLogger().info(
        { event: 'staff_password_set', outcome: 'not_found', role },
        'staff_password_rejected',
      );
      res.status(404).json({ error: 'staff_not_found' });
      return;
    }

    const hash = await hashPassword(bcryptHash, password);
    const pool = await getPool();
    const table = ROLE_TABLE[role];
    const r = await pool.query(
      `UPDATE ${table} SET password_hash = $2 WHERE id = $1::uuid`,
      [id, hash],
    );
    if (r.rowCount !== 1) {
      // The row vanished between the SELECT and the UPDATE. Treat it
      // as not-found rather than reporting a success that did not land.
      getLogger().info(
        { event: 'staff_password_set', outcome: 'not_found', role },
        'staff_password_rejected',
      );
      res.status(404).json({ error: 'staff_not_found' });
      return;
    }

    getLogger().info(
      {
        event: 'staff_password_set',
        outcome: 'success',
        role,
        email: redactEmail(email),
      },
      'staff_password_set',
    );
    res.status(200).json({
      credential_configured: true,
      role,
      id,
    });
  },
);

adminStaffPasswordRouter.delete(
  '/staff/:role/:id/password',
  async (req: Request, res: Response): Promise<void> => {
    const { role, id } = req.params as { role: string; id: string };

    if (!isStaffRole(role)) {
      res.status(400).json({ error: 'invalid_role' });
      return;
    }
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }

    const email = await lookupEmail(role, id);
    if (email === null) {
      getLogger().info(
        { event: 'staff_password_clear', outcome: 'not_found', role },
        'staff_password_rejected',
      );
      res.status(404).json({ error: 'staff_not_found' });
      return;
    }

    const pool = await getPool();
    const table = ROLE_TABLE[role];
    const r = await pool.query(
      `UPDATE ${table} SET password_hash = NULL WHERE id = $1::uuid`,
      [id],
    );
    if (r.rowCount !== 1) {
      res.status(404).json({ error: 'staff_not_found' });
      return;
    }

    getLogger().info(
      {
        event: 'staff_password_clear',
        outcome: 'success',
        role,
        email: redactEmail(email),
      },
      'staff_password_clear',
    );
    res.status(200).json({
      credential_configured: false,
      role,
      id,
    });
  },
);
