/**
 * Composer for the Prometheus exposition surface.
 *
 * `render()` returns the full Prometheus text body: counters + histograms +
 * process metrics in a single string. The metrics route reads this once per
 * request so the three registries do not each format their own copy of the
 * shared `# HELP`/`# TYPE` scaffolding.
 *
 * Exposition format: text v0.0.4 (`Content-Type: text/plain; version=0.0.4`).
 */
import { toPrometheus as countersToPrometheus } from './counters.js';
import { toPrometheus as histogramsToPrometheus } from './histograms.js';
import { toPrometheus as processToPrometheus } from './process.js';

export function render(): string {
  // Concatenate in fixed order so test assertions on substrings stay stable
  // across changes (counters → histograms → process). Each sub-renderer
  // appends a trailing newline; the joined body has exactly one final '\n'.
  return (
    countersToPrometheus() +
    histogramsToPrometheus() +
    processToPrometheus()
  );
}
