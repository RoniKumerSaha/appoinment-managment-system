# UX Guide

## Overview

The web client is four separate role applications that share a design
system, an API client and a small set of primitives. This file records
the visual and interaction contracts that are enforced by tests, plus
the conventions that are observed but not enforced.

**The design system is a contract.** Token names map 1:1 to CSS
variables; drift is a bug (invariant 8 in
`system-architecture.md`).

## The token layer

`apps/web/src/styles/tokens.css` is the **single source of truth** for
every visual value in the web package. Two files make up the style
layer:

| File | Role |
|---|---|
| `styles/tokens.css` | Every colour, space, radius, elevation, font size. Also the global reset, the `#root` sizing rule, and the `prefers-reduced-motion` strip. |
| `styles/shell.css` | The admin app shell (`.shell`, `.nav`, `.nav__*`) plus the three global accessibility rules. |

### Token families

Tokens are grouped by concern, with the source section cited in the
file header comment:

| Family | Examples | Notes |
|---|---|---|
| Brand | `--brand-primary`, `--brand-primary-hover`, `--brand-light`, `--brand-border` | Teal. `--brand-primary` is pinned by a test — renaming it breaks every `var()` reference. |
| Surface | `--surface-page`, `--surface-card`, `--surface-soft`, `--surface-divider` | |
| Border | `--border-default`, `--border-strong` | |
| Text | `--text-heading`, `--text-body`, `--text-strong`, `--text-default`, `--text-muted`, `--text-disabled` | `--text-disabled` is 2.85:1 on `--surface` — **fails AA for body text**. Only for disabled controls, placeholders and de-emphasised hints. |
| Semantic | `--success-*`, `--warning-*`, `--danger-*`, `--info-*`, `--neutral-bg` | |
| On-colour | `--on-brand`, `--on-danger`, `--on-warning` | Foreground tokens for text on filled backgrounds. |
| Dark mode (reserved) | `--surface-page-dark`, `--surface-card-dark` | Unused in v1. Names are stable so a later dark-mode pass needs no rename. |
| Typography | `--text-3xs` … `--text-display` | System font stack only. No `@font-face`, no web font load. |
| Spacing | `--space-1` … `--space-12` | 4px base, but the scale is **not** strictly geometric — `--space-2` is 6px, `--space-4` is 10px. Use the named step, do not compute one. |
| Container | `--container-stacked`, `--container-wide`, `--container-grid` | |
| Radius | `--radius-xs` … `--radius-pill` | |
| Elevation | `--elev-1` … `--elev-modal`, `--ring-focus`, `--ring-danger`, `--ring-success`, `--ring-offset` | "Clinical calm, flat by default." |
| Font | `--font-sans`, `--font-mono` | `--font-mono` for rule citations like `BR-024 · atomic_slot_hold_timeout`. |
| Scrim | `--scrim` | Modal backdrop tint. |
| Patient palette | `--brand-primary-patient`, `--text-primary`, `--shadow-elev-*`, `--hover-tint`, `--brand-tint` | The patient components shipped with a slightly different palette. Rather than rewrite them, the values were preserved as **semantic** tokens so the patient UI keeps its intended appearance while the CSS becomes token-only. |

### The token-only rule

> **No hex, `rgb()`, `rgba()`, `hsl()` or CSS named colour anywhere in
> `apps/web/src` outside `styles/tokens.css`.**

Enforced by `apps/web/test/token-only-css.test.ts`
(`pnpm --filter @clinic/web run test:e7-s1`). The scanner walks every
`.ts`, `.tsx` and `.css` file under `apps/web/src` and flags:

- hex literals (`#rgb`, `#rrggbb`, `#rrggbbaa`),
- `rgb()` / `rgba()` calls,
- `hsl()` / `hsla()` calls,
- CSS named colours (the full CSS Color 4 list) in `.css` files.

Whitelisted: `var(--…)` references, `currentColor`, `transparent`,
`inherit`, `unset`, `initial`, HTML entities (`&#123;`), route hashes
(`href="#section"`), `id="…"` selectors, comment-only lines, and
mid-string `#` in non-colour identifiers (`Appt #10234`,
`BR-024 · #024`).

**Adding a colour means adding a token.** Do not inline a hex to work
around a missing token — name it, add it to `tokens.css`, reference it.

## Global accessibility rules

These live in `styles/shell.css` and are **global**, not per-page. Each
has a static test.

### Focus ring (FR-WCAG-FOCUS)

```css
:where(a, button, input, select, textarea, [role="button"], [tabindex]):focus-visible {
  outline: none;
  box-shadow: var(--ring-focus);
  border-radius: inherit;
}
```

`:where()` keeps specificity at 0 so per-component `:hover` / `:active`
rules still win. Per-component overrides use `:focus-visible` too.

The `--ring-focus` shadow is a *composition*: an outer ring that
matches the surface plus an inner ring in the brand colour, so the
indicator stays visible against any background.

Test: `apps/web/test/a11y-focus-ring.test.ts` (`test:e7-s5-focus`).

### Touch targets (FR-WCAG-TOUCH)

```css
@media (max-width: 640px) {
  :where(button, a[role="button"], input, select):not(.compact) {
    min-height: 40px;
    min-width: 40px;
  }
}
```

Opt out with the `.compact` class — dense dashboards (the doctor
kanban) keep tight targets on purpose.

Test: `apps/web/test/a11y-touch-targets.test.ts` (`test:e7-s5-touch`).

### Reduced motion (FR-WCAG-MOTION)

Two places, both scoped to `@media (prefers-reduced-motion: reduce)`:

- `shell.css:167-176` — zeroes `animation-duration`,
  `animation-iteration-count`, `transition-duration` and forces
  `scroll-behavior: auto`.
- `tokens.css:205-212` — the same idea at the document level, on the
  `:root` reset.

The `!important` is scoped to the media query, so it cannot leak into
the normal cascade.

### Status pills are colour-independent (FR-WCAG-COLOR / WCAG 1.4.1)

**A status pill may never convey meaning through colour alone.** Every
status pill must carry a non-ASCII glyph prefix (● ○ ✓ ✕ ⊘ + ·) or a
nested `<svg>`, or an `aria-label` that names the status.

Test: `apps/web/test/a11y-status-pills.test.ts` (`test:e7-s5-pills`).
The scanner looks for a CSS-module class whose name contains `pill`,
then inspects the next few lines of the JSX for a glyph, an `<svg>` or
an `aria-label`.

Exempt: navigation chips, doctor info cards and avatars — they
communicate identity, not state.

## The ConflictModal

`apps/web/src/components/ConflictModal.tsx` is the **only** conflict
modal in the codebase, and it is a fixed three-part shape:

```
icon · what · why · [rule] · canDo
```

| Slot | Contract |
|---|---|
| `what` | Present-tense, user-actionable. "This time isn't available." |
| `why` | The specific rule. "Another patient booked it first." |
| `canDo` | What the user can do next. **Always ≥ 1 option. Never "OK".** |
| `rule` | Optional BR/FR citation, rendered monospace under the `why` block. Diagnostic value for the staff audience; not part of the contract. |
| `flow` | Optional chip above the title, e.g. `F-01 · Patient booking`. |
| `tone` | `warn` (amber, soft/recoverable), `danger` (red, hard block), `info` (blue, informational). Defaults to `warn`. |

Accessibility built into the component: `role="alertdialog"`,
`aria-modal="true"`, `aria-labelledby` (or `aria-label` override),
`aria-describedby` on the `what` block, a Tab / Shift+Tab focus trap,
focus moved to the first focusable on open and restored on close,
`Escape` to dismiss (only when `onClose` is provided), `Enter` to
activate the focused button.

**There must not be a second one.** Any component that exports a name
containing `Conflict` or `ErrorModal`, or re-exports `ConflictTone` /
`ConflictAction` from another file, fails the test.

Test: `apps/web/test/conflict-modal-singleton.test.ts`
(`test:e7-s4`).

> **Note**: the singleton test deliberately targets the *contract*, not
> a literal list of dialog shapes. The web client has **10**
> dialog-shaped components that are **not** conflict modals — form
> modals (`AdminDoctors`, `AdminReceptionists`, `CancelModal`,
> `DoctorMarkStatus`, `DoctorResolve`, `ReschedulePage`),
> confirmations (`DoctorCancel`, `DoctorResolutionSaved`) and
> slide-in drawers (`DoctorAuditDrawer`, `ReceptionistAuditDrawer`).
> A new form modal does not fail the test; a new *conflict* modal does.

### Backward-compat surface

The component still accepts the original E1-S1-ui shape: `actions`
(alongside `canDo`, which wins), `variant` (mapped to `intent` at
render time). This exists for one in-repo consumer, `AdminBranches`.

## Drawers

The audit surfaces are **slide-in drawers** from the right, not
modals. Two of them, deliberately mirrored so the two role surfaces
read as one feature:

| Component | Scope |
|---|---|
| `DoctorAuditDrawer` | Doubly-bound: `claim.role === 'doctor'` **and** `appointment.doctor_id === claim.doctor_id`. |
| `ReceptionistAuditDrawer` | Branch-scope: appointments at the receptionist's own branch. |

Shared vocabulary:

- Filter chips — `All / Status changes / Cancellations / Block / Resolve`
  (client-side filtering over the full server window; the server caps
  at `MAX_AUDIT_ROWS = 200`).
- `role="dialog"`, `aria-modal="true"`, an `aria-label` naming the
  appointment, `Escape` to close.
- A `DisplayedRow` projection: display time, is-today flag, actor
  label, action line, meta line, pill label and pill tone.

**Privacy differs by surface.** Booked-slot privacy (F-15) does not
apply to the audit drawers — this is the internal audit surface
(NFR-005), so the receptionist sees the full patient phone and the
actor behind each event.

## Routing

The admin shell is hash-routed by a hand-rolled router
(`apps/web/src/router/usePathRoute.tsx`). `parsePath()` maps
`#/admin/{section}` to an `AdminSection` union, with regex sub-page
matches first and prefix fallbacks after. `usePathRoute()` subscribes
to `hashchange`. `<Link>` intercepts left-clicks only.

**Why hash routing**: the Vite dev proxy forwards unknown paths to the
API, so a `history.pushState` route would 404 on refresh.

**Scope limitation**: the router is **admin-only**. The patient, doctor
and receptionist apps are self-contained state machines
(`App.tsx:195-203`).

## The login split

The login used to be one page with two cards — staff sign-in on the
left, patient OTP on the right. Each audience was forced to look at
the other's form.

The current flow is three screens:

| Route | Screen | Shows |
|---|---|---|
| `#/` (no hash) | `LoginChooser` | Two cards: **Staff** and **Patient**. One question that actually separates them. |
| `#/login/staff` | `StaffLoginPage` | Role + email + password. |
| `#/login/patient` | `PatientLoginPage` | Phone + OTP. |

`LoginChooser` renders at `/` with no hash so a bare `page.goto('/')`
still lands on a usable login screen.

The chooser cards are `<button>` elements with stable `data-testid`s
(`login-choose-staff`, `login-choose-patient`).

## Layout conventions

- **Frames**: `LoginFrame`, `DoctorFrame`, `ReceptionistFrame`,
  `PatientFrame` — the per-role shell.
- **Nav**: `StaffNav` + `shell.css` for admin; each role app has its
  own nav inside its frame.
- **Patient primitives**: `apps/web/src/patient/components/` is a
  **barrel** (`index.ts`) of small building blocks — `Button`,
  `StepCard`, `StepFooter`, `SummaryCard`, `SummaryRow`, `DateBlock`,
  `SideRail`. Each has a co-located `.module.css`. The patient booking
  flow is a stepper built from these.
- **Sheets**: new screens use `.module.css` and access classes as
  `styles['kebab-class-name']`. Older doctor/receptionist screens use
  plain `.css` with global class names. Do not migrate the plain
  `.css` files as a side effect of unrelated work.

## Data display rules

- **Phone numbers**: never shown in full on a patient-facing or
  booked-slot surface. Masked as `Patient ···8990`. The receptionist
  day view shows the **full** phone (the receptionist identifies the
  patient on arrival); the receptionist *schedule* view shows the
  first-name initial only (F-15).
- **Times**: rendered in `appointment.branch.tz`, never in the
  browser's zone. Timestamps are stored UTC.
- **Statuses**: the DB enum casing is authoritative —
  `Scheduled`, `Completed`, `Cancelled`, `No-show` (lowercase `s`).
  The API mirrors it verbatim, so a client sending `No-Show` gets a
  400 `invalid_status`.

## Anti-patterns

| Do not | Because |
|---|---|
| Hold a slot client-side | The UI may display slots; it may never assume one is bookable. Test: `apps/web/test/no-tentative-holds.test.ts` (`test:e7-s7`). |
| Add a second conflict modal | Singleton test fails. |
| Inline a hex colour | Token-only test fails. |
| Decide availability in the browser | The API is the only thing that may grant or release a slot. |
| Show a colour-only status | Pill test fails. |
| Add a bespoke focus ring per page | The global ring is the rule; override with `:focus-visible` if genuinely needed. |
| Give a conflict modal a single "OK" action | `canDo` must always offer a path forward. |
