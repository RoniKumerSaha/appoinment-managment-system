---
name: MediSlot
description: Multi-branch clinic appointment scheduling system. Stacked-vertical-flow default with sidebar when there is a summary. Clinical Calm teal (`#0f766e`) as the brand color; system font stack only; no web fonts.
status: draft
created: 2026-09-06
updated: 2026-09-06
sources:
  - docs/design/DESIGN-SYSTEM.md
  - docs/design/user-flows/*.md
  - docs/design/mockups/v1/mockups/*.html
mockups_dir: ./mockups
imports_dir: ./imports

# ============================================================================
# Token surface. Mirrors docs/design/DESIGN-SYSTEM.md §2–§6 verbatim.
# This is the brand layer; shadcn/Radix defaults are NOT inherited (MediSlot
# is built on raw HTML + Tailwind v4 + Radix primitives per architecture ADR-4).
# ============================================================================
colors:
  # --- Brand (Clinical Calm teal) ---
  brand-primary: '#0f766e'
  brand-primary-hover: '#0d6660'
  brand-light: '#ccfbf1'
  brand-light-50: '#f0fdfa'
  brand-border: '#99f6e4'

  # --- Surface ---
  surface-page: '#f5f6f8'
  surface-card: '#ffffff'
  surface-soft: '#f9fafb'
  surface-divider: '#f3f4f6'
  border-default: '#e5e7eb'
  border-strong: '#d1d5db'

  # --- Text ---
  text-heading: '#111827'
  text-body: '#1a1d23'
  text-strong: '#374151'
  text-default: '#4b5563'
  text-muted: '#6b7280'
  text-faint: '#9ca3af'

  # --- Semantic ---
  success-bg: '#f0fdfa'
  success-border: '#99f6e4'
  success-text: '#065f46'
  success-badge-bg: '#d1fae5'
  warning-bg: '#fffbeb'
  warning-border: '#f59e0b'
  warning-soft: '#fef3c7'
  warning-text: '#422006'
  danger-bg: '#fef2f2'
  danger-border: '#fca5a5'
  danger-strong: '#dc2626'
  danger-text: '#7f1d1d'
  danger-dark: '#991b1b'
  info-bg: '#dbeafe'
  info-text: '#1e40af'
  neutral-bg: '#f3f4f6'

  # --- Dark mode ---
  surface-page-dark: '#0f1419'
  surface-card-dark: '#1a1d23'
  brand-primary-dark: '#2dd4bf'

typography:
  # System font stack only. No web fonts (architecture §7).
  family: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
  scale:
    text-3xs: { size: 10, weight: 600, lineHeight: 1.5 }
    text-2xs: { size: 11, weight: 500, lineHeight: 1.5 }
    text-xs:  { size: 12, weight: 500, lineHeight: 1.5 }
    text-sm:  { size: 13, weight: 500, lineHeight: 1.5 }
    text-md:  { size: 14, weight: 500, lineHeight: 1.5 }
    text-lg:  { size: 15, weight: 600, lineHeight: 1.5 }
    text-xl:  { size: 16, weight: 700, lineHeight: 1.5 }
    text-2xl: { size: 17, weight: 700, lineHeight: 1.5 }
    text-3xl: { size: 18, weight: 700, lineHeight: 1.5 }
    text-4xl: { size: 22, weight: 600, lineHeight: 1.4 }
    text-5xl: { size: 32, weight: 600, lineHeight: 1.3 }
    text-display: { size: 36, weight: 700, lineHeight: 1.1 }

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 12px
  pill: 999px

spacing:
  space-1: 4px
  space-2: 6px
  space-3: 8px
  space-4: 10px
  space-5: 12px
  space-6: 14px
  space-7: 16px
  space-8: 18px
  space-9: 20px
  space-10: 24px
  space-11: 28px
  space-12: 32px

containers:
  stacked: 760px
  wide: 1080px
  full: 100%
  sidebar-width: 320px

elevation:
  elev-0: none
  elev-1: '0 1px 2px rgba(0,0,0,0.06)'
  elev-2: '0 2px 6px rgba(15,118,110,0.3)'
  elev-3: '0 2px 8px rgba(15,118,110,0.08-0.1)'
  elev-4: '0 4px 12px rgba(0,0,0,0.06)'
  ring-focus: '0 0 0 3px rgba(15,118,110,0.1)'
  ring-danger: '0 0 0 4px #fca5a5'
  ring-success: '0 0 0 4px #99f6e4'

# ============================================================================
# Components. Behavioral specs live in EXPERIENCE.md; visual specs here.
# ============================================================================
components:
  button-primary:
    background: '{colors.brand-primary}'
    foreground: '#ffffff'
    border: none
    radius: '{rounded.sm}'
    padding: '10px 18px'
    fontSize: 14px
    fontWeight: 500
  button-secondary:
    background: '#ffffff'
    foreground: '{colors.brand-primary}'
    border: '1px {colors.brand-primary}'
    radius: '{rounded.sm}'
  button-danger:
    background: '{colors.danger-strong}'
    foreground: '#ffffff'
    border: none
  status-pill:
    radius: '{rounded.pill}'
    fontSize: 11px
    fontWeight: 700
    letterSpacing: implicit
    textTransform: uppercase
  card:
    background: '{colors.surface-card}'
    border: '1px {colors.border-default}'
    radius: '{rounded.lg}' # 10px default; can swap to xl (12) on hero cards
    padding: '{spacing.space-7} {spacing.space-9}'
  card-selected:
    background: '{colors.brand-light-50}'
    border: '1px {colors.brand-primary}'
    elevation: '{elevation.ring-success}'
  field:
    background: '{colors.surface-card}'
    border: '1.5px {colors.border-default}'
    radius: '{rounded.sm}'
    padding: '10px 12px'
    fontSize: '{typography.scale.text-md.size}'
  field-focus:
    border: '1.5px {colors.brand-primary}'
    elevation: '{elevation.ring-focus}'
  conflict-modal:
    pattern: '3-part' # what / why / can_do
    background: '{colors.surface-card}'
    radius: '{rounded.xl}'
    radius-focus-trap: true
---

## Brand & Style

**MediSlot** schedules appointments across multi-branch clinics without ever double-booking. The product is for four actor roles (Patient, Doctor, Receptionist, Administrator) each with a distinct surface family, but the visual language is **one**: clinical calm, sober chrome, primary teal reserved for *action* and *now*, semantic colors reserved for *state*. Nothing decorative.

The brand expression follows two principles, both observable in the 31 mockups under `mockups/`:

1. **Stacked Vertical Flow is the default.** 22 of 31 mockups (per `CHOICES.md` tally) use the single-column stacked pattern at `--container-stacked` (760 px). A 320 px right-rail sidebar appears when there is a live summary (booking confirmation, today view, audit drawer). Use Stacked Vertical unless there is a reason to deviate; deviations are listed in `CHOICES.md` §"Pattern deviations".
2. **Token discipline.** No literal hex outside `tokens.css`. No web fonts. No custom destructive colors (`--danger-strong` only). Status pills never use brand teal — teal is for actions; pills use semantic colors.

Visual identity, components, and accessibility floor all reference this `DESIGN.md`. Concrete behavioral specs (state machines, microcopy, journeys) live in `EXPERIENCE.md`.

## Colors

The palette is clinical calm on the surface, with semantic accents reserved for state.

- **Primary Teal (`--brand-primary` `#0f766e`)** is the action color. One CTA per visible region, never two. Used on primary buttons, active nav, selected-state outline, focus ring (second layer).
- **Surface triad** (`--surface-page` `#f5f6f8` / `--surface-card` `#ffffff` / `--surface-soft` `#f9fafb`) sets the visual hierarchy: app background, then card, then inset.
- **Text ramp** (`--text-heading` → `--text-faint`) is a 6-step gray scale. Default body is `--text-body` (`#1a1d23`); secondary is `--text-default` (`#4b5563`); muted is `--text-muted` (`#6b7280`).
- **Semantic** (`--success-*`, `--warning-*`, `--danger-*`, `--info-*`, `--neutral-bg`) is closed-set. Each status surface uses exactly one semantic color family. Status pills use these — never brand teal.
- **Dark mode** (`-dark` suffix) is reserved and defined but not yet rolled out to mockups.

## Typography

System stack only (`system-ui, -apple-system, "Segoe UI", Roboto, ...`). Zero web fonts (architecture §7). Tabular figures on every time / duration / count.

Type ramp: `--text-3xs` (10px, pill uppercase) → `--text-display` (36px, hero numbers in validation summaries like "4 created"). Default body is `--text-sm` (13 / 500 / 1.5).

## Layout & Spacing

Three container widths: `--container-stacked` (760 px, default), `--container-wide` (1080 px, doctor schedule + admin lists), `--container-full` (100%, Kanban `06-resolve-affected.html`). Sidebar width is `--sidebar-width` (320 px) and is reserved for live-summary surfaces.

Spacing scale is 4-based (`--space-1` 4px → `--space-12` 32px). Default card padding is `--space-7 --space-9` (16 20). Default button padding is `9 16` (compact) or `10 18` (promoted in form footers).

## Elevation & Depth

Three elevation levels, two ring colors, and a strict "selection halo" rule.

- **Selected** items use `--ring-success` (`0 0 0 4px #99f6e4`) on a `--brand-light-50` background — **never** a solid border swap. The halo says "this is currently chosen"; the color says "this is good".
- **Hover** adds `--elev-3` (`0 2px 8px rgba(15,118,110,0.08–0.1)`).
- **Focus** uses `--ring-focus` (`0 0 0 3px rgba(15,118,110,0.1)`) on every interactive element.
- **Danger step** in stepped forms uses `--ring-danger` (`0 0 0 4px #fca5a5`) — see `15-recep-cancel.html`.

## Shapes

Two radii only per screen (rule from `DESIGN-SYSTEM.md` §5). Buttons: `--radius-sm` (6). Cards: `--radius-lg` (10) or `--radius-xl` (12) — never both. Pills: `--radius-pill` (999).

## Components

Component **behavioral** specs (state machines, props, accessibility roles) live in `EXPERIENCE.md` §Component Patterns. Visual specs are summarized here.

- **Button** — `button-primary` / `button-secondary` / `button-danger`. One primary CTA per visible region. Never two primaries on one screen.
- **Status pill** — uppercase, 11 px, 700 weight, `--radius-pill`. Uses semantic tokens. Pill colors per `DESIGN-SYSTEM.md` §7.2.
- **Card** — `--surface-card`, `--border-default`, `--radius-lg` default. `.card.selected` swaps to `--brand-light-50` + `--brand-primary` border + `--ring-success`. `.card.hoverable:hover` adds `--elev-3`.
- **Section** — header + body. Used in stacked vertical flows. See `04-patient-confirm.html` for canonical.
- **Field** — label + input + optional hint. `.req` marker in `--danger-strong`. Focus: `--brand-primary` border + `--ring-focus`.
- **ConflictModal** — 3-part: what happened / why (the rule) / what you can do (max 2 action buttons). Universal conflict surface. See `29-conflict-modal.html` and `EXPERIENCE.md` §State Patterns.

## Do's and Don'ts

**Do**
- Use `--brand-primary` only for actions (CTAs, active nav, selected-state outline).
- Use one CTA per region; pair with `--button-secondary` if a second action is needed.
- Use Stacked Vertical Flow unless the use case demands deviation (see `CHOICES.md` §deviations).
- Use `--ring-success` halo for selection, not a border color swap.
- Use semantic colors for status pills (`Scheduled → --info-*`, `Cancelled → --danger-*`, etc).

**Don't**
- Don't add web fonts (architecture §7).
- Don't put literal hex outside `tokens.css`.
- Don't use brand teal on status pills.
- Don't use `--button-danger` styling for non-destructive actions.
- Don't mix more than two radii on one screen.
- Don't show two primary CTAs in the same visible region.

---

**Status:** `draft`. Spine content is structure + sourced pointers — full spine distillation requires a real Discovery run. Source documents: `docs/design/DESIGN-SYSTEM.md`, `docs/design/user-flows/*.md`, `mockups/01-…31-*.html`.
