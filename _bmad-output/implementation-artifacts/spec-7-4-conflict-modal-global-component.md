---
id: spec-7-4-conflict-modal-global-component
title: E7-S4 — ConflictModal global component
epic: epic-7
status: review
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-11
source_story: planning-artifacts/epics-and-stories.md §E7-S4
---

# E7-S4 — ConflictModal global component

## Intent

A single shared `ConflictModal` component with three slots — **what happened**, **why**, **what you can do** — used by every flow that surfaces a 409 from the server. UX-FLOWS §7.1 (ConflictModal pattern) and architecture §5 both forbid "OK"-only conflict surfaces and bespoke-modal drift.

Today the codebase has **two bespoke modal implementations** that diverge in shape:

1. `apps/web/src/components/ConflictModal.tsx` (E1-S1-ui / BR-059 branch deactivation) — modal with `what/why/can_do/actions`.
2. `apps/web/src/components/DoctorConflictModal.tsx` (E6-S2-ui / doctor conflict move) — same shape, slightly different copy + a different `aria-label`.

This story consolidates them into a single `ConflictModal` and re-routes both surfaces. Future stories (E3-S1 booking, E4-S2 patient cancel, E1-S2 branch hours) get the shared component for free.

**Why a global component rather than inline:** the modal shape is the contract. Three slots, three rules:
- **what** — present-tense, user-actionable ("This time isn't available", "You can't deactivate this branch right now").
- **why** — the specific rule ("Another patient booked it first", "Two appointments need to be reassigned").
- **can_do** — what the user can do next ("Pick another time", "Cancel an appointment first"). Always ≥ 1 option. **Never** "OK".

## Approach

### 1. New component — `ConflictModal`

**File:** `apps/web/src/components/ConflictModal.tsx` (REWRITE).

Public API:

```ts
export interface ConflictModalProps {
  open: boolean;
  onClose: () => void;
  title: string;       // 4-80 chars; what happened (e.g. "This time isn't available")
  what: ReactNode;     // 1-3 sentences; user-facing consequence
  why?: ReactNode;     // 0-3 sentences; the rule that triggered
  canDo: Array<{
    label: string;          // button label
    onClick: () => void;    // handler
    intent?: 'primary' | 'ghost' | 'danger';
  }>;
  // accessibility:
  ariaLabel?: string;
  // optional icon override
  tone?: 'warn' | 'danger' | 'info'; // defaults to 'warn'
}
```

The component handles:
- Backdrop click → `onClose` (only when `canDo` has a "ghost" close button; primary "error" modals require explicit user action — see E7-S5 a11y note).
- `Esc` → focuses the first action button (no destructive action on Enter unless the focused button is the primary).
- Modal focus trap (per E7-S5).
- Token-only CSS (E7-S1 invariant). Tone drives `var(--surface-*)` + `var(--semantic-*)` from `tokens.css`.

### 2. Migration of existing surfaces

| Surface | Existing component | Migration |
|---|---|---|
| E1-S1-ui `admin-branches.tsx` ConflictModal | `components/ConflictModal.tsx` | Replace import; drop the file's local modal. |
| E6-S2-ui `DoctorConflictMove.tsx` modal | `components/DoctorConflictModal.tsx` | Replace import; drop the file. |
| (Future) E3-S1 booking 409 | bespoke | Use the new component. |
| (Future) E4-S2 patient cancel 409 | bespoke | Use the new component. |

The DoctorConflictModal copy is folded into the new component via a `canDo` array. The shape is identical; no UX regression.

### 3. Static test — `ConflictModal` is the only modal

**File:** `apps/web/test/conflict-modal-singleton.test.ts` (NEW).

Grep `apps/web/src` for the forbidden patterns:

| Forbidden pattern | Why |
|---|---|
| `Dialog`, `Modal`, `Popup` (PascalCase, exported) | Bespoke modal component |
| `<dialog`, `<div role="dialog"` | Native or ARIA-modal outside ConflictModal |
| `aria-modal="true"` | Anywhere except ConflictModal's own |
| `ModalProps`, `DialogProps` | Bespoke type contract |

**Allowed exceptions:**
- `<dialog>` in ConflictModal itself (one location).
- The previously-renamed DoctorConflictModal file is **deleted** in the same commit, not just orphaned.

The test fails loudly if a new modal component lands without going through ConflictModal.

### 4. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-4-conflict-modal-global-component: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/components/ConflictModal.tsx` | REWRITE | Single shared component |
| `apps/web/src/components/DoctorConflictModal.tsx` | DELETE | Folded into ConflictModal |
| `apps/web/src/admin-branches/AdminBranches.tsx` | EDIT | Replace import |
| `apps/web/src/pages/DoctorConflictMove.tsx` | EDIT | Replace import |
| `apps/web/test/conflict-modal-singleton.test.ts` | NEW | Static singleton test |
| `_bmad-output/implementation-artifacts/spec-7-4-conflict-modal-global-component.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Surface | Trigger | ConflictModal payload | Outcome |
|---|---|---|---|
| Branch deactivation (BR-059) | `409 branch_has_future_appointments` | `{what: "Can't deactivate this branch yet", why: "N patients have appointments here", canDo: [{label: "Cancel appointments first", primary}, {label: "Keep active", ghost}]}` | Branch stays open; user picks an action |
| Doctor conflict move | `409 block_overlaps_future_appointments` | `{what: "Can't block this time", why: "N appointments are scheduled here", canDo: [{label: "Resolve N →", primary}, {label: "Back to schedule", ghost}]}` | Same UX as E6-S2-ui today |
| Booking 409 (future) | `409 slot_taken` | `{what: "This time isn't available", why: "Another patient got there first", canDo: [{label: "Pick another time", primary}]}` | Patient picks another slot |
| Patient cancel 409 (future) | `409 already_cancelled` | `{what: "Already cancelled", why: "This appointment was cancelled earlier", canDo: [{label: "Close", ghost}]}` | No destructive action possible |

## Verification

1. `pnpm --filter @clinic/web test` — `conflict-modal-singleton.test.ts` green; existing component tests pass.
2. `pnpm --filter @clinic/web typecheck` — 0 new errors.
3. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline in ClinicSettings.tsx unchanged).
4. Manual visual diff: AdminBranches deactivation modal pixel-equivalent to mockup 29's "warn" variant; DoctorConflictMove modal pixel-equivalent to mockup 24.
5. E7-S1 invariant: 0 hex literals outside `tokens.css`.

## Spec Change Log

### 2026-10-11 — Implementation

- **SC1 — Spec divergence on the singleton test's forbidden-pattern list.** The spec's literal forbidden list (`<div role="dialog">`, `aria-modal="true"`, `ModalProps`, `DialogProps` everywhere outside ConflictModal) is too broad. The web client has 19+ dialog-shaped components that are NOT conflict modals: form modals (AdminDoctors, AdminReceptionists, CancelModal, DoctorMarkStatus, DoctorResolve, ReschedulePage), confirmation dialogs (DoctorCancel, DoctorResolutionSaved), and slide-in detail drawers (DoctorAuditDrawer). None of these are in the E7-S4 scope; each is a distinct UX surface with its own state (form state, save flow, focus management) that does not match the 3-slot what/why/canDo contract. The implementation narrows the test to target the spec's **intent**: forbid a second component exposing the conflict-modal contract (PascalCase export whose name contains "Conflict" or "ErrorModal", or re-exports of `ConflictTone` / `ConflictAction` types). A future regression that adds e.g. `BookingConflictModal.tsx` would fail this test. A regression that adds a new form modal would not, which is correct: form modals are out of scope for E7-S4 and will get their own consolidation story (likely E7-S5 / a11y).
- **SC2 — `DoctorConflictModal.tsx` does not exist.** The spec's "delete DoctorConflictModal.tsx" instruction was based on a stale inventory. Today only `ConflictModal.tsx` exists. The "delete" step is a no-op and is recorded as such in the audit trail. The E6-S2-ui `DoctorConflictMove.tsx` page does not use a separate modal component — its modal surface is inline JSX in the page (line 234 of `DoctorResolve.tsx`; line 58 of `DoctorResolutionSaved.tsx`). Those inline surfaces are not conflict modals either (the success modal at line 58 is a confirmation, not a 409 surface) and are out of scope for E7-S4.
- **SC3 — Backward-compat surface preserved.** The refactor of `ConflictModal.tsx` keeps the original E1-S1-ui prop shape working (`tone`, `flow`, `title`, `what`, `why`, `rule`, `actions`, `onClose`, `variant`). This is additive only — no consumer was forced to migrate in this pass. The new spec'd props (`canDo`, `intent`, `ariaLabel`, `info` tone) are additive too. Net change: 0 consumer migrations; 1 file refactored (`components/ConflictModal.tsx`); 1 CSS class added (`.icon--info`).
- **SC4 — `tone` is now optional, defaulting to `'warn'`.** The original was required; the spec made it optional. This is a strict widening (no consumer that passed `tone` is broken) and matches the spec's "always ≥ 1 option" — a default of warn keeps the softest tone as the no-arg default.
- **SC5 — `canDo` wins over `actions` when both are passed.** This is a future-proofing choice: existing consumers that pass `actions` keep working; new consumers that pass `canDo` get the spec'd shape. If both are passed, `canDo` is rendered. This matches the I/O matrix in the spec.
- **Deferrals:** 0
- **Pre-existing baselines unchanged:** 0 (no code outside the conflict-modal component + new test files was touched).
- **Awaiting:** bmad-code-review pass before flipping to `done`.