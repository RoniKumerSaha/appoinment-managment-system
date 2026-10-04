/**
 * Availability engine — pure slot-list builder.
 *
 * `buildSlots(intervals, durationMinutes)` takes a sorted, merged list
 * of half-open `[startMin, endMin)` intervals in minutes-of-day and
 * returns a list of slots of `durationMinutes` length, stepping every
 * `durationMinutes` minutes (no buffer per FR-016 / BR-017).
 *
 * Pure function: no I/O, no DB. Unit-testable in isolation.
 *
 * Per spec-3-1:
 *   - No buffer between slots (FR-016).
 *   - End-of-day remainder is unused (FR-017).
 *   - Half-open `[start, end)` semantics matching GIST exclusion.
 */

import type { Interval, Slot } from './types.js';

/** Build bookable slots from a list of half-open intervals.
 *
 *  Algorithm:
 *    1. For each interval `[a, b)`:
 *       - Anchor `cursor = a`.
 *       - While `cursor + duration <= b`, emit `{startMin: cursor, endMin: cursor + duration}`.
 *       - Step `cursor += duration` (NO buffer).
 *    2. Flatten into a single sorted-by-time list.
 *
 *  Caller's responsibility:
 *    - `intervals` must already be merged and sorted (the engine layer
 *      calls `mergeIntervals` before this).
 *    - `durationMinutes` must be ≥ 1 (caller-side validation).
 *
 *  Returns an empty array when no slot fits. */
export function buildSlots(
  intervals: Interval[],
  durationMinutes: number,
): Slot[] {
  if (durationMinutes <= 0) return [];
  const slots: Slot[] = [];
  for (const iv of intervals) {
    if (iv.endMin <= iv.startMin) continue;
    let cursor = iv.startMin;
    while (cursor + durationMinutes <= iv.endMin) {
      slots.push({ startMin: cursor, endMin: cursor + durationMinutes });
      cursor += durationMinutes;
    }
  }
  return slots;
}

/** Merge a list of half-open intervals into a sorted, disjoint list.
 *  Adjacent intervals (where one ends exactly when the next starts)
 *  are coalesced into one — this preserves the half-open semantic
 *  (a slot ending at 10:00 and another starting at 10:00 do not
 *  collide). */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin);
  const out: Interval[] = [];
  let cur = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.startMin <= cur.endMin) {
      // Overlap or coalesce.
      cur = {
        startMin: cur.startMin,
        endMin: Math.max(cur.endMin, next.endMin),
      };
    } else {
      out.push(cur);
      cur = next;
    }
  }
  out.push(cur);
  return out;
}

/** Subtract a list of intervals from a list of base intervals. The
 *  result is the set of (start..end) ranges from `base` that have no
 *  intersection with any interval in `subtract`. Half-open semantics
 *  are preserved. Used by the engine to remove block intervals and
 *  existing-appointment intervals from the available window. */
export function subtractIntervals(
  base: Interval[],
  subtract: Interval[],
): Interval[] {
  if (subtract.length === 0) return base;
  const mergedBase = mergeIntervals(base);
  const mergedSubtract = mergeIntervals(subtract);
  const out: Interval[] = [];
  for (const iv of mergedBase) {
    let cursor = iv.startMin;
    for (const sub of mergedSubtract) {
      if (sub.endMin <= cursor) continue;
      if (sub.startMin >= iv.endMin) break;
      // sub overlaps [cursor, iv.endMin); emit [cursor, sub.startMin) if non-empty
      if (sub.startMin > cursor) {
        out.push({ startMin: cursor, endMin: sub.startMin });
      }
      cursor = Math.max(cursor, sub.endMin);
      if (cursor >= iv.endMin) break;
    }
    if (cursor < iv.endMin) {
      out.push({ startMin: cursor, endMin: iv.endMin });
    }
  }
  return out;
}

/** Intersect two interval lists and return the overlap. Result is
 *  sorted and merged. Used by the engine to compute the doctor's
 *  effective working window = branch_hours ∩ doctor_schedule. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      // max of starts, min of ends — overlap iff endMin > startMin.
      const startMin = Math.max(x.startMin, y.startMin);
      const endMin = Math.min(x.endMin, y.endMin);
      if (endMin > startMin) {
        out.push({ startMin, endMin });
      }
    }
  }
  return mergeIntervals(out);
}

/** Clamp a row's interval to `[0, 1440)` minutes-of-day by intersecting
 *  with the day's window. Returns null if no overlap. The engine uses
 *  this to safely ingest block / appointment rows that cross midnight
 *  or span outside the day — the upstream `tstzrange` overlap is on
 *  absolute timestamps, not minutes-of-day. */
export function clampToDay(
  startMin: number,
  endMin: number,
): Interval | null {
  const s = Math.max(0, startMin);
  const e = Math.min(1440, endMin);
  if (e <= s) return null;
  return { startMin: s, endMin: e };
}