/**
 * TwilioSmsOtpProvider — production OTP transport.
 *
 * Lazy-imports `twilio` so dev installs do not require the package. The
 * composition root (`server.ts`) is the only place that constructs this
 * class in production; tests inject a stub via the `client` parameter so no
 * real Twilio HTTP call ever fires in CI.
 *
 * Credentials are read from env at construction time (NOT at first `send`),
 * so a missing-credential misconfig fails the boot process — same posture
 * as `loadAuthConfig()` and `loadOtpConfig()`. The `client` parameter takes
 * precedence over env when supplied; this lets tests wire a stub without
 * polluting the env.
 *
 * `send()` throws `SmsSendFailed` on any Twilio error. The service's
 * transaction rolls back the row insert, so a Twilio outage never leaves
 * a phantom OTP row.
 */
import type { SmsOtpProvider } from './provider.js';
import { SmsSendFailed } from './provider.js';

export interface TwilioClientLike {
  messages: {
    create(args: { to: string; from: string; body: string }): Promise<unknown>;
  };
}

export interface TwilioSmsOtpProviderOptions {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /**
   * OTP TTL in seconds — used in the SMS body so the message matches the
   * configured expiry rather than a hard-coded "5 minutes".
   */
  ttlSeconds: number;
  /**
   * Injectable Twilio client. If omitted, the provider is "unbound" and
   * the first `send()` will lazy-import `twilio` and bind on demand. Tests
   * always inject.
   */
  client?: TwilioClientLike;
}

export class TwilioSmsOtpProvider implements SmsOtpProvider {
  private readonly from: string;
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly ttlSeconds: number;
  private client: TwilioClientLike | null;
  // F12: dedup concurrent bind attempts. Without this, two parallel
  // `send()` calls before the lazy client resolves would both run
  // `import('twilio')` and instantiate two distinct clients.
  private bindPromise: Promise<TwilioClientLike> | null = null;

  constructor(opts: TwilioSmsOtpProviderOptions) {
    // F11: missing-creds is a misconfig at construction time (boot path),
    // not a runtime provider failure. Throw a dedicated boot-error class
    // so the composition root can surface it as `boot_invalid_config` and
    // exit non-zero, instead of conflating with a Twilio outage.
    if (!opts.accountSid) throw new Error('twilio_account_sid_missing');
    if (!opts.authToken) throw new Error('twilio_auth_token_missing');
    if (!opts.fromNumber) throw new Error('twilio_from_number_missing');
    this.from = opts.fromNumber;
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.ttlSeconds = opts.ttlSeconds;
    this.client = opts.client ?? null;
  }

  public async send(phone: string, code: string): Promise<void> {
    if (!this.client) {
      // F12: dedup concurrent first-call bind via a cached promise.
      this.bindPromise ??= this.bindClient();
      this.client = await this.bindPromise;
    }
    try {
      await this.client.messages.create({
        to: phone,
        from: this.from,
        // F13: interpolate TTL minutes from the actual config rather
        // than hardcoding. The body matches `cfg.ttlSeconds / 60`.
        body: `Your verification code is ${code}. It expires in ${this.ttlSeconds / 60} minutes.`,
      });
    } catch (err) {
      throw new SmsSendFailed('twilio_send_failed', err);
    }
  }

  private async bindClient(): Promise<TwilioClientLike> {
    // Lazy import so dev/test installs do not require `twilio`. The specifier
    // is held in a variable so TypeScript does not statically resolve the
    // module — the package is an optional production dependency and must not
    // be a build-time requirement for dev/test/CI.
    const specifier = 'twilio';
    const twilioModule = (await import(specifier)) as unknown as {
      default: (sid: string, token: string) => TwilioClientLike;
    };
    return twilioModule.default(this.accountSid, this.authToken);
  }
}

/**
 * Build a TwilioSmsOtpProvider from env. Reads TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER. Returns null if any required env
 * var is missing — the composition root decides what to do (typically log
 * a warning and fall back to LogSmsOtpProvider in dev). Throwing here
 * would force CI to mock twilio even when OTP_PROVIDER=log; null-return
 * is the more permissive shape.
 */
export function buildTwilioProviderFromEnv(ttlSeconds: number): TwilioSmsOtpProvider | null {
  const accountSid = process.env['TWILIO_ACCOUNT_SID'];
  const authToken = process.env['TWILIO_AUTH_TOKEN'];
  const fromNumber = process.env['TWILIO_FROM_NUMBER'];
  if (!accountSid || !authToken || !fromNumber) return null;
  return new TwilioSmsOtpProvider({
    accountSid,
    authToken,
    fromNumber,
    ttlSeconds,
  });
}
