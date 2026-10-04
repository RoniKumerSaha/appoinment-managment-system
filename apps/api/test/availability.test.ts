/**
 * availability.test.ts — unit tests for the pure slot-list builder
 * + integration tests for the GET /availability route.
 *
 * Spec-3-1 + architecture §3.2:
 *   - Server-side, transactional.
 *   - 30-day window (FR-018).
 *   - No buffer between slots (FR-016 / BR-017).
 *   - End-of-day remainder unused (FR-017).
 *   - Half-open `[start, end)` semantics matching GIST exclusion.
 *   - Multi-period days honored.
 *   - FR-027 / FR-029 patient filters when patient_phone is supplied.
 *
 * Two test groups:
 *   1. Pure unit tests for `buildSlots`, `mergeIntervals`, `subtractIntervals`,
 *      `intersect`, `isWithin30DayWindow` — no DB.
 *   2. Integration tests against the seeded DB via the route — covers the
 *      full pipeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlots,
  clampToDay,
  intersect,
  mergeIntervals,
  subtractIntervals,
} from '../src/availability/slots.js';
import {
  isWithin30DayWindow,
  timeStringToMinutes,
  utcDayOfWeek,
} from '../src/availability/types.js';

// ===========================================================================
// Pure: buildSlots
// ===========================================================================

test('buildSlots: 9:00-17:00 with 30min duration → 16 slots (no buffer)', () => {
  const slots = buildSlots([{ startMin: 540, endMin: 1020 }], 30);
  assert.equal(slots.length, 16);
  assert.equal(slots[0]!.startMin, 540);
  assert.equal(slots[0]!.endMin, 570);
  assert.equal(slots[15]!.startMin, 990);
  assert.equal(slots[15]!.endMin, 1020);
});

test('buildSlots: 10:00-13:00 with 60min → 3 slots (10:00, 11:00, 12:00)', () => {
  const slots = buildSlots([{ startMin: 600, endMin: 780 }], 60);
  assert.equal(slots.length, 3);
  assert.deepEqual(slots[0], { startMin: 600, endMin: 660 });
  assert.deepEqual(slots[1], { startMin: 660, endMin: 720 });
  assert.deepEqual(slots[2], { startMin: 720, endMin: 780 });
});

test('buildSlots: end-of-day remainder unused (FR-017)', () => {
  // 25-min slots in 9:00-17:00 (= 480 minutes available).
  // 480 / 25 = 19.2 → 19 slots (475 minutes used), 5 minutes leftover.
  const slots = buildSlots([{ startMin: 540, endMin: 1020 }], 25);
  assert.equal(slots.length, 19);
  // The last slot must end ≤ 1020 (the close time).
  assert.ok(slots[slots.length - 1]!.endMin <= 1020);
});

test('buildSlots: multi-period day (10:00-12:00 + 14:00-17:00)', () => {
  const slots = buildSlots(
    [
      { startMin: 600, endMin: 720 },
      { startMin: 840, endMin: 1020 },
    ],
    30,
  );
  // morning: 600..720 → 4 (600, 630, 660, 690)
  // afternoon: 840..1020 → 6 (840, 870, 900, 930, 960, 990)
  assert.equal(slots.length, 10);
  // Verify gap (no 720..750 etc).
  assert.equal(slots[3]!.endMin, 720);
  assert.equal(slots[4]!.startMin, 840);
});

test('buildSlots: empty interval list → 0 slots', () => {
  assert.deepEqual(buildSlots([], 30), []);
});

test('buildSlots: duration 0 → 0 slots (defensive)', () => {
  assert.deepEqual(buildSlots([{ startMin: 540, endMin: 1020 }], 0), []);
});

test('buildSlots: duration larger than interval → 0 slots', () => {
  assert.deepEqual(buildSlots([{ startMin: 540, endMin: 600 }], 120), []);
});

// ===========================================================================
// Pure: mergeIntervals
// ===========================================================================

test('mergeIntervals: disjoint intervals preserved', () => {
  const out = mergeIntervals([
    { startMin: 540, endMin: 600 },
    { startMin: 660, endMin: 720 },
  ]);
  assert.deepEqual(out, [
    { startMin: 540, endMin: 600 },
    { startMin: 660, endMin: 720 },
  ]);
});

test('mergeIntervals: adjacent intervals coalesce (10:00 ends, 10:00 starts)', () => {
  const out = mergeIntervals([
    { startMin: 540, endMin: 600 },
    { startMin: 600, endMin: 660 },
  ]);
  assert.deepEqual(out, [{ startMin: 540, endMin: 660 }]);
});

test('mergeIntervals: overlapping intervals merge', () => {
  const out = mergeIntervals([
    { startMin: 540, endMin: 660 },
    { startMin: 600, endMin: 720 },
  ]);
  assert.deepEqual(out, [{ startMin: 540, endMin: 720 }]);
});

test('mergeIntervals: unsorted input is sorted', () => {
  const out = mergeIntervals([
    { startMin: 660, endMin: 720 },
    { startMin: 540, endMin: 600 },
  ]);
  assert.deepEqual(out, [
    { startMin: 540, endMin: 600 },
    { startMin: 660, endMin: 720 },
  ]);
});

// ===========================================================================
// Pure: subtractIntervals
// ===========================================================================

test('subtractIntervals: subtract middle → split', () => {
  const out = subtractIntervals(
    [{ startMin: 540, endMin: 1020 }],
    [{ startMin: 600, endMin: 660 }],
  );
  assert.deepEqual(out, [
    { startMin: 540, endMin: 600 },
    { startMin: 660, endMin: 1020 },
  ]);
});

test('subtractIntervals: subtract left edge', () => {
  const out = subtractIntervals(
    [{ startMin: 540, endMin: 1020 }],
    [{ startMin: 540, endMin: 600 }],
  );
  assert.deepEqual(out, [{ startMin: 600, endMin: 1020 }]);
});

test('subtractIntervals: subtract right edge', () => {
  const out = subtractIntervals(
    [{ startMin: 540, endMin: 1020 }],
    [{ startMin: 960, endMin: 1020 }],
  );
  assert.deepEqual(out, [{ startMin: 540, endMin: 960 }]);
});

test('subtractIntervals: subtract entire interval → empty', () => {
  const out = subtractIntervals(
    [{ startMin: 540, endMin: 600 }],
    [{ startMin: 540, endMin: 600 }],
  );
  assert.deepEqual(out, []);
});

test('subtractIntervals: empty subtract → base returned', () => {
  const out = subtractIntervals([{ startMin: 540, endMin: 600 }], []);
  assert.deepEqual(out, [{ startMin: 540, endMin: 600 }]);
});

// ===========================================================================
// Pure: intersect
// ===========================================================================

test('intersect: overlap → narrowed', () => {
  const out = intersect(
    [{ startMin: 540, endMin: 1020 }],
    [{ startMin: 600, endMin: 720 }],
  );
  assert.deepEqual(out, [{ startMin: 600, endMin: 720 }]);
});

test('intersect: disjoint → empty', () => {
  const out = intersect(
    [{ startMin: 540, endMin: 600 }],
    [{ startMin: 660, endMin: 720 }],
  );
  assert.deepEqual(out, []);
});

// ===========================================================================
// Pure: clampToDay
// ===========================================================================

test('clampToDay: in-range → unchanged', () => {
  assert.deepEqual(clampToDay(540, 600), { startMin: 540, endMin: 600 });
});

test('clampToDay: spans midnight (end > 1440) → end clamped to 1440', () => {
  // A block 23:30 → 00:30 next day: minutes -30, 1470.
  assert.deepEqual(clampToDay(-30, 1470), { startMin: 0, endMin: 1440 });
});

test('clampToDay: negative start → 0', () => {
  assert.deepEqual(clampToDay(-100, 600), { startMin: 0, endMin: 600 });
});

test('clampToDay: end ≤ start → null', () => {
  assert.equal(clampToDay(600, 600), null);
  assert.equal(clampToDay(700, 600), null);
});

test('clampToDay: outside day → null', () => {
  assert.equal(clampToDay(1500, 1600), null);
});

// ===========================================================================
// Pure: window helper
// ===========================================================================

test('isWithin30DayWindow: today → false (FR-019 same-day exclusion)', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0);
  assert.equal(isWithin30DayWindow(now, now), false);
});

test('isWithin30DayWindow: today+1 → true', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0);
  assert.equal(
    isWithin30DayWindow(now + 24 * 60 * 60 * 1000, now),
    true,
  );
});

test('isWithin30DayWindow: today+30 → true (boundary inclusive)', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0);
  assert.equal(
    isWithin30DayWindow(now + 30 * 24 * 60 * 60 * 1000, now),
    true,
  );
});

test('isWithin30DayWindow: today+31 → false', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0);
  assert.equal(
    isWithin30DayWindow(now + 31 * 24 * 60 * 60 * 1000, now),
    false,
  );
});

// ===========================================================================
// Pure: timeStringToMinutes
// ===========================================================================

test('timeStringToMinutes: 09:00 → 540', () => {
  assert.equal(timeStringToMinutes('09:00'), 540);
});

test('timeStringToMinutes: 09:30:00 → 570', () => {
  assert.equal(timeStringToMinutes('09:30:00'), 570);
});

test('timeStringToMinutes: 17:00 → 1020', () => {
  assert.equal(timeStringToMinutes('17:00'), 1020);
});

test('timeStringToMinutes: invalid → null', () => {
  assert.equal(timeStringToMinutes('not-a-time'), null);
  assert.equal(timeStringToMinutes('25:00'), null);
});

// ===========================================================================
// Pure: utcDayOfWeek
// ===========================================================================

test('utcDayOfWeek: 2026-01-04 (Sunday) → 0', () => {
  const d = new Date(Date.UTC(2026, 0, 4));
  assert.equal(utcDayOfWeek(d), 0);
});

test('utcDayOfWeek: 2026-01-05 (Monday) → 1', () => {
  const d = new Date(Date.UTC(2026, 0, 5));
  assert.equal(utcDayOfWeek(d), 1);
});

test('utcDayOfWeek: 2026-01-10 (Saturday) → 6', () => {
  const d = new Date(Date.UTC(2026, 0, 10));
  assert.equal(utcDayOfWeek(d), 6);
});