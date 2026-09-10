/**
 * SmsOtpProvider — the seam between the OTP service and the outside world.
 *
 * The service never imports a real SDK directly. Every implementation must
 * conform to this interface so a stub (LogSmsOtpProvider, dev/test) and a
 * real Twilio client (TwilioSmsOtpProvider, prod) can be swapped without
 * touching the service code.
 *
 * Contract:
 *   - `send()` is fire-and-forget from the caller's POV: a successful return
 *     means the provider accepted the message; delivery failures are async
 *     and out of scope (W22).
 *   - `send()` MUST throw `SmsSendFailed` on synchronous failure (auth,
 *     validation, network unreachable). The service rolls back the DB
 *     transaction on this error.
 *   - The phone is already E.164-validated by the route before this call,
 *     so providers may assume a normalized format.
 *   - The code is the raw 6-digit OTP — providers MUST NOT log it at info+
 *     unless they are `LogSmsOtpProvider` (which exists for that exact
 *     reason in dev/test).
 */

export class SmsSendFailed extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SmsSendFailed';
    this.cause = cause;
  }
}

export interface SmsOtpProvider {
  /** Send the OTP code to the given phone. Throws `SmsSendFailed` on failure. */
  send(phone: string, code: string): Promise<void>;
}
