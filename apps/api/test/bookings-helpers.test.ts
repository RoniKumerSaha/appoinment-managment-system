/**
 * bookings-helpers.test.ts — unit tests for the pure validators +
 * window helper used by POST /bookings.
 *
 * Tests run without a DB (just node:test + tsx). Integration coverage
 * for the route itself lives in `bookings.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCreateBookingBody,
  isValidUuid,
  isValidIsoDateTime,
  isValidDurationMinutes,
  isValidE164Phone,
  isValidPatientName,
  checkBookingWindow,
  ALLOWED_POST_KEYS,
} from '../src/routes/bookings-helpers.js';

// ===========================================================================
// Pure: isValidUuid
// ===========================================================================

test('isValidUuid: accepts canonical lowercase', () => {
  assert.equal(
    isValidUuid('12345678-1234-1234-1234-123456789012'),
    true,
  );
});

test('isValidUuid: accepts uppercase', () => {
  assert.equal(
    isValidUuid('12345678-1234-1234-1234-123456789ABC'),
    true,
  );
});

test('isValidUuid: rejects non-UUID', () => {
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidUuid(''), false);
});

// ===========================================================================
// Pure: isValidIsoDateTime
// ===========================================================================

test('isValidIsoDateTime: Z form accepted', () => {
  assert.ok(isValidIsoDateTime('2026-10-05T09:00:00Z'));
});

test('isValidIsoDateTime: offset form accepted', () => {
  assert.ok(isValidIsoDateTime('2026-10-05T09:00:00+00:00'));
  assert.ok(isValidIsoDateTime('2026-10-05T09:00:00-0500'));
});

test('isValidIsoDateTime: naive (no TZ) rejected', () => {
  assert.equal(isValidIsoDateTime('2026-10-05T09:00:00'), null);
});

test('isValidIsoDateTime: invalid month rejected', () => {
  assert.equal(isValidIsoDateTime('2026-13-05T09:00:00Z'), null);
});

// ===========================================================================
// Pure: isValidDurationMinutes
// ===========================================================================

test('isValidDurationMinutes: 30 accepted', () => {
  assert.equal(isValidDurationMinutes(30), 30);
});

test('isValidDurationMinutes: 4 rejected (below CHECK min 5)', () => {
  assert.equal(isValidDurationMinutes(4), null);
});

test('isValidDurationMinutes: 481 rejected (above CHECK max 480)', () => {
  assert.equal(isValidDurationMinutes(481), null);
});

test('isValidDurationMinutes: 30.5 rejected (non-integer)', () => {
  assert.equal(isValidDurationMinutes(30.5), null);
});

test('isValidDurationMinutes: string rejected', () => {
  assert.equal(isValidDurationMinutes('30'), null);
});

// ===========================================================================
// Pure: isValidE164Phone
// ===========================================================================

test('isValidE164Phone: +15550000001 accepted', () => {
  assert.equal(isValidE164Phone('+15550000001'), true);
});

test('isValidE164Phone: 555-0000 rejected', () => {
  assert.equal(isValidE164Phone('555-0000'), false);
});

test('isValidE164Phone: leading 0 rejected (E.164 forbids)', () => {
  assert.equal(isValidE164Phone('+0123456789'), false);
});

// ===========================================================================
// Pure: isValidPatientName
// ===========================================================================

test('isValidPatientName: "Alice" accepted', () => {
  assert.equal(isValidPatientName('Alice'), true);
});

test('isValidPatientName: blank rejected', () => {
  assert.equal(isValidPatientName(''), false);
  assert.equal(isValidPatientName('   '), false);
});

test('isValidPatientName: 121 chars rejected', () => {
  assert.equal(isValidPatientName('a'.repeat(121)), false);
});

test('isValidPatientName: 120 chars accepted', () => {
  assert.equal(isValidPatientName('a'.repeat(120)), true);
});

// ===========================================================================
// Pure: checkBookingWindow
// ===========================================================================

test('checkBookingWindow: today → slot_in_past', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0); // 2026-10-04T12:00Z
  const today9am = Date.UTC(2026, 9, 4, 9, 0);
  const result = checkBookingWindow(today9am, now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'slot_in_past');
});

test('checkBookingWindow: today+1 → ok', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0);
  const tomorrow = Date.UTC(2026, 9, 5, 9, 0);
  assert.deepEqual(checkBookingWindow(tomorrow, now), { ok: true });
});

test('checkBookingWindow: today+30 boundary → ok', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0);
  const day30 = Date.UTC(2026, 10, 3, 9, 0); // 2026-11-03
  assert.deepEqual(checkBookingWindow(day30, now), { ok: true });
});

test('checkBookingWindow: today+31 → outside_30d_window', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0);
  const day31 = Date.UTC(2026, 10, 4, 9, 0); // 2026-11-04
  const result = checkBookingWindow(day31, now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'outside_30d_window');
});

// ===========================================================================
// Pure: validateCreateBookingBody
// ===========================================================================

test('validateCreateBookingBody: valid body returns ok', () => {
  const body = {
    doctor_id: '12345678-1234-1234-1234-123456789012',
    branch_id: '12345678-1234-1234-1234-123456789013',
    appointment_type_id: '12345678-1234-1234-1234-123456789014',
    start_datetime: '2026-10-05T09:00:00Z',
    end_datetime: '2026-10-05T09:30:00Z',
    slot_duration_minutes: 30,
    patient_phone: '+15550000001',
    patient_name: 'Alice',
  };
  const result = validateCreateBookingBody(body);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.patient_name, 'Alice');
  }
});

test('validateCreateBookingBody: unknown_field returns error', () => {
  const body = {
    doctor_id: '12345678-1234-1234-1234-123456789012',
    branch_id: '12345678-1234-1234-1234-123456789013',
    appointment_type_id: '12345678-1234-1234-1234-123456789014',
    start_datetime: '2026-10-05T09:00:00Z',
    end_datetime: '2026-10-05T09:30:00Z',
    slot_duration_minutes: 30,
    patient_phone: '+15550000001',
    patient_name: 'Alice',
    foo: 'bar',
  };
  const result = validateCreateBookingBody(body);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'unknown_field');
});

test('validateCreateBookingBody: not an object returns unknown_field', () => {
  const result = validateCreateBookingBody('not an object');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'unknown_field');
});

test('validateCreateBookingBody: invalid_doctor_id order', () => {
  const body = {
    doctor_id: 'not-a-uuid',
    branch_id: '12345678-1234-1234-1234-123456789013',
    appointment_type_id: '12345678-1234-1234-1234-123456789014',
    start_datetime: '2026-10-05T09:00:00Z',
    end_datetime: '2026-10-05T09:30:00Z',
    slot_duration_minutes: 30,
    patient_phone: '+15550000001',
    patient_name: 'Alice',
  };
  const result = validateCreateBookingBody(body);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_doctor_id');
});

test('validateCreateBookingBody: invalid_start_datetime (no TZ)', () => {
  const body = {
    doctor_id: '12345678-1234-1234-1234-123456789012',
    branch_id: '12345678-1234-1234-1234-123456789013',
    appointment_type_id: '12345678-1234-1234-1234-123456789014',
    start_datetime: '2026-10-05T09:00:00',
    end_datetime: '2026-10-05T09:30:00Z',
    slot_duration_minutes: 30,
    patient_phone: '+15550000001',
    patient_name: 'Alice',
  };
  const result = validateCreateBookingBody(body);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_start_datetime');
});

test('validateCreateBookingBody: invalid_patient_phone', () => {
  const body = {
    doctor_id: '12345678-1234-1234-1234-123456789012',
    branch_id: '12345678-1234-1234-1234-123456789013',
    appointment_type_id: '12345678-1234-1234-1234-123456789014',
    start_datetime: '2026-10-05T09:00:00Z',
    end_datetime: '2026-10-05T09:30:00Z',
    slot_duration_minutes: 30,
    patient_phone: '555-0000',
    patient_name: 'Alice',
  };
  const result = validateCreateBookingBody(body);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'invalid_patient_phone');
});

test('validateCreateBookingBody: name is trimmed', () => {
  const body = {
    doctor_id: '12345678-1234-1234-1234-123456789012',
    branch_id: '12345678-1234-1234-1234-123456789013',
    appointment_type_id: '12345678-1234-1234-1234-123456789014',
    start_datetime: '2026-10-05T09:00:00Z',
    end_datetime: '2026-10-05T09:30:00Z',
    slot_duration_minutes: 30,
    patient_phone: '+15550000001',
    patient_name: '  Alice  ',
  };
  const result = validateCreateBookingBody(body);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.patient_name, 'Alice');
});

test('validateCreateBookingBody: ALLOWED_POST_KEYS exposes 8 keys', () => {
  assert.equal(ALLOWED_POST_KEYS.size, 8);
});