/**
 * auth-config.test.ts — boot-time validation for `loadAuthConfig()`.
 *
 * Covers AC-5 / AC-6 / AC-6b (throws on missing / weak / invalid-TTL secret
 * in any env) and AC-17b (memoization invariant).
 *
 * Each test mutates `process.env` and resets the memoized singleton via
 * `__resetAuthConfigForTests()`. The `afterEach` clears the env so the
 * rest of the test suite (auth.test.ts, etc.) is not contaminated.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAuthConfig,
  __resetAuthConfigForTests,
} from '../src/auth/config.js';

const VALID_SECRET = 'a'.repeat(48);

function clearEnv(): void {
  delete process.env['AUTH_SECRET'];
  delete process.env['AUTH_TOKEN_TTL_SECONDS'];
  delete process.env['MOCK_OTP_CODE'];
  delete process.env['NODE_ENV'];
}

afterEach(() => {
  clearEnv();
  __resetAuthConfigForTests();
});

test('AC-5: AUTH_SECRET missing in any env throws auth_secret_missing', () => {
  clearEnv();
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_secret_missing/);
});

test('AC-5: AUTH_SECRET missing in development throws', () => {
  process.env['NODE_ENV'] = 'development';
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_secret_missing/);
});

test('AC-5: AUTH_SECRET missing in production throws', () => {
  process.env['NODE_ENV'] = 'production';
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_secret_missing/);
});

test('AC-6: AUTH_SECRET shorter than 32 bytes throws auth_secret_too_short', () => {
  process.env['AUTH_SECRET'] = 'a'.repeat(31);
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_secret_too_short/);
});

test('AC-6: AUTH_SECRET exactly 32 bytes (ASCII) passes', () => {
  process.env['AUTH_SECRET'] = 'a'.repeat(32);
  __resetAuthConfigForTests();
  const cfg = loadAuthConfig();
  assert.equal(cfg.secret.length, 32);
});

test('AC-6: AUTH_TOKEN_TTL_SECONDS = 0 throws auth_ttl_invalid', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['AUTH_TOKEN_TTL_SECONDS'] = '0';
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_ttl_invalid/);
});

test('AC-6b: AUTH_TOKEN_TTL_SECONDS = -1 throws auth_ttl_invalid', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['AUTH_TOKEN_TTL_SECONDS'] = '-1';
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_ttl_invalid/);
});

test('AC-6b: AUTH_TOKEN_TTL_SECONDS non-numeric throws auth_ttl_invalid', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['AUTH_TOKEN_TTL_SECONDS'] = 'NaN';
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_ttl_invalid/);
});

test('AC-6b: AUTH_TOKEN_TTL_SECONDS float throws auth_ttl_invalid', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['AUTH_TOKEN_TTL_SECONDS'] = '3600.5';
  __resetAuthConfigForTests();
  assert.throws(() => loadAuthConfig(), /auth_ttl_invalid/);
});

test('default TTL is 3600 when env unset', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  __resetAuthConfigForTests();
  const cfg = loadAuthConfig();
  assert.equal(cfg.ttlSeconds, 3600);
});

test('AC-17b: loadAuthConfig() is memoized — runtime env change does not affect returned config', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['AUTH_TOKEN_TTL_SECONDS'] = '600';
  __resetAuthConfigForTests();
  const cfg1 = loadAuthConfig();
  assert.equal(cfg1.ttlSeconds, 600);
  // Mutate env after first load; subsequent call must return same object.
  process.env['AUTH_TOKEN_TTL_SECONDS'] = '9999';
  const cfg2 = loadAuthConfig();
  assert.strictEqual(cfg2, cfg1, 'memoized singleton must be the same object');
  assert.equal(cfg2.ttlSeconds, 600, 'returned config must reflect original env');
});

test('mockOtpAllowed is true in development', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'development';
  __resetAuthConfigForTests();
  const cfg = loadAuthConfig();
  assert.equal(cfg.mockOtpAllowed, true);
  assert.equal(cfg.allowDebugHeader, true);
});

test('mockOtpAllowed is true in test', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'test';
  __resetAuthConfigForTests();
  const cfg = loadAuthConfig();
  assert.equal(cfg.mockOtpAllowed, true);
});

test('mockOtpAllowed is false in production', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'production';
  __resetAuthConfigForTests();
  const cfg = loadAuthConfig();
  assert.equal(cfg.mockOtpAllowed, false);
  assert.equal(cfg.allowDebugHeader, false);
});

test('mockOtpAllowed is false in staging (allowlist: dev/test only)', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  process.env['NODE_ENV'] = 'staging';
  __resetAuthConfigForTests();
  const cfg = loadAuthConfig();
  assert.equal(cfg.mockOtpAllowed, false, 'staging must NOT register the mock-OTP route');
  assert.equal(cfg.allowDebugHeader, true);
});

test('audience and issuer default to clinic-api', () => {
  process.env['AUTH_SECRET'] = VALID_SECRET;
  __resetAuthConfigForTests();
  const cfg = loadAuthConfig();
  assert.equal(cfg.audience, 'clinic-api');
  assert.equal(cfg.issuer, 'clinic-api');
});
