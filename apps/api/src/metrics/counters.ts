/**
 * Counter registry seeded with the named counters downstream stories increment.
 *
 * The names are a contract — booking, OTP, and recurring stories reference them
 * by string. E0-S6 (observability baseline) will swap this registry for a real
 * Prometheus client; for E0-S1 we just need the names to be queryable from
 * GET /metrics in a stable JSON shape so test code and downstream writers can
 * rely on the key list.
 *
 * Counters are integer-only; values never decrease within a process lifetime.
 */

const NAMED_COUNTERS = [
  'booking.attempt',
  'booking.success',
  'booking.conflict',
  'booking.failure',
  'otp.verification',
  'recurring.created',
  'recurring.skipped',
] as const;

export type CounterName = (typeof NAMED_COUNTERS)[number];

const state: Record<CounterName, number> = NAMED_COUNTERS.reduce(
  (acc, name) => {
    acc[name] = 0;
    return acc;
  },
  {} as Record<CounterName, number>,
);

export function inc(name: CounterName, by = 1): void {
  state[name] = (state[name] ?? 0) + by;
}

export function snapshot(): Record<CounterName, number> {
  return { ...state };
}

export function knownCounters(): readonly CounterName[] {
  return NAMED_COUNTERS;
}
