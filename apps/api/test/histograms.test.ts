/**
 * Histogram registry contract tests.
 *
 * Asserts:
 *  - `observe()` on a known histogram increments count and sum.
 *  - `observe()` on an unknown name throws `Error('unknown_histogram_name:...')`.
 *  - `snapshot()` returns `{name, count, sum, buckets[]}` with the
 *    documented bucket boundaries.
 *  - Prometheus exposition has `_count` / `_sum` / per-bucket `_bucket{le=...}`
 *    lines for `http.request.duration_ms`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  observe,
  reset,
  snapshot,
  toPrometheus,
} from '../src/metrics/histograms.js';

test('observe() increments count and sum', () => {
  reset();
  observe('http.request.duration_ms', 42);
  observe('http.request.duration_ms', 8);
  const snaps = snapshot();
  assert.equal(snaps.length, 1);
  const snap = snaps[0]!;
  assert.equal(snap.name, 'http.request.duration_ms');
  assert.equal(snap.count, 2);
  assert.equal(snap.sum, 50);
});

test('observe() on an unknown histogram throws (unknown_histogram_name)', () => {
  reset();
  assert.throws(
    () => {
      // Cast to bypass the typed HistogramName union — the test purpose is
      // to assert that an unknown name throws at runtime, which is exactly
      // what the typed contract protects against. A second arg is required
      // by the typed signature so we pass a dummy value; the throw happens
      // BEFORE the value is touched.
      observe('totally.fake.metric' as never, 0);
    },
    /unknown_histogram_name/,
  );
});

test('snapshot() returns the documented shape with bucket boundaries', () => {
  reset();
  observe('http.request.duration_ms', 30);
  const snaps = snapshot();
  const snap = snaps[0]!;
  assert.equal(snap.name, 'http.request.duration_ms');
  assert.equal(snap.count, 1);
  assert.equal(snap.sum, 30);
  assert.ok(Array.isArray(snap.buckets));
  // boundaries are 5, 10, 25, 50, 100, 250, 500, 1000, 2500, +Inf
  const leValues = snap.buckets.map((b) => b.le);
  assert.deepEqual(leValues, [5, 10, 25, 50, 100, 250, 500, 1000, 2500, '+Inf']);
  // value 30 falls into le=50 (cumulative); counts below are 0, le=50 = 1.
  const bucketByLe = new Map(snap.buckets.map((b) => [String(b.le), b.count]));
  assert.equal(bucketByLe.get('5'), 0);
  assert.equal(bucketByLe.get('10'), 0);
  assert.equal(bucketByLe.get('25'), 0);
  assert.equal(bucketByLe.get('50'), 1);
  assert.equal(bucketByLe.get('+Inf'), 1);
});

test('toPrometheus() emits # TYPE histogram + per-bucket + _count + _sum lines', () => {
  reset();
  observe('http.request.duration_ms', 42);
  const body = toPrometheus();
  assert.ok(body.includes('# TYPE http_request_duration_ms histogram'));
  assert.match(body, /^http_request_duration_ms_bucket\{le="5"\} 0$/m);
  assert.match(body, /^http_request_duration_ms_bucket\{le="50"\} 1$/m);
  assert.match(body, /^http_request_duration_ms_bucket\{le="\+Inf"\} 1$/m);
  assert.match(body, /^http_request_duration_ms_count 1$/m);
  assert.match(body, /^http_request_duration_ms_sum 42$/m);
});

test('observe() rejects non-finite or negative valueMs with invalid_histogram_value:<name>', () => {
  reset();
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.throws(
      () => observe('http.request.duration_ms', bad),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'observe() must throw an Error');
        assert.equal(
          (err as Error).message,
          'invalid_histogram_value:http.request.duration_ms',
        );
        return true;
      },
    );
  }
  // And the registry state must remain zero after all the rejected calls.
  const snaps = snapshot();
  assert.equal(snaps[0]!.count, 0);
  assert.equal(snaps[0]!.sum, 0);
});
