/**
 * phone-country.test.ts — the phone field must produce the E.164
 * string the API accepts.
 *
 * The API validates `patient_phone` against
 * `^\+[1-9]\d{6,14}$` and looks the patient up by that exact
 * string, so a wrong prefix means a different patient (or none).
 *
 * There is no country picker: the patient types the whole
 * international number and the field normalises it. These tests pin
 * that normalisation and the validity rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizePhone,
  isValidPhone,
} = await import('../src/pages/booking-utils.js');

test('normalizePhone keeps a typed international number intact', () => {
  assert.equal(normalizePhone('+966512345678'), '+966512345678');
  assert.equal(normalizePhone('+8801684960808'), '+8801684960808');
  assert.equal(normalizePhone('+15551234567'), '+15551234567');
});

test('normalizePhone strips cosmetic separators', () => {
  assert.equal(normalizePhone('+966 512 345 678'), '+966512345678');
  assert.equal(normalizePhone('+966-512-345-678'), '+966512345678');
  assert.equal(normalizePhone('+1 (555) 123-4567'), '+15551234567');
  assert.equal(normalizePhone('+880.1684.960808'), '+8801684960808');
});

test('normalizePhone accepts the longhand 00 international prefix', () => {
  // 00966… is how a lot of people write a number from a landline.
  assert.equal(normalizePhone('00966512345678'), '+966512345678');
  assert.equal(normalizePhone('00 966 512 345 678'), '+966512345678');
});

test('normalizePhone drops leading zeros after the +', () => {
  // E.164 forbids a zero immediately after the country code.
  assert.equal(normalizePhone('+00966512345678'), '+966512345678');
});

test('normalizePhone leaves a bare national number alone', () => {
  // We do not guess a country code. The API rejects a bare national
  // number, and the field shows the patient what is missing.
  assert.equal(normalizePhone('512345678'), '512345678');
  assert.equal(normalizePhone('966512345678'), '966512345678');
});

test('normalizePhone of an empty value is empty', () => {
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone('   '), '');
  assert.equal(normalizePhone('()-. '), '');
});

test('isValidPhone accepts a well-formed international number', () => {
  for (const n of [
    '+966512345678',
    '+8801684960808',
    '+15551234567',
    '+971501234567',
    '+447911123456',
  ]) {
    assert.ok(isValidPhone(n), `${n} should be valid`);
  }
});

test('isValidPhone tolerates separators', () => {
  assert.ok(isValidPhone('+966 512 345 678'));
  assert.ok(isValidPhone('+1 (555) 123-4567'));
});

test('isValidPhone rejects a number without a country code', () => {
  assert.equal(isValidPhone('512345678'), false);
  assert.equal(isValidPhone('966512345678'), false);
});

test('isValidPhone rejects a malformed number', () => {
  assert.equal(isValidPhone(''), false);
  assert.equal(isValidPhone('+'), false);
  assert.equal(isValidPhone('+0123'), false, 'a zero cannot lead the country code');
  assert.equal(isValidPhone('+9665123456789012'), false, 'more than 15 digits');
  assert.equal(isValidPhone('+966512'), false, 'too short');
});
