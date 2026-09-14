/**
 * Admin-scope middleware.
 *
 * Gates routes that require an admin session scoped to the singleton clinic.
 * Per spec-1-0:
 *   - `req.auth?.claim` missing → 401 `{error: 'unauthenticated'}`.
 *     The field is optional per the E0-S3 declare-merge at `auth.ts:82-86`,
 *     so a missing claim (anonymous after a bad/missing token) is the
 *     no-claim path → unauthenticated.
 *   - `claim.role !== 'admin'` → 403 `{error: 'forbidden_role'}`.
 *   - `claim.scope !== 'clinic'` → 403 `{error: 'forbidden_scope'}`.
 *   - Otherwise `next()`.
 *
 * No shared `badRequest` / `forbidden` helper exists in `auth.ts` —
 * error envelopes are emitted inline (matches the E0-S6 envelope shape).
 *
 * Mounted AFTER `authMiddleware` (E0-S3) on `/admin/*` so a request without
 * a valid token reaches the auth path first; the unauthenticated 401 envelope
 * wins over this middleware's branch-scope checks.
 */
import type { Request, Response, NextFunction } from 'express';

export function adminScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const claim = req.auth?.claim ?? null;
  if (!claim) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (claim.role !== 'admin') {
    res.status(403).json({ error: 'forbidden_role' });
    return;
  }
  if (claim.scope !== 'clinic') {
    res.status(403).json({ error: 'forbidden_scope' });
    return;
  }
  next();
}
