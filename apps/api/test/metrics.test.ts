/**
 * Counter registry contract tests.
 *
 * Unit-level assertions on the counter registry:
 *  - MP-1: `inc()` throws on an unknown counter name.
 *  - `inc()` on a known counter increments the snapshot value.
 *
 * HTTP-level assertion (MP-2):
 *  - GET /metrics against `createApp()` returns all seven named counters at 0.
 *
 * E0-S6 additions:
 *  - Prometheus exposition shape (Content-Type, # HELP, # TYPE, sample lines).
 *  - JSON back-compat under `Accept: application/json`.
 *  - Process metrics presence (numeric type + Prometheus names).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { inc, reset, snapshot } from '../src/metrics/counters.js';
import { __resetForTests as resetProcess } from '../src/metrics/process.js';
import { createApp } from '../src/app.js';

const EXPECTED_COUNTERS = [
  'booking.attempt',
  'booking.success',
  'booking.conflict',
  'booking.failure',
  'otp.verification',
  'recurring.created',
  'recurring.skipped',
];

test('GET /metrics returns all seven named counters at 0', async () => {
  // Reset so the test sees a deterministic fresh snapshot. (The registry
  // is process-global; other tests may have incremented counters.)
  reset();
  resetProcess();
  const app = createApp();
  // E0-S6: default Content-Type is Prometheus; the legacy JSON `{counters}`
  // shape is returned only under `Accept: application/json`.
  const res = await request(app).get('/metrics').set('Accept', 'application/json');
  assert.equal(res.status, 200);
  const body = res.body as { counters: Record<string, number> };
  for (const name of EXPECTED_COUNTERS) {
    assert.ok(name in body.counters, `metrics must include ${name}; got=${Object.keys(body.counters).join(',')}`);
    assert.equal(body.counters[name], 0, `${name} should start at 0`);
  }
  assert.equal(Object.keys(body.counters).length, EXPECTED_COUNTERS.length);
});

test('inc() on a known counter increments the snapshot', () => {
  reset();
  resetProcess();
  inc('booking.attempt', 3);
  assert.equal(snapshot()['booking.attempt'], 3);
});

test('inc() on an unknown counter throws (MP-1)', () => {
  assert.throws(
    () => inc('booking.totally.invented' as never),
    /unknown_counter_name/,
  );
});

test('GET /metrics returns Prometheus exposition by default with # HELP / # TYPE / sample line per counter', async () => {
  reset();
  resetProcess();
  const app = createApp();
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  assert.equal(
    res.headers['content-type'],
    'text/plain; version=0.0.4; charset=utf-8',
  );
  const body = res.text;
  // Every named counter must be present in Prometheus form with full scaffolding.
  for (const name of EXPECTED_COUNTERS) {
    const promName = name.replace(/\./g, '_') + '_total';
    assert.ok(
      body.includes(`# HELP ${promName}`),
      `body must include # HELP for ${promName}`,
    );
    assert.ok(
      body.includes(`# TYPE ${promName} counter`),
      `body must include # TYPE counter for ${promName}`,
    );
    assert.ok(
      new RegExp(`^${promName} \\d+$`, 'm').test(body),
      `body must include a sample line for ${promName}`,
    );
  }
});

test('GET /metrics reflects counter increments in Prometheus sample lines', async () => {
  reset();
  resetProcess();
  inc('booking.attempt', 3);
  const app = createApp();
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.text, /^booking_attempt_total 3$/m);
});

test('GET /metrics returns JSON `{counters: {...}}` under Accept: application/json (back-compat)', async () => {
  reset();
  resetProcess();
  const app = createApp();
  const res = await request(app).get('/metrics').set('Accept', 'application/json');
  assert.equal(res.status, 200);
  const body = res.body as { counters: Record<string, number> };
  for (const name of EXPECTED_COUNTERS) {
    assert.ok(name in body.counters);
    assert.equal(body.counters[name], 0);
  }
  assert.equal(Object.keys(body.counters).length, EXPECTED_COUNTERS.length);
});

test('GET /metrics includes process_* metric lines (Prometheus)', async () => {
  reset();
  resetProcess();
  const app = createApp();
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  const body = res.text;
  for (const metric of [
    'uptime_seconds',
    'process_cpu_seconds_total',
    'process_resident_memory_bytes',
    'nodejs_eventloop_lag_seconds',
  ]) {
    assert.ok(
      body.includes(`# TYPE ${metric} `) || body.includes(`# TYPE ${metric}\n`),
      `body must include a # TYPE line for ${metric}`,
    );
    assert.ok(
      new RegExp(`^${metric} -?\\d+(\\.\\d+)?$`, 'm').test(body),
      `body must include a numeric sample line for ${metric}`,
    );
  }
});

test('GET /metrics includes histogram scaffolding for http.request.duration_ms', async () => {
  reset();
  resetProcess();
  const app = createApp();
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  const body = res.text;
  assert.ok(body.includes('# TYPE http_request_duration_ms histogram'));
  assert.ok(body.includes('http_request_duration_ms_bucket{le="5"} 0'));
  assert.ok(body.includes('http_request_duration_ms_bucket{le="+Inf"} 0'));
  assert.ok(body.includes('http_request_duration_ms_count 0'));
  assert.ok(body.includes('http_request_duration_ms_sum 0'));
});

test('GET /metrics with default Accept returns Prometheus body with all 7 counters at 0', async () => {
  reset();
  resetProcess();
  const app = createApp();
  // No Accept header at all → default branch is Prometheus, and the seven
  // named counters must each read exactly 0 in their `_total` sample line.
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  assert.equal(
    res.headers['content-type'],
    'text/plain; version=0.0.4; charset=utf-8',
  );
  const body = res.text;
  for (const name of EXPECTED_COUNTERS) {
    const promName = name.replace(/\./g, '_') + '_total';
    assert.match(
      body,
      new RegExp(`^${promName} 0$`, 'm'),
      `body must include a 0-valued sample line for ${promName}`,
    );
  }
});

test('GET /metrics with no Accept header does NOT take the JSON path (original E0-S1 caller shape)', async () => {
  reset();
  resetProcess();
  const app = createApp();
  // Original E0-S1 callers did not send an Accept header. The legacy JSON
  // back-compat path is reserved for an EXPLICIT `Accept: application/json`.
  // No header → Prometheus body, NOT JSON.
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  assert.notEqual(
    (res.headers['content-type'] as string | undefined) ?? '',
    'application/json',
  );
  assert.equal(
    res.headers['content-type'],
    'text/plain; version=0.0.4; charset=utf-8',
  );
  // Body should NOT be parseable as the legacy `{counters: ...}` JSON shape.
  let parsedAsLegacy: unknown = null;
  try {
    parsedAsLegacy = JSON.parse(res.text);
  } catch {
    // expected — Prometheus body is not valid JSON
  }
  if (parsedAsLegacy && typeof parsedAsLegacy === 'object') {
    assert.ok(
      !('counters' in (parsedAsLegacy as Record<string, unknown>)),
      'no-Accept response must not be the legacy {counters: ...} JSON shape',
    );
  }
});

test('GET /metrics with Accept: application/jsonp does NOT match (exact-token only)', async () => {
  reset();
  resetProcess();
  const app = createApp();
  const res = await request(app).get('/metrics').set('Accept', 'application/jsonp');
  assert.equal(res.status, 200);
  assert.notEqual(
    (res.headers['content-type'] as string | undefined) ?? '',
    'application/json',
  );
  assert.equal(
    res.headers['content-type'],
    'text/plain; version=0.0.4; charset=utf-8',
  );
});
