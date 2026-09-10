/**
 * SMS OTP routes — `/patient/otp/send` and `/patient/otp/verify`.
 *
 * Both routes are unauthenticated (the OTP is the credential). They mount
 * BEFORE `authMiddleware` so a patient who has not yet verified can hit
 * them. They NEVER consult `req.auth.claim` or `req.body.role` /
 * `req.body.branch_ids` / `req.body.scope` / `req.body.doctor_id`.
 *
 * Phone is E.164-validated (`^\+[1-9]\d{6,14}$`). Code is 6-digit numeric.
 * Validation errors return 400 BEFORE consulting the service so a bad
 * input never increments `attempts`.
 *
 * The verify path produces the same `{token, claim, expires_at}` shape as
 * E0-S3's `/patient/otp/verify-now`, so E4-S1 can swap its body without
 * touching the response contract.
 */
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { getLogger } from '../middleware/log.js';
import type { SmsOtpService } from '../otp/service.js';
import {
  OtpCooldownError,
  OtpLockedError,
  OtpExpiredError,
  NoOutstandingOtpError,
  InvalidOtpCodeError,
} from '../otp/errors.js';
import { SmsSendFailed } from '../otp/provider.js';
import { inc } from '../metrics/counters.js';

const E164_REGEX = /^\+[1-9]\d{6,14}$/;
const CODE_REGEX = /^\d{6}$/;

function redactPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return `***${phone.slice(-4)}`;
}

export interface SmsOtpRouterDeps {
  service: SmsOtpService;
}

export function createSmsOtpRouter(deps: SmsOtpRouterDeps): Router {
  const router = Router();

  router.post('/otp/send', (async (req: Request, res: Response): Promise<void> => {
    // F14: reject non-JSON content types with 415 instead of silently
    // treating an empty body as `{}` → 400 invalid_phone.
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body['phone'] !== 'string' || !E164_REGEX.test(body['phone'])) {
      getLogger().info(
        { event: 'sms_otp_send', outcome: 'invalid_phone', phone: redactPhone(String(body['phone'] ?? '')) },
        'sms_otp_send_rejected',
      );
      res.status(400).json({ error: 'invalid_phone' });
      return;
    }
    const phone = body['phone'] as string;
    try {
      const result = await deps.service.send(phone);
      getLogger().info(
        { event: 'sms_otp_send', outcome: 'success', phone: redactPhone(phone) },
        'sms_otp_send_success',
      );
      res.status(200).json({
        expires_at: result.expiresAt.toISOString(),
        cooldown_ms: result.cooldownMs,
      });
    } catch (err) {
      if (err instanceof OtpCooldownError) {
        getLogger().info(
          { event: 'sms_otp_send', outcome: 'cooldown', phone: redactPhone(phone), retry_after_ms: err.retryAfterMs },
          'sms_otp_send_rejected',
        );
        res.status(429).json({ error: 'otp_cooldown', retry_after_ms: err.retryAfterMs });
        return;
      }
      if (err instanceof OtpLockedError) {
        getLogger().info(
          { event: 'sms_otp_send', outcome: 'locked', phone: redactPhone(phone), retry_after_ms: err.retryAfterMs },
          'sms_otp_send_rejected',
        );
        res.status(429).json({ error: 'otp_locked', retry_after_ms: err.retryAfterMs });
        return;
      }
      if (err instanceof SmsSendFailed) {
        getLogger().warn(
          { event: 'sms_otp_send', outcome: 'provider_failure', phone: redactPhone(phone), err: err.message },
          'sms_otp_send_failed',
        );
        res.status(502).json({ error: 'sms_send_failed' });
        return;
      }
      // F15: unmapped error → 500 with a structured log line. Without this
      // fallback the original `throw err` left the response hanging.
      getLogger().error(
        { event: 'sms_otp_send', outcome: 'internal_error', phone: redactPhone(phone), err: err instanceof Error ? err.message : 'unknown_error' },
        'sms_otp_send_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  }) as RequestHandler);

  router.post('/otp/verify', (async (req: Request, res: Response): Promise<void> => {
    // F14: reject non-JSON content types with 415.
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body['phone'] !== 'string' || !E164_REGEX.test(body['phone'])) {
      getLogger().info(
        { event: 'sms_otp_verify', outcome: 'invalid_phone', phone: redactPhone(String(body['phone'] ?? '')) },
        'sms_otp_verify_rejected',
      );
      res.status(400).json({ error: 'invalid_phone' });
      return;
    }
    if (typeof body['code'] !== 'string' || !CODE_REGEX.test(body['code'])) {
      getLogger().info(
        { event: 'sms_otp_verify', outcome: 'invalid_code', phone: redactPhone(body['phone'] as string) },
        'sms_otp_verify_rejected',
      );
      res.status(400).json({ error: 'invalid_code' });
      return;
    }
    const phone = body['phone'] as string;
    const code = body['code'] as string;
    try {
      // Increment on EVERY verify attempt (success + failure + expired +
      // locked + no-row) — matches the E0-S1 metrics contract and the
      // E7-S9 (product metrics) success-rate calculation.
      inc('otp.verification');
      const result = await deps.service.verify(phone, code);
      getLogger().info(
        { event: 'sms_otp_verify', outcome: 'success', phone: redactPhone(phone) },
        'sms_otp_verify_success',
      );
      res.status(200).json({
        token: result.token,
        claim: result.claim,
        expires_at: result.expiresAt,
      });
    } catch (err) {
      if (err instanceof NoOutstandingOtpError) {
        getLogger().info(
          { event: 'sms_otp_verify', outcome: 'no_row', phone: redactPhone(phone) },
          'sms_otp_verify_rejected',
        );
        res.status(401).json({ error: 'no_outstanding_otp' });
        return;
      }
      if (err instanceof OtpExpiredError) {
        getLogger().info(
          { event: 'sms_otp_verify', outcome: 'expired', phone: redactPhone(phone) },
          'sms_otp_verify_rejected',
        );
        res.status(401).json({ error: 'otp_expired' });
        return;
      }
      if (err instanceof OtpLockedError) {
        getLogger().info(
          { event: 'sms_otp_verify', outcome: 'locked', phone: redactPhone(phone), retry_after_ms: err.retryAfterMs },
          'sms_otp_verify_rejected',
        );
        res.status(429).json({ error: 'otp_locked', retry_after_ms: err.retryAfterMs });
        return;
      }
      if (err instanceof InvalidOtpCodeError) {
        getLogger().info(
          { event: 'sms_otp_verify', outcome: 'wrong_code', phone: redactPhone(phone) },
          'sms_otp_verify_rejected',
        );
        res.status(401).json({ error: 'invalid_otp_code' });
        return;
      }
      // F15: unmapped error → 500 with structured log. Without this the
      // response hangs because the original throw was uncaught.
      getLogger().error(
        { event: 'sms_otp_verify', outcome: 'internal_error', phone: redactPhone(phone), err: err instanceof Error ? err.message : 'unknown_error' },
        'sms_otp_verify_failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  }) as RequestHandler);

  return router;
}
