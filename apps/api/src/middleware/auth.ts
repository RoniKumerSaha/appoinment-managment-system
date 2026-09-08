/**
 * Auth middleware (STUB).
 *
 * E0-S3 replaces this with a real provider (JWT, opaque cookie, etc.). For now
 * we accept the envelope shape from a header (`x-auth-claim`) ONLY so test code
 * and tooling can exercise claim-aware guards. The token (when present) must be
 * a JSON string of `AuthClaim`; an invalid shape yields anonymous context.
 *
 * Hard rules established by this stub:
 *   - Body fields named role/branch_ids/scope/doctor_id are NEVER consulted.
 *   - Staff tokens with empty branch_ids are rejected at middleware.
 *   - Doctor tokens missing doctor_id are accepted but flagged for downstream
 *     doctor-only guards (which reject at the route, not here).
 */
import type { Request, Response, NextFunction } from 'express';
import type { AuthClaim, AuthContext } from '../types/auth.js';
import { attachLogContext } from './log.js';

function isRole(v: unknown): v is AuthClaim['role'] {
  return v === 'patient' || v === 'receptionist' || v === 'doctor' || v === 'admin';
}

function isScope(v: unknown): v is AuthClaim['scope'] {
  return v === 'self' || v === 'branch' || v === 'clinic' || v === 'global';
}

// Caps chosen to bound work the parser must do per request. The header is
// caller-controlled, so a 4 KiB cap and a 256-id cap stop a single request
// from forcing unbounded JSON.parse / Array.every work. Anything over either
// cap is treated as malformed and yields anonymous (request continues).
const MAX_X_AUTH_CLAIM_BYTES = 4096;
const MAX_BRANCH_IDS = 256;

function parseClaimHeader(raw: string | undefined): AuthClaim | null {
  if (!raw) return null;
  // Hard cap on header length so a malicious client cannot force unbounded
  // JSON.parse work via a multi-megabyte x-auth-claim header.
  if (raw.length > MAX_X_AUTH_CLAIM_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as Record<string, unknown>;
  if (typeof c.sub !== 'string') return null;
  if (!isRole(c.role)) return null;
  if (!Array.isArray(c.branch_ids)) return null;
  // Cap on branch_ids.length so a claim cannot carry an arbitrarily large
  // array. Anything longer is malformed — return null (anonymous).
  if (c.branch_ids.length > MAX_BRANCH_IDS) return null;
  if (!c.branch_ids.every((id) => typeof id === 'string')) return null;
  if (!isScope(c.scope)) return null;
  if (c.doctor_id !== undefined && typeof c.doctor_id !== 'string') return null;
  const claim: AuthClaim = {
    sub: c.sub,
    role: c.role,
    branch_ids: c.branch_ids,
    scope: c.scope,
    ...(typeof c.doctor_id === 'string' ? { doctor_id: c.doctor_id } : {}),
  };
  return claim;
}

declare module 'express' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Auth middleware. Always populates `req.auth` (anonymous when no/bad header).
 * Staff with empty branch_ids is rejected at 403 — invariant from spec §Auth.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const claim = parseClaimHeader(req.header('x-auth-claim'));

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
