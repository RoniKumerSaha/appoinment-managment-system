---
id: spec-7-4-conflict-modal-global-component
title: E7-S4 — ConflictModal global component
epic: epic-7
status: ready-for-dev
review_loop_iteration: 0
created: 2026-10-07
last_updated: 2026-10-07
source_story: planning-artifacts/epics-and-stories.md §E7-S4
---

# E7-S4 — ConflictModal global component

## Intent

A single shared `ConflictModal` component with three slots — **what happened**, **why**, **what you can do** — used by every flow that surfaces a 409 from the server. UX-FLOWS §8 (Conflict Patterns) and architecture §5 both forbid "OK"-only conflict surfaces and bespoke-modal drift.

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

(none yet — first authoring)