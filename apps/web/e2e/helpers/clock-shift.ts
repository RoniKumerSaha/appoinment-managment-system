/**
 * e2e/helpers/clock-shift.ts — direct-DB clock-shifting helper.
 *
 * Lets a Playwright spec move an appointment's start/end datetimes
 * without going through the public booking API (which would block
 * the row with `slot_in_past`). Used by spec 36 to seed a "past
 * row" that the doctor-move endpoint then rejects with
 * `appointment_in_past`.
 *
 * Implementation: we shell out to a one-shot tsx script (this
 * file's `scriptBody()` content) that opens the same Postgres
 * pool as the API, runs the UPDATE, and closes. We pass the row
 * id and target timestamps as env vars so we don't have to deal
 * with argv escaping (the appointment id is a UUID with hyphens;
 * no spaces; safe in argv).
 *
 * The script is written to a tmp .mjs file and run with `node`
 * (not `tsx -e`). This avoids the `tsx -e` argv parsing issue
 * (which fails on multi-line content with `$1` because the
 * shell sees the dollar-signs). The tmp file is auto-cleaned.
 *
 * Why not call the API directly? The booking API is the only
 * legal writer, and it actively rejects past slots. The doctor
 * `update` route doesn't exist (FR-038 / E2-S3: only cancel
 * transitions a row, no PATCH on the row itself). So a direct
 * UPDATE is the only path.
 *
 * Side effect: this bypasses the booking-window route check
 * (`checkBookingWindow`) but does NOT bypass the DB-level
 * `appointment_no_overlap` GIST exclusion. The spec is
 * responsible for picking a past window that doesn't collide
 * with another Scheduled row for the same doctor — the suite's
 * DB reset clears all `+1555000%` rows first, so this is safe.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/e2e/helpers/clock-shift.ts → ../../../.. = repoRoot
const repoRoot = resolve(here, '..', '..', '..', '..');
const envFile = resolve(repoRoot, 'apps', 'api', '.env');
const cwd = resolve(repoRoot, 'apps', 'api');
// poolPath is a file:// URL on Windows so ESM can import it. The
// pool module ships as `.js` but tsx transpiles the .ts source on
// the fly.
const poolPath = pathToFileUrl(
  resolve(repoRoot, 'apps', 'api', 'src', 'db', 'pool.ts'),
);

function pathToFileUrl(p: string): string {
  // Manual file:// URL builder that handles Windows drive letters
  // and spaces. `pathToFileURL` from `node:url` is the canonical
  // helper but is platform-sensitive on backslashes; we do it by
  // hand for control.
  const norm = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(norm)) {
    return 'file:///' + norm;
  }
  if (norm.startsWith('/')) {
    return 'file://' + norm;
  }
  return 'file:///' + norm;
}

/**
 * Move a single appointment row's start/end to the given UTC
 * millis. Status is left untouched.
 */
export function makeRowPast(
  appointmentId: string,
  startMs: number,
  endMs: number,
): void {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'pnpm.cmd' : 'pnpm';

  // The SQL is written to a tmp file (not `-e`) so the shell
  // doesn't get to interpret `$1` / `$2` as positional args. We
  // use env vars for the inputs.
  const env = {
    ...process.env,
    E2E_APPT_ID: appointmentId,
    E2E_START_MS: String(startMs),
    E2E_END_MS: String(endMs),
  };

  const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-clock-'));
  const scriptPath = join(tmpDir, 'shift.mjs');
  writeFileSync(scriptPath, scriptBody(poolPath), 'utf-8');

  try {
    // Use `node` directly with the .mjs file. The pool module
    // is plain ESM (.js) and re-exports from the .ts source —
    // tsx transpiles on the fly.
    const result = spawnSync(
      `${cmd} exec tsx --env-file="${envFile}" "${scriptPath}"`,
      { cwd, stdio: 'pipe', shell: true, env },
    );
    if (result.status !== 0) {
      const stdout = result.stdout?.toString() ?? '';
      const stderr = result.stderr?.toString() ?? '';
      throw new Error(
        `makeRowPast failed (exit=${result.status}); appointmentId=${appointmentId}\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }
  } finally {
    try {
      unlinkSync(scriptPath);
      // Best-effort cleanup of the dir.
    } catch {
      // ignore
    }
  }
}

function scriptBody(poolPath: string): string {
  return `import { getPool, closePool } from '${poolPath}';
(async () => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE appointment SET start_datetime = to_timestamp($1 / 1000.0), end_datetime = to_timestamp($2 / 1000.0) WHERE id = $3",
      [Number(process.env.E2E_START_MS), Number(process.env.E2E_END_MS), process.env.E2E_APPT_ID],
    );
  } finally {
    client.release();
    await closePool();
  }
})().catch((e) => { console.error('makeRowPast failed', e); process.exit(1); });
`;
}
