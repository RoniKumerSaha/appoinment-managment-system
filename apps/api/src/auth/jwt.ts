/**
 * JWT minter / verifier — pure functions, no I/O.
 *
 * Algorithm: HS256 with a single shared secret loaded from `loadAuthConfig()`.
 * No external library — `node:crypto`'s `createHmac` is sufficient for RFC 7519
 * Section 3.2 (HMAC SHA-256). Keeping the dependency tree small is a deliberate
 * choice for E0-S3; a future hardening story can swap in `jose` if key rotation
 * (W11) requires it.
 *
 * SECURITY POSTURE (per E0-S3 spec + Architecture §3.1):
 *   - Verifier hardcodes `HS256`; the token's `alg` header is ignored. This
 *     defeats the classic `alg=none` attack.
 *   - Signature is verified FIRST, before any claim-shape checks. This avoids
 *     a timing oracle where an attacker probes claim shape with unsigned tokens.
 *   - Signature comparison uses `crypto.timingSafeEqual` (constant-time).
 *   - `aud` and `iss` are mandatory and must match the configured values.
 *   - `jti` is mandatory (UUID v4 string). Enables future W9 denylist.
 *   - `iat` and `exp` are JSON numbers (RFC 7519 NumericDate), not strings.
 *   - 30-second clock-skew tolerance on `iat` and `exp`.
 *   - Closed enums for `role` and `scope` enforced at VERIFY time (not just
 *     at mint) so a token minted by a future buggy issuer is rejected.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthClaim, Role, Scope } from '../types/auth.js';
import { loadAuthConfig, type AuthConfig } from './config.js';

const CLOCK_SKEW_SECONDS = 30;
const MAX_BRANCH_IDS = 256;
const ROLES: ReadonlySet<Role> = new Set([
  'patient',
  'receptionist',
  'doctor',
  'admin',
]);
const SCOPES: ReadonlySet<Scope> = new Set([
  'self',
  'branch',
  'clinic',
  'global',
]);

/** Input shape accepted by `signClaim`. The minter adds `aud`, `iss`, `jti`,
 *  `iat`, `exp` automatically; the caller must not supply them. */
export interface SignClaimInput {
  sub: string;
  role: Role;
  branch_ids: readonly string[];
  scope: Scope;
  doctor_id?: string;
}

interface JwtPayload extends SignClaimInput {
  doctor_id?: string;
  aud: string;
  iss: string;
  jti: string;
  iat: number;
  exp: number;
}

function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Sign a domain claim into a JWT string. The returned token is the only
 *  output — no side effects. Throws if the config is malformed (boot guard
 *  should have caught it, but defense in depth). */
export function signClaim(input: SignClaimInput, now: number = Math.floor(Date.now() / 1000)): string {
  const cfg = loadAuthConfig();
  const payload: JwtPayload = {
    sub: input.sub,
    role: input.role,
    branch_ids: [...input.branch_ids],
    scope: input.scope,
    ...(input.doctor_id !== undefined ? { doctor_id: input.doctor_id } : {}),
    aud: cfg.audience,
    iss: cfg.issuer,
    jti: randomUUID(),
    iat: now,
    exp: now + cfg.ttlSeconds,
  };
  return encodeToken(payload, cfg);
}

function encodeToken(payload: JwtPayload, cfg: AuthConfig): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac('sha256', cfg.secret)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64urlEncode(sig)}`;
}

/** Verify a JWT and return the `AuthClaim` (including `expires_at` and
 *  `jti`); returns `null` on ANY failure (bad signature, expired, malformed,
 *  wrong aud/iss, unknown fields, future iat, etc.). Callers treat null as
 *  anonymous. */
export function verifyToken(token: string, now: number = Math.floor(Date.now() / 1000)): AuthClaim | null {
  const cfg = loadAuthConfig();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  // 1. Verify signature FIRST (constant-time) — prevents timing oracle
  //    on claim-shape probes with attacker-supplied tokens.
  const expectedSig = createHmac('sha256', cfg.secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let actualSig: Buffer;
  try {
    actualSig = base64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (!constantTimeEqual(expectedSig, actualSig)) return null;

  // 2. Parse header — must be `{alg: "HS256", typ: "JWT"}`. We hardcode
  //    HS256 anyway but reject `alg=none` and other variants explicitly so
  //    tokens claiming a different algorithm don't sneak through.
  let header: unknown;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object') return null;
  const h = header as Record<string, unknown>;
  if (h['alg'] !== 'HS256' || h['typ'] !== 'JWT') return null;

  // 3. Parse payload and validate shape.
  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  return validatePayload(payload as Record<string, unknown>, cfg, now);
}

function validatePayload(
  p: Record<string, unknown>,
  cfg: AuthConfig,
  now: number,
): AuthClaim | null {
  // Required string fields.
  if (typeof p['sub'] !== 'string' || p['sub'].length === 0) return null;
  if (typeof p['aud'] !== 'string' || p['aud'] !== cfg.audience) return null;
  if (typeof p['iss'] !== 'string' || p['iss'] !== cfg.issuer) return null;
  if (typeof p['jti'] !== 'string' || p['jti'].length === 0) return null;
  // Enums.
  const role = p['role'];
  if (typeof role !== 'string' || !ROLES.has(role as Role)) return null;
  const scope = p['scope'];
  if (typeof scope !== 'string' || !SCOPES.has(scope as Scope)) return null;
  // branch_ids: array of non-empty unique strings, capped length.
  if (!Array.isArray(p['branch_ids'])) return null;
  const branchIds = p['branch_ids'] as unknown[];
  if (branchIds.length > MAX_BRANCH_IDS) return null;
  const seen = new Set<string>();
  for (const id of branchIds) {
    if (typeof id !== 'string' || id.length === 0) return null;
    if (seen.has(id)) return null;
    seen.add(id);
  }
  // doctor_id: optional string.
  if (p['doctor_id'] !== undefined && typeof p['doctor_id'] !== 'string') {
    return null;
  }
  // Numeric claims — RFC 7519 NumericDate is JSON number, integer.
  const iat = p['iat'];
  const exp = p['exp'];
  if (typeof iat !== 'number' || !Number.isInteger(iat)) return null;
  if (typeof exp !== 'number' || !Number.isInteger(exp)) return null;
  if (exp <= iat) return null;
  if (iat > now + CLOCK_SKEW_SECONDS) return null; // future-iat
  if (exp < now - CLOCK_SKEW_SECONDS) return null; // expired (small leeway)

  // Build the typed claim. Reject any extra fields beyond the closed shape.
  const allowed = new Set([
    'sub',
    'role',
    'branch_ids',
    'scope',
    'doctor_id',
    'aud',
    'iss',
    'jti',
    'iat',
    'exp',
  ]);
  for (const k of Object.keys(p)) {
    if (!allowed.has(k)) return null;
  }

  const claim: AuthClaim = {
    sub: p['sub'] as string,
    role: role as Role,
    branch_ids: branchIds as string[],
    scope: scope as Scope,
    ...(p['doctor_id'] !== undefined ? { doctor_id: p['doctor_id'] as string } : {}),
    expires_at: exp as number,
    jti: p['jti'] as string,
  };
  return claim;
}
