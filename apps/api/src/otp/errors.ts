/**
 * Typed errors raised by SmsOtpService. Each carries `retryAfterMs` where
 * applicable so the route handler can return the right HTTP envelope
 * without doing arithmetic.
 *
 * The routes translate these into the HTTP status + body shape documented
 * in the E0-S4 spec's I/O matrix. The error classes are intentionally
 * distinct from `SmsSendFailed` (a provider-level error) so the route
 * can distinguish "client sent bad input" from "provider is broken".
 */

export class OtpCooldownError extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('otp_cooldown');
    this.name = 'OtpCooldownError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class OtpLockedError extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('otp_locked');
    this.name = 'OtpLockedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class OtpExpiredError extends Error {
  constructor() {
    super('otp_expired');
    this.name = 'OtpExpiredError';
  }
}

export class NoOutstandingOtpError extends Error {
  constructor() {
    super('no_outstanding_otp');
    this.name = 'NoOutstandingOtpError';
  }
}

export class InvalidOtpCodeError extends Error {
  constructor() {
    super('invalid_otp_code');
    this.name = 'InvalidOtpCodeError';
  }
}

export class OtpPhoneFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtpPhoneFormatError';
  }
}

export class OtpCodeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtpCodeFormatError';
  }
}
