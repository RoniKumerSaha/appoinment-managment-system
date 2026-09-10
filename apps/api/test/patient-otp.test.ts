/**
 * patient-otp.test.ts — `/patient/otp/verify-now` contract.
 *
 * Drives the live route via `createApp()` + supertest. Covers AC-10b
 * (body-escalation), AC-13 (happy path), AC-14 (bad code), AC-15 (bad
 * phone / missing fields), AC-16 (production + staging guard), AC-21
 * (log redaction: no full phone, no JWT body in emitted lines).
 *
 * The mock-OTP route is registered only when `NODE_ENV ∈ {development, test}`
 * (allowlist). Production and staging tests use a separate `createApp()`
 * after mutating `NODE_ENV` and resetting the config memoization.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Writable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createBaseLogger, createRequestLogger } from '../src/middleware/log.js';
import { __resetAuthConfigForTests } from '../src/auth/config.js';
import { verifyToken } from '../src/auth/jwt.js';
import {
  __redirectBaseLoggerForTests,
} from '../src/middleware/log.js';

const VALID_SECRET = 'a'.repeat(48);
const MOCK_CODE = '123456';

before(() => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['MOCK_OTP_CODE'] = MOCK_CODE;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
});

after(() => {
  delete process.env['AUTH_SECRET'];
  delete process.env['MOCK_OTP_CODE'];
  delete process.env['NODE_ENV'];
  __resetAuthConfigForTests();
});

beforeEach(() => {
  // Per-test reset: ensures the NODE_ENV mutation in production/staging
  // tests does not poison subsequent tests' config cache.
  resetForTest();
});

function appWithCapture() {
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
  // Force the captured logger to emit at info+ regardless of the ambient
  // LOG_LEVEL — the audit-log assertions need the route's `info(...)` lines
  // to land in `lines`. Without this, LOG_LEVEL=error (the default in CI)
  // would suppress every audit line and the redaction tests would never see
  // the data they're testing FOR the absence of.
  const prevLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'info';
  __redirectBaseLoggerForTests(stream);
  const baseLogger = createBaseLogger(stream);
  const requestLogger = createRequestLogger({ logger: baseLogger });
  const app = createApp({ requestLogger });
  return {
    app,
    lines,
    stream,
    restoreLevel: () => {
      process.env['LOG_LEVEL'] = prevLevel;
      __redirectBaseLoggerForTests();
    },
  };
}

// Force-reset memoized config for every test in this file. Tests mutate
// NODE_ENV (production, staging) and the boot-time memoization would
// otherwise pin a stale value for subsequent tests.
function resetForTest(): void {
  __resetAuthConfigForTests();
}

test('AC-13: happy path — {phone, code} returns {token, claim, expires_at}', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551234567', code: MOCK_CODE });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string', 'token must be a JWT string');
  assert.ok(res.body.claim, 'claim must be present');
  assert.equal(typeof res.body.expires_at, 'string', 'expires_at must be an ISO string');

  // Round-trip: the minted JWT verifies and yields the same claim shape.
  const claim = verifyToken(res.body.token);
  assert.ok(claim, 'minted JWT must verify');
  assert.equal(claim!.sub, '+15551234567');
  assert.equal(claim!.role, 'patient');
  assert.deepEqual([...claim!.branch_ids], []);
  assert.equal(claim!.scope, 'self');
});

test('AC-13: expires_at matches the JWT exp * 1000 (single source of truth)', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551234567', code: MOCK_CODE });
  assert.equal(res.status, 200);
  const claim = verifyToken(res.body.token)!;
  assert.equal(res.body.expires_at, new Date(claim.expires_at * 1000).toISOString());
});

test('AC-14: bad code → 401 {error: invalid_otp_code}, no token issued', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551234567', code: '000000' });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'invalid_otp_code' });
  assert.equal((res.body as { token?: unknown }).token, undefined, 'no token in 401 body');
});

test('AC-15: bad phone format (not E.164) → 400 {error: invalid_phone}', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '5551234', code: MOCK_CODE });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-15: missing phone → 400 {error: invalid_phone}', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ code: MOCK_CODE });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-15: missing code → 400 {error: invalid_phone}', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551234567' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-15: non-string phone (number) → 400', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: 1_555_123_4567, code: MOCK_CODE });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-15: non-string code (number) → 400', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551234567', code: 123456 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-15: phone with leading zero after + → 400 (E.164 forbids 0 after country code)', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+0123456789', code: MOCK_CODE });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-15: too-short phone (less than 7 digits) → 400', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551', code: MOCK_CODE });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-15: too-long phone (more than 15 digits) → 400', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+155512345678901234', code: MOCK_CODE });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'invalid_phone' });
});

test('AC-10b: body-escalation — body {role, branch_ids, doctor_id} ignored; mints patient JWT anyway', async () => {
  const { app } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({
      phone: '+15551234567',
      code: MOCK_CODE,
      role: 'admin',
      branch_ids: ['sneaky-branch'],
      scope: 'global',
      doctor_id: 'evil-doc',
    });
  assert.equal(res.status, 200, 'body fields must not affect route outcome');
  const claim = verifyToken(res.body.token)!;
  assert.equal(claim.role, 'patient', 'role MUST be patient regardless of body');
  assert.deepEqual([...claim.branch_ids], [], 'branch_ids MUST be empty regardless of body');
  assert.equal(claim.scope, 'self', 'scope MUST be self regardless of body');
  assert.equal(claim.doctor_id, undefined, 'doctor_id MUST NOT leak from body');
});

test('AC-16: production NODE_ENV refuses the route (404 not_found)', async () => {
  process.env['NODE_ENV'] = 'production';
  __resetAuthConfigForTests();
  try {
    const app = createApp();
    const res = await request(app)
      .post('/patient/otp/verify-now')
      .send({ phone: '+15551234567', code: MOCK_CODE });
    assert.equal(res.status, 404, 'route must NOT be registered in production');
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    process.env['NODE_ENV'] = 'test';
    __resetAuthConfigForTests();
  }
});

test('AC-16: staging NODE_ENV refuses the route (allowlist: dev/test only)', async () => {
  process.env['NODE_ENV'] = 'staging';
  __resetAuthConfigForTests();
  try {
    const app = createApp();
    const res = await request(app)
      .post('/patient/otp/verify-now')
      .send({ phone: '+15551234567', code: MOCK_CODE });
    assert.equal(res.status, 404, 'route must NOT be registered in staging');
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    process.env['NODE_ENV'] = 'test';
    __resetAuthConfigForTests();
  }
});

test('AC-21: audit log redacts phone to last-4 (success path)', async () => {
  const { app, lines, stream } = appWithCapture();
  await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551234567', code: MOCK_CODE });
  await new Promise<void>((resolve) => stream.end(resolve));
  const phoneLog = lines.find((l) => l.includes('mock_otp_success'));
  assert.ok(phoneLog, 'expected a mock_otp_success audit line');
  assert.ok(!phoneLog!.includes('+15551234567'), 'full phone must NOT appear in log');
  assert.ok(phoneLog!.includes('4567'), 'redacted phone (last-4) must appear');
});

test('AC-21: audit log redacts phone on failure path too', async () => {
  const { app, lines, stream } = appWithCapture();
  await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15559998888', code: '000000' });
  await new Promise<void>((resolve) => stream.end(resolve));
  const phoneLog = lines.find((l) => l.includes('mock_otp_rejected'));
  assert.ok(phoneLog, 'expected a mock_otp_rejected audit line');
  assert.ok(!phoneLog!.includes('+15559998888'), 'full phone must NOT appear in failure log');
  assert.ok(phoneLog!.includes('8888'), 'redacted phone (last-4) must appear');
});

test('AC-21: full JWT body never appears in log lines', async () => {
  const { app, lines, stream } = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/verify-now')
    .send({ phone: '+15551234567', code: MOCK_CODE });
  await new Promise<void>((resolve) => stream.end(resolve));
  // The minted JWT is `res.body.token`. We must NOT find that string in any
  // emitted log line — the response body is held only in memory and returned
  // to the caller, never logged at info+.
  const token = res.body.token as string;
  for (const line of lines) {
    assert.ok(!line.includes(token), `JWT must not appear in log line: ${line.slice(0, 80)}`);
  }
});
