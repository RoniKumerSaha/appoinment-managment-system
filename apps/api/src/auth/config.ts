/**
 * Auth config — boot-time validation + memoized singleton.
 *
 * Reads env once on first call. Subsequent calls return the same object —
 * runtime env mutations after boot are ignored (memoization invariant pinned
 * by `auth-config.test.ts` AC-17b). Throws on missing / weak / malformed
 * inputs in ANY env (no dev/test fallback; devs copy `.env.example`).
 *
 * The boot path is `loadAuthConfig() throws → process exits non-zero`. We
 * rely on the caller (server.ts) to wire that into a process exit; `app.ts`
 * consumers call `loadAuthConfig()` lazily so the failure mode is "process
 * can't bind to a port".
 */
import { Buffer } from 'node:buffer';

const MIN_SECRET_BYTES = 32;
const DEFAULT_TTL_SECONDS = 3600;

export interface AuthConfig {
  /** Raw secret bytes. Use this with createHmac; do NOT log or stringify. */
  secret: Buffer;
  /** Token lifetime in seconds; encoded into the `exp` claim at mint time. */
  ttlSeconds: number;
  /** Mock OTP code; required for the dev-only `/patient/otp/verify-now` route. */
  mockOtpCode: string;
  /** True when `x-auth-claim` debug fallback is allowed (dev/test only). */
  allowDebugHeader: boolean;
  /** True when the mock-OTP route should be registered (allowlist: dev/test). */
  mockOtpAllowed: boolean;
  /** JWT `aud` claim — verified by `verifyToken` to prevent confused-deputy. */
  audience: string;
  /** JWT `iss` claim — verified by `verifyToken` to prevent confused-deputy. */
  issuer: string;
}

const MOCK_OTP_ALLOWED_ENVS = new Set(['development', 'test']);

let memoized: AuthConfig | null = null;

function parseTtl(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS;
  // Number() coerces; reject non-finite and non-integer explicitly so a
  // 'NaN' env value or '1.5' env value can't slip through to mint tokens
  // with floating-point `exp` claims (RFC 7519 NumericDate is integer).
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error('auth_ttl_invalid');
  }
  return n;
}

function isMockOtpAllowed(): boolean {
  return MOCK_OTP_ALLOWED_ENVS.has(process.env['NODE_ENV'] ?? '');
}

/**
 * Read env vars, validate, return a frozen `AuthConfig`. Throws on missing
 * or weak `AUTH_SECRET` (`auth_secret_missing` / `auth_secret_too_short`)
 * in ANY env. Throws `auth_ttl_invalid` if `AUTH_TOKEN_TTL_SECONDS` is
 * non-numeric, non-integer, or `<= 0`. Memoized.
 */
export function loadAuthConfig(): AuthConfig {
  if (memoized) return memoized;
  const secretRaw = process.env['AUTH_SECRET'];
  if (!secretRaw || secretRaw.length === 0) {
    throw new Error('auth_secret_missing');
  }
  // Use Buffer.byteLength (NOT .length) so a 32-char emoji secret (64 bytes
  // in UTF-8) is correctly recognized as too long and a 32-char ASCII
  // secret (32 bytes) is correctly recognized as sufficient.
  const bytes = Buffer.byteLength(secretRaw, 'utf8');
  if (bytes < MIN_SECRET_BYTES) {
    throw new Error('auth_secret_too_short');
  }
  const ttlSeconds = parseTtl(process.env['AUTH_TOKEN_TTL_SECONDS']);
  const mockOtpCode = process.env['MOCK_OTP_CODE'] ?? '123456';
  const allowDebugHeader = process.env['NODE_ENV'] !== 'production';
  const mockOtpAllowed = isMockOtpAllowed();
  const cfg: AuthConfig = {
    secret: Buffer.from(secretRaw, 'utf8'),
    ttlSeconds,
    mockOtpCode,
    allowDebugHeader,
    mockOtpAllowed,
    audience: 'clinic-api',
    issuer: 'clinic-api',
  };
  memoized = Object.freeze(cfg);
  return memoized;
}

/**
 * Reset the memoized config. Test-only utility — production code never
 * invokes this. Lets `auth-config.test.ts` exercise the throw paths without
 * contaminating other tests' cached state.
 */
export function __resetAuthConfigForTests(): void {
  memoized = null;
}
