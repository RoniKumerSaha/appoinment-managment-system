/**
 * Runnable API entry. Imports the factory from `./app.ts` and binds to PORT.
 * Tests do NOT import this file; they import `./app.ts` directly.
 *
 * Boot guards (run in order; first failure exits non-zero):
 *   1. `loadAuthConfig()` — refuses if AUTH_SECRET missing/weak/short.
 *   2. `loadOtpConfig()` — refuses if OTP_PROVIDER=log in production, etc.
 *
 * The exit code is non-zero so a process supervisor restarts and the
 * failure is visible in deployment logs.
 *
 * Composition root: the SMS OTP provider is selected here (the only place
 * the service + provider wiring exists). `LogSmsOtpProvider` for dev/test,
 * `TwilioSmsOtpProvider` for production (lazy-imported).
 */
import { createApp } from './app.js';
import { getLogger } from './middleware/log.js';
import { closePool, getPool } from './db/pool.js';
import { loadAuthConfig } from './auth/config.js';
import { loadOtpConfig } from './otp/config.js';
import { SmsOtpService } from './otp/service.js';
import { LogSmsOtpProvider } from './otp/log-provider.js';
import {
  TwilioSmsOtpProvider,
  buildTwilioProviderFromEnv,
} from './otp/twilio-provider.js';
import { serviceStarted } from './observability/build-info.js';

const PORT = Number(process.env.PORT ?? 3001);

// Boot guard 1: AUTH_SECRET validation (E0-S3 contract).
try {
  loadAuthConfig();
} catch (err) {
  const message = err instanceof Error ? err.message : 'auth_config_load_failed';
  getLogger().error({ err: message }, 'auth_config_load_failed');
  process.exit(1);
}

// Boot guard 2: OTP provider validation (E0-S4 contract). Refuses to start
// if `OTP_PROVIDER=log` is configured in production (the log provider
// writes the raw OTP code to stdout — that's a leak in prod).
let otpCfg: ReturnType<typeof loadOtpConfig>;
try {
  otpCfg = loadOtpConfig();
} catch (err) {
  const message = err instanceof Error ? err.message : 'otp_config_load_failed';
  getLogger().error({ err: message }, 'otp_config_load_failed');
  process.exit(1);
}

// Composition root: assemble the provider + service. Tests stub the pool
// and the service via the `smsOtpService` option on `createApp()` and
// never reach this file. Production takes this path.
async function bootstrap(): Promise<void> {
  const pool = await getPool();
  let provider: import('./otp/provider.js').SmsOtpProvider;
  if (otpCfg.provider === 'twilio') {
    const twilioProvider = buildTwilioProviderFromEnv(otpCfg.ttlSeconds);
    if (twilioProvider) {
      provider = twilioProvider;
    } else {
      // Missing Twilio creds. In production this is a boot-fatal misconfig:
      // silently falling back to LogSmsOtpProvider would emit plaintext
      // OTPs to stdout. In dev/test/staging we tolerate the fallback so
      // local work can proceed without Twilio creds.
      if (process.env['NODE_ENV'] === 'production') {
        getLogger().error(
          { event: 'twilio_creds_missing_in_production' },
          'twilio credentials missing in production — refusing to fall back to LogSmsOtpProvider (would leak OTPs)',
        );
        process.exit(1);
      }
      getLogger().warn(
        { event: 'twilio_fallback_to_log' },
        'twilio credentials missing; falling back to LogSmsOtpProvider — DEV/TEST/STAGING ONLY',
      );
      provider = new LogSmsOtpProvider();
    }
  } else {
    provider = new LogSmsOtpProvider();
  }
  const smsOtpService = new SmsOtpService(pool, provider, otpCfg);
  const app = createApp({ smsOtpService });
  const server = app.listen(PORT, () => {
    getLogger().info({ port: PORT, otp_provider: otpCfg.provider }, 'api_listening');
    // E0-S6 observability baseline: emit the single `service_started` line
    // carrying build version + commit sha so operators can correlate the
    // log stream with the running deployment. One emit per process; never
    // throws (missing APP_VERSION / GIT_SHA default to safe placeholders).
    serviceStarted(PORT);
  });

  // Surface bind failures (e.g. EADDRINUSE) via the structured logger and
  // exit non-zero so a process supervisor restarts cleanly.
  server.on('error', (err) => {
    getLogger().error({ err: err.message }, 'bind_failed');
    // Pool may not be open yet (bootstrap is in flight); attempt close
    // but do not block on it. 1s grace, then exit.
    closePool()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });

  // Graceful shutdown: stop accepting new connections, drain in-flight
  // requests, close the pg.Pool, then exit. A 10s hard timeout guards
  // against keep-alive connections preventing server.close() from firing.
  const SHUTDOWN_TIMEOUT_MS = 10_000;
  const shutdown = (signal: string) => {
    getLogger().info({ signal }, 'shutting_down');
    const hardExit = setTimeout(() => {
      getLogger().warn({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'shutdown_timeout_force_exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref();
    server.close(() => {
      clearTimeout(hardExit);
      closePool()
        .catch((err) => {
          getLogger().error(
            { err: err instanceof Error ? err.message : String(err) },
            'pool_close_failed',
          );
        })
        .finally(() => {
          process.exit(0);
        });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// F5: surface unhandled bootstrap rejections with a structured log line so
// a misconfigured boot is visible in deployment logs (not just an opaque
// process exit).
process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  getLogger().error({ err: message, event: 'bootstrap_unhandled_rejection' }, 'bootstrap_failed');
  process.exit(1);
});

void bootstrap();
