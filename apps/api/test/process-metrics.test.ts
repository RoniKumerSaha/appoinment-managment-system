/**
 * Process metrics contract tests.
 *
 * Asserts:
 *  - `snapshot()` returns the four documented fields with numeric types.
 *  - `toPrometheus()` emits one `# TYPE` line + one numeric sample line per
 *    process metric.
 *  - The four Prometheus names use the documented spelling:
 *      uptime_seconds, process_cpu_seconds_total,
 *      process_resident_memory_bytes, nodejs_eventloop_lag_seconds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, toPrometheus, __resetForTests as resetProcess } from '../src/metrics/process.js';

test('snapshot() returns numeric fields for every process metric', () => {
  resetProcess();
  const s = snapshot();
  assert.equal(typeof s.uptime_seconds, 'number');
  assert.equal(typeof s.process_cpu_seconds_total, 'number');
  assert.equal(typeof s.process_resident_memory_bytes, 'number');
  assert.equal(typeof s.nodejs_eventloop_lag_seconds, 'number');
});

test('toPrometheus() includes a # TYPE + numeric sample line per process metric', () => {
  resetProcess();
  const body = toPrometheus();
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
