/**
 * LogSmsOtpProvider — dev/test OTP transport.
 *
 * Writes the OTP code (and redacted phone) to the structured logger at
 * `info` level so a developer running the API locally can pick up the code
 * from stdout without configuring Twilio. This is INTENTIONAL behavior in
 * dev/test; production refuses to register this provider (see
 * `loadOtpConfig()` — `otp_provider_log_in_production`).
 *
 * The implementation never throws. If the logger misbehaves, pino itself
 * will throw — but that bubbles up to a 500 from the route handler, which
 * is the correct posture (the OTP subsystem is broken, not the caller).
 */
import type { SmsOtpProvider } from './provider.js';
import { getLogger } from '../middleware/log.js';

function redactPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return `***${phone.slice(-4)}`;
}

export class LogSmsOtpProvider implements SmsOtpProvider {
  public async send(phone: string, code: string): Promise<void> {
    // Note: we deliberately log the raw 6-digit `code`. This is only safe in
    // dev/test — `loadOtpConfig()` refuses this provider in production.
    getLogger().info(
      {
        event: 'sms_otp_send',
        outcome: 'success',
        provider: 'log',
        phone: redactPhone(phone),
        code,
      },
      'sms_otp_send_logged',
    );
  }
}
