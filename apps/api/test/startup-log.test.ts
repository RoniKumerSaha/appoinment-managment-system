/**
 * Startup log contract test.
 *
 * Drives the production `serviceStarted()` function directly with a captured
 * logger so we observe the JSON line without binding the test process to a
 * real PORT. The test asserts the E0-S6 startup contract:
 *
 *   exactly one `service_started` info log line, with non-empty
 *   `service`, `version`, `git_sha`, `node_env`, `port`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { __redirectBaseLoggerForTests } from '../src/middleware/log.js';
import { serviceStarted } from '../src/observability/build-info.js';

/**
 * Capture pino JSON lines into a string array. The captured Writable receives
 * one line per emit; we parse defensively so a malformed line does not throw.
 */
function captureLogger(): { stream: Writable; lines: () => string[] } {
  const captured: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const piece of s.split('\n')) {
        if (piece.length > 0) captured.push(piece);
      }
      cb();
    },
  });
  // Force info+ so the captured logger records the `service_started` emit
  // regardless of ambient LOG_LEVEL.
  const prevLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'info';
  // Inject the captured stream directly via the test-only redirect hook. The
  // hook builds a fresh pino logger bound to this destination, so subsequent
  // `getLogger()` reads (including the one inside `serviceStarted()`) emit
  // into the captured Writable.
  __redirectBaseLoggerForTests(stream);
  process.env['LOG_LEVEL'] = prevLevel;
  return {
    stream,
    lines: () => captured.slice(),
  };
}

test('serviceStarted() emits exactly one service_started info log line with the required fields', async () => {
  const { stream, lines } = captureLogger();
  // Pin the env so the captured line has predictable values.
  const prevVersion = process.env['APP_VERSION'];
  const prevSha = process.env['GIT_SHA'];
  const prevEnv = process.env['NODE_ENV'];
  process.env['APP_VERSION'] = '0.0.0-test';
  process.env['GIT_SHA'] = 'deadbeef';
  process.env['NODE_ENV'] = 'test';
  try {
    serviceStarted(4242);
    // flush
    await new Promise<void>((resolve) => stream.end(resolve));

    const events = lines()
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((p): p is Record<string, unknown> => p !== null);

    const startupLines = events.filter((e) => e['msg'] === 'service_started');
    assert.equal(
      startupLines.length,
      1,
      `expected exactly one service_started line; got ${startupLines.length}`,
    );

    const ev = startupLines[0]!;
    assert.equal(ev['service'], 'clinic-api');
    assert.equal(ev['version'], '0.0.0-test');
    assert.equal(ev['git_sha'], 'deadbeef');
    assert.equal(ev['node_env'], 'test');
    assert.equal(ev['port'], 4242);
  } finally {
    if (prevVersion === undefined) delete process.env['APP_VERSION'];
    else process.env['APP_VERSION'] = prevVersion;
    if (prevSha === undefined) delete process.env['GIT_SHA'];
    else process.env['GIT_SHA'] = prevSha;
    if (prevEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prevEnv;
    __redirectBaseLoggerForTests(undefined);
  }
});

test('serviceStarted() falls back to safe defaults when APP_VERSION / GIT_SHA are unset', async () => {
  const { stream, lines } = captureLogger();
  const prevVersion = process.env['APP_VERSION'];
  const prevSha = process.env['GIT_SHA'];
  delete process.env['APP_VERSION'];
  delete process.env['GIT_SHA'];
  try {
    serviceStarted(7777);
    await new Promise<void>((resolve) => stream.end(resolve));
    const events = lines()
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((p): p is Record<string, unknown> => p !== null);
    const startupLines = events.filter((e) => e['msg'] === 'service_started');
    assert.equal(startupLines.length, 1);
    const ev = startupLines[0]!;
    assert.equal(ev['version'], '0.0.0-dev');
    assert.equal(ev['git_sha'], 'unknown');
    assert.equal(typeof ev['service'], 'string');
    assert.ok((ev['service'] as string).length > 0);
    assert.equal(typeof ev['node_env'], 'string');
    assert.ok((ev['node_env'] as string).length > 0);
    assert.equal(ev['port'], 7777);
  } finally {
    if (prevVersion === undefined) delete process.env['APP_VERSION'];
    else process.env['APP_VERSION'] = prevVersion;
    if (prevSha === undefined) delete process.env['GIT_SHA'];
    else process.env['GIT_SHA'] = prevSha;
    __redirectBaseLoggerForTests(undefined);
  }
});

test('serviceStarted() with invalid port emits a warn and does NOT emit service_started', async () => {
  const { stream, lines } = captureLogger();
  // Cover the four rejection axes: NaN, negative, fractional, >65535.
  for (const bad of [Number.NaN, -1, 3.14, 99999]) {
    try {
      serviceStarted(bad);
    } catch {
      // The current implementation must NOT throw on invalid port — it
      // returns early after a warn line. A throw would also be acceptable
      // per the spec AC, but this implementation chose the warn path.
    }
  }
  await new Promise<void>((resolve) => stream.end(resolve));
  const events = lines()
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => p !== null);
  const startupLines = events.filter((e) => e['msg'] === 'service_started');
  assert.equal(
    startupLines.length,
    0,
    `service_started must not be emitted for invalid ports; got ${startupLines.length}`,
  );
  const warns = events.filter((e) => e['event'] === 'service_started_invalid_port');
  assert.ok(
    warns.length >= 1,
    `expected at least one service_started_invalid_port warn line; got ${warns.length}`,
  );
  __redirectBaseLoggerForTests(undefined);
});
