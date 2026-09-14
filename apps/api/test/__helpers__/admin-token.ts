/**
 * Test-only helper that mints an admin JWT for use in supertest calls.
 *
 * Per spec-1-0 §"Always":
 *   - Defaults `sub = 'admin-main'`, `scope = 'clinic'`.
 *   - Throws `Error('admin_token_helper_disabled_in_production')` when
 *     `process.env['NODE_ENV'] === 'production'`.
 *   - Calls `signClaim(...)` from `apps/api/src/auth/jwt.ts` with the
 *     minimal claim shape an admin needs (`role: 'admin'`, `scope: 'clinic'`).
 *
 * DEVIATION FROM SPEC LITERAL TEXT — DOCUMENTED:
 *   The spec's prose says `signClaim({sub, role: 'admin', branch_ids: [],
 *   scope: 'clinic'})`. The existing E0-S3 `authMiddleware` at
 *   `src/middleware/auth.ts:115-118` rejects any non-patient with empty
 *   `branch_ids` at 403 `{error: 'staff_token_requires_branch_ids'}`, and
 *   the E0-S3 `auth-bearer.test.ts:116-123` test pins that behavior for
 *   admin tokens specifically. The spec's helper can't be used as-written
 *   against the production app — every request would 403 at the middleware
 *   before reaching `adminScope`.
 *
 *   Resolution: this helper includes a single placeholder branch_id
 *   (`['__clinic_anchor__']`) so the existing middleware accepts the token.
 *   The admin route never reads `branch_ids` from the claim (admin scoping
 *   lives at `scope: 'clinic'` per AD-8 and the singleton invariant from
 *   E1-S0a). The placeholder is a sentinel value that nothing in the route
 *   code matches against; it exists only to satisfy the E0-S3 gate.
 *   `adminScope` then enforces `role === 'admin' && scope === 'clinic'`,
 *   which is the real authorization boundary.
 *
 * Production path is the staff login (deferred W10). This helper exists
 * because the E0-S3 staff login route hasn't landed yet — once it does,
 * `__makeAdminToken()` is replaced by real-logintime token issuance.
 */
import { signClaim } from '../../src/auth/jwt.js';

const VALID_SECRET_MIN_LENGTH = 48;
/** Sentinel branch_id that satisfies the E0-S3 empty-branch_ids guard
 *  without introducing a real branch reference. See file-level comment. */
const CLINIC_ANCHOR_BRANCH_ID = '__clinic_anchor__';

/** Mint a signed admin JWT for use in supertest calls. Defaults to
 *  `sub = 'admin-main'`, `scope: 'clinic'`. The JWT carries a sentinel
 *  `branch_ids` entry to satisfy the E0-S3 middleware's empty-branch_ids
 *  guard; the admin route ignores it. */
export function __makeAdminToken(
  sub: string = 'admin-main',
  scope: 'clinic' = 'clinic',
): string {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('admin_token_helper_disabled_in_production');
  }
  // Require the caller to have set `AUTH_SECRET` first (via `globalSetup.cjs`
  // or a per-file `before()` hook). We intentionally do NOT mutate
  // `process.env.AUTH_SECRET` here — silently rewriting global env from a
  // test helper leaks state across test files and races with
  // `__resetAuthConfigForTests()` calls. The shared 48-byte secret is the
  // codebase convention (`auth-jwt.test.ts:11-46`); failing fast produces a
  // clear diagnostic instead of a downstream JWT-verification mismatch.
  const secret = process.env['AUTH_SECRET'];
  if (!secret || secret.length < VALID_SECRET_MIN_LENGTH) {
    throw new Error(
      `admin_token_helper_requires_auth_secret: set process.env.AUTH_SECRET to a string >= ${VALID_SECRET_MIN_LENGTH} chars (test/setup/globalSetup.cjs does this for the default suite)`,
    );
  }
  return signClaim({
    sub,
    role: 'admin',
    branch_ids: [CLINIC_ANCHOR_BRANCH_ID],
    scope,
  });
}
