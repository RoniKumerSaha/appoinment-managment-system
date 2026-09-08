/**
 * Probe response contracts.
 *
 * /healthz is process liveness — does NOT touch the database.
 * /readyz pings the DB and returns 503 if unreachable.
 *
 * The responses are deliberately small so they never leak stack traces or PII.
 */
export interface HealthResponse {
  status: 'ok';
}

export interface ReadyResponse {
  db: 'ok' | 'unreachable';
}
