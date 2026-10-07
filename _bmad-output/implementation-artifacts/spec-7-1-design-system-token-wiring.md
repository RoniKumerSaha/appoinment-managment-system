---
id: spec-7-1-design-system-token-wiring
title: E7-S1 wiring — Token-only CSS enforcement in new module paths
epic: epic-7
status: ready-for-dev
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-07
source_story: planning-artifacts/epics-and-stories.md §E7-S1 (continuation)
---

# E7-S1 wiring — Token-only CSS enforcement in new module paths

## Intent

E7-S1 (`7-1-design-system-tokens`) is **done** — the design-system tokens are in `apps/web/src/styles/tokens.css`, the audit pass ran, and 0 hex literals live outside `tokens.css` today. This is the **continuation story** that closes the gap between "tokens are wired" and "tokens are wired *everywhere they need to be*".

A duplicate `7-1-design-system-token-wiring` key exists in `sprint-status.yaml` as `backlog` and is almost certainly a stale entry. This spec reconciles that and gives the story concrete scope.

### 1. What E7-S1 already covered

- 8 token groups defined in `tokens.css` per `docs/design/DESIGN-SYSTEM.md` §2–6.
- The 1 straggler JSDoc comment + 5 inline `marginTop` pixel values fixed.
- Token-only-CSS invariant established as a per-story quality bar (every story since E1-S0-ui records "0 hex literals outside `tokens.css`" in the spec change log).

### 2. What this continuation story adds

Three "wiring" gaps exist that weren't covered by the audit because they didn't exist yet when E7-S1 ran:

1. **E1-S0-ui-router** (W59) introduced a new `AdminAuditPage` and rewired navigation via `<Link>` + `usePathRoute`. The CSS audit on the new files passed, but a static test that **enforces the invariant going forward** doesn't exist yet.
2. **Mockup 39 (recurring back-out)**, **mockup 41 (phone country picker)**, and **mockup 42 (admin branch deactivate danger)** landed in v1 but the web ports haven't happened yet. When they do, they'll need a pre-commit / pre-push hook that fails the build if a hex literal sneaks in.
3. **`DoctorCancel.tsx`** and **`PatientBooking.tsx`** had the `&#123;` HTML entity escape; those are not colours, but a future contributor might mistake them for one and try to "fix" them. The static test must whitelist these (or pattern-match `&#` and skip).

### 3. Static enforcement

**File:** `apps/web/test/token-only-css.test.ts` (NEW).

A node-only test that:
1. Walks `apps/web/src/**/*.css` and `apps/web/src/**/*.tsx` files.
2. For each non-`tokens.css` file, scans for:
   - `#[0-9a-fA-F]{3,8}\b` — hex literals (with `(?<![&\w])` lookbehind to skip HTML entities and `id="…"` selectors).
   - `rgba?\(\d` — `rgb()` / `rgba()` literals.
   - CSS named colors (`red`, `blue`, `green`, `black`, `white`, etc.) inside `style` attributes or `.module.css` files. Whitelist `transparent` and `inherit`.
3. Asserts 0 matches.
4. On failure, prints file + line + the offending token.

**File:** `.githooks/pre-commit` (NEW) + `.husky/pre-commit` if Husky is already used.

Wires the test to pre-commit; if any staged file fails the audit, the commit is blocked.

### 4. `whitelist` audit

The test must allow:

| Pattern | Reason |
|---|---|
| `&#NN;` HTML entities | Not colours |
| `id="…"` attributes | Selector, not colour |
| `var(--…)` references | Token use, allowed |
| `currentColor` keyword | Semantic, allowed |
| `transparent`, `inherit`, `unset`, `initial` | CSS keywords |

### 5. CI integration

**File:** `package.json` (EDIT).

Add `test:tokens` script. CI workflow (`.github/workflows/web-lint.yml` or equivalent) runs the test on every push to main. Failing the test fails the build.

### 6. Reconciliation with the duplicate `7-1` backlog key

`sprint-status.yaml` line 1909 lists `7-1-design-system-token-wiring: backlog`. The done `7-1-design-system-tokens` (line 2018) is the canonical story. This spec is the **wiring continuation** that resolves the duplicate: when this story ships, the `token-wiring` key moves to `done` and the duplicate is resolved.

Recommended reconciliation edit to `sprint-status.yaml`:
- Line 1909: change `7-1-design-system-token-wiring: backlog` to a comment explaining the relationship:
  ```yaml
  # 7-1-design-system-token-wiring is a continuation of 7-1-design-system-tokens (done).
  # Spec: spec-7-1-design-system-token-wiring.md. Resolves the duplicate backlog key.
  7-1-design-system-token-wiring: backlog
  ```
  → On `done` move: `7-1-design-system-token-wiring: done`.

### 7. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-1-design-system-token-wiring: done` (and the duplicate-key comment updated).

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/test/token-only-css.test.ts` | NEW | Static audit test |
| `.githooks/pre-commit` (or Husky equivalent) | NEW | Pre-commit hook wiring |
| `package.json` | EDIT | `test:tokens` script |
| `sprint-status.yaml` | EDIT | Reconcile duplicate `7-1` key |
| `_bmad-output/implementation-artifacts/spec-7-1-design-system-token-wiring.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Scenario | Outcome |
|---|---|
| `git commit` with a `style={{ color: '#fff' }}` | Commit blocked; test points to file + line |
| `git commit` with `var(--surface-soft)` | Passes |
| `git commit` with `&#123;` HTML entity | Passes (whitelist) |
| CI on push to main | Same as pre-commit |
| Future regression: someone adds `red` keyword in `.module.css` | Test fails |

## Verification

1. `pnpm --filter @clinic/web test token-only-css` — green.
2. Introduce a deliberate violation: `style={{ color: '#ff0000' }}` in a test file → test fails with file + line.
3. Revert; test passes again.
4. `pnpm --filter @clinic/web typecheck` — 0 new errors.
5. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline in ClinicSettings.tsx unchanged).
6. Pre-commit hook is wired (manual test on a fork or a deliberate-violation commit).
7. CI workflow on main branch — `test:tokens` step is green.

## Spec Change Log

(none yet — first authoring)