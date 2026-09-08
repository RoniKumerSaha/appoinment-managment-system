/**
 * Counter registry contract tests.
 *
 * Unit-level assertions on the counter registry:
 *  - MP-1: `inc()` throws on an unknown counter name.
 *  - `inc()` on a known counter increments the snapshot value.
 *
 * HTTP-level assertion (MP-2):
 *  - GET /metrics against `createApp()` returns all seven named counters at 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { inc, reset, snapshot } from '../src/metrics/counters.js';
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
  const app = createApp();
  const res = await request(app).get('/metrics');
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
  inc('booking.attempt', 3);
  assert.equal(snapshot()['booking.attempt'], 3);
});

test('inc() on an unknown counter throws (MP-1)', () => {
  assert.throws(
    () => inc('booking.totally.invented' as never),
    /unknown_counter_name/,
  );
});
