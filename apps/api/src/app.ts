/**
 * Express app factory (no side effects on import).
 *
 * `server.ts` is the runnable entry that binds to PORT. Tests import this
 * module directly so importing does NOT start listening on a real port.
 */
import express from 'express';
import { healthRouter } from './routes/health.js';
import { metricsRouter } from './routes/metrics.js';
import { authMiddleware } from './middleware/auth.js';
import { logger, requestLogger } from './middleware/log.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(requestLogger);

  app.use(healthRouter);
  app.use(metricsRouter);

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
      logger.error({ err: message }, 'request_failed');
      res.status(500).json({ error: 'internal_error' });
    },
  );

  return app;
}
