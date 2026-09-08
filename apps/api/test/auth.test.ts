/**
 * Auth middleware contract tests.
 *
 * Drives real HTTP requests through `createApp()` so the production
 * `authMiddleware` is the thing being exercised. The spec invariants:
 *
 *  - A well-formed `x-auth-claim` header is accepted; the request continues.
 *  - Staff tokens (receptionist / doctor / admin) with `branch_ids: []` are
 *    rejected at 403 with `{error: 'staff_token_requires_branch_ids'}`.
 *  - Malformed JSON in `x-auth-claim` is treated as anonymous (200).
 *  - Unknown role strings are treated as anonymous (200).
 *  - The body NEVER supplies claims; the header always wins when both are
 *    present. This is the rule that prevents role-escalation via request body.
 *
 * Routing note: `/healthz` and `/readyz` are mounted BEFORE `authMiddleware`,
 * so auth invariants are exercised against the JSON 404 fallthrough path,
 * which sits AFTER authMiddleware in the chain. /metrics is also before
 * authMiddleware, so we can't reach authMiddleware via /healthz or /metrics
 * — we MUST use a path that does not match an earlier router.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

const POST_AUTH_PATH = '/__no_such_route__';

function claim(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    sub: 'user-1',
    role: 'receptionist',
    branch_ids: ['branch-a'],
    scope: 'branch',
    ...overrides,
  });
}

test('well-formed x-auth-claim header — request passes auth and reaches 404 fallthrough', async () => {
  const app = createApp();
  // /healthz is mounted BEFORE authMiddleware, so it returns 200 regardless.
  // We hit the 404 fallthrough to prove the auth middleware let the request
  // through — staff with empty branch_ids would have 403'd instead.
  const res = await request(app)
    .get(POST_AUTH_PATH)
    .set('x-auth-claim', claim());
  assert.equal(res.status, 404, 'well-formed claim + branch_ids should pass auth → 404');
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('staff token with branch_ids: [] → 403 {error: "staff_token_requires_branch_ids"}', async () => {
  const app = createApp();
  const res = await request(app)
    .get(POST_AUTH_PATH)
    .set('x-auth-claim', claim({ role: 'receptionist', branch_ids: [] }));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'staff_token_requires_branch_ids' });
});

test('doctor with empty branch_ids → 403', async () => {
  const app = createApp();
  const res = await request(app)
    .get(POST_AUTH_PATH)
    .set('x-auth-claim', claim({ role: 'doctor', branch_ids: [], doctor_id: 'doc-1' }));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'staff_token_requires_branch_ids' });
});

test('malformed JSON in x-auth-claim → anonymous (passes auth → 404 fallthrough)', async () => {
  const app = createApp();
  const res = await request(app)
    .get(POST_AUTH_PATH)
    .set('x-auth-claim', '{not-json');
  assert.equal(res.status, 404, 'malformed header must NOT 4xx the request');
});

test('unknown role in x-auth-claim → anonymous', async () => {
  const app = createApp();
  const res = await request(app)
    .get(POST_AUTH_PATH)
    .set('x-auth-claim', claim({ role: 'superuser' }));
  assert.equal(res.status, 404, 'unknown role must NOT 4xx the request');
});

test('request body never affects auth — header "patient" wins over body "admin"', async () => {
  const app = createApp();
  // Send a body that tries to escalate to admin with branch_ids; the header
  // is a legitimate patient claim. The body MUST be ignored; patient with
  // empty branch_ids is allowed (only staff are rejected for empty branch_ids).
  // If authMiddleware ever started reading the body, this test would flip
  // the 403 path and produce 403 {error: 'staff_token_requires_branch_ids'}.
  const res = await request(app)
    .post(POST_AUTH_PATH)
    .set('content-type', 'application/json')
    .set('x-auth-claim', claim({ role: 'patient', branch_ids: [] }))
    .send({ role: 'admin', branch_ids: ['sneaky-branch'] });
  assert.equal(res.status, 404, 'auth must not consult req.body; got=404 not 403');
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('no x-auth-claim header → anonymous pass-through (404 on the fallthrough)', async () => {
  const app = createApp();
  const res = await request(app).get(POST_AUTH_PATH);
  assert.equal(res.status, 404);
});

test('patient with empty branch_ids → allowed (passes auth → 404)', async () => {
  const app = createApp();
  const res = await request(app)
    .get(POST_AUTH_PATH)
    .set('x-auth-claim', claim({ role: 'patient', branch_ids: [] }));
  assert.equal(res.status, 404, 'patient with empty branch_ids is legitimate; only staff are rejected');
});

test('/healthz remains pre-auth — always 200 regardless of claim (auth runs after)', async () => {
  const app = createApp();
  // Even an obviously bad claim must NOT block /healthz because /healthz is
  // mounted before authMiddleware by design.
  const res = await request(app)
    .get('/healthz')
    .set('x-auth-claim', claim({ role: 'receptionist', branch_ids: [] }));
  assert.equal(res.status, 200);
});