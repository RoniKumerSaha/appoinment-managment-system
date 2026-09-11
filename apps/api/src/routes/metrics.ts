/**
 * GET /metrics — Prometheus exposition by default, JSON snapshot under
 * `Accept: application/json` for back-compat with the in-flight E0-S1 test
 * suite (`metrics.test.ts`).
 *
 * Format selection happens BEFORE we render so a single registry snapshot
 * isn't formatted twice:
 *   - Accept token EQUALS `application/json` (exact match) → `{counters: {...}}`
 *   - otherwise (default)                                  → text v0.0.4 Prometheus
 *
 * Exact-token matching is required; substring matches like `application/jsonp`
 * or `application/json; charset=utf-8` MUST NOT route to the legacy JSON
 * branch. The comma-separated token list is split, trimmed, and compared
 * for equality against `application/json` only.
 *
 * The legacy JSON shape uses the same 7 named counters as the Prometheus
 * output; the names are unchanged on the wire so scrapers reading either
 * format see the same domain.
 */
import { Router } from 'express';
import { snapshot } from '../metrics/counters.js';
import { render as renderPrometheus } from '../metrics/index.js';

export const metricsRouter = Router();

metricsRouter.get('/metrics', (req, res) => {
  const accept = req.headers['accept'] ?? '';
  // Exact-token Accept matching. The legacy JSON path is reserved for an
  // EXPLICIT `Accept: application/json`; substring matching would accidentally
  // match `application/jsonp` or any future vendor-prefixed media type that
  // happens to share the prefix. Comma-split + trim each token, then compare
  // for exact equality against `application/json`.
  const wantsJson =
    typeof accept === 'string' &&
    accept
      .split(',')
      .some((token) => token.trim() === 'application/json');
  if (wantsJson) {
    res.status(200).json({
      counters: snapshot(),
    });
    return;
  }
  // Default Prometheus exposition. Use `res.end()` rather than `res.send()`
  // because `res.send()` re-derives Content-Type / charset from the
  // argument and would rewrite our Prometheus-specific Content-Type into a
  // generic `text/plain; charset=utf-8`. `res.end()` writes the bytes
  // verbatim and leaves our Content-Type header intact.
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.end(renderPrometheus());
});
