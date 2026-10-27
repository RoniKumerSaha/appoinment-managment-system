/**
 * Regressions for the P0 fixes: `created_by` token encoding, async
 * handler rejection forwarding, and the 30-day booking window.
 *
 * Three independent units:
 *
 * 1. `created-by.ts` — the actor identity (a staff email) must be mapped
 *    into the DB CHECK's alphabet (`[A-Za-z0-9+_.-]`) reversibly, so the
 *    `created_by` column keeps identifying the actor of record without
 *    raising a 23514 check violation.
 *
 * 2. `middleware/async-handler.ts` — a rejected promise inside a route
 *    handler must reach Express's error middleware instead of escaping
 *    as an unhandled rejection (which terminates the process).
 *
 * 3. `availability/types.ts` — the 30-day window (FR-018) is a range of
 *    calendar days; comparing a date-at-midnight against a rolling
 *    `now + 24h` made tomorrow unbookable for the whole day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

import {
  decodeActorToken,
  encodeActorToken,
  patientCreatedBy,
  staffCreatedBy,
} from '../src/routes/created-by.js';
import { wrapAsyncHandler, wrapRouter } from '../src/middleware/async-handler.js';
import { isWithin30DayWindow, parseIsoDate } from '../src/availability/types.js';

/** The exact alphabet the DB CHECK permits. */
const DB_CHECK = /^(staff|patient):[A-Za-z0-9+_.-]{1,255}$/;

// ---------------------------------------------------------------------------
// encodeActorToken / decodeActorToken
// ---------------------------------------------------------------------------

test('encodeActorToken output always satisfies the DB CHECK alphabet', () => {
  const inputs = [
    'admin-main@clinic.local',
    'receptionist-east@clinic.local',
    'doctor.north@clinic.local',
    'a@b.c',
    'weird@chars!here',
    'colon:in@email',
    'plus+sign@clinic.local',
    'dots.and-dashes_and_underscores',
    '+15550000088',
    'ünïcodé@clinic.local',
  ];
  for (const input of inputs) {
    const encoded = encodeActorToken(input);
    assert.ok(
      /^[A-Za-z0-9+_.-]*$/.test(encoded),
      `encoded form of ${JSON.stringify(input)} contains a char outside the CHECK alphabet: ${JSON.stringify(encoded)}`,
    );
  }
});

test('decodeActorToken is the exact inverse of encodeActorToken', () => {
  const inputs = [
    'admin-main@clinic.local',
    'receptionist-east@clinic.local',
    'doctor.north@clinic.local',
    'a@b.c',
    'weird@chars!here',
    'colon:in@email',
    'plus+sign@clinic.local',
    '+15550000088',
    'ünïcodé@clinic.local',
    'x',
  ];
  for (const input of inputs) {
    assert.equal(
      decodeActorToken(encodeActorToken(input)),
      input,
      `round-trip failed for ${JSON.stringify(input)}`,
    );
  }
});

test('encodeActorToken is deterministic and injective on distinct inputs', () => {
  assert.equal(
    encodeActorToken('admin-main@clinic.local'),
    encodeActorToken('admin-main@clinic.local'),
  );
  assert.notEqual(
    encodeActorToken('admin-main@clinic.local'),
    encodeActorToken('admin-east@clinic.local'),
  );
  // A literal dot must not be confusable with an escape sequence.
  assert.notEqual(encodeActorToken('a.40b'), encodeActorToken('a@b'));
  assert.equal(decodeActorToken(encodeActorToken('a.40b')), 'a.40b');
});

test('decodeActorToken passes a malformed escape through instead of throwing', () => {
  // Audit data must never crash a reader.
  assert.equal(decodeActorToken('abc.zz'), 'abc.zz');
  assert.equal(decodeActorToken('abc.'), 'abc.');
});

// ---------------------------------------------------------------------------
// staffCreatedBy / patientCreatedBy
// ---------------------------------------------------------------------------

test('staffCreatedBy encodes the staff email into a CHECK-valid token', () => {
  const token = staffCreatedBy('admin-main@clinic.local');
  assert.ok(DB_CHECK.test(token), `token failed the DB CHECK: ${token}`);
  assert.ok(token.startsWith('staff:'));
  assert.equal(decodeActorToken(token.slice('staff:'.length)), 'admin-main@clinic.local');
});

test('staffCreatedBy falls back to a stable default when sub is absent', () => {
  const token = staffCreatedBy(undefined);
  assert.ok(DB_CHECK.test(token), `token failed the DB CHECK: ${token}`);
  assert.equal(decodeActorToken(token.slice('staff:'.length)), 'admin-main');
});

test('patientCreatedBy encodes the phone into a CHECK-valid token', () => {
  const token = patientCreatedBy('+15550000088');
  assert.ok(DB_CHECK.test(token), `token failed the DB CHECK: ${token}`);
  assert.ok(token.startsWith('patient:'));
  assert.equal(decodeActorToken(token.slice('patient:'.length)), '+15550000088');
});

// ---------------------------------------------------------------------------
// wrapAsyncHandler / wrapRouter
// ---------------------------------------------------------------------------

test('wrapAsyncHandler forwards a rejected promise to next', async () => {
  const app = express();
  app.get(
    '/boom',
    wrapAsyncHandler(async () => {
      throw new Error('kaboom');
    }),
  );
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal_error', message: err instanceof Error ? err.message : '' });
  });

  const res = await request(app).get('/boom');
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'internal_error');
  assert.equal(res.body.message, 'kaboom');
});

test('wrapRouter forwards a rejected promise from a registered route to next', async () => {
  const router = express.Router();
  router.get('/boom', async () => {
    throw new Error('route-kaboom');
  });
  wrapRouter(router);

  const app = express();
  app.use(router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal_error', message: err instanceof Error ? err.message : '' });
  });

  const res = await request(app).get('/boom');
  assert.equal(res.status, 500);
  assert.equal(res.body.message, 'route-kaboom');
});

test('wrapRouter is idempotent — wrapping twice still answers 500 once', async () => {
  const router = express.Router();
  router.get('/boom', async () => {
    throw new Error('double-wrap');
  });
  wrapRouter(router);
  wrapRouter(router);

  const app = express();
  app.use(router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal_error' });
  });

  const res = await request(app).get('/boom');
  assert.equal(res.status, 500);
});

test('wrapRouter leaves a successful route working', async () => {
  const router = express.Router();
  router.get('/ok', async (_req, res) => {
    res.json({ ok: true });
  });
  wrapRouter(router);

  const app = express();
  app.use(router);

  const res = await request(app).get('/ok');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

// ---------------------------------------------------------------------------
// isWithin30DayWindow (FR-018)
// ---------------------------------------------------------------------------

/** UTC midnight of the calendar day `offset` days from `nowMs`. */
function utcMidnightOffset(nowMs: number, offset: number): number {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const today = Math.floor(nowMs / ONE_DAY_MS) * ONE_DAY_MS;
  return today + offset * ONE_DAY_MS;
}

test('isWithin30DayWindow accepts tomorrow regardless of the time of day', () => {
  // The regression: at 09:33Z, tomorrow's midnight (00:00Z) is BEFORE
  // `now + 24h` (09:33Z tomorrow), so the old instant-based comparison
  // rejected the whole of tomorrow.
  for (const hour of [0, 1, 9, 13, 18, 23]) {
    const nowMs = Date.UTC(2026, 9, 26, hour, 33, 0);
    const tomorrow = utcMidnightOffset(nowMs, 1);
    assert.equal(
      isWithin30DayWindow(tomorrow, nowMs),
      true,
      `tomorrow was rejected at ${hour}:33 local time`,
    );
  }
});

test('isWithin30DayWindow rejects today (FR-019 same-day exclusion)', () => {
  const nowMs = Date.UTC(2026, 9, 26, 9, 33, 0);
  const today = utcMidnightOffset(nowMs, 0);
  assert.equal(isWithin30DayWindow(today, nowMs), false);
});

test('isWithin30DayWindow accepts today+30 and rejects today+31', () => {
  const nowMs = Date.UTC(2026, 9, 26, 9, 33, 0);
  assert.equal(isWithin30DayWindow(utcMidnightOffset(nowMs, 30), nowMs), true);
  assert.equal(isWithin30DayWindow(utcMidnightOffset(nowMs, 31), nowMs), false);
});

test('isWithin30DayWindow agrees with the route-level window check for a parsed ISO date', () => {
  // The availability route feeds `parseIsoDate(iso)` (UTC midnight) into
  // the engine, which forwards it to `isWithin30DayWindow`.
  const nowMs = Date.UTC(2026, 9, 26, 9, 33, 0);
  const tomorrow = parseIsoDate('2026-10-27');
  assert.ok(tomorrow !== null);
  assert.equal(isWithin30DayWindow(tomorrow.getTime(), nowMs), true);
});
