/**
 * /healthz is process liveness — always 200.
 * /readyz is DB readiness — 200 when DATABASE_URL points to a reachable DB,
 * 503 otherwise. To exercise the "DB unreachable" path without needing a live
 * Postgres, we point DATABASE_URL at a port nothing is listening on and assert
 * the 503 response shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

async function makeAppWithEnv(env: NodeJS.ProcessEnv) {
  const prev = process.env;
  process.env = { ...prev, ...env };
  // Import after env mutation so the module reads the test-time env.
  // Use the factory module (no listen side-effect).
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  return {
    app,
    restore: () => {
      process.env = prev;
    },
  };
}

test('/healthz returns 200 {status: "ok"} regardless of DB state', async () => {
  // Point DATABASE_URL at an unused port; /healthz must NOT depend on it.
  const { app, restore } = await makeAppWithEnv({
    DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nobody',
  });
  try {
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  } finally {
    restore();
  }
});

test('/readyz returns 503 {db: "unreachable"} when DB is unreachable', async () => {
  const { app, restore } = await makeAppWithEnv({
    DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nobody',
  });
  try {
    const res = await request(app).get('/readyz');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { db: 'unreachable' });
    // Response body must not include a stack trace.
    assert.equal(typeof (res.body as { error?: unknown }).error, 'undefined');
  } finally {
    restore();
  }
});
