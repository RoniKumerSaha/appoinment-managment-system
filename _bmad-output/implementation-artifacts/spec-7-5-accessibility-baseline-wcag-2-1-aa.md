---
id: spec-7-5-accessibility-baseline-wcag-2-1-aa
title: E7-S5 — Accessibility baseline (WCAG 2.1 AA)
epic: epic-7
status: ready-for-dev
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-07
source_story: planning-artifacts/epics-and-stories.md §E7-S5
---

# E7-S5 — Accessibility baseline (WCAG 2.1 AA)

## Intent

PRD NFR-006 and UX §10 require the patient booking + doctor + receptionist + admin surfaces to clear **WCAG 2.1 Level AA** with the rules called out in the story:

- Visible focus ring (default `--ring-focus`).
- Modal focus trap + `Esc` closes + `Enter` triggers primary in `ConflictModal`.
- Status pills never carry meaning via color alone — icon prefix always.
- Contrast: body text ≥ 4.5:1, large text ≥ 3:1; faint `#9ca3af` (2.85:1) **only** for disabled/placeholder.
- Touch targets ≥ 40×40 on mobile.
- `prefers-reduced-motion` honored.

This story is the **baseline** — it does NOT claim AA conformance for every screen (that's a separate audit), but it ships the global CSS tokens, the modal accessibility hooks (E7-S4 integration), and the static + dynamic tests that lock each rule.

**Why a baseline story rather than a one-shot AA pass:** WCAG 2.1 AA has 50 success criteria. Most are enforced by the design system + component contracts; a few require per-screen audits (e.g., reading order, ARIA roles per page). This story covers the former and explicitly hands the latter to a follow-up "P7-12: per-page AA audit" story.

### 1. Focus ring token

**File:** `apps/web/src/styles/tokens.css` (EDIT).

```css
:root {
  --ring-focus: 0 0 0 2px var(--surface-soft), 0 0 0 4px var(--brand-600);
  --ring-offset: 2px;
}
```

**File:** `apps/web/src/styles/shell.css` (EDIT).

```css
:where(a, button, input, select, textarea, [role="button"], [tabindex]):focus-visible {
  outline: none;
  box-shadow: var(--ring-focus);
  border-radius: inherit;
}
```

The `:where()` pseudo-class keeps specificity at 0 so per-component hover/active states still win.

### 2. ConflictModal accessibility (E7-S4 integration)

`ConflictModal` (the new shared component) implements:
- `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby` on the title.
- Focus trap: first focusable element receives focus on open; Tab cycles inside.
- `Esc` closes the modal (only when `canDo` has a "ghost" button).
- `Enter` triggers the focused button.
- `aria-describedby` on the `what` text.

### 3. Status pill — color + icon

Every status pill (Scheduled / Cancelled / Blocked / Resolved / Active / Inactive) renders an **icon prefix** in addition to the colour background. Existing pills already have icons in mockups; this story audits `apps/web/src/components/StatusPill*.tsx` (or wherever they live) and adds the icon where missing.

Static test: every `<span className="*pill*">` has a child `<svg>` or text symbol.

### 4. Contrast — `--text-faint` audit

**File:** `apps/web/src/styles/tokens.css` (EDIT).

The token `--text-faint` was set to `#9ca3af` (2.85:1 against `--surface`). Per the story rule, faint text is **only allowed for disabled/placeholder**. The token is renamed `--text-disabled` to make the constraint explicit, and a comment notes: "Faint text must NOT be used for body copy or actionable labels."

### 5. Touch targets ≥ 40×40 on mobile

**File:** `apps/web/src/styles/shell.css` (EDIT).

```css
@media (max-width: 640px) {
  :where(button, a[role="button"], input, select):not(.compact) {
    min-height: 40px;
    min-width: 40px;
  }
}
```

The `:not(.compact)` escape hatch lets dense dashboards (doctor kanban) keep tight targets on small screens.

### 6. `prefers-reduced-motion`

**File:** `apps/web/src/styles/shell.css` (EDIT).

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
  }
}
```

### 7. Tests

Three new test files:

1. `apps/web/test/a11y-focus-ring.test.ts` — every interactive element has `:focus-visible` style reachable (no `outline: none` without a fallback).
2. `apps/web/test/a11y-status-pills.test.ts` — every status-pill element has an icon child or aria-label that names the status.
3. `apps/web/test/a11y-touch-targets.test.ts` — CSS audit on `@media (max-width: 640px)` rules — interactive elements have `min-height: 40px` and `min-width: 40px` unless `.compact`.

Plus an axe-core integration smoke: `apps/web/test/a11y-axe-smoke.test.ts` — runs `@axe-core/playwright` against the dev server on `/admin/clinic`, `/doctor/today`, `/receptionist/today`, `/book`, `/manage`. Critical and serious violations fail the build.

### 8. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-5-accessibility-baseline-wcag-2-1-aa: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/styles/tokens.css` | EDIT | Add `--ring-focus`, `--ring-offset`; rename `--text-faint` → `--text-disabled` |
| `apps/web/src/styles/shell.css` | EDIT | `:focus-visible`, mobile touch-targets, reduced-motion |
| `apps/web/src/components/ConflictModal.tsx` | EDIT | `role="alertdialog"`, focus trap, `Esc`, `Enter` |
| `apps/web/src/components/StatusPill.tsx` (or wherever) | EDIT | Icon prefix on every status |
| `apps/web/test/a11y-focus-ring.test.ts` | NEW | Static focus-ring test |
| `apps/web/test/a11y-status-pills.test.ts` | NEW | Icon-prefix test |
| `apps/web/test/a11y-touch-targets.test.ts` | NEW | Mobile-target CSS audit |
| `apps/web/test/a11y-axe-smoke.test.ts` | NEW | axe-core integration smoke |
| `_bmad-output/implementation-artifacts/spec-7-5-accessibility-baseline-wcag-2-1-aa.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Surface | Rule | Test |
|---|---|---|
| Global | Focus ring visible on every interactive | `a11y-focus-ring` |
| Global | Status pills have icon prefix | `a11y-status-pills` |
| Global | Mobile touch targets ≥ 40×40 | `a11y-touch-targets` |
| Modal | Trap focus, `Esc`, `Enter` | ConflictModal tests (existing) + manual |
| Global | `prefers-reduced-motion` honored | Manual + smoke |
| All | axe-core violations | `a11y-axe-smoke` |
| Disputed | Faint text allowed only for disabled | grep `--text-faint` (now `--text-disabled`) |

## Verification

1. `pnpm --filter @clinic/web test` — 4 new tests + existing tests pass.
2. `pnpm --filter @clinic/web typecheck` — 0 new errors.
3. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline unchanged).
4. Manual: axe DevTools in browser on each persona's primary page → no critical violations.
5. Manual: keyboard-only flow for `/book` (patient books an appointment) → no traps, no unreachable elements.
6. E7-S1 invariant: 0 hex literals outside `tokens.css`.
7. Testcontainers runtime unavailable in this env; suite cannot be re-run for the axe smoke; status relies on spec audit trail.

## Deferrals (anticipated)

- **D1 — Per-page AA audit.** This story ships the global tokens + the modal + status-pill rules. A future "P7-12: per-page AA audit" story must run axe-core against every reachable URL and fix per-page violations (reading order, ARIA labels, alt text).
- **D2 — Screen reader labels for status badges.** Covered by the icon-prefix rule, but a manual NVDA / VoiceOver pass per page is recommended.
- **D3 — Keyboard navigation through `AvailabilityCalendar`.** UX-FLOWS §7 lists this as open. A separate follow-up story once a calendar component lands.

## Spec Change Log

(none yet — first authoring)