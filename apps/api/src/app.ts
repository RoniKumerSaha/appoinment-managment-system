/**
 * Express app factory (no side effects on import).
 *
 * `server.ts` is the runnable entry that binds to PORT. Tests import this
 * module directly so importing does NOT start listening on a real port.
 *
 * `opts.requestLogger` (optional) lets a test inject a `pinoHttp()` instance
 * wired to an in-memory destination so the JSON log line can be captured
 * without depending on stdout interception (which is unreliable on Windows
 * where SonicBoom writes via the fd-1 path directly). Production callers
 * omit this and get the production `requestLogger`.
 *
 * `opts.smsOtpService` (optional) lets a test inject the SmsOtpService
 * with a stub provider. Production callers construct the service in
 * `server.ts` from the env and pass it in. If omitted, the SMS OTP router
 * is NOT registered.
 *
 * Mock-OTP route registration is gated on `NODE_ENV ∈ {development, test}`
 * via `loadAuthConfig().mockOtpAllowed`. E0-S4 removes the mock — the
 * real SMS OTP gateway replaces it. The mock flag stays in `AuthConfig`
 * for one story to keep the diff visible; it is unused by `createApp()`
 * and documented as `@deprecated`.
 */
import express from 'express';
import type { RequestHandler } from 'express';
import { healthRouter } from './routes/health.js';
import { metricsRouter } from './routes/metrics.js';
import { patientOtpRouter } from './routes/patient-otp.js';
import { createSmsOtpRouter } from './routes/sms-otp.js';
import { adminClinicRouter } from './routes/admin-clinic.js';
import { adminBranchesRouter } from './routes/admin-branches.js';
import { adminBranchHoursRouter } from './routes/admin-branch-hours.js';
import { adminBranchDoctorsRouter } from './routes/admin-branch-doctors.js';
import { adminBranchReceptionistsRouter } from './routes/admin-branch-receptionists.js';
import { adminDoctorScheduleRouter } from './routes/admin-doctor-schedule.js';
import { adminDoctorBlockRouter } from './routes/admin-doctor-block.js';
import { adminAppointmentTypesRouter } from './routes/admin-appointment-types.js';
import { availabilityRouter } from './routes/availability.js';
import { bookingsRouter } from './routes/bookings.js';
import { authMiddleware } from './middleware/auth.js';
import { adminScope } from './middleware/admin-scope.js';
import { getLogger, requestLogger } from './middleware/log.js';
import { loadAuthConfig } from './auth/config.js';
import type { SmsOtpService } from './otp/service.js';

export interface CreateAppOptions {
  requestLogger?: RequestHandler;
  smsOtpService?: SmsOtpService;
}

export function createApp(opts: CreateAppOptions = {}): express.Express {
  const logMw = opts.requestLogger ?? requestLogger;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(logMw);

  app.use(healthRouter);
  app.use(metricsRouter);

  // SMS-OTP router mounts BEFORE authMiddleware so an unauthenticated
  // caller can hit the login routes. The routes are themselves the auth
  // gate (the OTP is the credential). Body-parser is also above this
  // point so the routes can read `req.body`.
  if (opts.smsOtpService) {
    app.use('/patient', createSmsOtpRouter({ service: opts.smsOtpService }));
  }

  // Mock-OTP router mounts BEFORE authMiddleware for backward compatibility
  // with E0-S3's test suite. The mock stays for one story per the E0-S4
  // spec; E4-S1 will delete it when the real OTP modal lands.
  let mockOtpAllowed = false;
  try {
    mockOtpAllowed = loadAuthConfig().mockOtpAllowed;
  } catch {
    // If config fails to load (missing AUTH_SECRET), skip the mock-OTP
    // registration. Production boots will still fail-fast via server.ts's
    // explicit `loadAuthConfig()` call before `createApp()`.
  }
  if (mockOtpAllowed) {
    app.use('/patient', patientOtpRouter);
  }

  app.use(authMiddleware);

  // Availability route — mounted AFTER authMiddleware so req.auth.claim
  // is populated. Open to any authenticated caller (no adminScope).
  app.use(availabilityRouter);

  // Bookings route — POST /bookings. Atomic create; GIST-protected.
  // Same auth gate as availability: open to any authenticated caller.
  app.use(bookingsRouter);

  // Admin routes — mounted AFTER authMiddleware. Chained router-level
  // middleware means adminScope gates only `/admin/*`, not every path.
  // The mount order mirrors the E0-S3 convention: authenticated routers
  // (admin) come after the auth middleware, public routers (health,
  // metrics, OTP) before it.
  app.use('/admin', adminScope, adminClinicRouter, adminBranchesRouter, adminBranchHoursRouter, adminBranchDoctorsRouter, adminBranchReceptionistsRouter, adminDoctorScheduleRouter, adminDoctorBlockRouter, adminAppointmentTypesRouter);

  // JSON 404 fallthrough — kept after the routers so a matching route wins;
  // every other path returns a stable JSON error envelope (no HTML default).
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      // express.json() throws a SyntaxError with `type === 'entity.parse.failed'`
      // when the request body is malformed JSON. That's a client error
      // (4xx), not a server error — surface it as 400 invalid_json instead
      // of the generic 500 (P-A5 from E1-S1 review).
      const parseErr = err as { type?: string; statusCode?: number };
      if (
        err instanceof SyntaxError &&
        parseErr.type === 'entity.parse.failed'
      ) {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }
      const message = err instanceof Error ? err.message : 'unknown_error';
      getLogger().error({ err: message }, 'request_failed');
      res.status(500).json({ error: 'internal_error' });
    },
  );

  return app;
}
