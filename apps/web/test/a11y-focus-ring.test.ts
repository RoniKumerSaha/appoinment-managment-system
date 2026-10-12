/**
 * a11y-focus-ring.test.ts — static CSS audit for E7-S5.
 *
 * Per spec-7-5 (FR-WCAG-FOCUS): every interactive element must show a
 * visible focus ring when focused via keyboard. The codebase applies a
 * global `:focus-visible` rule in `apps/web/src/styles/shell.css`; this
 * test pins that:
 *
 *   1. The global rule exists in `shell.css` and targets the right
 *      selector (a, button, input, select, textarea, [role="button"],
 *      [tabindex]).
 *   2. No CSS rule elsewhere disables the outline (`outline: none` or
 *      `outline: 0`) on an interactive element without supplying a
 *      focus-replacement (`box-shadow: var(--ring-focus)` or
 *      `box-shadow: var(--ring-*)` or an explicit `outline: <color>`).
 *
 * The second check catches the classic a11y regression where a stylesheet
 * says `button { outline: none }` and forgets to add a focus ring. The
 * global rule above still wins because `:focus-visible` is the more
 * specific state, but per-component focus rules need to exist for
 * `:hover` to not double-up; this test enforces a discipline: if you
 * remove the outline, you must add a focus ring of some kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = resolve(__dirname, '..');
const SHELL_CSS = resolve(WEB_ROOT, 'src', 'styles', 'shell.css');

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      walk(full, acc);
    } else if (entry.endsWith('.css')) {
      acc.push(full);
    }
  }
}

const CSS_FILES: string[] = [];
walk(resolve(WEB_ROOT, 'src'), CSS_FILES);

test('a11y — shell.css declares a global :focus-visible ring', () => {
  const shell = readFileSync(SHELL_CSS, 'utf8');
  // The global rule from spec-7-5 §1 uses :where() to keep specificity
  // at 0. The selector must include button, a, input, select, textarea.
  const re = /:where\(\s*([^)]+)\s*\)\s*:\s*focus-visible\s*\{([\s\S]*?)\}/;
  const m = shell.match(re);
  assert.ok(
    m,
    'shell.css must contain a `:where(...):focus-visible { ... }` rule. ' +
      'Spec-7-5 §1 (FR-WCAG-FOCUS) requires a global focus ring.',
  );
  const selector = m![1]!;
  for (const required of ['button', 'input', 'select', 'textarea', 'a']) {
    assert.ok(
      selector.includes(required),
      `global focus-visible rule must target "${required}". ` +
        `Found selector: ${selector.trim()}`,
    );
  }
  const body = m![2]!;
  assert.ok(
    /box-shadow\s*:\s*var\(\s*--ring-focus\s*\)/.test(body) ||
      /box-shadow\s*:\s*var\(\s*--ring-/.test(body),
    'global focus-visible rule must apply `box-shadow: var(--ring-focus)` ' +
      'or another ring token. Got: ' + body.trim(),
  );
});

test('a11y — no CSS file removes an outline without a focus-replacement', () => {
  // The discipline: `outline: none` / `outline: 0` on an interactive
  // selector (button, a, input, select, textarea, [role="button"],
  // [tabindex]) is a regression unless the same rule block also sets
  // a focus ring (box-shadow: var(--ring-*) or an explicit outline
  // colour).
  //
  // We scan each CSS file in isolation, splitting on `}` to get rule
  // blocks. For each block whose selector mentions an interactive
  // element, we look for outline-removal and assert a focus-replacement
  // is present in the same block.
  const offenders: { file: string; selector: string; text: string }[] = [];

  const INTERACTIVE_RE =
    /(?:^|[\s,])(?:button|a|input|select|textarea|\[role=["']button["']\]|\[tabindex\])(?=[\s,:.\[]|$)/;

  for (const file of CSS_FILES) {
    const rel = file.slice(WEB_ROOT.length + 1).replace(/\\/g, '/');
    if (rel.endsWith('tokens.css')) continue; // tokens.css is the single source of colour truth
    const css = readFileSync(file, 'utf8');
    // Strip /* ... */ comments so the regex below doesn't false-match
    // prose that mentions "outline: none" in a comment.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = stripped.split('}');
    for (const block of blocks) {
      const [selectorRaw, bodyRaw] = block.split('{');
      if (bodyRaw === undefined) continue; // dangling or empty
      const selector = selectorRaw.trim();
      if (!selector) continue;
      // Ignore `:where(...)` and `:is(...)` global resets (e.g. the
      // global :focus-visible rule itself).
      if (/^\s*:where\s*\(/.test(selector)) continue;
      if (!INTERACTIVE_RE.test(selector)) continue;
      const body = bodyRaw;
      const removesOutline = /outline\s*:\s*(?:none|0|0px)\b/.test(body);
      if (!removesOutline) continue;
      const hasFocusReplacement =
        /box-shadow\s*:\s*var\(\s*--ring-/.test(body) ||
        /outline\s*:\s*(?!none|0\b)[^\s;]+/.test(body) ||
        /outline-color\s*:/.test(body) ||
        /outline-offset\s*:/.test(body);
      if (!hasFocusReplacement) {
        offenders.push({
          file: rel,
          selector: selector.split('\n').join(' '),
          text: body.split('\n').map((l) => l.trim()).filter(Boolean).join(' '),
        });
      }
    }
  }

  assert.equal(
    offenders.length,
    0,
    'CSS rules remove an outline without a focus-replacement (a11y ' +
      'regression). Either remove the `outline: none` or add ' +
      '`box-shadow: var(--ring-focus)`. ' +
      JSON.stringify(offenders, null, 2),
  );
});
