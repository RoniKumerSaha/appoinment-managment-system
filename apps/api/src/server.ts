/**
 * Runnable API entry. Imports the factory from `./app.ts` and binds to PORT.
 * Tests do NOT import this file; they import `./app.ts` directly.
 */
import { createApp } from './app.js';
import { logger } from './middleware/log.js';
import { closePool } from './db/pool.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = createApp();
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'api_listening');
});

// Surface bind failures (e.g. EADDRINUSE) via the structured logger and
// exit non-zero so a process supervisor restarts cleanly.
server.on('error', (err) => {
  logger.error({ err: err.message }, 'bind_failed');
  process.exit(1);
});

// Graceful shutdown: stop accepting new connections, drain in-flight
// requests, close the pg.Pool, then exit.
const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting_down');
  server.close(() => {
    closePool()
      .catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'pool_close_failed');
      })
      .finally(() => {
        process.exit(0);
      });
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
