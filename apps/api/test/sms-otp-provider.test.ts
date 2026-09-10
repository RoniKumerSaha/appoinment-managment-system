/**
 * sms-otp-provider.test.ts — provider implementations.
 *
 * Pure unit tests for `LogSmsOtpProvider` and `TwilioSmsOtpProvider`. No DB
 * access; no HTTP. The Twilio test injects a stub client so no real Twilio
 * API call ever fires in CI.
 *
 * AC-13 (Log writes OTP code) and AC-14 (Twilio calls messages.create
 * with correct args) live here.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { LogSmsOtpProvider } from '../src/otp/log-provider.js';
import { TwilioSmsOtpProvider } from '../src/otp/twilio-provider.js';
import { SmsSendFailed } from '../src/otp/provider.js';
import {
  __redirectBaseLoggerForTests,
  createBaseLogger,
} from '../src/middleware/log.js';

before(() => {
  process.env['NODE_ENV'] = 'test';
});

after(() => {
  // Restore the original stdout logger.
  __redirectBaseLoggerForTests();
});

function captureLogLines(): { lines: string[]; stream: Writable } {
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
  __redirectBaseLoggerForTests(stream);
  createBaseLogger(stream);
  return { lines, stream };
}

test('LogSmsOtpProvider writes the 6-digit code + redacted phone to logger (AC-13)', async () => {
  const { lines } = captureLogLines();
  const provider = new LogSmsOtpProvider();
  await provider.send('+15551234567', '482917');
  const logLine = lines.find((l) => l.includes('sms_otp_send'));
  assert.ok(logLine, 'expected a sms_otp_send log line');
  const obj = JSON.parse(logLine!) as Record<string, unknown>;
  assert.equal(obj['event'], 'sms_otp_send');
  assert.equal(obj['outcome'], 'success');
  assert.equal(obj['provider'], 'log');
  assert.equal(obj['code'], '482917', 'log provider must surface the raw code (intentional dev behavior)');
  assert.equal(obj['phone'], '***4567', 'phone must be redacted to last-4');
});

test('LogSmsOtpProvider does not throw on success (always resolves)', async () => {
  const { lines: _lines } = captureLogLines();
  const provider = new LogSmsOtpProvider();
  await provider.send('+15551234567', '123456');
  // No assertion needed beyond the awaited promise resolving.
});

test('TwilioSmsOtpProvider calls messages.create with to/from/body containing the code (AC-14)', async () => {
  const calls: Array<{ to: string; from: string; body: string }> = [];
  const stubClient = {
    messages: {
      create: async (args: { to: string; from: string; body: string }): Promise<unknown> => {
        calls.push(args);
        return { sid: 'SM_TEST' };
      },
    },
  };
  const provider = new TwilioSmsOtpProvider({
    accountSid: 'AC_TEST_SID',
    authToken: 'TEST_TOKEN',
    fromNumber: '+15559999000',
    ttlSeconds: 300,
    client: stubClient,
  });
  await provider.send('+15551234567', '654321');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, '+15551234567');
  assert.equal(calls[0]!.from, '+15559999000');
  assert.ok(calls[0]!.body.includes('654321'), 'body must include the OTP code');
  assert.ok(calls[0]!.body.toLowerCase().includes('expire'), 'body should mention expiration');
  // F13: body should reflect the configured TTL (300s = 5 minutes), not
  // a hard-coded value.
  assert.ok(calls[0]!.body.includes('5 minutes'), 'body should interpolate configured TTL');
});

test('TwilioSmsOtpProvider wraps client errors in SmsSendFailed', async () => {
  const stubClient = {
    messages: {
      create: async (): Promise<unknown> => {
        throw new Error('twilio internal: rate limit');
      },
    },
  };
  const provider = new TwilioSmsOtpProvider({
    accountSid: 'AC_TEST_SID',
    authToken: 'TEST_TOKEN',
    fromNumber: '+15559999000',
    ttlSeconds: 300,
    client: stubClient,
  });
  await assert.rejects(
    () => provider.send('+15551234567', '111111'),
    (err: unknown) => err instanceof SmsSendFailed && (err as { message: string }).message === 'twilio_send_failed',
  );
});

test('TwilioSmsOtpProvider throws plain Error on missing credentials at construction (F11)', () => {
  // F11: construction-time misconfig is a boot error, not a runtime
  // provider failure — the class throws plain `Error`, not `SmsSendFailed`.
  assert.throws(
    () => new TwilioSmsOtpProvider({ accountSid: '', authToken: 't', fromNumber: '+1', ttlSeconds: 300 }),
    (err: unknown) => err instanceof Error && !(err instanceof SmsSendFailed) && (err as { message: string }).message === 'twilio_account_sid_missing',
  );
  assert.throws(
    () => new TwilioSmsOtpProvider({ accountSid: 'a', authToken: '', fromNumber: '+1', ttlSeconds: 300 }),
    (err: unknown) => err instanceof Error && !(err instanceof SmsSendFailed) && (err as { message: string }).message === 'twilio_auth_token_missing',
  );
  assert.throws(
    () => new TwilioSmsOtpProvider({ accountSid: 'a', authToken: 't', fromNumber: '', ttlSeconds: 300 }),
    (err: unknown) => err instanceof Error && !(err instanceof SmsSendFailed) && (err as { message: string }).message === 'twilio_from_number_missing',
  );
});
