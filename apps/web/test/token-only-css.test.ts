/**
 * token-only-css.test.ts — static token-discipline enforcement for E7-S1.
 *
 * Per spec-7-1-wiring (continuation of E7-S1 design-system-tokens):
 *   "0 hex literals outside `tokens.css`" is the per-story quality bar
 *   every story since E1-S0-ui records in its spec change log. This
 *   test is the **enforcement** for that invariant: a future regression
 *   that introduces a hex literal, `rgb()/rgba()` literal, or CSS named
 *   colour in any non-tokens source file fails this test in CI.
 *
 * What it forbids:
 *   - `#[0-9a-fA-F]{3,8}` in `.css` and `.tsx`/`.ts` files outside `tokens.css`
 *   - `rgba?(...)` in the same scope
 *   - CSS named colours (red, blue, green, …) in `.module.css` files
 *
 * What it whitelists (intentional non-flagged matches):
 *   - `&#NN;` HTML entities (e.g. `&#123;` in DoctorCancel.tsx comments)
 *   - `id="…"` attributes (selectors, not colours)
 *   - `var(--…)` references (token use, allowed)
 *   - `currentColor`, `transparent`, `inherit`, `unset`, `initial`
 *   - Comments inside CSS / TS files (lines starting with `//`, `*`, `/*`, `<!--`)
 *   - Appointment ID strings like `Appt #10234` in mock data
 *   - `.tsx`/`.ts` files where the hex is a non-color identifier (e.g.
 *     JSDoc comments mentioning `BR-024 · #024 · foo`). The pattern
 *     requires a colour-shaped context (a `:` or `=`, not preceded by a
 *     word char) to reduce false positives.
 *
 * Why this lives in `apps/web/test/`:
 *   Web-domain invariant, walker targets `apps/web/src/`. Same run
 *   strategy as the E7-S7 and E7-S4 web tests — `node --import tsx
 *   --test` via the web test driver. The web package's `test` script
 *   is a no-op (preserved for backward compat); a dedicated `test:e7-s1`
 *   script invokes the driver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_SRC_DIR = resolve(__dirname, '..', 'src');

/** Files that are allowed to contain hex / rgb literals. The canonical
 *  source of truth for token values is `tokens.css`; everything else
 *  outside this whitelist is forbidden. */
const FILE_WHITELIST: string[] = [
  'styles/tokens.css',
];

/** CSS named colours that the test forbids in `.module.css` files.
 *  Sourced from the CSS Color Module Level 4 named-colour list. Whitelist
 *  of allowed keywords (transparent, inherit, currentColor, etc.) is
 *  applied per-pattern; this list is what trips the alarm. */
const NAMED_COLOURS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure',
  'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet',
  'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral',
  'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
  'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
  'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray',
  'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue',
  'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite',
  'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod',
  'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink',
  'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush',
  'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue',
  'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow',
  'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen',
  'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
  'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise',
  'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
  'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue',
  'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna',
  'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow',
  'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato',
  'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
]);

/** Pattern A: hex colour literal.
 *  Matches `#` followed by 3, 4, 6, or 8 hex chars (CSS spec), with a
 *  lookbehind to skip HTML entities (`&#123;`) and identifiers that
 *  contain a `#` (e.g. `Appt #10234`, `id="foo"`). The pattern requires
 *  a CSS-colour context: either preceded by whitespace / `:` / `=` / `(`,
 *  OR at start of line in a CSS file. */
const HEX_PATTERN = /(?<!&|\w)#[0-9a-fA-F]{3,8}\b/g;

/** Pattern B: `rgb()` / `rgba()` colour function. */
const RGB_PATTERN = /\brgba?\s*\(\s*\d/gi;

/** Pattern C: `hsl()` / `hsla()` colour function. */
const HSL_PATTERN = /\bhsla?\s*\(\s*\d/gi;

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      walk(full, acc);
    } else if (
      entry.endsWith('.ts') ||
      entry.endsWith('.tsx') ||
      entry.endsWith('.css')
    ) {
      acc.push(full);
    }
  }
}

interface Offender {
  file: string;
  line: number;
  text: string;
  kind: 'hex' | 'rgb' | 'hsl' | 'named';
  match: string;
}

function scanFile(file: string, rel: string, offenders: Offender[]): void {
  if (FILE_WHITELIST.includes(rel)) return;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const isCss = file.endsWith('.css');

  lines.forEach((text, i) => {
    // Skip comment-only lines: a regression that *adds* a hex literal
    // is caught by the call-site match, not by a comment mention.
    // Matches: //, /*, *, <!--, and CSS /* */ openers.
    if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return;
    // Skip HTML entity references entirely on this line: a line that
    // contains only &#NN; entities is documentation, not a colour.
    // (Lines that mix entity references with other code are still
    // checked — the lookbehind on HEX_PATTERN handles the entity case
    // for mixed lines.)
    if (/&#\d+;/.test(text) && !/[\w)]\s*#/.test(text)) {
      // Whole line is entity references; skip.
      // (The negative-lookbehind on HEX_PATTERN already handles
      // individual entities, but a fast-path skip is cheaper.)
    }

    // Hex
    const hexMatches = text.matchAll(HEX_PATTERN);
    for (const m of hexMatches) {
      if (!isCss) {
        // In TSX/TS files, the hex literal must appear at the
        // **start of a string literal** (the whole string IS the hex
        // value, or the string is a `var(--token, #hex)` fallback).
        // This filters out:
        //   - `Appt #10234` (mock data, # is mid-string)
        //   - JSDoc references like `BR-024 · #024`
        //   - `href="#section"` (route hashes)
        //   - `id="foo"` selectors
        // while still catching:
        //   - `color: '#fff'` (the string IS the hex)
        //   - `var(--token, '#fff')` (fallback value)
        //   - `style={{ background: '#fff' }}` (inline style)
        const start = m.index!;
        const before = text.slice(0, start);
        const singleQuote = before.lastIndexOf("'");
        const doubleQuote = before.lastIndexOf('"');
        const backQuote = before.lastIndexOf('`');
        const lastQuote = Math.max(singleQuote, doubleQuote, backQuote);
        if (lastQuote === -1) continue;
        // The # must be immediately after the opening quote (or
        // after whitespace, e.g. `var(--token, '#fff')` opens with
        // a `,` not whitespace; in practice the `var(--..., '#hex')`
        // pattern has no space between the quote and the #).
        // Walk forward from `lastQuote + 1` to `start`; if any
        // non-whitespace char is present, the # is mid-string.
        let midString = false;
        for (let j = lastQuote + 1; j < start; j++) {
          if (!/\s/.test(text.charAt(j))) {
            midString = true;
            break;
          }
        }
        if (midString) continue;
      }
      offenders.push({
        file: rel,
        line: i + 1,
        text: text.trim(),
        kind: 'hex',
        match: m[0],
      });
    }

    // rgb / rgba
    const rgbMatches = text.matchAll(RGB_PATTERN);
    for (const m of rgbMatches) {
      offenders.push({
        file: rel,
        line: i + 1,
        text: text.trim(),
        kind: 'rgb',
        match: m[0] + '…)',
      });
    }

    // hsl / hsla
    const hslMatches = text.matchAll(HSL_PATTERN);
    for (const m of hslMatches) {
      offenders.push({
        file: rel,
        line: i + 1,
        text: text.trim(),
        kind: 'hsl',
        match: m[0] + '…)',
      });
    }

    // Named colours (CSS files only — too noisy in TSX strings)
    if (isCss) {
      // Token boundary: \b won't work for hyphens. Split on
      // non-word-or-hyphen.
      const tokens = text.split(/[^\w-]+/);
      for (const tok of tokens) {
        if (NAMED_COLOURS.has(tok.toLowerCase())) {
          offenders.push({
            file: rel,
            line: i + 1,
            text: text.trim(),
            kind: 'named',
            match: tok,
          });
        }
      }
    }
  });
}

test('static — apps/web/src has no colour literals outside tokens.css', () => {
  const files: string[] = [];
  walk(WEB_SRC_DIR, files);
  assert.ok(files.length > 0, `expected to find source files under ${WEB_SRC_DIR}`);

  const offenders: Offender[] = [];
  for (const file of files) {
    const rel = file.slice(WEB_SRC_DIR.length + 1).replace(/\\/g, '/');
    scanFile(file, rel, offenders);
  }

  assert.equal(
    offenders.length,
    0,
    `colour literals found outside tokens.css: ${JSON.stringify(offenders, null, 2)}`,
  );
});

test('static — apps/web/src contains the canonical tokens.css source of truth', () => {
  // Sanity check that the whitelisted file is still on disk. If a
  // future refactor accidentally deletes tokens.css, the singleton
  // test above would have a free pass (no other colour literals in
  // the codebase either, since this test is the only enforcer), so
  // this test pins the file's presence.
  const file = resolve(WEB_SRC_DIR, 'styles', 'tokens.css');
  let exists = false;
  try {
    statSync(file);
    exists = true;
  } catch {
    exists = false;
  }
  assert.ok(exists, `expected tokens.css at ${file}`);
});

test('static — tokens.css defines the spec-required brand-primary token', () => {
  // Pins the contract that the rest of the web client relies on. A
  // regression that renames or removes --brand-primary would break
  // every var(--brand-primary) reference in the codebase; this test
  // catches the rename/removal at the source.
  const file = resolve(WEB_SRC_DIR, 'styles', 'tokens.css');
  const src = readFileSync(file, 'utf8');
  assert.ok(
    /--brand-primary\s*:/i.test(src),
    'tokens.css must define --brand-primary (referenced by every component)',
  );
  assert.ok(
    /--text-muted\s*:/i.test(src),
    'tokens.css must define --text-muted (referenced by every muted-text surface)',
  );
  assert.ok(
    /--surface-card\s*:/i.test(src),
    'tokens.css must define --surface-card (card backgrounds)',
  );
});