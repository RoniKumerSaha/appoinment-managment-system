/**
 * Runnable API entry. Imports the factory from `./app.ts` and binds to PORT.
 * Tests do NOT import this file; they import `./app.ts` directly.
 */
import { createApp } from './app.js';
import { logger } from './middleware/log.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = createApp();
app.listen(PORT, () => {
  logger.info({ port: PORT }, 'api_listening');
});
