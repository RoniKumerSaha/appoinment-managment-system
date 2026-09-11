/**
 * Build-info observability — emits one `service_started` info log line per
 * process boot so operators can correlate "which code is running" with the
 * deployment sha + semver tag.
 *
 * Source of the two version fields:
 *   - `APP_VERSION` — defaults to `'0.0.0-dev'` so a local `tsx watch` boot
 *     without an injected version still emits a non-empty value.
 *   - `GIT_SHA`     — defaults to `'unknown'` for the same reason. A missing
 *     git_sha is NEVER an error: the value is informational, not a gate.
 *
 * The structured shape is fixed by the E0-S6 contract:
 *   { service, version, git_sha, node_env, port }
 *
 * Tests inject the destination via `__redirectBaseLoggerForTests()` in
 * `middleware/log.ts` and call `serviceStarted(port)` directly so a single
 * JSON line lands in the captured Writable without binding to PORT.
 */
import { getLogger } from '../middleware/log.js';

export function serviceStarted(port: number): void {
  // Port must be a non-negative integer in the IANA-registered range
  // (0..65535). Any other value (NaN, fractional, negative, >65535) means
  // a buggy bootstrap is calling us — refuse to emit the operator-facing
  // `service_started` line because it would carry `port: NaN` and mislead
  // on-call. We still emit a structured warn line so the failure is
  // visible in the same log stream.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    getLogger().warn(
      { event: 'service_started_invalid_port', port },
      'service_started called with invalid port',
    );
    return;
  }
  const version = process.env['APP_VERSION'] ?? '0.0.0-dev';
  const git_sha = process.env['GIT_SHA'] ?? 'unknown';
  const node_env = process.env['NODE_ENV'] ?? 'development';
  getLogger().info(
    {
      service: 'clinic-api',
      version,
      git_sha,
      node_env,
      port,
    },
    'service_started',
  );
}
