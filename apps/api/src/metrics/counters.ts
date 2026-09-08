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
  if (!(name in state)) {
    // Defend the contract: unknown names signal a typo in caller code and
    // would silently disappear from /metrics. Throw so the mistake is caught
    // at the first increment attempt, not six months later at runtime review.
    throw new Error(`unknown_counter_name:${name}`);
  }
  state[name] = (state[name] ?? 0) + by;
}

export function snapshot(): Record<CounterName, number> {
  return { ...state };
}

/**
 * Reset every counter to 0. Intended for test setup so each test sees a
 * deterministic starting snapshot — production code never calls this.
 */
export function reset(): void {
  for (const name of NAMED_COUNTERS) {
    state[name] = 0;
  }
}

export function knownCounters(): readonly CounterName[] {
  return NAMED_COUNTERS;
}
