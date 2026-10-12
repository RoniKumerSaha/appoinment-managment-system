/**
 * a11y-status-pills.test.ts — static, file-walking test for E7-S5.
 *
 * Per spec-7-5 (FR-WCAG-COLOR + WCAG 1.4.1): a status pill may not
 * convey meaning via colour alone. Every pill in the rendered DOM must
 * carry an icon prefix (Unicode glyph or <svg>) OR an aria-label that
 * names the status.
 *
 * Strategy:
 *   Walk every `.tsx`/`.ts` file under `apps/web/src`. For each line
 *   that contains a pill-bearing className (a CSS-module class whose
 *   name includes "pill"), look at the next 3–6 lines for the
 *   element's text children and assert that those children include a
 *   non-ASCII glyph (the icon prefix) OR a nested <svg>.
 *
 *   We also accept `aria-label` on the open tag as a substitute for
 *   the glyph.
 *
 * The heuristic is intentionally simple: a status pill in this
 * codebase is a small <span> with text like "● Active" or an
 * <svg> + "Active". Looking at the next 4 lines after the className
 * line catches both the inline-text and the svg-prefix shapes. A
 * future regression that strips the prefix surfaces as a missing
 * glyph on the children lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_SRC_DIR = resolve(__dirname, '..', 'src');

/** Files whose content is allowed to mention "pill" without carrying
 *  a glyph. Today: this test file itself. */
const FILE_WHITELIST: string[] = [
  'test/a11y-status-pills.test.ts', // this file
];

/** Match a line that contains a CSS-module class with "pill" in its
 *  name. We accept both `styles['pill']` and `styles['pill--xxx']`
 *  plus inline-string forms. The captured group is the pill class. */
const PILL_LINE_RE =
  /styles?\[\s*['"]([^'"]*pill[^'"]*)['"]\s*\]/i;
const ARIA_LABEL_RE = /aria-label\s*=\s*['"`][^'"`]+['"`]/;
/** Unicode glyph prefix: any non-ASCII character. Covers ●, ○, ✓,
 *  ✕, ⊘, +, ·, 📍, 🔴, 🟡, 🟢 etc. */
const GLYPH_REGEX = /[^\x00-\x7F]/;
/** Self-closing svg (or svg with content) — pill's nested svg icon. */
const SVG_RE = /<svg[\s>]/i;

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      walk(full, acc);
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
}

interface PillMatch {
  file: string;
  line: number;
  className: string;
  /** The 6 lines after the className, joined. */
  window: string;
  hasGlyph: boolean;
  hasSvg: boolean;
  hasAriaLabel: boolean;
}

function findPillMatches(text: string, rel: string): PillMatch[] {
  const out: PillMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!PILL_LINE_RE.test(line)) continue;
    const m = PILL_LINE_RE.exec(line)!;
    const className = m[1]!;
    // Non-status pills (navigation chips, doctor info cards, avatars)
    // are exempted from the glyph rule — they communicate identity,
    // not state. Status pills always carry a `--modifier` variant
    // (pill--active, pill--inactive, pill--cancelled, etc.) or are
    // the bare `pill` class used inside status lists.
    if (
      className === 'nav__pill' ||
      className.startsWith('doctor-pill') ||
      className === 'returning-pill' ||
      className === 'target-pill' ||
      className === 'type-lock-pill' ||
      className === 'role-pill' ||
      className === 'branch-pill'
    ) {
      continue;
    }
    // Window: the className line itself plus 6 lines after. Covers
    // both the inline-children shape (children on the same line as
    // the open tag) and the multiline-children shape (children on
    // a dedicated line between the open and close tags).
    const windowLines = [line, ...lines.slice(i + 1, i + 7)].join('\n');
    out.push({
      file: rel,
      line: i + 1,
      className,
      window: windowLines,
      hasGlyph: GLYPH_REGEX.test(windowLines),
      hasSvg: SVG_RE.test(windowLines),
      hasAriaLabel: ARIA_LABEL_RE.test(windowLines),
    });
  }
  return out;
}

test('a11y — every status pill has a glyph prefix, <svg>, or aria-label', () => {
  const files: string[] = [];
  walk(WEB_SRC_DIR, files);
  assert.ok(files.length > 0, `expected source files under ${WEB_SRC_DIR}`);

  const allMatches: PillMatch[] = [];
  for (const file of files) {
    const rel = file.slice(WEB_SRC_DIR.length + 1).replace(/\\/g, '/');
    if (FILE_WHITELIST.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    const matches = findPillMatches(text, rel);
    allMatches.push(...matches);
  }

  // Filter to just status pills (CSS classes that look like status
  // indicators: pill--active, pill--inactive, pill--moved, pill--
  // cancelled, etc.). Pure "pill" is a base class; pill--xxx is a
  // variant. We want both to satisfy the rule, but a class name
  // containing "pill" but used in non-status contexts (e.g. CSS class
  // names in comments) shouldn't trigger the rule.
  //
  // Heuristic: keep matches whose className contains 'pill' (base) OR
  // 'pill--' (variant). The window check then determines if the
  // status pill is glyph-bearing.

  const offenders = allMatches.filter(
    (m) => !(m.hasGlyph || m.hasSvg || m.hasAriaLabel),
  );

  const report = offenders.map((o) => ({
    file: o.file,
    line: o.line,
    className: o.className,
    window: o.window.split('\n').map((l) => l.trim()).filter(Boolean).join(' | ').slice(0, 200),
  }));

  assert.equal(
    offenders.length,
    0,
    'Pills without a glyph prefix, <svg>, or aria-label violate WCAG ' +
      '1.4.1 (use of colour). Add a Unicode glyph (●○✓✕⊘) or a nested ' +
      '<svg aria-hidden="true"> prefix. ' +
      JSON.stringify(report, null, 2),
  );
});

