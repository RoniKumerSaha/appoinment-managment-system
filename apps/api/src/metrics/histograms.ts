/**
 * Histogram registry — typed mirror of the counter registry.
 *
 * Each histogram is named in `HISTOGRAMS`; `observe(name, valueMs)` throws
 * on unknown names so a typo in caller code is caught at first call, not six
 * months later at runtime review.
 *
 * Bucket boundaries (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, +Inf.
 * Chosen for sub-second API latency (p50/p95/p99 within a 1s budget).
 *
 * The snapshot shape is `{name, count, sum, buckets[]}` where each bucket is
 * `{le: number | '+Inf', count: number}`. Prometheus exposition uses the same
 * data via `toPrometheus()`.
 */

const HISTOGRAMS = ['http.request.duration_ms'] as const;

export type HistogramName = (typeof HISTOGRAMS)[number];

const BOUNDARIES_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;
const POS_INF_LABEL = '+Inf';

interface HistogramState {
  count: number;
  sum: number;
  // Per-boundary cumulative counts. Index i holds the count of observations
  // whose value was <= BOUNDARIES_MS[i]. The implicit +Inf bucket equals
  // `count` (every observation satisfies value <= +Inf).
  bucketCounts: number[];
}

const state: Record<HistogramName, HistogramState> = HISTOGRAMS.reduce(
  (acc, name) => {
    acc[name] = {
      count: 0,
      sum: 0,
      bucketCounts: BOUNDARIES_MS.map(() => 0),
    };
    return acc;
  },
  {} as Record<HistogramName, HistogramState>,
);

export function observe(name: HistogramName, valueMs: number): void {
  if (!(name in state)) {
    throw new Error(`unknown_histogram_name:${name}`);
  }
  // Guard against NaN, +Infinity, -Infinity, and negative durations. NaN
  // would silently corrupt `sum` and the bucket counts (NaN + 1 === NaN);
  // Infinity would create a non-finite sum that Prometheus scrapers reject;
  // negative values are not a meaningful API latency.
  if (!Number.isFinite(valueMs) || valueMs < 0) {
    throw new Error(`invalid_histogram_value:${name}`);
  }
  const h = state[name]!;
  h.count += 1;
  h.sum += valueMs;
  // Cumulative bucket counts: each boundary bucket holds observations
  // <= boundary. We add +1 to every bucket whose boundary >= value.
  for (let i = 0; i < BOUNDARIES_MS.length; i++) {
    const boundary = BOUNDARIES_MS[i]!;
    if (valueMs <= boundary) {
      h.bucketCounts[i] = (h.bucketCounts[i] ?? 0) + 1;
    }
  }
}

export interface HistogramBucket {
  le: number | typeof POS_INF_LABEL;
  count: number;
}

export interface HistogramSnapshot {
  name: HistogramName;
  count: number;
  sum: number;
  buckets: HistogramBucket[];
}

export function snapshot(): HistogramSnapshot[] {
  return HISTOGRAMS.map((name) => {
    const h = state[name]!;
    const buckets: HistogramBucket[] = BOUNDARIES_MS.map((boundary, i) => ({
      le: boundary,
      count: h.bucketCounts[i] ?? 0,
    }));
    buckets.push({ le: POS_INF_LABEL, count: h.count });
    return {
      name,
      count: h.count,
      sum: h.sum,
      buckets,
    };
  });
}

/**
 * Reset every histogram to its zero state. Test-only.
 */
export function reset(): void {
  for (const name of HISTOGRAMS) {
    const h = state[name]!;
    h.count = 0;
    h.sum = 0;
    for (let i = 0; i < BOUNDARIES_MS.length; i++) {
      h.bucketCounts[i] = 0;
    }
  }
}

export function knownHistograms(): readonly HistogramName[] {
  return HISTOGRAMS;
}

/**
 * Prometheus exposition for all histograms.
 *
 * Per histogram we emit one `# HELP`, one `# TYPE histogram`, and one line per
 * bucket (cumulative count with `le="..."` label), plus `_count` and `_sum`.
 */
export function toPrometheus(): string {
  const lines: string[] = [];
  for (const name of HISTOGRAMS) {
    const h = state[name]!;
    const baseName = name.replace(/\./g, '_');
    lines.push(`# HELP ${baseName} Clinic API histogram ${name}`);
    lines.push(`# TYPE ${baseName} histogram`);
    for (let i = 0; i < BOUNDARIES_MS.length; i++) {
      const boundary = BOUNDARIES_MS[i]!;
      const count = h.bucketCounts[i] ?? 0;
      lines.push(`${baseName}_bucket{le="${boundary}"} ${count}`);
    }
    lines.push(`${baseName}_bucket{le="${POS_INF_LABEL}"} ${h.count}`);
    lines.push(`${baseName}_count ${h.count}`);
    lines.push(`${baseName}_sum ${h.sum}`);
  }
  return lines.join('\n') + '\n';
}
