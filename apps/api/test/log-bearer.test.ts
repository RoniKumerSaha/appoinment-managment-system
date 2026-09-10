/**
 * log-bearer.test.ts — Bearer-path log context parity (AC-19b, AC-21).
 *
 * Drives `createApp()` once with a Bearer JWT and once with the dev-only
 * `x-auth-claim` debug header. Captures pino-http output and asserts the
 * emitted line carries the SAME `actor_role` and `actor_id` fields in both
 * paths. The two paths must be interchangeable from a log-consumer's point
 * of view — switching from dev (debug header) to prod (Bearer) must not
 * change the shape of the structured log line.
 *
 * Also pins AC-21 (log redaction): the Bearer JWT must never appear in any
 * emitted log line (pino redact strips `req.headers.authorization` and the
 * `x-auth-claim` header before serialization; we verify the post-redaction
 * line does not contain the raw token or claim JSON).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Writable } from 'node:stream';
import { createApp } from '../src/app.js';
import {
  createBaseLogger,
  createRequestLogger,
} from '../src/middleware/log.js';
import { signClaim } from '../src/auth/jwt.js';
import {
  __resetAuthConfigForTests,
} from '../src/auth/config.js';

const VALID_SECRET = 'a'.repeat(48);
const POST_AUTH_PATH = '/__no_such_route__';

before(() => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  __resetAuthConfigForTests();
});

after(() => {
  delete process.env['AUTH_SECRET'];
  __resetAuthConfigForTests();
});

interface Capture {
  app: ReturnType<typeof createApp>;
  lines: string[];
  stream: Writable;
}

function makeCapture(): Capture {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const piece of s.split('\n')) {
        if (piece.length > 0) lines.push(piece);
      }
      cb();
    },
  });
  // Force info level for the captured logger so pino-http emits its
  // request-completion line; see patient-otp.test.ts for the same pattern.
  const prevLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'info';
  const baseLogger = createBaseLogger(stream);
  const requestLogger = createRequestLogger({ logger: baseLogger });
  const app = createApp({ requestLogger });
  process.env['LOG_LEVEL'] = prevLevel;
  return { app, lines, stream };
}

async function getPinoEvents(lines: string[]): Promise<Record<string, unknown>[]> {
  // Wait for the async log emit to land before we end the stream.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => p !== null && 'req' in p);
}

test('AC-19b: Bearer path attaches actor_role and actor_id identically to debug path', async () => {
  const bearer = makeCapture();
  const debug = makeCapture();
  // Mint a fresh JWT with a fixed `now` so the verifier accepts it.
  const now = Math.floor(Date.now() / 1000);
  const token = signClaim(
    { sub: 'doctor-abc', role: 'doctor', branch_ids: ['branch-a'], scope: 'branch', doctor_id: 'doctor-abc' },
    now,
  );
  // Issue one request through each path with the SAME actor identity.
  const r1 = await request(bearer.app).get(POST_AUTH_PATH).set('Authorization', `Bearer ${token}`);
  const r2 = await request(debug.app).get(POST_AUTH_PATH).set(
    'x-auth-claim',
    JSON.stringify({
      sub: 'doctor-abc',
      role: 'doctor',
      branch_ids: ['branch-a'],
      scope: 'branch',
      doctor_id: 'doctor-abc',
    }),
  );
  assert.equal(r1.status, 404, 'Bearer + valid claim → 404 fallthrough');
  assert.equal(r2.status, 404, 'Debug header + valid claim → 404 fallthrough');

  const evBearer = (await getPinoEvents(bearer.lines))[0]!;
  const evDebug = (await getPinoEvents(debug.lines))[0]!;

  assert.equal(evBearer.actor_role, 'doctor', 'Bearer-path actor_role');
  assert.equal(evBearer.actor_id, 'doctor-abc', 'Bearer-path actor_id');
  assert.equal(evDebug.actor_role, 'doctor', 'Debug-path actor_role');
  assert.equal(evDebug.actor_id, 'doctor-abc', 'Debug-path actor_id');

  assert.equal(evBearer.actor_role, evDebug.actor_role, 'parity: actor_role');
  assert.equal(evBearer.actor_id, evDebug.actor_id, 'parity: actor_id');
  assert.equal(evBearer.appointment_id, null, 'parity: appointment_id absent → null');
  assert.equal(evDebug.appointment_id, null, 'parity: appointment_id absent → null');
});

test('AC-19b: Bearer path with patient (empty branch_ids) attaches actor_role/actor_id', async () => {
  const cap = makeCapture();
  const now = Math.floor(Date.now() / 1000);
  const token = signClaim(
    { sub: 'patient-xyz', role: 'patient', branch_ids: [], scope: 'self' },
    now,
  );
  const res = await request(cap.app).get(POST_AUTH_PATH).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  const ev = (await getPinoEvents(cap.lines))[0]!;
  assert.equal(ev.actor_role, 'patient');
  assert.equal(ev.actor_id, 'patient-xyz');
});

test('AC-19b: anonymous Bearer (no header) emits null actor_role and actor_id', async () => {
  const cap = makeCapture();
  const res = await request(cap.app).get(POST_AUTH_PATH);
  assert.equal(res.status, 404);
  const ev = (await getPinoEvents(cap.lines))[0]!;
  assert.equal(ev.actor_role, null, 'anonymous → actor_role null');
  assert.equal(ev.actor_id, null, 'anonymous → actor_id null');
});

test('AC-21: Bearer JWT never appears in any emitted log line', async () => {
  const cap = makeCapture();
  const now = Math.floor(Date.now() / 1000);
  const token = signClaim(
    { sub: 'leak-test', role: 'receptionist', branch_ids: ['b1'], scope: 'branch' },
    now,
  );
  const res = await request(cap.app).get(POST_AUTH_PATH).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
  // pino redact strips `req.headers.authorization` before serialization.
  for (const line of cap.lines) {
    assert.ok(
      !line.includes(token),
      `JWT must NOT appear in log line: ${line.slice(0, 120)}`,
    );
  }
});

test('AC-21: x-auth-claim JSON never appears in any emitted log line', async () => {
  const cap = makeCapture();
  const claimJson = JSON.stringify({
    sub: 'leak-test',
    role: 'doctor',
    branch_ids: ['b1'],
    scope: 'branch',
    doctor_id: 'leak-test',
  });
  const res = await request(cap.app).get(POST_AUTH_PATH).set('x-auth-claim', claimJson);
  assert.equal(res.status, 404);
  for (const line of cap.lines) {
    assert.ok(
      !line.includes(claimJson),
      `x-auth-claim JSON must NOT appear in log line: ${line.slice(0, 120)}`,
    );
  }
});
