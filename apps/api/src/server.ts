/**
 * Runnable API entry. Imports the factory from `./app.ts` and binds to PORT.
 * Tests do NOT import this file; they import `./app.ts` directly.
 *
 * Boot guard: `loadAuthConfig()` is called BEFORE `createApp()` so a missing
 * or weak `AUTH_SECRET` (per E0-S3 AC-5/AC-6) fails the process before any
 * socket is bound. The exit code is non-zero so a supervisor restarts and the
 * failure is visible in deployment logs.
 */
import { createApp } from './app.js';
import { getLogger } from './middleware/log.js';
import { closePool } from './db/pool.js';
import { loadAuthConfig } from './auth/config.js';

const PORT = Number(process.env.PORT ?? 3001);

try {
  loadAuthConfig();
} catch (err) {
  const message = err instanceof Error ? err.message : 'auth_config_load_failed';
  getLogger().error({ err: message }, 'auth_config_load_failed');
  process.exit(1);
}

const app = createApp();
const server = app.listen(PORT, () => {
  getLogger().info({ port: PORT }, 'api_listening');
});

// Surface bind failures (e.g. EADDRINUSE) via the structured logger and
// exit non-zero so a process supervisor restarts cleanly.
server.on('error', (err) => {
  getLogger().error({ err: err.message }, 'bind_failed');
  process.exit(1);
});

// Graceful shutdown: stop accepting new connections, drain in-flight
// requests, close the pg.Pool, then exit.
const shutdown = (signal: string) => {
  getLogger().info({ signal }, 'shutting_down');
  server.close(() => {
    closePool()
      .catch((err) => {
        getLogger().error({ err: err instanceof Error ? err.message : String(err) }, 'pool_close_failed');
      })
      .finally(() => {
        process.exit(0);
      });
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

