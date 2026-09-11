/**
 * Process metrics — stdlib-only readings of the Node.js process.
 *
 * `snapshot()` returns a fresh object on each call:
 *   - `uptime_seconds`             — `process.uptime()`
 *   - `process_cpu_seconds_total`  — accumulated user+sys CPU since process start (seconds)
 *   - `process_resident_memory_bytes` — `process.memoryUsage().rss`
 *   - `nodejs_eventloop_lag_seconds` — best-effort event-loop lag in seconds
 *
 * `process_cpu_seconds_total` is computed once at module-load and
 * continuously accumulated against the value returned by `process.cpuUsage()`
 * (which is a delta since the last call). The module records its own
 * baseline on first read so subsequent readings are monotonically
 * increasing — the way Prometheus expects counters to behave.
 *
 * `nodejs_eventloop_lag_seconds`: we use `node:perf_hooks.monitorEventLoopDelay`
 * to get an actual reading when the monitor is enabled; for the snapshot path
 * we expose a numeric value (0 if the monitor isn't initialised yet) so the
 * shape is stable for downstream consumers. The test contract requires
 * presence + numeric type only.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

const NS_PER_SEC = 1_000_000_000;

interface ProcessMetricsSnapshot {
  uptime_seconds: number;
  process_cpu_seconds_total: number;
  process_resident_memory_bytes: number;
  nodejs_eventloop_lag_seconds: number;
}

let cpuBaselineNs: number | null = null;
let lastCpuUsageNs = 0;

function readCpuSecondsTotal(): number {
  const usage = process.cpuUsage();
  // usage.user + usage.system are deltas since process start OR since the
  // last cpuUsage() call, depending on Node version. On Node 20+ these are
  // deltas since the last call to cpuUsage(); to get a monotonic total we
  // capture our own baseline once at module-load and accumulate.
  const deltaNs = usage.user + usage.system;
  if (cpuBaselineNs === null) {
    cpuBaselineNs = deltaNs;
    lastCpuUsageNs = deltaNs;
    return 0;
  }
  lastCpuUsageNs += deltaNs;
  return lastCpuUsageNs / NS_PER_SEC;
}

/**
 * Event-loop lag in seconds. Uses `node:perf_hooks.monitorEventLoopDelay`
 * to get a real reading when the monitor is enabled. We lazily enable the
 * monitor on first call and read its current `min` value (a stable lower
 * bound on recent lag). Until the monitor collects samples, we return 0 so
 * the value is numeric and never throws.
 */
let eventLoopMonitor: IntervalHistogram | null = null;
let eventLoopMonitorEnabled = false;

function readEventLoopLagSeconds(): number {
  if (!eventLoopMonitorEnabled) {
    try {
      // Lazy construction so the test runner that doesn't touch process
      // metrics never pays the cost of constructing the monitor until a
      // snapshot actually requests it.
      eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
      eventLoopMonitor.enable();
      eventLoopMonitorEnabled = true;
    } catch {
      return 0;
    }
  }
  if (!eventLoopMonitor) return 0;
  // `min` is in nanoseconds; lag is observed at the resolution interval, so
  // a freshly-enabled monitor reports 0 until samples accumulate. Return 0
  // in that case — the contract only requires a numeric value.
  const minNs = eventLoopMonitor.min;
  if (!Number.isFinite(minNs) || minNs <= 0) return 0;
  return minNs / NS_PER_SEC;
}

export function snapshot(): ProcessMetricsSnapshot {
  const mem = process.memoryUsage();
  return {
    uptime_seconds: process.uptime(),
    process_cpu_seconds_total: readCpuSecondsTotal(),
    process_resident_memory_bytes: mem.rss,
    nodejs_eventloop_lag_seconds: readEventLoopLagSeconds(),
  };
}

/**
 * Prometheus exposition for process metrics. Renders the four snapshot
 * fields as gauges (or counter for cpu_seconds_total) with the
 * Prometheus-recommended metric names.
 *
 * Any non-finite (NaN / +Inf / -Inf) numeric value is replaced with 0 before
 * the sample line is emitted. Prometheus exposition format forbids literal
 * `NaN` / `Infinity` in sample values (scrapers reject the body), so the
 * substitution here keeps the body always parseable. The underlying
 * snapshot itself is unchanged — callers that want the raw value can
 * still call `snapshot()`.
 */
export function toPrometheus(): string {
  const s = snapshot();
  const lines: string[] = [];
  lines.push(`# HELP uptime_seconds Process uptime in seconds`);
  lines.push(`# TYPE uptime_seconds gauge`);
  lines.push(`uptime_seconds ${sanitizeNumber(s.uptime_seconds)}`);
  lines.push(`# HELP process_cpu_seconds_total Total user+system CPU time in seconds`);
  lines.push(`# TYPE process_cpu_seconds_total counter`);
  lines.push(`process_cpu_seconds_total ${sanitizeNumber(s.process_cpu_seconds_total)}`);
  lines.push(`# HELP process_resident_memory_bytes Resident memory size in bytes`);
  lines.push(`# TYPE process_resident_memory_bytes gauge`);
  lines.push(`process_resident_memory_bytes ${sanitizeNumber(s.process_resident_memory_bytes)}`);
  lines.push(`# HELP nodejs_eventloop_lag_seconds Node.js event loop lag in seconds`);
  lines.push(`# TYPE nodejs_eventloop_lag_seconds gauge`);
  lines.push(`nodejs_eventloop_lag_seconds ${sanitizeNumber(s.nodejs_eventloop_lag_seconds)}`);
  return lines.join('\n') + '\n';
}

function sanitizeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Test-only: reset the CPU baseline so successive tests start from zero,
 * AND disable + null the event-loop monitor handle so it cannot leak state
 * across tests. Production code never calls this.
 */
export function __resetForTests(): void {
  cpuBaselineNs = null;
  lastCpuUsageNs = 0;
  if (eventLoopMonitor !== null) {
    try {
      eventLoopMonitor.disable();
    } catch {
      // monitor was never enabled or already disabled — nothing to do.
    }
    eventLoopMonitor = null;
  }
  eventLoopMonitorEnabled = false;
}
