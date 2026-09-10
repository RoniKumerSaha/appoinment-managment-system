/**
 * Mock patient OTP route — DEV/TEST ONLY.
 *
 * `POST /patient/otp/verify-now` accepts `{phone, code}` and mints a patient
 * JWT when `code === process.env.MOCK_OTP_CODE` (default `'123456'`). This
 * is the stub login surface; E0-S4 (real SMS gateway) and E4-S1 (patient
 * OTP modal) replace the body but keep the route + response shape stable.
 *
 * Security posture:
 *   - Registered only when `NODE_ENV ∈ {development, test}` (allowlist, not
 *     denylist). Production, staging, or any other env 404s the path.
 *   - Phone is type-checked (string) and E.164-validated (`^\+[1-9]\d{6,14}$`).
 *   - Code comparison uses `crypto.timingSafeEqual` against equal-length
 *     buffers — no early-return string compare (timing side-channel).
 *   - The route handler does NOT consult `req.body.role` / `req.body.branch_ids`
 *     / `req.body.scope` / `req.body.doctor_id`. The minted claim is always
 *     patient-scoped regardless of body. Tested by `patient-otp.test.ts`.
 *   - Audit log on every attempt (success + failure) with redacted phone
 *     (last-4 only) and no JWT body.
 *
 * No rate limiting in this story — see deferred-work W16 (E0-S4 / E4-S1).
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getLogger } from '../middleware/log.js';
import { loadAuthConfig } from '../auth/config.js';
import { signClaim, verifyToken } from '../auth/jwt.js';

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

function redactPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return `***${phone.slice(-4)}`;
}

function constantTimeCodeCompare(a: string, b: string): boolean {
  // Pad both to a common length so timingSafeEqual doesn't leak length.
  // (Both are 6 digits per Architecture §3.8; the pad is defense-in-depth.)
  const MAX = 256;
  const aBuf = Buffer.alloc(MAX);
  const bBuf = Buffer.alloc(MAX);
  Buffer.from(a, 'utf8').copy(aBuf);
  Buffer.from(b, 'utf8').copy(bBuf);
  return timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

export const patientOtpRouter: Router = Router();

patientOtpRouter.post('/otp/verify-now', (req: Request, res: Response): void => {
  const cfg = loadAuthConfig();
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Type-check both fields BEFORE any other validation so we never crash on
  // `undefined` / non-string inputs.
  if (typeof body['phone'] !== 'string' || typeof body['code'] !== 'string') {
    res.status(400).json({ error: 'invalid_phone' });
    return;
  }
  const phone = body['phone'];
  const code = body['code'];

  if (!E164_REGEX.test(phone)) {
    getLogger().info(
      { event: 'mock_otp_attempt', outcome: 'invalid_phone', phone: redactPhone(phone) },
      'mock_otp_rejected',
    );
    res.status(400).json({ error: 'invalid_phone' });
    return;
  }

  if (!constantTimeCodeCompare(code, cfg.mockOtpCode)) {
    getLogger().info(
      { event: 'mock_otp_attempt', outcome: 'invalid_code', phone: redactPhone(phone) },
      'mock_otp_rejected',
    );
    res.status(401).json({ error: 'invalid_otp_code' });
    return;
  }

  const token = signClaim({
    sub: phone,
    role: 'patient',
    branch_ids: [],
    scope: 'self',
  });
  // Decode the just-minted token so `expires_at` and `jti` are read from the
  // single source of truth (the JWT payload) rather than re-derived.
  const claim = verifyToken(token);
  if (!claim) {
    // Should be unreachable — we just signed it with our own verifier's rules.
    getLogger().error({ event: 'mock_otp_mint_failed' }, 'mock_otp_internal_error');
    res.status(500).json({ error: 'internal_error' });
    return;
  }
  const expiresAt = new Date(claim.expires_at * 1000).toISOString();

  getLogger().info(
    { event: 'mock_otp_attempt', outcome: 'success', phone: redactPhone(phone) },
    'mock_otp_success',
  );
  res.status(200).json({ token, claim, expires_at: expiresAt });
});
