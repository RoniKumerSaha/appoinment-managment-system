# Epic 7 — Backlog Spec Stubs (2026-10-07)

> **Status:** Specs drafted. Not implemented. Awaiting `bmad-build` invocations per story in a session with Bash sandbox access to `uv run _bmad/scripts/render_skill.py`.

## Stories in this batch

Drafted on 2026-10-07 to convert the E7 backlog from "no spec, build when ready" to "spec ready, build in suggested order".

| Sprint key | Title | Spec | Suggested build order |
|---|---|---|---|
| `7-7-no-tentative-client-side-slot-holds` | Static + dynamic test pair forbidding client-side holds; mirrors E2-S4 pattern. | [spec-7-7-no-tentative-client-side-slot-holds.md](spec-7-7-no-tentative-client-side-slot-holds.md) | **1 (lowest risk)** |
| `7-4-conflict-modal-global-component` | Single shared `ConflictModal`; replace two bespoke modals. | [spec-7-4-conflict-modal-global-component.md](spec-7-4-conflict-modal-global-component.md) | **2** |
| `7-1-design-system-token-wiring` | Pre-commit / CI enforcement of token-only CSS; reconciles the duplicate `7-1` backlog key. | [spec-7-1-design-system-token-wiring.md](spec-7-1-design-system-token-wiring.md) | **3** |
| `7-5-accessibility-baseline-wcag-2-1-aa` | Focus ring, modal a11y, status-pill icons, contrast, touch targets, reduced-motion. | [spec-7-5-accessibility-baseline-wcag-2-1-aa.md](spec-7-5-accessibility-baseline-wcag-2-1-aa.md) | **4** |
| `7-8-performance-availability-slas` | k6 load test, chaos test, per-route perf budgets, SLO metrics. | [spec-7-8-performance-availability-slas.md](spec-7-8-performance-availability-slas.md) | **5** |
| `7-9-product-metrics-instrumentation` | 8 missing counters/histograms from PRD §16; dashboard JSON. | [spec-7-9-product-metrics-instrumentation.md](spec-7-9-product-metrics-instrumentation.md) | **6** |
| `7-10-design-open-questions-parking-lot` | `docs/design/open-questions.md` capturing UX-FLOWS §7 items. | [spec-7-10-design-open-questions-parking-lot.md](spec-7-10-design-open-questions-parking-lot.md) | **7 (last)** |

## Why this order

- **7-7 first** — the smallest story, ~15 minutes, mirrors the proven E2-S4 pattern. Gets a quick win in the column.
- **7-4 second** — the UI consolidation lands while the design system is fresh in mind; reuses the new conflict modal in future stories (E3-S1 booking, E4-S2 patient cancel).
- **7-1-wiring third** — the duplicate backlog key is reconciled, the token-only invariant is enforced going forward; every subsequent story benefits.
- **7-5 fourth** — the a11y baseline is a global pass; once landed, every future UI story inherits the rules.
- **7-8 + 7-9** — infra stories. They observe the system, not change user-facing behavior. Land in either order.
- **7-10 last** — a documentation story. Can land at any time; lands last in this batch because every other decision is recorded in the parking lot by then.

## Conventions every spec follows

Each spec is the same shape as recent stories (E7-S1, E7-S2, E6-S2-ui):

1. YAML frontmatter: `id`, `title`, `epic`, `status: ready-for-dev`, `review_loop_iteration: 0`, `created`, `last_updated`, `source_story`.
2. **Intent** — what the story is and why.
3. **Approach** — the concrete change list, file by file.
4. **Files to change** — table with `Path | Kind | What`.
5. **I/O & Edge-Case Matrix** — explicit matrix rows.
6. **Verification** — `pnpm test`, `pnpm typecheck`, `pnpm lint`, plus any test-container-specific notes.
7. **Deferrals (anticipated)** — items the build pass will likely defer, listed upfront so the review pass can confirm.
8. **Spec Change Log** — empty at authoring; filled by the build pass.

## Open blockers the build sessions must resolve

These are intentionally **not** resolved by the spec drafts; they require either a runtime decision or a stakeholder answer:

- **A1 (E7-S5):** Should the staff sign-in card (mockup 21) ship with a "Remember me" toggle? Out of E7-S5 scope but flagged for the W10d follow-up.
- **A2 (E7-S8):** The k6 load-test thresholds (50 VU, 100 iter) — confirm with infra owner. The seeded-data baseline may need to differ from production-scale.
- **A3 (E7-S9):** PRD §16 lists 16 metrics; the spec covers all 16 but the dashboard JSON groups them under 6 panels. Confirm panel layout with the dashboard owner.

## Build pass instructions (for the next session with Bash access)

For each story in suggested order:

1. Run `bmad-build` with the spec stub as the input.
2. The build pass:
   - Reads the spec.
   - Validates the spec against the planning doc (epics-and-stories.md).
   - Generates any additional context (test plans, file-by-file change list).
   - Implements the change.
   - Runs `pnpm test`, `pnpm typecheck`, `pnpm lint`.
   - Reviews the diff (three-lens pass).
   - Updates the spec's Spec Change Log with the actual review patches.
   - Updates `sprint-status.yaml` to mark the story `done`.

3. After all 7 stories land, the Epic 7 retro can run via `bmad-retrospective`.

## What was NOT done in this batch

- **No code was written.** The Bash sandbox blocked `uv run ... render_skill.py`, so the build loop couldn't run. Specs are the highest-value artifact a planning-only session can ship.
- **No tests were run.** Same reason.
- **No `sprint-status.yaml` was edited.** The `7-1` duplicate-key reconciliation is described in the spec but not applied; the build pass that lands `7-1-wiring` will apply it.

The next session (or this session, with Bash unblocked) picks up from `ready-for-dev` for each story in suggested order.