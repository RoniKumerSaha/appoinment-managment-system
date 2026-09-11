/**
 * Counter registry seeded with the named counters downstream stories increment.
 *
 * The names are a contract — booking, OTP, and recurring stories reference them
 * by string. E0-S6 (observability baseline) added Prometheus exposition on top
 * of the original JSON shape; downstream stories still import by the dotted
 * counter names and the legacy `{counters: {<name>: n}}` JSON body is
 * retained under `Accept: application/json`.
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

/**
 * Prometheus exposition for the named counters.
 *
 * Naming convention: dotted counter names → snake_case with `_total`
 * suffix (Prometheus best practice for monotonic counters). e.g.
 * `booking.attempt` → `booking_attempt_total`.
 *
 * Format follows the text-based Prometheus exposition format v0.0.4
 * (one `# HELP` + one `# TYPE counter` per metric, followed by sample lines).
 * Histogram + process metrics are emitted by their own modules; this
 * function only renders counters.
 */
export function toPrometheus(): string {
  const lines: string[] = [];
  for (const name of NAMED_COUNTERS) {
    const promName = name.replace(/\./g, '_') + '_total';
    const value = state[name] ?? 0;
    lines.push(`# HELP ${promName} Clinic API counter ${name}`);
    lines.push(`# TYPE ${promName} counter`);
    lines.push(`${promName} ${value}`);
  }
  return lines.join('\n') + '\n';
}
