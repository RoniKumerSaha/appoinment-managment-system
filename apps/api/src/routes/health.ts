/**
 * /healthz and /readyz.
 *
 * /healthz is process liveness — returns 200 as long as the process is up.
 * /readyz pings the DB; returns 200 when reachable, 503 when not. The 503 body
 * never includes a stack trace.
 */
import { Router } from 'express';
import type { HealthResponse, ReadyResponse } from '../types/health.js';
import { pingDb } from '../db/pool.js';

export const healthRouter = Router();

healthRouter.get('/healthz', (_req, res) => {
  const body: HealthResponse = { status: 'ok' };
  res.status(200).json(body);
});

healthRouter.get('/readyz', async (_req, res) => {
  const ok = await pingDb();
  if (ok) {
    const body: ReadyResponse = { db: 'ok' };
    res.status(200).json(body);
  } else {
    const body: ReadyResponse = { db: 'unreachable' };
    res.status(503).json(body);
  }
});
