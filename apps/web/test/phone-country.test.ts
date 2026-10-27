/**
 * phone-country.test.ts — the country-code picker must produce the
 * E.164 string the API accepts.
 *
 * The API validates `patient_phone` against
 * `^\+[1-9]\d{6,14}$` and looks the patient up by that exact
 * string, so a wrong prefix means a different patient (or none).
 * The picker splits the number into a country code + a national
 * number; these tests pin the join/split round-trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  joinPhone,
  splitPhone,
  isValidPhone,
  detectCountryCode,
} = await import('../src/pages/booking-utils.js');
const { searchCountries } = await import('../src/pages/phone-countries.js');

test('joinPhone prefixes the national number with the dial code', () => {
  assert.equal(joinPhone('SA', '512345678'), '+966512345678');
  assert.equal(joinPhone('AE', '501234567'), '+971501234567');
  assert.equal(joinPhone('US', '5551234567'), '+15551234567');
});

test('joinPhone strips cosmetic separators from the national number', () => {
  assert.equal(joinPhone('SA', '512 345 678'), '+966512345678');
  assert.equal(joinPhone('SA', '512-345-678'), '+966512345678');
  assert.equal(joinPhone('SA', '(512) 345-678'), '+966512345678');
});

test('joinPhone does not double the prefix when the number already carries it', () => {
  assert.equal(joinPhone('SA', '+966512345678'), '+966512345678');
  assert.equal(joinPhone('SA', '966512345678'), '+966512345678');
});

test('joinPhone keeps a typed international number as-is', () => {
  // The patient typed the whole number including a country code that
  // is NOT the chip's. The chip must not be glued on top of it —
  // that produced an over-length, invalid E.164 string.
  assert.equal(joinPhone('SA', '+8801684960808'), '+8801684960808');
  assert.equal(joinPhone('SA', '+1 555 123 4567'), '+15551234567');
  assert.ok(isValidPhone(joinPhone('SA', '+8801684960808')));
});

test('joinPhone strips cosmetic separators from a typed international number', () => {
  assert.equal(joinPhone('SA', '+880 1684 960808'), '+8801684960808');
  assert.equal(joinPhone('SA', '+880-1684-960808'), '+8801684960808');
});

test('joinPhone with OTHER keeps the patient’s own prefix', () => {
  assert.equal(joinPhone('OTHER', '+15551234567'), '+15551234567');
  assert.equal(joinPhone('OTHER', '15551234567'), '+15551234567');
});

test('joinPhone with an empty national number is empty', () => {
  assert.equal(joinPhone('SA', ''), '');
  assert.equal(joinPhone('SA', '   '), '');
});

test('splitPhone recovers the country code and national number', () => {
  const split = splitPhone('+966512345678');
  assert.ok(split !== null);
  assert.equal(split?.countryCode, 'SA');
  assert.equal(split?.nationalNumber, '512345678');
});

test('splitPhone prefers the longest matching dial code', () => {
  // +971 (UAE) starts with +97; a naive prefix scan would match
  // the shorter code first and leave the wrong national number.
  const split = splitPhone('+971501234567');
  assert.ok(split !== null);
  assert.equal(split?.countryCode, 'AE');
  assert.equal(split?.nationalNumber, '501234567');
});

test('splitPhone returns null for a number with no prefix at all', () => {
  // A bare national number carries no country information.
  assert.equal(splitPhone('512345678'), null);
});

test('splitPhone falls back to OTHER for an unknown country code', () => {
  // +81 (Japan) is not in the catalogue. It is still a valid
  // international number, so it must not be rejected — it splits as
  // `OTHER` with the whole number intact.
  const split = splitPhone('+81123456789');
  assert.ok(split !== null);
  assert.equal(split?.countryCode, 'OTHER');
  assert.equal(split?.nationalNumber, '+81123456789');
  // And `OTHER` puts the number back together unchanged.
  assert.equal(joinPhone('OTHER', split?.nationalNumber ?? ''), '+81123456789');
});

test('splitPhone recognises Bangladesh', () => {
  const split = splitPhone('+8801684960808');
  assert.equal(split?.countryCode, 'BD');
  assert.equal(split?.nationalNumber, '1684960808');
  assert.equal(joinPhone('BD', '1684960808'), '+8801684960808');
});

test('a joined phone is a valid E.164 number', () => {
  for (const code of ['SA', 'AE', 'KW', 'BH', 'QA', 'OM', 'EG', 'US', 'GB']) {
    const joined = joinPhone(code, '512345678');
    assert.ok(
      isValidPhone(joined),
      `${code}: ${joined} is not valid E.164`,
    );
  }
});

test('a joined + split round-trip preserves the national number', () => {
  const joined = joinPhone('AE', '501234567');
  const split = splitPhone(joined);
  assert.equal(split?.countryCode, 'AE');
  assert.equal(split?.nationalNumber, '501234567');
});

test('detectCountryCode follows the country the patient typed', () => {
  assert.equal(detectCountryCode('+966512345678'), 'SA');
  assert.equal(detectCountryCode('+8801684960808'), 'BD');
  assert.equal(detectCountryCode('+971501234567'), 'AE');
  assert.equal(detectCountryCode('+1 555 123 4567'), 'US');
});

test('detectCountryCode returns null for a bare national number', () => {
  // No country information in the value — the chip keeps its own pick.
  assert.equal(detectCountryCode('512345678'), null);
  assert.equal(detectCountryCode(''), null);
  assert.equal(detectCountryCode('  '), null);
});

test('detectCountryCode returns OTHER for an unknown country code', () => {
  assert.equal(detectCountryCode('+81123456789'), 'OTHER');
});

test('the country search matches name, ISO code, and dial code', () => {
  assert.ok(
    searchCountries('united arab').gulf.some((c) => c.code === 'AE'),
  );
  assert.ok(searchCountries('+971').gulf.some((c) => c.code === 'AE'));
  assert.ok(searchCountries('sa').gulf.some((c) => c.code === 'SA'));
  // A miss keeps "Other country" reachable so the patient is never
  // stuck without a way to enter their number.
  const miss = searchCountries('zzzz');
  assert.equal(miss.other?.code, 'OTHER');
  assert.equal(miss.gulf.length, 0);
  assert.equal(miss.international.length, 0);
});
