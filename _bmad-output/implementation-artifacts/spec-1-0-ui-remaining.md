---
id: spec-1-0-ui-remaining
title: E1-S0-ui remaining — Discard changes, View audit log, Deactivate-clinic flow
epic: epic-1
review_loop_iteration: 0
created: 2026-10-06
last_updated: 2026-10-06
status: done
---

# E1-S0-ui remaining — Discard changes / View audit log / Deactivate-clinic flow

## Intent

Three placeholders that shipped in the E1-S0-ui Clinic Settings
mockup-32 port are no longer placeholders:

1. **Discard changes** — already worked (resets `draftName` to
   `data.name`); this spec promotes it from "no-op comment" to a
   documented handler.
2. **View audit log** — wired to an inline **Audit access policy**
   card (per the E7-S2 D-E7-S-UI-1 deferral). The admin role
   doesn't see appointment audit (PRD §2.4); the card explains
   why and what they don't see. No back-end call.
3. **Deactivate clinic…** — wired to navigate to `/admin/branches`
   where the actual branch-deactivate flow lives today (mocks 38 /
   42, with the BR-059 ConflictModal). Clinic-level deactivation
   is a future story (E1-S5+): no clinic-level endpoint exists
   yet.

The remaining touch is the parent router plumbing: `App.tsx`
already has `onNavigate`; we just pass it down to `ClinicSettings`.

## Approach

### 1. `ClinicSettings` — accept `onNavigate` prop

**File:** `apps/web/src/pages/ClinicSettings.tsx` (EDIT).

```ts
import type { AdminSection } from '../AppShell';

export function ClinicSettings({
  onNavigate,
}: {
  onNavigate?: (section: AdminSection) => void;
} = {}) {
  // …
}
```

When the parent passes `onNavigate`, the "Deactivate clinic…"
button flips to the Branches section (which renders
`AdminBranches` with its existing 409 ConflictModal). If `onNavigate`
is missing (e.g. a Storybook-style isolation mount), fall back to
`window.location.hash = '#branches'`.

### 2. `ClinicSettings` — wire the handlers

```ts
function onDiscardChanges() {
  if (data) setDraftName(data.name);
  setSaveError(null);
}

const [auditCardOpen, setAuditCardOpen] = useState(false);
function onViewAuditLog() {
  // E7-S2 D-E7-S-UI-1 — policy envelope as static card.
  setAuditCardOpen((v) => !v);
}

function onDeactivateClinic() {
  if (onNavigate) {
    onNavigate('branches');
  } else {
    window.location.hash = '#branches';
  }
}
```

The "View audit log" button gets `aria-expanded={auditCardOpen}`
and `aria-controls="audit-policy-card"` for the a11y axe-check
(E7-S5 invariant). The card's close button toggles the same
state.

### 3. Audit policy card

A new section rendered only when `auditCardOpen === true`,
positioned between the page header and the existing
"single-clinic note" banner. Token-only CSS (E7-S1 invariant;
no hex literals). Structure:

- **Head** — info icon (teal circle) + title "Audit access
  policy" + sub "Why you don't see appointment audit rows
  here." + close button (`×`).
- **Body** — three short paragraphs / list items:
  - **Lead:** per PRD §2.4 (Privacy boundaries), admins do not
    see appointment-level audit rows. Surfacing them on the
    admin role would re-introduce a clinician-grade read into
    the operator seat, which the privacy posture forbids.
  - **List:**
      - What you can see: branch / doctor / receptionist /
        appointment-type change events (the actor's audit log
        on each resource).
      - What you can't see: appointment create / cancel /
        reschedule / status-marked / recurring-created audit
        rows. Those live on the doctor's per-appointment drawer
        and the patient's appointment detail.
      - Who can see them: the assigned doctor (via
        `GET /doctor/audit`) and the patient (via
        `GET /patient/appointments/:id/audit`).
  - **Foot:** hardening note that a `GET /admin/audit/policy`
    endpoint can return this prose from the API in a future
    pass. Today it's documented in the spec and rendered as a
    static card.

### 4. CSS additions

**File:** `apps/web/src/pages/ClinicSettings.module.css` (EDIT).

Append a `.audit-card` block (~80 lines, all `var(--…)`-only):

```css
.audit-card {
  background: var(--brand-light-50);
  border: 1px solid var(--brand-border);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-7);
  overflow: hidden;
  animation: audit-card__in 180ms ease-out;
}
/* … + __icon, __title, __hint, __close, __list, __foot, *…
   modifier classes; animations respect reduced-motion. */
```

### 5. `App.tsx` — pass `onNavigate`

**File:** `apps/web/src/App.tsx` (EDIT).

```tsx
{!sub && active === 'clinic' && <ClinicSettings onNavigate={onNavigate} />}
```

`onNavigate` already exists in `App.tsx` (Task #22 keeps it as the
deferred-router stand-in until W59 ships a real router).

### 6. `DoctorAffected.tsx` — fix missing `useCallback` deps

**File:** `apps/web/src/pages/DoctorAffected.tsx` (EDIT).

Pre-existing bug from the E6-S2 pass: the `onResolved`
`useCallback` was missing its dependency array. Typecheck
correctly flagged it. Add `[]`:

```ts
const onResolved = useCallback(
  (info: ResolvedRow): void => { /* … */ },
  [],
);
```

Not part of the original Task #21 scope, but blocking the
typecheck — fixed in the same commit.

### 7. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  `1-0-ui-remaining: done`; top changelog line.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/pages/ClinicSettings.tsx` | EDIT | `onNavigate` prop; `onViewAuditLog`; `onDeactivateClinic`; audit policy card |
| `apps/web/src/pages/ClinicSettings.module.css` | EDIT | `.audit-card*` block |
| `apps/web/src/App.tsx` | EDIT | Pass `onNavigate` to `<ClinicSettings>` |
| `apps/web/src/pages/DoctorAffected.tsx` | EDIT | Add `[]` deps to `onResolved` `useCallback` |
| `_bmad-output/implementation-artifacts/spec-1-0-ui-remaining.md` | NEW | This doc |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Surface | Input | Behaviour |
|---------|-------|-----------|
| Discard changes (clean) | click | (no-op; disabled when `!dirty`) |
| Discard changes (dirty) | click | `draftName = data.name`; `saveError = null` |
| Discard changes (saving) | click | (no-op; disabled while saving) |
| View audit log | click (closed) | Audit card slides in (animation respects reduced-motion) |
| View audit log | click (open) | Audit card slides out |
| Audit card close `×` | click | Audit card closes |
| Deactivate clinic… | click | `onNavigate('branches')` → Branches section renders `AdminBranches` |
| Deactivate clinic… (no `onNavigate`) | click | `window.location.hash = '#branches'` (dev fallback) |

The audit card's content is static (no back-end call). The
card's `aria-expanded` is wired so screen readers announce
"expanded / collapsed".

## Verification (manual, no tests in this pass per user instruction)

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001);
   `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Sign in as `admin-main@clinic.local` / role `admin`. Land
   on ClinicSettings.
3. **Discard changes.** Type a new clinic name. The "Discard
   changes" button enables. Click → input resets to the API
   value.
4. **View audit log (open).** Click "View audit log" → audit
   card slides in below the page header with the three list items
   + lead + foot. `aria-expanded` is "true".
5. **View audit log (close via button).** Click "View audit log"
   again → card slides out. `aria-expanded` is "false".
6. **View audit log (close via `×`).** Re-open, then click the
   close `×` → card closes. Same state path as toggle on click.
8. **A11y.** Tab to "View audit log", press Space — card opens.
   Tab forward — focus moves into the card content (close `×` is
   reachable). Tab past the card → focus continues into the
   "Single-clinic deployment" banner (no focus trap).
9. **Deactivate clinic (with parent router).** Click "Deactivate
   clinic…" → the AppShell nav highlights "Branches" and the
   page swaps to `AdminBranches` (mock 01). The
   "Deactivate clinic…" was mockup parity for a future story;
   navigation to the closest working surface (branch
   deactivation) is the deferred-but-honest behaviour.
10. **Deactivate clinic (no parent router).** Render
    `<ClinicSettings />` directly with no `onNavigate`. The
    click falls back to `window.location.hash = '#branches'`.
11. `pnpm --filter @clinic/web typecheck` — 0 new errors
    (the pre-existing `useCallback` deps bug in
    `DoctorAffected.tsx` is fixed in the same change).
12. `pnpm --filter @clinic/web lint` — 0 **new** errors
    (the 2 pre-existing `react/no-unescaped-entities` errors
    on lines 258 / 628 of `ClinicSettings.tsx` are baseline and
    out of scope).
13. Grep `apps/web/src/pages/ClinicSettings.module.css` for
    hex literals → 0 (E7-S1 invariant).

## Out of scope (deferred to later stories)

- **D-E1-S0-UI-R-1** — clinic-level deactivation endpoint +
  full deactivate flow. The "Deactivate clinic…" button is
  mockup parity; the actual clinic deactivate API surface ships
  with E1-S5 or later. Today the button routes to the branch
  page; when the clinic endpoint exists, this spec swaps the
  navigation for an inline two-step gate (mocks 38 / 42
  patterns applied at clinic scope).
- **D-E1-S0-UI-R-2** — `GET /admin/audit/policy`. Today the
  audit policy prose is a static card (D-E7-S-UI-1). A future
  hardening pass exposes the prose from the API; the card
  fetches the prose and renders it the same way.
- **D-E1-S0-UI-R-3** — the `2 react/no-unescaped-entities`
  errors on lines 258 and 628 of `ClinicSettings.tsx` are
  pre-existing baseline. A future linter-cleanup pass will fix
  them.
- **D-E1-S0-UI-R-4** — the "Discard changes" affordance exists
  in the mockup header. Today it duplicates the form's own
  "Cancel" button (which is right next to "Save clinic name" in
  the identity card footer). A future UX pass consolidates the
  two (either keep both with different copy, or remove one).
- **D-E1-S0-UI-R-5** — the dev fallback `window.location.hash
  = '#branches'` is only meaningful if `<ClinicSettings />` is
  ever rendered in isolation (which it isn't today). The fallback
  is defensive; in production, the parent always passes
  `onNavigate`.

## Cross-references

- `apps/web/src/pages/AdminBranches.tsx` — branch-deactivate
  flow with the BR-059 ConflictModal (mock 17 + 38/42 patterns)
- `apps/api/src/routes/admin-branches.ts` — PATCH
  `/admin/branches/:id` (the 409 `branch_has_future_appointments`
  envelope)
- `docs/design/mockups/v1/mockups/32-admin-clinic-settings.html`
  — Clinic Settings mockup
- `docs/design/mockups/v1/mockups/38-admin-branch-deactivate.html`
  — Branch deactivate gate (variant A: 0 future appts)
- `docs/design/mockups/v1/mockups/42-admin-branch-deactivate-danger.html`
  — Branch deactivate gate (variant B: N future appts)
- `_bmad-output/implementation-artifacts/spec-7-2-ui-audit-drawers.md`
  — D-E7-S-UI-1 (admin policy envelope)
- `apps/web/src/AppShell.tsx` — `AdminSection` type