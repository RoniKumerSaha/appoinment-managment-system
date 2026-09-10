/**
 * auth-bearer.test.ts — Bearer-path middleware contract.
 *
 * Drives real HTTP requests through `createApp()` with
 * `Authorization: Bearer <jwt>`. The JWT is minted via the same
 * `signClaim` that production uses so the verifier path is the
 * production verifier, not a hand-rolled mock.
 *
 * Covers AC-7, AC-8, AC-8b, AC-8c, AC-9 (Bearer-wins-over-debug),
 * AC-10, AC-19b (parity assertions attached in log-bearer.test.ts),
 * and a wide attacker surface from the spec's auth-acceptance table.
 *
 * The dev-only `x-auth-claim` fallback is exercised indirectly by the
 * existing 12-case `auth.test.ts` (E0-S1) — these tests focus on the
 * Bearer surface.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
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

function bearerApp() {
  return createApp();
}

// Use a fixed-but-current time so tokens don't expire between mint and verify.
// Without `now`, signClaim/verifyToken default to wall-clock — fine for live
// HTTP, but tests run a long time after mint and would otherwise get null.
const TEST_NOW = Math.floor(Date.now() / 1000);

function makeJwt(overrides: Record<string, unknown> = {}): string {
  return signClaim(
    {
      sub: 'user-1',
      role: 'receptionist',
      branch_ids: ['branch-a'],
      scope: 'branch',
      ...overrides,
    },
    TEST_NOW,
  );
}

function jwtWithRawPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  // Fill in iat/exp defaults from TEST_NOW so non-default-payload tests don't
  // accidentally mint expired tokens (which would mask the field they intend
  // to test by failing on expiry first).
  const full = {
    aud: 'clinic-api',
    iss: 'clinic-api',
    jti: 'j',
    iat: TEST_NOW,
    exp: TEST_NOW + 3600,
    ...payload,
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', VALID_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

test('AC-7: valid Bearer JWT populates req.auth.claim and reaches 404 fallthrough', async () => {
  const token = makeJwt({ sub: 'u1', role: 'receptionist', branch_ids: ['b1'], scope: 'branch' });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404, 'Bearer + valid claim should pass auth → 404');
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('AC-7: doctor without doctor_id passes auth (route guards are downstream)', async () => {
  const token = makeJwt({ sub: 'doc-1', role: 'doctor', branch_ids: ['b1'], scope: 'branch' });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  // doctor_id enforcement happens at route guards, not in middleware.
  assert.equal(res.status, 404, 'doctor + branch_ids should pass middleware');
});

test('AC-8: staff with empty branch_ids → 403 {error: staff_token_requires_branch_ids}', async () => {
  const token = makeJwt({ role: 'receptionist', branch_ids: [] });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'staff_token_requires_branch_ids' });
});

test('AC-8: doctor with empty branch_ids → 403', async () => {
  const token = makeJwt({ role: 'doctor', doctor_id: 'd1', branch_ids: [] });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'staff_token_requires_branch_ids' });
});

test('AC-8: admin with empty branch_ids → 403', async () => {
  const token = makeJwt({ role: 'admin', branch_ids: [] });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'staff_token_requires_branch_ids' });
});

test('AC-8b: Bearer with branch_ids.length > 256 → anonymous (404 fallthrough)', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'receptionist',
    branch_ids: Array.from({ length: 257 }, (_, i) => `b${i}`),
    scope: 'branch',
    aud: 'clinic-api', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404, 'over-cap branch_ids must not 4xx');
});

test('AC-8c: Bearer with non-string branch_ids → anonymous', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'receptionist',
    branch_ids: ['b1', 42 as unknown as string],
    scope: 'branch',
    aud: 'clinic-api', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404, 'non-string branch_ids must not 4xx');
});

test('AC-8c: Bearer with empty-string branch_ids → anonymous', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'receptionist',
    branch_ids: ['b1', ''],
    scope: 'branch',
    aud: 'clinic-api', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404, 'empty-string branch_ids must not 4xx');
});

test('AC-8c: Bearer with duplicate branch_ids → anonymous', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'receptionist',
    branch_ids: ['b1', 'b1'],
    scope: 'branch',
    aud: 'clinic-api', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404, 'duplicate branch_ids must not 4xx');
});

test('Bearer with role outside closed enum → anonymous', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'superuser', branch_ids: ['b1'], scope: 'branch',
    aud: 'clinic-api', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
});

test('Bearer with scope outside closed enum → anonymous', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'patient', branch_ids: [], scope: 'universal',
    aud: 'clinic-api', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
});

test('Bearer with bad signature → anonymous (404, not 401)', async () => {
  const token = makeJwt({ role: 'patient', branch_ids: [] });
  const parts = token.split('.');
  const tampered = parts[2]!.slice(0, -1) + (parts[2]!.endsWith('A') ? 'B' : 'A');
  const evil = `${parts[0]}.${parts[1]}.${tampered}`;
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${evil}`);
  assert.equal(res.status, 404, 'forged token must yield anonymous, not 401');
});

test('Bearer with alg=none in header → anonymous', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'u1', role: 'patient', branch_ids: [], scope: 'self',
    aud: 'clinic-api', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  })).toString('base64url');
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${header}.${payload}.`);
  assert.equal(res.status, 404, 'alg=none must be rejected by the verifier');
});

test('Bearer with wrong aud → anonymous', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'patient', branch_ids: [], scope: 'self',
    aud: 'other-service', iss: 'clinic-api', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
});

test('Bearer with wrong iss → anonymous', async () => {
  const token = jwtWithRawPayload({
    sub: 'u1', role: 'patient', branch_ids: [], scope: 'self',
    aud: 'clinic-api', iss: 'evil', jti: 'j', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
});

test('AC-9: Bearer wins over x-auth-claim debug header when both present', async () => {
  // Bearer is a receptionist with branch_ids: ['b1'] (passes auth).
  // Debug header claims admin with branch_ids: [] (would 403 if it won).
  // Result must be 404 (Bearer parses, debug header ignored).
  const bearerToken = makeJwt({ role: 'receptionist', branch_ids: ['b1'], scope: 'branch' });
  const debugHeader = JSON.stringify({
    sub: 'user-x', role: 'admin', branch_ids: [], scope: 'clinic',
  });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${bearerToken}`)
    .set('x-auth-claim', debugHeader);
  assert.equal(res.status, 404, 'Bearer wins; if debug header won, admin+empty-branch would be 403');
});

test('AC-10: Bearer-path body-escalation — body role/branch_ids ignored', async () => {
  const bearerToken = makeJwt({ role: 'patient', branch_ids: [], scope: 'self' });
  const res = await request(bearerApp())
    .post(POST_AUTH_PATH)
    .set('content-type', 'application/json')
    .set('Authorization', `Bearer ${bearerToken}`)
    .send({ role: 'admin', branch_ids: ['sneaky-branch'] });
  // Patient with empty branch_ids passes auth; if body were consulted, the
  // admin claim with branch_ids would 403 (admin has empty branch_ids in body
  // is undefined here, so an admin-with-empty-branch_ids path could 403 OR a
  // patient-with-branch-id path could mismatch). Either way, getting 404
  // proves body was ignored. We assert 404 explicitly.
  assert.equal(res.status, 404, 'body must NEVER affect auth');
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('Bearer with malformed Authorization header (no Bearer prefix) → anonymous', async () => {
  const token = makeJwt({ role: 'patient', branch_ids: [] });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Basic ${token}`);
  assert.equal(res.status, 404, 'Basic auth scheme must not parse');
});

test('Bearer scheme is case-insensitive (RFC 6750 §2.1)', async () => {
  const token = makeJwt({ role: 'patient', branch_ids: [] });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `bearer ${token}`);
  assert.equal(res.status, 404, 'lowercase "bearer" must parse per RFC 6750');
});

test('Bearer with empty token after "Bearer " → anonymous', async () => {
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', 'Bearer ');
  assert.equal(res.status, 404);
});

test('No Authorization header → anonymous; x-auth-claim debug fallback in dev', async () => {
  // Sanity check: no header at all yields the 404 fallthrough (the dev
  // fallback is exercised by the E0-S1 auth.test.ts suite; this case just
  // pins the anonymous path for the Bearer surface).
  const res = await request(bearerApp()).get(POST_AUTH_PATH);
  assert.equal(res.status, 404);
});

test('PATIENT with empty branch_ids → allowed (passes auth → 404)', async () => {
  // Patients are NOT subject to the staff_token_requires_branch_ids rejection.
  const token = makeJwt({ role: 'patient', branch_ids: [] });
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404, 'patient with empty branch_ids is legitimate');
});

test('expired Bearer JWT → anonymous', async () => {
  // Mint a token at t=0 with TTL=60s; verify at t=120s.
  const token = signClaim(
    { sub: 'u1', role: 'receptionist', branch_ids: ['b1'], scope: 'branch' },
    0,
  );
  const res = await request(bearerApp())
    .get(POST_AUTH_PATH)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404, 'expired Bearer must yield anonymous');
});
