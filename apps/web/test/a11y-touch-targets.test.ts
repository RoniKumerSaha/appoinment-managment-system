/**
 * a11y-touch-targets.test.ts — static CSS audit for E7-S5.
 *
 * Per spec-7-5 (FR-WCAG-TOUCH + WCAG 2.5.5 Target Size Level AAA; we
 * ship the AA floor of 40×40): interactive elements on small viewports
 * (max-width 640px) must be at least 40×40 pixels unless they opt out
 * with `.compact`.
 *
 * The codebase applies a global rule in `apps/web/src/styles/shell.css`:
 *
 *   @media (max-width: 640px) {
 *     :where(button, a[role="button"], input, select):not(.compact) {
 *       min-height: 40px;
 *       min-width: 40px;
 *     }
 *   }
 *
 * This test pins that rule exists with the right shape. It does NOT
 * crawl per-component CSS for "min-height: 40px" because the global
 * rule is the canonical place for the floor and per-component
 * overrides are not required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SHELL_CSS = resolve(__dirname, '..', 'src', 'styles', 'shell.css');

test('a11y — shell.css declares a mobile (max-width: 640px) 40×40 touch-target rule', () => {
  const shell = readFileSync(SHELL_CSS, 'utf8');
  // Find the @media (max-width: 640px) block. We don't assume a single
  // one — capture the last block (the spec'd one) and assert.
  const mediaMatches = [
    ...shell.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/g),
  ];
  assert.ok(
    mediaMatches.length > 0,
    'shell.css must contain an `@media (max-width: 640px)` block. ' +
      'Spec-7-5 §5 (FR-WCAG-TOUCH) requires a 40×40 floor on small ' +
      'viewports.',
  );

  // Concatenate all 640px blocks — there may be more than one (e.g.
  // future split-out rules). We assert the union contains the required
  // elements.
  const union = mediaMatches.map((m) => m[1]!).join('\n');

  // The selector must include button, input, select, and the opt-out
  // for `.compact`.
  assert.ok(
    /button/.test(union),
    'mobile touch-target rule must target `button`. Got: ' + union.trim(),
  );
  assert.ok(
    /input/.test(union),
    'mobile touch-target rule must target `input`. Got: ' + union.trim(),
  );
  assert.ok(
    /select/.test(union),
    'mobile touch-target rule must target `select`. Got: ' + union.trim(),
  );
  assert.ok(
    /:not\(\s*\.compact\s*\)/.test(union),
    'mobile touch-target rule must allow the `.compact` opt-out (so ' +
      'dense dashboards like the doctor kanban keep tight targets on ' +
      'purpose). Got: ' + union.trim(),
  );

  // The body must set min-height: 40px AND min-width: 40px.
  assert.ok(
    /min-height\s*:\s*40px/.test(union),
    'mobile touch-target rule must set `min-height: 40px`. Got: ' + union.trim(),
  );
  assert.ok(
    /min-width\s*:\s*40px/.test(union),
    'mobile touch-target rule must set `min-width: 40px`. Got: ' + union.trim(),
  );
});

test('a11y — shell.css honours prefers-reduced-motion', () => {
  const shell = readFileSync(SHELL_CSS, 'utf8');
  const m = shell.match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(
    m,
    'shell.css must contain an `@media (prefers-reduced-motion: reduce)` ' +
      'block. Spec-7-5 §6 (FR-WCAG-MOTION) requires the OS preference ' +
      'to be honoured.',
  );
  const body = m![1]!;
  // Must zero out at least one of: animation-duration, transition-duration.
  const zeroesMotion =
    /animation-duration\s*:\s*0(?:\.0+)?(?:ms|s)?(?:\s*!important)?/.test(body) ||
    /transition-duration\s*:\s*0(?:\.0+)?(?:ms|s)?(?:\s*!important)?/.test(body);
  assert.ok(
    zeroesMotion,
    'prefers-reduced-motion block must zero out animation-duration or ' +
      'transition-duration. Got: ' + body.trim(),
  );
});
