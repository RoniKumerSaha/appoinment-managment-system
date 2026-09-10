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
 * Mock-OTP route registration is gated on `NODE_ENV ∈ {development, test}`
 * via `loadAuthConfig().mockOtpAllowed` — see `./auth/config.ts`.
 */
import express from 'express';
import type { RequestHandler } from 'express';
import { healthRouter } from './routes/health.js';
import { metricsRouter } from './routes/metrics.js';
import { patientOtpRouter } from './routes/patient-otp.js';
import { authMiddleware } from './middleware/auth.js';
import { getLogger, requestLogger } from './middleware/log.js';
import { loadAuthConfig } from './auth/config.js';

export interface CreateAppOptions {
  requestLogger?: RequestHandler;
}

export function createApp(opts: CreateAppOptions = {}): express.Express {
  const logMw = opts.requestLogger ?? requestLogger;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(logMw);

  app.use(healthRouter);
  app.use(metricsRouter);

  // Mock-OTP router mounts BEFORE authMiddleware so an unauthenticated caller
  // can hit the login route. The route handler itself is the auth gate for
  // this surface. Body-parser is also above this point so the route can
  // read `req.body`.
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
      const message = err instanceof Error ? err.message : 'unknown_error';
      getLogger().error({ err: message }, 'request_failed');
      res.status(500).json({ error: 'internal_error' });
    },
  );

  return app;
}
