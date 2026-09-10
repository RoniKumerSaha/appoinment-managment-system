/**
 * sms-otp-config.test.ts — boot-time validation of OtpConfig.
 *
 * Mirrors E0-S3's auth-config.test.ts pattern: mutate `process.env` at
 * module / per-test boundaries, call `loadOtpConfig()` (after resetting
 * the memoization), assert the throw path or the returned shape.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadOtpConfig, __resetOtpConfigForTests } from '../src/otp/config.js';

before(() => {
  // Set required env so unrelated tests don't see a missing-secret state.
  process.env['AUTH_SECRET'] = 'a'.repeat(48);
  process.env['NODE_ENV'] = 'test';
});

after(() => {
  // No global cleanup; per-test `beforeEach` handles each case.
});

beforeEach(() => {
  __resetOtpConfigForTests();
  delete process.env['OTP_PROVIDER'];
  delete process.env['OTP_TTL_SECONDS'];
  delete process.env['OTP_LOCKOUT_THRESHOLD'];
  delete process.env['OTP_LOCKOUT_SECONDS'];
  delete process.env['OTP_COOLDOWN_SECONDS'];
  delete process.env['OTP_CODE_LENGTH'];
});

test('default provider in dev/test is `log`', () => {
  process.env['NODE_ENV'] = 'test';
  const cfg = loadOtpConfig();
  assert.equal(cfg.provider, 'log');
  assert.equal(cfg.ttlSeconds, 300);
  assert.equal(cfg.lockoutThreshold, 3);
  assert.equal(cfg.lockoutSeconds, 600);
  assert.equal(cfg.cooldownSeconds, 30);
  assert.equal(cfg.codeLength, 6);
});

test('default provider in production is `twilio`', () => {
  process.env['NODE_ENV'] = 'production';
  __resetOtpConfigForTests();
  const cfg = loadOtpConfig();
  assert.equal(cfg.provider, 'twilio');
  process.env['NODE_ENV'] = 'test';
  __resetOtpConfigForTests();
});

test('OTP_PROVIDER=log in production throws `otp_provider_log_in_production`', () => {
  process.env['NODE_ENV'] = 'production';
  process.env['OTP_PROVIDER'] = 'log';
  __resetOtpConfigForTests();
  assert.throws(
    () => loadOtpConfig(),
    /otp_provider_log_in_production/,
  );
  process.env['NODE_ENV'] = 'test';
});

test('OTP_PROVIDER=twilio reads through; OTP_PROVIDER=invalid throws', () => {
  process.env['NODE_ENV'] = 'test';
  process.env['OTP_PROVIDER'] = 'twilio';
  __resetOtpConfigForTests();
  const cfg = loadOtpConfig();
  assert.equal(cfg.provider, 'twilio');

  process.env['OTP_PROVIDER'] = 'carrier-pigeon';
  __resetOtpConfigForTests();
  assert.throws(
    () => loadOtpConfig(),
    /otp_provider_invalid/,
  );
});

test('non-integer OTP_TTL_SECONDS throws `otp_ttl_invalid`', () => {
  process.env['NODE_ENV'] = 'test';
  process.env['OTP_TTL_SECONDS'] = 'NaN';
  __resetOtpConfigForTests();
  assert.throws(() => loadOtpConfig(), /otp_ttl_invalid/);
});

test('non-integer OTP_LOCKOUT_THRESHOLD throws', () => {
  process.env['NODE_ENV'] = 'test';
  process.env['OTP_LOCKOUT_THRESHOLD'] = '2.5';
  __resetOtpConfigForTests();
  assert.throws(() => loadOtpConfig(), /otp_lockout_threshold_invalid/);
});

test('OTP_LOCKOUT_SECONDS=0 throws `otp_lockout_seconds_invalid`', () => {
  process.env['NODE_ENV'] = 'test';
  process.env['OTP_LOCKOUT_SECONDS'] = '0';
  __resetOtpConfigForTests();
  assert.throws(() => loadOtpConfig(), /otp_lockout_seconds_invalid/);
});

test('OTP_COOLDOWN_SECONDS=0 throws `otp_cooldown_seconds_invalid`', () => {
  process.env['NODE_ENV'] = 'test';
  process.env['OTP_COOLDOWN_SECONDS'] = '0';
  __resetOtpConfigForTests();
  assert.throws(() => loadOtpConfig(), /otp_cooldown_seconds_invalid/);
});

test('OTP_CODE_LENGTH=0 throws `otp_code_length_invalid`', () => {
  process.env['NODE_ENV'] = 'test';
  process.env['OTP_CODE_LENGTH'] = '0';
  __resetOtpConfigForTests();
  assert.throws(() => loadOtpConfig(), /otp_code_length_invalid/);
});

test('all overrides are read', () => {
  process.env['NODE_ENV'] = 'test';
  process.env['OTP_TTL_SECONDS'] = '180';
  process.env['OTP_LOCKOUT_THRESHOLD'] = '5';
  process.env['OTP_LOCKOUT_SECONDS'] = '900';
  process.env['OTP_COOLDOWN_SECONDS'] = '45';
  process.env['OTP_CODE_LENGTH'] = '8';
  __resetOtpConfigForTests();
  const cfg = loadOtpConfig();
  assert.equal(cfg.ttlSeconds, 180);
  assert.equal(cfg.lockoutThreshold, 5);
  assert.equal(cfg.lockoutSeconds, 900);
  assert.equal(cfg.cooldownSeconds, 45);
  assert.equal(cfg.codeLength, 8);
});

test('memoization: env mutation after first call does not affect returned config', () => {
  process.env['NODE_ENV'] = 'test';
  __resetOtpConfigForTests();
  const cfg1 = loadOtpConfig();
  process.env['OTP_TTL_SECONDS'] = '999';
  const cfg2 = loadOtpConfig();
  assert.equal(cfg1, cfg2, 'memoization invariant');
  assert.equal(cfg2.ttlSeconds, 300, 'memoized value must not change after env mutation');
});
