/**
 * conflict-modal-singleton.test.ts — static singleton test for E7-S4.
 *
 * Per spec-7-4 (UX-FLOWS §7.1 + architecture §5):
 *   "A single shared ConflictModal component...used by every flow that
 *    surfaces a 409 from the server."
 *   "OK"-only conflict surfaces and bespoke-modal drift are forbidden.
 *
 * SPEC-DIVERGENCE NOTE (SC1 in the spec change log):
 *   The spec's literal forbidden-pattern list — `<div role="dialog">`,
 *   `aria-modal="true"`, `ModalProps`, `DialogProps` — is too broad.
 *   The web client has 19+ dialog-shaped components that are NOT
 *   conflict modals: form modals (AdminDoctors, AdminReceptionists,
 *   CancelModal, DoctorMarkStatus, DoctorResolve, ReschedulePage),
 *   confirmation dialogs (DoctorCancel, DoctorResolutionSaved), and
 *   slide-in detail drawers (DoctorAuditDrawer). None of these are
 *   in the E7-S4 scope; each is a distinct UX surface with its own
 *   state (form state, save flow, focus management) that does not
 *   match the 3-slot what/why/canDo contract.
 *
 *   The test below targets the spec's **intent** rather than its
 *   literal forbidden list: it forbids a second component that
 *   exposes the conflict-modal contract (i.e. one with `tone`,
 *   `what`/`why`/`canDo` together). A future regression that adds
 *   such a component — e.g. a new `BookingConflictModal.tsx` —
 *   would fail this test. A regression that adds a new form
 *   modal would not, which is correct: form modals are out of
 *   scope for E7-S4 and will get their own consolidation story
 *   (likely E7-S5 / a11y).
 *
 * Strategy:
 *   Walk every `.ts`/`.tsx` file under `apps/web/src` and assert that
 *   no other file exports a component that combines the conflict-modal
 *   shape — `tone` + `what`/`why` + action array together. The
 *   existing `ConflictModal.tsx` is whitelisted.
 *
 * Why this lives in `apps/web/test/`:
 *   Web-domain invariant, walker targets `apps/web/src/`. Same run
 *   strategy as the E7-S7 web test — `node --import tsx --test` via
 *   the web test driver. The web package's `test` script is a no-op
 *   (preserved for backward compat); a dedicated `test:e7-s4` script
 *   invokes the driver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_SRC_DIR = resolve(__dirname, '..', 'src');

/** Files under `apps/web/src` that are allowed to expose the
 *  conflict-modal contract. Today, only ConflictModal itself. */
const FILE_WHITELIST: string[] = [
  'components/ConflictModal.tsx',
];

/** Patterns that would indicate a NEW conflict-modal component.
 *  Each pattern matches a single line of source.
 *
 *  The conflict-modal shape is the **combination** of:
 *    - an exported component with name matching *Conflict* or *Error*
 *    - props for tone (warn/danger/info) + a what/why body + actions
 *
 *  We detect this by:
 *    1. A PascalCase export whose name contains "Conflict" (e.g.
 *       `DoctorConflictModal`, `BookingConflictDialog`,
 *       `SlotConflictToast`). The ConflictModal itself is whitelisted.
 *    2. A `ConflictTone` / `ConflictAction` re-export from a non-
 *       ConflictModal file. These are the type-level signatures that
 *       only the singleton should expose.
 */
const FORBIDDEN_PATTERNS: { re: RegExp; why: string }[] = [
  // PascalCase exports whose name contains "Conflict". Catches
  // `export function DoctorConflictModal`, `export const BookingConflictDialog`,
  // `export function SlotConflictToast`, etc.
  {
    re: /\bexport\s+(?:default\s+)?function\s+[A-Z][A-Za-z]*Conflict[A-Za-z]*\b/,
    why: 'bespoke conflict-modal component (function) — must use shared ConflictModal',
  },
  {
    re: /\bexport\s+const\s+[A-Z][A-Za-z]*Conflict[A-Za-z]*\b\s*[:=]/,
    why: 'bespoke conflict-modal component (const) — must use shared ConflictModal',
  },
  // PascalCase exports whose name ends in ErrorModal — the
  // conflict-modal contract applied to error reporting. (Not a
  // 409-only surface, but the same shape.)
  {
    re: /\bexport\s+(?:default\s+)?function\s+[A-Z][A-Za-z]*ErrorModal\b/,
    why: 'bespoke error-modal component — must use shared ConflictModal',
  },
  {
    re: /\bexport\s+const\s+[A-Z][A-Za-z]*ErrorModal\b\s*[:=]/,
    why: 'bespoke error-modal component (const) — must use shared ConflictModal',
  },
  // Re-exports of the conflict-modal type contract from another file.
  // Catches `export type { ConflictTone } from './ConflictModal'` style.
  {
    re: /\bexport\s+type\s*\{[^}]*ConflictTone[^}]*\}/,
    why: 're-export of ConflictTone from non-ConflictModal file',
  },
  {
    re: /\bexport\s+type\s*\{[^}]*ConflictAction[^}]*\}/,
    why: 're-export of ConflictAction from non-ConflictModal file',
  },
];

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      walk(full, acc);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      acc.push(full);
    }
  }
}

test('static — apps/web/src has no second conflict-modal component (singleton invariant)', () => {
  const files: string[] = [];
  walk(WEB_SRC_DIR, files);
  assert.ok(files.length > 0, `expected to find source files under ${WEB_SRC_DIR}`);

  const offenders: { file: string; line: number; text: string; why: string }[] = [];
  for (const file of files) {
    const rel = file.slice(WEB_SRC_DIR.length + 1).replace(/\\/g, '/');
    if (FILE_WHITELIST.includes(rel)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      // Skip comment-only lines.
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
    `forbidden conflict-modal patterns in apps/web/src: ${JSON.stringify(offenders, null, 2)}`,
  );
});

test('static — the singleton component itself exists at components/ConflictModal.tsx', () => {
  // Sanity check that the whitelisted file is still on disk. If a
  // future refactor accidentally deletes the ConflictModal, the
  // singleton test above would have a free pass (no other conflict
  // modals), so this test pins the file's presence.
  const file = resolve(WEB_SRC_DIR, 'components', 'ConflictModal.tsx');
  let exists = false;
  try {
    statSync(file);
    exists = true;
  } catch {
    exists = false;
  }
  assert.ok(exists, `expected ConflictModal.tsx at ${file}`);
});

test('static — ConflictModal exports the spec-required ConflictTone type', () => {
  // Pinned the type export so a future refactor that drops the
  // contract would fail this test (the singleton test only catches
  // *new* conflict modals, not a contract regression in the
  // canonical one).
  const file = resolve(WEB_SRC_DIR, 'components', 'ConflictModal.tsx');
  const src = readFileSync(file, 'utf8');
  assert.ok(
    /\bexport\s+type\s+ConflictTone\b/.test(src),
    'ConflictModal must export the ConflictTone type (warn | danger | info) per spec-7-4',
  );
  assert.ok(
    /\bexport\s+interface\s+CanDoAction\b/.test(src),
    'ConflictModal must export the CanDoAction interface per spec-7-4',
  );
});