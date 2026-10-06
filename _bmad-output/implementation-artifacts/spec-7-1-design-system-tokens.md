---
id: spec-7-1-design-system-tokens
title: E7-S1 — Design-system token discipline audit
epic: epic-7
review_loop_iteration: 0
created: 2026-10-06
last_updated: 2026-10-06
status: done
---

# E7-S1 — Design-system token discipline audit

## Intent

The E7-S1 invariant is the rule that **every visual value in
`apps/web/src` references a CSS variable from `tokens.css`**.
This is enforced because:

- Token-only CSS is the only way to theme the app consistently
  (white-label, multi-clinic, dark-mode reserved tokens, etc.).
- It centralizes the design contract — change a token once, every
  component picks it up.
- It guards against the drift that happens when one page hardcodes
  `#f9fafb` and another uses `#f5f6f8` for "the same" surface
  colour.

This spec is the audit pass that closes E7-S1. Before this
audit, the codebase had a few stragglers (one JSDoc comment +
several inline-style marginTop values in `PatientBooking.tsx`).
The audit:

1. **Closes the JSDoc straggler** — `AdminDoctorSchedule.tsx`
   referenced `#f9fafb` in a comment. Replaced with
   `var(--surface-soft)`.
2. **Closes the inline-style stragglers** — `PatientBooking.tsx`
   had 5 inline `marginTop` pixel values. Replaced with the
   matching `var(--space-N)` tokens.

## Approach

### 1. Audit

Grep across `apps/web/src` for:

- `#[0-9a-fA-F]{3,8}` — hex colour literals.
- `rgba?(?:...)` — `rgb()` / `rgba()` literals.
- Colour names: `red`, `blue`, `green`, `black`, `white`, etc.
- Inline `style={{ ... }}` with raw numbers.

The audit is automated in the verification section.

### 2. Fix the stragglers

**File:** `apps/web/src/pages/AdminDoctorSchedule.tsx` (EDIT).

```diff
- *   - Left "form-col" (#f9fafb surface-soft background):
+ *   - Left "form-col" (var(--surface-soft) background):
```

**File:** `apps/web/src/pages/PatientBooking.tsx` (EDIT).

Replace five `style={{ marginTop: N }}` with `style={{ marginTop:
'var(--space-N)' }}` (24 → 10, 14 → 6, 16 → 7).

### 3. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  `7-1-design-system-tokens: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/pages/AdminDoctorSchedule.tsx` | EDIT | Replace `#f9fafb` in JSDoc with `var(--surface-soft)` |
| `apps/web/src/pages/PatientBooking.tsx` | EDIT | Replace 5 inline `marginTop` pixel values with `var(--space-N)` |
| `_bmad-output/implementation-artifacts/spec-7-1-design-system-tokens.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Grep | Expected count | Notes |
|------|----------------|-------|
| `#[0-9a-fA-F]{3,8}` outside `tokens.css` | 0 | (excl. `&#123;` HTML entity escapes in JSX) |
| `rgba?\(...\)` outside `tokens.css` | 0 | |
| Colour names (`red`, `blue`, etc.) | 0 | only `transparent` and `inherit` are allowed (semantic keywords) |
| Inline `style={{` with raw numbers | 0 | only `auto`, `inherit`, `none`, `100vh`, `100%` allowed |

## Verification

1. `pnpm --filter @clinic/web typecheck` — 0 new errors.
2. `pnpm --filter @clinic/web lint` — 0 new errors.
3. Manual grep:
   ```bash
   rg '#[0-9a-fA-F]{3,8}' apps/web/src
   # Should only show matches in apps/web/src/styles/tokens.css
   # (and HTML entity escapes in JSX, e.g. DoctorCancel.tsx
   # has `&#123;` which is an HTML entity, not a colour).
   ```
4. Visual regression: render ClinicSettings, PatientBooking,
   AdminDoctorSchedule side-by-side with the previous build.
   No layout shifts expected (the token values match the
   pixel-for-pixel values that were inline).

## Out of scope (deferred to later stories)

- **D-E7-S-1** — A linter rule (e.g. `stylelint-no-hex-outside-design-tokens`)
  that fails the build when a hex literal appears outside
  `tokens.css`. Today the discipline is enforced by code-review;
  a hardening pass adds the rule.
- **D-E7-S-2** — A linter rule that fails the build when an
  inline-style `marginTop`/`padding`/`width` value isn't a
  `var(--…)` token. Same status — code-review today, linter
  later.
- **D-E7-S-3** — Token coverage audit. The spacing tokens
  cover 4px → 32px. Pixel values outside this range (e.g. 1.5px
  borders, 1px hairlines) are still allowed as raw numbers
  because they don't fit the 4px grid; the spec might decide to
  add `--hairline: 1px` and `--thin-border: 1.5px` tokens in a
  later pass.
- **D-E7-S-4** — The 2 pre-existing `react/no-unescaped-entities`
  errors on ClinicSettings.tsx are baseline and unrelated to
  E7-S1. They get fixed in a future linter-cleanup pass.

## Cross-references

- `apps/web/src/styles/tokens.css` — single source of truth
- `docs/design/DESIGN-SYSTEM.md` §2-6 — token reference
- `_bmad-output/implementation-artifacts/spec-1-0-ui-clinic-settings.md`
  — original E7-S1 invariant statement
- `_bmad-output/implementation-artifacts/spec-7-2-ui-audit-drawers.md`
  — sibling E7 story that consumed the tokens