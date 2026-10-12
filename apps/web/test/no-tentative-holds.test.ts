/**
 * no-tentative-holds.test.ts — static, file-walking test for E7-S7.
 *
 * Per spec-7-7 (Architecture §2 "atomicity over clever UX" + UX-FLOWS §6.2):
 *   "The UI may display slots; it may not assume a slot is still
 *    bookable, and it may not hold tentative reservations outside the
 *    server's booking transaction."
 *
 * This is the **static half** of the E7-S7 pair. The dynamic half
 * (`apps/api/test/no-tentative-holds-concurrent.test.ts`) pins the
 * server contract that ConflictModal (E7-S4) consumes.
 *
 * Strategy:
 *   Walk every `.ts`/`.tsx` file under `apps/web/src` and assert that
 *   none of them contain a forbidden pattern that would indicate a
 *   client-side hold. The patterns are intentionally narrow — they
 *   would only appear if a future regression introduced a hold-style
 *   feature, which the architecture explicitly forbids.
 *
 * Why a static test, not a runtime test:
 *   The negative capability — "no client store treats a slot as held"
 *   — is easier to assert by absence-of-show-disconfirmation than by
 *   runtime behavior. A grep test pinned in CI catches a future
 *   regression where someone adds a `Map<slotId, holdExpiry>` or a
 *   `pendingHolds: string[]` to the web client.
 *
 * Why this lives in `apps/web/test/`:
 *   The test only walks `apps/web/src/` and is web-domain knowledge.
 *   Putting it under `apps/api/test/` would couple the api test
 *   glob to a web-only invariant; this file is runnable on its own
 *   via `node --import tsx --test apps/web/test/no-tentative-holds.test.ts`
 *   and is also picked up by the web test driver at
 *   `apps/web/test/run-no-tentative-holds.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve `apps/web/src` relative to this test file. Test file is at
// `apps/web/test/no-tentative-holds.test.ts`; src is one level up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_SRC_DIR = resolve(__dirname, '..', 'src');

/** Patterns that would indicate a client-side slot hold. Each pattern
 *  matches a single line of source. Order is irrelevant — the test
 *  reports every offender, not just the first.
 *
 *  Every pattern is anchored to a *call site* (a `new Map(`, a
 *  `localStorage.setItem`, etc.) so existing harmless identifiers
 *  like `medicalBusyEvent` or `holds_*` column references in comments
 *  are not flagged. The exceptions list below documents the
 *  intentional false-positives the patterns might otherwise match. */
const FORBIDDEN_PATTERNS: { re: RegExp; why: string }[] = [
  // In-memory hold state — variable names
  { re: /\b(?:pendingHolds|tentativeHolds|slotHolds|holdMap)\b/, why: 'in-memory hold-state variable' },
  // Hold lifetime tracking
  { re: /\b(?:holdExpiry|holdUntil|holdExpiryMs)\b/, why: 'hold-lifetime tracker' },
  // Mutable hold store
  { re: /\bholds\.(?:set|add)\(/, why: 'mutable hold store mutation' },
  { re: /\bholdsMap\.(?:set|add)\(/, why: 'mutable hold-map mutation' },
  { re: /\bnew\s+Map<string,\s*hold\b/, why: 'typed hold-map construction' },
  // Optimistic-locking smoke — wrong tool for this job
  { re: /\b(?:optimisticHold|optimisticSlot|optimisticBooking)\b/, why: 'optimistic-locking smoke' },
  // Persistent hold state across sessions
  { re: /\b(?:localStorage|sessionStorage)\.setItem\(\s*['"`]holds/, why: 'persistent hold store' },
  // Timer-driven hold expiry
  { re: /\bsetTimeout\(\s*[^,]+,\s*(?:hold|holds)\b/, why: 'timer-driven hold expiry' },
  { re: /\bclearTimeout\(\s*(?:hold|holds)\b/, why: 'timer-driven hold expiry' },
];

/** Whitelist: files (relative to `apps/web/src`) whose content is
 *  expected to mention a "hold" identifier without violating the
 *  invariant. The whitelist is intentionally empty today; the API
 *  surfaces `holds_*` columns in the *server* (apps/api) only, not the
 *  web client. If a future legitimate use appears (e.g. a hold-shaped
 *  audit-row type), add it here with a comment citing the spec. */
const FILE_WHITELIST: string[] = [
  // 'components/SomeComponent.tsx' — example; no entries today
];

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip type-only / build / node_modules directories.
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      walk(full, acc);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      acc.push(full);
    }
  }
}

test('static — no client-side slot-hold state in apps/web/src', () => {
  const files: string[] = [];
  walk(WEB_SRC_DIR, files);
  assert.ok(files.length > 0, `expected to find source files under ${WEB_SRC_DIR}`);

  const offenders: { file: string; line: number; text: string; why: string }[] = [];
  for (const file of files) {
    const rel = file.slice(WEB_SRC_DIR.length + 1).replace(/\\/g, '/');
    if (FILE_WHITELIST.includes(rel)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      // Skip comment-only lines: a regression that *adds* a hold store
      // is caught by the call-site match, not by a comment mention. This
      // keeps the test focused on real call sites and avoids false
      // positives from prose like "no tentative holds per spec-7-7".
      if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return;
      for (const { re, why } of FORBIDDEN_PATTERNS) {
        if (re.test(text)) {
          offenders.push({ file: rel, line: i + 1, text: text.trim(), why });
        }
      }
    });
  }

  assert.equal(
    offenders.length,
    0,
    `forbidden client-side hold patterns in apps/web/src: ${JSON.stringify(offenders, null, 2)}`,
  );
});

test('static — apps/web/src/ contains at least the expected entrypoints', () => {
  // Sanity check that the walk actually saw real web source. A
  // misconfigured WEB_SRC_DIR would silently pass the hold-test above
  // (no files = no matches), so we pin a count floor here.
  const files: string[] = [];
  walk(WEB_SRC_DIR, files);
  assert.ok(
    files.length >= 5,
    `expected at least 5 web source files (App.tsx + 4 more); found ${files.length}. ` +
      `WEB_SRC_DIR = ${WEB_SRC_DIR}`,
  );
});
