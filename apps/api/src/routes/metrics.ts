/**
 * GET /metrics — returns the current counter snapshot.
 *
 * Format is JSON, not Prometheus exposition — E0-S6 will switch the format
 * once the observability baseline lands. The keys are stable and named exactly
 * the way booking/otp/recurring stories will increment them.
 */
import { Router } from 'express';
import { snapshot } from '../metrics/counters.js';

export const metricsRouter = Router();

metricsRouter.get('/metrics', (_req, res) => {
  res.status(200).json({
    counters: snapshot(),
  });
});
