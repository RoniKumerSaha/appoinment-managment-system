/**
 * Auth middleware.
 *
 * Two parsing paths:
 *   1. `Authorization: Bearer <jwt>` — the production path. `verifyToken`
 *      enforces the full claim shape (aud, iss, jti, iat, exp, enum role,
 *      enum scope, branch_ids length + element validation, etc.). Invalid
 *      tokens yield `req.auth = { claim: null }` (anonymous); middleware
 *      never 4xxs the request directly — route guards decide.
 *   2. `x-auth-claim: <json>` — DEV/TEST ONLY. Allows the existing 12
 *      E0-S1 `auth.test.ts` cases to keep passing. Disabled when
 *      `config.allowDebugHeader === false` (i.e. `NODE_ENV === 'production'`).
 *
 * Body-NEVER-consulted invariant (Architecture §3.1): the body fields
 * `role`, `branch_ids`, `scope`, `doctor_id` are NEVER read by this
 * middleware. A regression test in `auth-bearer.test.ts` asserts this
 * against the Bearer path; the E0-S1 `auth.test.ts` case covers the
 * debug path.
 */
import type { Request, Response, NextFunction } from 'express';
import type { AuthClaim, AuthContext } from '../types/auth.js';
import { attachLogContext } from './log.js';
import { loadAuthConfig } from '../auth/config.js';
import { verifyToken } from '../auth/jwt.js';

const MAX_X_AUTH_CLAIM_BYTES = 4096;
const MAX_BRANCH_IDS_DEBUG = 256;

function isRole(v: unknown): v is AuthClaim['role'] {
  return v === 'patient' || v === 'receptionist' || v === 'doctor' || v === 'admin';
}

function isScope(v: unknown): v is AuthClaim['scope'] {
  return v === 'self' || v === 'branch' || v === 'clinic' || v === 'global';
}

function parseClaimHeader(raw: string | undefined): AuthClaim | null {
  if (!raw) return null;
  if (raw.length > MAX_X_AUTH_CLAIM_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  if (typeof c['sub'] !== 'string') return null;
  if (!isRole(c['role'])) return null;
  if (!Array.isArray(c['branch_ids'])) return null;
  if (c['branch_ids'].length > MAX_BRANCH_IDS_DEBUG) return null;
  if (!(c['branch_ids'] as unknown[]).every((id) => typeof id === 'string' && id.length > 0)) return null;
  if (!isScope(c['scope'])) return null;
  if (c['doctor_id'] !== undefined && typeof c['doctor_id'] !== 'string') return null;

  const now = Math.floor(Date.now() / 1000);
  const claim: AuthClaim = {
    sub: c['sub'] as string,
    role: c['role'] as AuthClaim['role'],
    branch_ids: c['branch_ids'] as string[],
    scope: c['scope'] as AuthClaim['scope'],
    ...(typeof c['doctor_id'] === 'string' ? { doctor_id: c['doctor_id'] } : {}),
    // Debug-header path doesn't carry exp/jti — synthesize placeholders so the
    // type stays consistent with the Bearer path. The debug header is dev-only
    // and will not reach the future W9 denylist path.
    expires_at: now + 3600,
    jti: 'debug-header',
  };
  return claim;
}

function parseBearerHeader(raw: string | undefined): AuthClaim | null {
  if (!raw) return null;
  // Case-insensitive on the scheme per RFC 6750 §2.1.
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) return null;
  const token = match[1]?.trim();
  if (!token) return null;
  return verifyToken(token);
}

declare module 'express' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Auth middleware. Populates `req.auth` (anonymous when no/bad header).
 * Staff with empty branch_ids is rejected at 403 — invariant from spec §Auth.
 * Verifier enforces the same on the Bearer path; the debug path duplicates
 * the check so `x-auth-claim` users get the same code.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  let claim: AuthClaim | null = parseBearerHeader(req.header('authorization'));
  // Fall back to debug header only when allowed. Bearer wins when both are
  // present (more specific path).
  if (!claim) {
    const cfg = (() => {
      try {
        return loadAuthConfig();
      } catch {
        return null;
      }
    })();
    if (cfg?.allowDebugHeader) {
      claim = parseClaimHeader(req.header('x-auth-claim'));
    }
  }

  if (claim && claim.role !== 'patient' && claim.branch_ids.length === 0) {
    res.status(403).json({ error: 'staff_token_requires_branch_ids' });
    return;
  }

  req.auth = { claim };
  if (claim) {
    attachLogContext(req, {
      actor_role: claim.role,
      actor_id: claim.sub,
    });
  }
  next();
}
