/**
 * Structured-log contract test.
 *
 * Asserts that pino's emit produces a JSON line carrying:
 *   request_id, actor_role, actor_id, appointment_id
 *
 * We use pino's destination with a write callback so the test captures the
 * raw JSON line — no live DB or HTTP needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import pino from 'pino';

test('structured log line carries the four contract fields', async () => {
  const captured: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      captured.push(chunk.toString());
      cb();
    },
  });

  const logger = pino(
    {
      level: 'info',
      base: { service: 'clinic-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream,
  );

  const ctx = {
    request_id: '11111111-1111-1111-1111-111111111111',
    actor_role: 'doctor',
    actor_id: 'doctor-abc',
    appointment_id: 'appt-xyz',
  };
  logger.info(ctx, 'test_event');

  // pino writes synchronously into the stream; flush before asserting.
  await new Promise<void>((resolve) => stream.end(resolve));

  assert.equal(captured.length, 1, 'expected exactly one log line');
  const line = captured[0]!;
  const parsed = JSON.parse(line) as Record<string, unknown>;
  for (const key of ['request_id', 'actor_role', 'actor_id', 'appointment_id']) {
    assert.ok(
      key in parsed,
      `log line must include ${key}; got keys=${Object.keys(parsed).join(',')}`,
    );
  }
  assert.equal(parsed.request_id, ctx.request_id);
  assert.equal(parsed.actor_role, ctx.actor_role);
  assert.equal(parsed.actor_id, ctx.actor_id);
  assert.equal(parsed.appointment_id, ctx.appointment_id);
});

test('pino redact strips password / phone_number / code keys', async () => {
  const captured: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      captured.push(chunk.toString());
      cb();
    },
  });

  const logger = pino(
    {
      level: 'info',
      redact: {
        paths: ['req.body.password', 'req.body.phone_number', 'req.body.code'],
        censor: '[REDACTED]',
      },
    },
    stream,
  );

  logger.info(
    {
      req: {
        body: {
          password: 'hunter2',
          phone_number: '+15555550100',
          code: '123456',
        },
      },
    },
    'sensitive',
  );

  await new Promise<void>((resolve) => stream.end(resolve));
  const parsed = JSON.parse(captured[0]!) as {
    req: { body: Record<string, unknown> };
  };
  assert.equal(parsed.req.body.password, '[REDACTED]');
  assert.equal(parsed.req.body.phone_number, '[REDACTED]');
  assert.equal(parsed.req.body.code, '[REDACTED]');
});
