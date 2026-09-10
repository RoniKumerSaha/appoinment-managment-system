/**
 * sms-otp.test.ts — `/patient/otp/send` + `/patient/otp/verify` integration.
 *
 * Exercises the live route via `createApp()` + supertest, against a real
 * Postgres container (`withTestDb`). The SmsOtpService is constructed
 * with `LogSmsOtpProvider` (the test capture destination) so the OTP code
 * is observable in logs but never sent over the wire.
 *
 * Coverage matrix (refer to spec-0-4-sms-otp-gateway.md):
 *   AC-1, AC-2 (send happy path; code_hash format)
 *   AC-3 (cooldown)
 *   AC-4 (lockout after 3 wrong verifies)
 *   AC-5 (verify happy path; row deleted)
 *   AC-6 (wrong code; attempts incremented; counter incremented)
 *   AC-7 (expired code)
 *   AC-8 (no outstanding row)
 *   AC-9 (parallel verify race)
 *   AC-10 (invalid phone)
 *   AC-11 (invalid code)
 *   AC-12 (body-escalation ignored)
 *   AC-21 (counter increments per verify)
 *   AC-22 (provider failure rolls back)
 *   AC-23 (last_sent_at anchored to send, not created_at)
 *   AC-24 (log redaction)
 *   AC-25 (E0-S2/E0-S3 invariants unaffected — covered by re-running
 *          the existing migration/invariant/seed/auth/pgcrypto suites)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { getTestDb, type TestDb } from './db/withTestDb.js';
import { createApp } from '../src/app.js';
import { SmsOtpService } from '../src/otp/service.js';
import { LogSmsOtpProvider } from '../src/otp/log-provider.js';
import {
  __redirectBaseLoggerForTests,
  createBaseLogger,
  createRequestLogger,
} from '../src/middleware/log.js';
import { reset } from '../src/metrics/counters.js';
import { SmsSendFailed } from '../src/otp/provider.js';
import { loadAuthConfig, __resetAuthConfigForTests } from '../src/auth/config.js';
import { verifyToken } from '../src/auth/jwt.js';

const VALID_SECRET = 'a'.repeat(48);

let db: TestDb;
let service: SmsOtpService;
let lines: string[];

before(async () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
  loadAuthConfig();
  db = await getTestDb();
  service = new SmsOtpService(db.pool, new LogSmsOtpProvider(), {
    provider: 'log',
    ttlSeconds: 300,
    lockoutThreshold: 3,
    lockoutSeconds: 600,
    cooldownSeconds: 30,
    codeLength: 6,
  });
});

after(async () => {
  __redirectBaseLoggerForTests();
});

function appWithCapture() {
  lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const piece of s.split('\n')) {
        if (piece.length > 0) lines.push(piece);
      }
      cb();
    },
  });
  // F16: capture LOG_LEVEL before mutation and restore it in an `after`
  // hook so a test failure doesn't leak the override into the next test.
  // We track the previous value per-call and rely on `beforeEach` to
  // reset `lines` — the LOG_LEVEL restoration happens via an `after`
  // hook attached the first time `appWithCapture` runs.
  const prevLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'info';
  if (prevLevel === undefined) {
    after(() => {
      delete process.env['LOG_LEVEL'];
    });
  } else {
    after(() => {
      process.env['LOG_LEVEL'] = prevLevel;
    });
  }
  __redirectBaseLoggerForTests(stream);
  const baseLogger = createBaseLogger(stream);
  const requestLogger = createRequestLogger({ logger: baseLogger });
  return createApp({ requestLogger, smsOtpService: service });
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function fetchOtpRow(phone: string): Promise<{
  code_hash: string;
  expires_at: Date;
  attempts: number;
  locked_until: Date | null;
  last_sent_at: Date;
  created_at: Date;
} | null> {
  const { rows } = await db.pool.query<{
    code_hash: string;
    expires_at: Date;
    attempts: number;
    locked_until: Date | null;
    last_sent_at: Date;
    created_at: Date;
  }>(
    `SELECT code_hash, expires_at, attempts, locked_until, last_sent_at, created_at
     FROM otp_verification WHERE phone_e164 = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

async function fetchOtpCode(phone: string): Promise<string | null> {
  // Pulls the most recent code from the in-memory log capture. The
  // `LogSmsOtpProvider` writes the raw code into the log so tests can
  // recover it without standing up a stub registry.
  const logLine = [...lines].reverse().find(
    (l) => l.includes('sms_otp_send_logged') && l.includes('"phone":"***'),
  );
  if (!logLine) return null;
  const obj = JSON.parse(logLine) as { code?: string; phone?: string };
  if (obj.phone !== '***' + phone.slice(-4)) return null;
  return typeof obj.code === 'string' ? obj.code : null;
}

beforeEach(async () => {
  reset();
  await db.pool.query(`DELETE FROM otp_verification`);
  lines = [];
});

test('AC-1: send happy path inserts row with sha-256 hex code_hash', async () => {
  const app = appWithCapture();
  const res = await request(app)
    .post('/patient/otp/send')
    .send({ phone: '+15551234567' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.expires_at, 'string');
  // F2: spec matrix pins `cooldown_ms: 0` on first-time send. The full
  // cooldown window is reported only on the 429 rejection path. See
  // sms-otp.test.ts AC-3 for the rejection-side assertion.
  assert.equal(res.body.cooldown_ms, 0);

  const row = await fetchOtpRow('+15551234567');
  assert.ok(row, 'row must exist after send');
  assert.equal(row!.code_hash.length, 64, 'sha-256 hex is exactly 64 chars');
  assert.equal(row!.attempts, 0);
  assert.equal(row!.locked_until, null);
});

test('AC-2: code_hash is NOT the raw code; matches sha256(code)', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const code = await fetchOtpCode('+15551234567');
  assert.ok(code, 'expected to capture the OTP code from log');
  const row = await fetchOtpRow('+15551234567');
  assert.ok(row);
  assert.notEqual(row!.code_hash, code, 'code_hash MUST NOT be the raw code');
  assert.equal(row!.code_hash, sha256Hex(code!), 'code_hash must equal sha256(code) hex');
});

test('AC-3: cooldown (30s) on second send within window', async () => {
  const app = appWithCapture();
  const first = await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  assert.equal(first.status, 200);
  const second = await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'otp_cooldown');
  assert.ok(second.body.retry_after_ms > 0, 'retry_after_ms must be positive');
  assert.ok(second.body.retry_after_ms <= 30000, 'retry_after_ms must be within cooldown');
  // Exactly one row.
  const { rows } = await db.pool.query(`SELECT id FROM otp_verification WHERE phone_e164 = $1`, ['+15551234567']);
  assert.equal(rows.length, 1, 'cooldown path must not insert a second row');
});

test('AC-4: 3 wrong-code verifies → lockout; 4th is locked without incrementing attempts', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const code = await fetchOtpCode('+15551234567');
  assert.ok(code);
  const wrongCode = code === '000000' ? '111111' : '000000';

  for (let i = 0; i < 3; i++) {
    const r = await request(app)
      .post('/patient/otp/verify')
      .send({ phone: '+15551234567', code: wrongCode });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
    assert.equal(r.body.error, 'invalid_otp_code');
  }
  let row = await fetchOtpRow('+15551234567');
  assert.ok(row);
  assert.equal(row!.attempts, 3, 'attempts must be 3 after three failures');
  assert.ok(row!.locked_until !== null, 'locked_until must be set after threshold');
  assert.ok(new Date(row!.locked_until!).getTime() > Date.now(), 'locked_until must be in the future');

  // 4th attempt with correct code (just to prove the lockout blocks even right code).
  const fourth = await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15551234567', code });
  assert.equal(fourth.status, 429, '4th attempt within lockout returns 429');
  assert.equal(fourth.body.error, 'otp_locked');
  assert.ok(fourth.body.retry_after_ms > 0);

  row = await fetchOtpRow('+15551234567');
  assert.equal(row!.attempts, 3, 'attempts MUST NOT increment during lockout');
});

test('AC-5: verify happy path returns JWT, deletes row, counter increments', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const code = await fetchOtpCode('+15551234567');
  assert.ok(code);
  reset();
  const r = await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15551234567', code });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.token, 'string');
  const claim = verifyToken(r.body.token)!;
  assert.equal(claim.sub, '+15551234567');
  assert.equal(claim.role, 'patient');
  assert.deepEqual([...claim.branch_ids], []);
  assert.equal(claim.scope, 'self');
  assert.equal(typeof r.body.expires_at, 'string');
  assert.equal(r.body.expires_at, new Date(claim.expires_at * 1000).toISOString());
  const row = await fetchOtpRow('+15551234567');
  assert.equal(row, null, 'row must be deleted on successful verify');
  const { snapshot } = await import('../src/metrics/counters.js');
  assert.equal(snapshot()['otp.verification'], 1, 'counter MUST increment on success');
});

test('AC-6: wrong code increments attempts by exactly 1; counter increments', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  reset();
  const before = (await db.pool.query(`SELECT attempts FROM otp_verification WHERE phone_e164 = $1`, ['+15551234567'])).rows[0]?.attempts ?? 0;
  const r = await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15551234567', code: '999999' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'invalid_otp_code');
  const row = await fetchOtpRow('+15551234567');
  assert.equal(row!.attempts, before + 1, 'attempts must increment by 1');
  // Read counter via fresh import to avoid circular reset.
  const { snapshot } = await import('../src/metrics/counters.js');
  assert.equal(snapshot()['otp.verification'], 1, 'counter MUST increment on failure');
});

test('AC-7: expired code returns 401 otp_expired (not deleted)', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  // Force expiry by rewriting the row.
  await db.pool.query(
    `UPDATE otp_verification SET expires_at = now() - INTERVAL '1 second' WHERE phone_e164 = $1`,
    ['+15551234567'],
  );
  const code = await fetchOtpCode('+15551234567');
  assert.ok(code);
  const r = await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15551234567', code });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'otp_expired');
  const row = await fetchOtpRow('+15551234567');
  assert.ok(row, 'expired row must NOT be deleted (caller can re-verify up to lockout)');
});

test('AC-8: no outstanding row → 401 no_outstanding_otp', async () => {
  const app = appWithCapture();
  const r = await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15559998888', code: '123456' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'no_outstanding_otp');
  const { rows } = await db.pool.query(`SELECT id FROM otp_verification WHERE phone_e164 = $1`, ['+15559998888']);
  assert.equal(rows.length, 0, 'no row must be created on a no_outstanding_otp path');
});

test('AC-9: parallel verify race — exactly one wins, the other gets no_outstanding_otp', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const code = await fetchOtpCode('+15551234567');
  assert.ok(code);

  const verifyOnce = async () =>
    request(app).post('/patient/otp/verify').send({ phone: '+15551234567', code });

  const [a, b] = await Promise.all([verifyOnce(), verifyOnce()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 401], `expected one 200 and one 401; got [${a.status}, ${b.status}]`);
  const winner = a.status === 200 ? a : b;
  const loser = a.status === 401 ? a : b;
  const claim = verifyToken(winner.body.token)!;
  assert.equal(claim.role, 'patient');
  assert.equal(loser.body.error, 'no_outstanding_otp');
});

test('AC-10: send with non-E.164 phone returns 400 invalid_phone', async () => {
  const app = appWithCapture();
  for (const bad of ['5551234', '+0123456789', '+15551', '+155512345678901234', '']) {
    const r = await request(app).post('/patient/otp/send').send({ phone: bad });
    assert.equal(r.status, 400, `phone=${JSON.stringify(bad)}`);
    assert.equal(r.body.error, 'invalid_phone');
  }
});

test('AC-10b: send with non-string phone returns 400', async () => {
  const app = appWithCapture();
  const r = await request(app).post('/patient/otp/send').send({ phone: 1_555_123_4567 });
  assert.equal(r.status, 400);
});

test('AC-10c: send with no phone returns 400', async () => {
  const app = appWithCapture();
  const r = await request(app).post('/patient/otp/send').send({});
  assert.equal(r.status, 400);
});

test('AC-11: verify with non-6-digit code returns 400 invalid_code', async () => {
  const app = appWithCapture();
  for (const bad of ['abc', '12345', '1234567', '', 123456, null]) {
    const r = await request(app)
      .post('/patient/otp/verify')
      .send({ phone: '+15551234567', code: bad });
    assert.equal(r.status, 400, `code=${JSON.stringify(bad)}`);
    assert.equal(r.body.error, 'invalid_code');
  }
});

test('AC-12: body-escalation — body {role, branch_ids, doctor_id} ignored', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const code = await fetchOtpCode('+15551234567');
  assert.ok(code);
  const r = await request(app)
    .post('/patient/otp/verify')
    .send({
      phone: '+15551234567',
      code,
      role: 'admin',
      branch_ids: ['sneaky'],
      scope: 'global',
      doctor_id: 'evil-doc',
    });
  assert.equal(r.status, 200);
  const claim = verifyToken(r.body.token)!;
  assert.equal(claim.role, 'patient');
  assert.deepEqual([...claim.branch_ids], []);
  assert.equal(claim.scope, 'self');
  assert.equal(claim.doctor_id, undefined);
});

test('AC-22: provider failure rolls back the send transaction (no orphan row)', async () => {
  const app = appWithCapture();
  // Replace the service's provider with a stub that throws.
  const failingService = new SmsOtpService(
    db.pool,
    {
      send: async () => {
        throw new SmsSendFailed('test_provider_failure');
      },
    },
    {
      provider: 'log',
      ttlSeconds: 300,
      lockoutThreshold: 3,
      lockoutSeconds: 600,
      cooldownSeconds: 30,
      codeLength: 6,
    },
  );
  const failApp = createApp({ smsOtpService: failingService });
  const r = await request(failApp)
    .post('/patient/otp/send')
    .send({ phone: '+15551234567' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'sms_send_failed');
  const { rows } = await db.pool.query(`SELECT id FROM otp_verification WHERE phone_e164 = $1`, ['+15551234567']);
  assert.equal(rows.length, 0, 'transaction must roll back so no orphan row exists');
});

test('AC-23: last_sent_at anchored to send time (not created_at)', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const row = await fetchOtpRow('+15551234567');
  assert.ok(row);
  // last_sent_at and created_at should be within ~10ms of each other on
  // first send. Both are derived from `app_now()`.
  const drift = Math.abs(new Date(row!.last_sent_at).getTime() - new Date(row!.created_at).getTime());
  assert.ok(drift < 50, `last_sent_at and created_at must agree on first send; drift=${drift}ms`);
});

test('AC-24: log redaction — full phone never appears in any log line', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15551234567', code: '999999' });
  const full = '+15551234567';
  for (const line of lines) {
    assert.ok(!line.includes(full), `full phone must NOT appear in log: ${line.slice(0, 80)}`);
  }
});

test('AC-24b: log redacts phone to last-4 (success path)', async () => {
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const sendLog = lines.find((l) => l.includes('sms_otp_send_success'));
  assert.ok(sendLog, 'expected a sms_otp_send_success line');
  assert.ok(sendLog!.includes('***4567'), 'redacted last-4 must appear');
});

test('AC-21: counter increments per verify (success + failure + no-row)', async () => {
  const app = appWithCapture();
  reset();
  // No-row verify (counts as 1).
  await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15559998001', code: '123456' });
  // Send + wrong code (counts as 1 more = 2).
  await request(app).post('/patient/otp/send').send({ phone: '+15559998002' });
  await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15559998002', code: '999999' });
  // Send + success (counts as 1 more = 3).
  await request(app).post('/patient/otp/send').send({ phone: '+15559998003' });
  const lines3: string[] = lines;
  const code3 = (() => {
    const logLine = [...lines3].reverse().find(
      (l) => l.includes('sms_otp_send_logged') && l.includes('"phone":"***8003"'),
    );
    return logLine ? (JSON.parse(logLine) as { code?: string }).code ?? null : null;
  })();
  assert.ok(code3);
  await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15559998003', code: code3 });
  const { snapshot } = await import('../src/metrics/counters.js');
  assert.equal(snapshot()['otp.verification'], 3, 'expected 3 verifications total');
});

test('AC-1b: cleanup-of-expired-row path inside the same transaction', async () => {
  // Insert an expired row directly (no provider involved), then send —
  // the new send should rotate it without UNIQUE conflict.
  await db.pool.query(
    `INSERT INTO otp_verification (phone_e164, code_hash, expires_at, attempts, locked_until, last_sent_at, created_at)
     VALUES ('+15551234567', repeat('a', 64), now() - INTERVAL '1 second', 5, NULL, now() - INTERVAL '5 minutes', now() - INTERVAL '5 minutes')`,
  );
  const app = appWithCapture();
  const r = await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  assert.equal(r.status, 200, 'send should rotate the expired row, not conflict on UNIQUE');
  const { rows } = await db.pool.query(`SELECT attempts FROM otp_verification WHERE phone_e164 = $1`, ['+15551234567']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.attempts, 0, 'attempts must reset on rotation');
});

test('F4: successful verify resets the cooldown window', async () => {
  // After a successful verify the row is deleted. The next send inserts a
  // fresh row with `last_sent_at = now()`, so the cooldown is no longer
  // active. Regression check: if `INSERT ... ON CONFLICT DO UPDATE` ever
  // dropped `last_sent_at = EXCLUDED.last_sent_at` from its SET clause,
  // the cooldown would persist across rotations and patients could not
  // re-send for 30 seconds after a successful login.
  const app = appWithCapture();
  await request(app).post('/patient/otp/send').send({ phone: '+15551234567' });
  const code = await fetchOtpCode('+15551234567');
  assert.ok(code);
  const verifyRes = await request(app)
    .post('/patient/otp/verify')
    .send({ phone: '+15551234567', code });
  assert.equal(verifyRes.status, 200);
  // Immediately re-send — cooldown should NOT be active because the
  // verify deleted the row.
  const resendRes = await request(app)
    .post('/patient/otp/send')
    .send({ phone: '+15551234567' });
  assert.equal(resendRes.status, 200, 'resend after verify must NOT hit cooldown');
  assert.equal(resendRes.body.cooldown_ms, 0);
  const row = await fetchOtpRow('+15551234567');
  assert.ok(row);
  // Fresh `last_sent_at` must be very recent (post-verify, post-resend).
  const drift = Math.abs(new Date(row!.last_sent_at).getTime() - Date.now());
  assert.ok(drift < 5_000, `last_sent_at must be near now after resend; drift=${drift}ms`);
});
