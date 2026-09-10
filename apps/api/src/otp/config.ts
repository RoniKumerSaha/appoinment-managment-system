/**
 * OtpConfig — boot-time validation + memoized singleton.
 *
 * Reads env once on first call. Subsequent calls return the same object —
 * runtime env mutations after boot are ignored. Throws on missing /
 * malformed inputs in any env (no dev/test fallback; devs copy
 * `.env.example`).
 *
 * Production guard: `OTP_PROVIDER=log` AND `NODE_ENV=production` is a
 * boot-fatal misconfig because the log provider writes the raw OTP code
 * to stdout — we refuse rather than silently route plaintext OTPs through
 * a prod log pipeline.
 *
 * Staging default: `OTP_PROVIDER=log` so a staging env without explicit
 * credentials does not accidentally route through Twilio. Per user
 * decision in bmad-code-review F17.
 */

export type OtpProviderName = 'log' | 'twilio';

const PROVIDER_NAMES = new Set<OtpProviderName>(['log', 'twilio']);

export interface OtpConfig {
  /** Selected provider (single source of truth for composition root). */
  provider: OtpProviderName;
  /** OTP TTL in seconds (default 300 = 5 minutes). */
  ttlSeconds: number;
  /** Number of verify failures before lockout (default 3). */
  lockoutThreshold: number;
  /** Lockout window in seconds (default 600 = 10 minutes). */
  lockoutSeconds: number;
  /** Resend cooldown in seconds (default 30). */
  cooldownSeconds: number;
  /** OTP code length in digits (default 6). */
  codeLength: number;
}

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_LOCKOUT_THRESHOLD = 3;
const DEFAULT_LOCKOUT_SECONDS = 600;
const DEFAULT_COOLDOWN_SECONDS = 30;
const DEFAULT_CODE_LENGTH = 6;

let memoized: OtpConfig | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  // Reject non-canonical integer strings (hex '0x10', exponential '1e2',
  // signed '+5', whitespace) — only match base-10 digits with optional
  // leading minus. Number('1e2') === 100 would otherwise pass.
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`otp_${name}_invalid`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`otp_${name}_invalid`);
  }
  return n;
}

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

function isDevelopmentOrTest(): boolean {
  // staging is included per F17 (user decision) — staging mirrors dev/test
  // posture: defaults to `log` provider so missing Twilio creds don't
  // accidentally route real OTPs through a real provider in a non-prod env.
  return (
    process.env['NODE_ENV'] === 'development' ||
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'staging'
  );
}

function resolveProvider(raw: string | undefined): OtpProviderName {
  // Default: `log` for dev/test, `twilio` for everything else (prod).
  if (raw === undefined || raw === '') {
    return isDevelopmentOrTest() ? 'log' : 'twilio';
  }
  if (!PROVIDER_NAMES.has(raw as OtpProviderName)) {
    throw new Error('otp_provider_invalid');
  }
  return raw as OtpProviderName;
}

/**
 * Read env vars, validate, return a frozen `OtpConfig`. Throws on:
 *   - `otp_provider_invalid` — unknown provider name
 *   - `otp_provider_log_in_production` — `OTP_PROVIDER=log` in production
 *   - `otp_ttl_invalid`, `otp_lockout_threshold_invalid`,
 *     `otp_lockout_seconds_invalid`, `otp_cooldown_seconds_invalid`,
 *     `otp_code_length_invalid` — non-integer / non-finite / `<= 0`
 *
 * Memoized: subsequent calls return the same object.
 */
export function loadOtpConfig(): OtpConfig {
  if (memoized) return memoized;
  const provider = resolveProvider(process.env['OTP_PROVIDER']);
  if (provider === 'log' && isProduction()) {
    throw new Error('otp_provider_log_in_production');
  }
  const cfg: OtpConfig = {
    provider,
    ttlSeconds: parsePositiveInt(process.env['OTP_TTL_SECONDS'], DEFAULT_TTL_SECONDS, 'ttl'),
    lockoutThreshold: parsePositiveInt(
      process.env['OTP_LOCKOUT_THRESHOLD'],
      DEFAULT_LOCKOUT_THRESHOLD,
      'lockout_threshold',
    ),
    lockoutSeconds: parsePositiveInt(
      process.env['OTP_LOCKOUT_SECONDS'],
      DEFAULT_LOCKOUT_SECONDS,
      'lockout_seconds',
    ),
    cooldownSeconds: parsePositiveInt(
      process.env['OTP_COOLDOWN_SECONDS'],
      DEFAULT_COOLDOWN_SECONDS,
      'cooldown_seconds',
    ),
    codeLength: parsePositiveInt(
      process.env['OTP_CODE_LENGTH'],
      DEFAULT_CODE_LENGTH,
      'code_length',
    ),
  };
  memoized = Object.freeze(cfg);
  return memoized;
}

/**
 * Test-only: reset the memoized config. Production code never invokes this.
 */
export function __resetOtpConfigForTests(): void {
  memoized = null;
}
