# Design System

The visual language, components, and interaction patterns for the **Multi-Branch Clinic Appointment Scheduling System**. Every value in this document is sourced from the 19 winners under `docs/mockups/v1/winners/` — this is **not** aspirational, it documents what we actually ship.

> **How to use this**
> - **Designer** — copy tokens into Figma variables, build screens with the components.
> - **Engineer** — wire tokens into CSS variables or your design-token lib of choice. Reference the components by name; don't re-invent them.
> - **Reviewer** — if a mockup doesn't match a token here, either update the mockup or update the token. The two should never diverge.

---

## 1. Brand & personality

| | |
|---|---|
| **Name** | MediSlot (working title) |
| **Tone** | Clinical calm · confident · quietly precise · never cold |
| **Visual archetype** | Modern clinical SaaS. Inspired by Linear, Calendly, and hospital systems that don't feel like hospital systems. |
| **Logo** | Logo 03 · Monoline Icon (see `docs/mockups/v1/logos/selected-logo-monoline-icon.html`). |
| **Anti-patterns** | Skeuomorphic medical clipboards, red-alert over-use, stock-photo doctors, generic blue "tech" gradients. |

**One-sentence brand:** "Boring software that gets appointments right."

---

## 2. Color tokens

All hex values are exact. No opacity tricks, no shorthand aliases.

### 2.1 Brand

| Token | Hex | Usage |
|---|---|---|
| `--brand-primary` | `#0f766e` | Primary teal. CTAs, logo, active states, primary nav. |
| `--brand-primary-hover` | `#0d6660` | Hover/focus darken of primary. *(Implied; not yet in mockups.)* |
| `--brand-light` | `#ccfbf1` | Avatars, soft accents, disabled-state hints. |
| `--brand-light-50` | `#f0fdfa` | Selected card backgrounds, success surfaces, "active row" tint. |
| `--brand-border` | `#99f6e4` | Selected-state outline, focus ring (2nd layer), success callouts. |

### 2.2 Surface

| Token | Hex | Usage |
|---|---|---|
| `--surface-page` | `#f5f6f8` | App background behind cards. |
| `--surface-card` | `#ffffff` | Cards, sections, panels, nav. |
| `--surface-soft` | `#f9fafb` | Inset surfaces (info rows, meta cells, appt card bodies). |
| `--surface-divider` | `#f3f4f6` | Section dividers, table row separators. |
| `--border-default` | `#e5e7eb` | Default 1px borders on cards, fields, inputs. |
| `--border-strong` | `#d1d5db` | Hover borders, radio rings. |

### 2.3 Text

| Token | Hex | Usage |
|---|---|---|
| `--text-heading` | `#111827` | Page H1, card titles, primary labels. |
| `--text-body` | `#1a1d23` | Default body color (also `body { color }` in `01`). |
| `--text-strong` | `#374151` | Field labels, helper text in form groups. |
| `--text-default` | `#4b5563` | Secondary text, table data, body content. |
| `--text-muted` | `#6b7280` | Subtitles, hints, breadcrumbs, captions. |
| `--text-faint` | `#9ca3af` | Disabled, placeholder, very subtle labels. |

### 2.4 Semantic

| Token | Hex | Usage |
|---|---|---|
| `--success-bg` | `#f0fdfa` | Success banner background. (Same as brand light-50.) |
| `--success-border` | `#99f6e4` | Success outline. (Same as brand border.) |
| `--success-text` | `#065f46` | Success body text — "Will be created (4)". |
| `--success-badge-bg` | `#d1fae5` | Success pill background. |
| `--warning-bg` | `#fffbeb` | "Now" row background, soft warning surface. |
| `--warning-border` | `#f59e0b` | "Now" row outline (receptionist active-row cue). |
| `--warning-soft` | `#fef3c7` | Warning outline ring, footnote bg. |
| `--warning-text` | `#422006` | Warning body text (footnote copy). |
| `--danger-bg` | `#fef2f2` | Destructive card background, selected-error tint. |
| `--danger-border` | `#fca5a5` | Destructive outline, step "current danger" glow. |
| `--danger-strong` | `#dc2626` | Destructive CTA, danger step badge, error text. |
| `--danger-text` | `#7f1d1d` | Destructive body copy in impact cards. |
| `--danger-dark` | `#991b1b` | Skip-row date label, destructive text on tinted bg. |
| `--info-bg` | `#dbeafe` | Scheduled-status pill background. |
| `--info-text` | `#1e40af` | Scheduled-status pill text. |
| `--neutral-bg` | `#f3f4f6` | Segmented control track, neutral chip background. |

> **Color rule:** status pills never use brand teal — `Scheduled` is **info-blue**, `Completed` is success, `Cancelled` is **danger**, `No-show` is **danger**. Brand teal is for actions, never for state.

### 2.5 Dark mode

Reserved but **not implemented** in mockups. The token names are stable so the migration is trivial later.

| Token | Hex |
|---|---|
| `--surface-page-dark` | `#0f1419` |
| `--surface-card-dark` | `#1a1d23` |
| `--brand-primary-dark` | `#2dd4bf` (lighter teal for contrast on dark) |

---

## 3. Typography

System font stack only — no web fonts. **Zero layout shift, zero asset load.**

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

Line-height is **always `1.5`** for body. Headings use the inherited body line-height.

### 3.1 Type scale

| Token | Size / weight / line-height | Usage |
|---|---|---|
| `--text-3xs` | 10 / 600 / 1.5 | Uppercase labels in pills ("SCHEDULED"), micro-meta |
| `--text-2xs` | 11 / 500 / 1.5 | Field hints, inline metadata, skip-row reason pills |
| `--text-xs`  | 12 / 500 / 1.5 | Subtitle, captions, secondary button label |
| `--text-sm`  | 13 / 500 / 1.5 | Default body text, table data, filter chips |
| `--text-md`  | 14 / 500 / 1.5 | Button label, prominent form value |
| `--text-lg`  | 15 / 600 / 1.5 | Card title, section title, modal title |
| `--text-xl`  | 16 / 700 / 1.5 | Sub-page H2 (rare) |
| `--text-2xl` | 17 / 700 / 1.5 | Logo wordmark |
| `--text-3xl` | 18 / 700 / 1.5 | Logo variant, large nav header |
| `--text-4xl` | 22 / 600 / 1.4 | Page H1 (compact flows) |
| `--text-5xl` | 32 / 600 / 1.3 | Hero number (e.g. validation summary "4 created") |
| `--text-display` | 36 / 700 / 1.1 | Validation summary hero numbers (`summary-num`) |

### 3.2 Weights in use

`400` (rare), `500` (body default), `600` (titles, pills), `700` (display, logo). **No 300, no 800, no 900.**

### 3.3 Numerics

- Tabular figures: `font-variant-numeric: tabular-nums` on **all times, durations, counts**. So `09:00`, `09:45`, `10:30` align on the colon.
- Always pad: `09:00`, never `9:00`.
- 24-hour clock everywhere in mockups. **Do not** show AM/PM.

### 3.4 Phone numbers

Format: `+966 5XX XXX 5555`. The `XXX` segments are deliberately redacted in demos; the prefix (`+966`), the first `5XX`, and the last 4 digits are the only literal parts.

---

## 4. Spacing & sizing

A 4px base. Tokens below are the exact values that appear in mockups.

| Token | px | Common use |
|---|---|---|
| `--space-1`  | 4   | Tight stack, gap between two meta cells |
| `--space-2`  | 6   | Pill vertical padding |
| `--space-3`  | 8   | Field gap, inline icon-to-text |
| `--space-4`  | 10  | Small button vertical pad, segmented button gap |
| `--space-5`  | 12  | Field horizontal padding, nav vertical pad |
| `--space-6`  | 14  | Card padding (compact), button size |
| `--space-7`  | 16  | Section padding, default card padding |
| `--space-8`  | 18  | Card padding (loose) |
| `--space-9`  | 20  | Page section padding |
| `--space-10` | 24  | Page horizontal padding, large card padding |
| `--space-11` | 28  | Large section head padding |
| `--space-12` | 32  | Page outer padding (desktop) |

### 4.1 Containers

| Token | px | Use |
|---|---|---|
| `--container-stacked` | 760 | Stacked-vertical flows (most flows) |
| `--container-wide` | 1080 | Doctor schedule + admin lists |
| `--container-full` | 100% | Kanban (`06-resolve-affected`) |
| `--sidebar-width` | 320 | Sidebar layouts (`01-layout-direction`, `05-patient-self-service`) |

### 4.2 Breakpoints (reserved)

| Token | px | Note |
|---|---|---|
| `--bp-sm` | 640 | Below this, stack sidebars |
| `--bp-md` | 768 | Tablet portrait |
| `--bp-lg` | 1024 | Default desktop, fit content |
| `--bp-xl` | 1280 | Wide admin tables |

Mockups target a single 1440 viewport. The above tokens are reserved for responsive behaviour in production but are **not visualised** in `v1/`.

---

## 5. Radius

| Token | px | Usage |
|---|---|---|
| `--radius-xs` | 4   | Segmented inner button, code chip |
| `--radius-sm` | 6   | Default — buttons, inputs, small badges |
| `--radius-md` | 8   | Inner callouts, small cards, meta cells |
| `--radius-lg` | 10  | Cards, panels, step blocks |
| `--radius-xl` | 12  | Sections, large cards |
| `--radius-pill` | 999 | Status pills, segmented control track, hero badges |

**Rule:** don't mix more than two radii on a single screen. Pick `--radius-md` for cards **or** `--radius-lg`, not both. Buttons always use `--radius-sm`.

---

## 6. Elevation

Five levels. Use sparingly — clinical calm means flat by default.

| Token | Value | Usage |
|---|---|---|
| `--elev-0` | none | Default surface |
| `--elev-1` | `0 1px 2px rgba(0,0,0,0.06)` | Segmented inner active, tab indicator |
| `--elev-2` | `0 2px 6px rgba(15,118,110,0.3)` | The floating "PART X" badge |
| `--elev-3` | `0 2px 8px rgba(15,118,110,0.08–0.1)` | Hover state on cards (`02`, `06`, `17`) |
| `--elev-4` | `0 4px 12px rgba(0,0,0,0.06)` | Doctor card hover (`01`) |
| `--ring-focus` | `0 0 0 3px rgba(15,118,110,0.1)` | All input focus + active stack-card |
| `--ring-danger` | `0 0 0 4px #fca5a5` | Danger step current-state glow (`15`) |
| `--ring-success` | `0 0 0 4px #99f6e4` | Current-step success glow (`14`, `16`, `17`) |

**Selection halos:** selected items use `--ring-success` on a `#f0fdfa` background, never a solid border swap. The halo says "this is currently chosen"; the colour says "this is good".

---

## 7. Components

All components are implemented (or templated) under `docs/mockups/v1/app/components.html`. The visual rules below are what every mockup must follow.

### 7.1 Buttons

Four variants, one shape.

| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| **Primary** | `#0f766e` | `#fff` | none | The one CTA per screen (Book, Save, Confirm) |
| **Secondary** | `#fff` | `#0f766e` | `1px #0f766e` | Equal-weight pairing with primary |
| **Ghost** | transparent | `#4b5563` | none | "Cancel", "Back", "Edit pattern", tertiary |
| **Danger** | `#dc2626` | `#fff` | none | "Confirm cancellation", destructive only |

**Specs (default):** padding `9px 16px`, font-size 13px, weight 500, radius 6px.
**Promoted (form footers):** padding `10px 18px`, font-size 14px.

**Rules:**
- One primary button per visible region. Never two.
- Destructive actions are always `danger`. Never primary-red, never ghost-danger.
- Disabled state = `opacity: 0.5; cursor: not-allowed`. Never remove the label.
- Icon-only buttons get a 4px gap between icon and label (or zero if truly iconless).

### 7.2 Status pill

Round (`999px`). Icon prefix always. Three sizes, all variants.

| Status | Icon | Background | Text | Border |
|---|---|---|---|---|
| Scheduled | ● | `#dbeafe` | `#1e40af` | none |
| Checked-in | ◐ | `#ccfbf1` | `#0f766e` | none |
| Completed | ✓ | `#d1fae5` | `#065f46` | none |
| Cancelled | ✕ | `#fecaca` | `#991b1b` | none |
| No-show | ⚠ | `#fecaca` | `#991b1b` | none |
| Will create | ✓ | `#d1fae5` | `#065f46` | none |
| Will skip | ✕ | `#fecaca` | `#991b1b` | none |
| Neutral / Draft | ○ | `#f3f4f6` | `#4b5563` | none |

Pill text is always **uppercase** with letter-spacing implicit, **10–11px**, weight 600–700.

### 7.3 Card

```
.card {
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); /* 10 or 12 */
  padding: var(--space-7) var(--space-9); /* 16 20 */
}
.card.selected {
  background: var(--brand-light-50);
  border-color: var(--brand-primary);
  box-shadow: var(--ring-success);
}
.card.hoverable:hover {
  border-color: var(--brand-border);
  box-shadow: var(--elev-3);
}
```

### 7.4 Section

A card with a numbered head, used in stacked-vertical flows (07, 14, 16, 17).

```
.section { radius 12, padding 0; }
.section-head { padding 16 20; border-bottom 1px divider; display flex; gap 12; }
.section-num { 26x26 circle, teal; current-step + halo glow; danger variant in 15 }
.section-body { padding 18 20; }
.section-actions { padding 14 20; border-top; display flex; gap 10; justify flex-end; }
```

Step number is **filled** for current step, **outlined** for future steps, **filled brand-light** for completed steps. In `15-recep-cancel` the current step uses `--danger-strong` fill + `--danger-border` glow.

### 7.5 Field

```
.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1.5px solid var(--border-default);
  border-radius: var(--radius-sm);
  font-size: var(--text-md);
  font-family: inherit;
  background: var(--surface-card);
}
.field input:focus { outline: none; border-color: var(--brand-primary); box-shadow: var(--ring-focus); }
.field label { display: block; font-size: 12px; color: var(--text-strong); font-weight: 600; margin-bottom: 5px; }
.field label .req { color: var(--danger-strong); margin-left: 2px; }
.field .hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
```

**Required field marker:** red asterisk inline after the label, never a "(required)" caption.

### 7.6 Modal (ConflictModal pattern)

UX-FLOWS §6.1. The canonical modal. Three slots:

1. **What happened** — one sentence in present tense. "That slot was just booked."
2. **Why** — the rule. "Dr. Al-Rashid's 10:00 Saturday slot was claimed by another patient 12 seconds ago."
3. **What you can do** — two buttons max. Primary = the best next step. Secondary = stay / back.

```
.conflict-modal { max-width: 480px; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 24px 48px rgba(0,0,0,0.18); }
.conflict-modal .head { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
.conflict-modal .icon { 36x36, danger-tinted, rounded 8; }
.conflict-modal .why { font-size: 13px; color: var(--text-default); margin: 4px 0 8px; }
.conflict-modal .rule { background: #fef2f2; border-left: 3px solid var(--danger-strong); padding: 8px 12px; border-radius: 6px; font-size: 12px; color: var(--danger-text); margin-bottom: 16px; }
.conflict-modal .actions { display: flex; gap: 8px; justify-content: flex-end; }
```

**Modal rules:**
- Never block with a yes/no that doesn't tell the user why.
- Always offer a "what's next" path. "OK" alone is forbidden for conflicts.
- Backdrop click = same as cancel (the safest secondary).

### 7.7 Toast

Top-right. Auto-dismiss 3s.

```
.toast { position: fixed; top: 16px; right: 16px; min-width: 280px; max-width: 360px;
  background: var(--brand-primary); color: white; padding: 12px 16px; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15,118,110,0.3); display: flex; align-items: center; gap: 10px;
  font-size: 13px; }
.toast .dismiss { opacity: 0.7; cursor: pointer; }
```

Tone variants: **success** (default teal), **info** (blue), **warning** (amber), **error** (red).

### 7.8 Empty state

Centered. Single column. Icon + title + description + optional CTA.

```
.empty { padding: 48px 24px; text-align: center; color: var(--text-muted); }
.empty .icon { 48x48; color: var(--text-faint); margin-bottom: 12px; }
.empty .title { font-size: 15px; color: var(--text-heading); font-weight: 600; margin-bottom: 4px; }
.empty .desc { font-size: 13px; max-width: 360px; margin: 0 auto; }
```

### 7.9 Audit log drawer

Slides in from the right. Width 480px. Header with timestamp range + filter chips; rows are one-line `{actor} {action} {target} · {time}`.

Templated in `components.html` as `tpl-audit-drawer`. **No row** should expose patient PII when viewed by a role other than the data owner — receptionist sees only their branch's audit; doctor only sees their own appointments.

### 7.10 Appointment card

The shared unit across roles. Variants:

- **Doctor view** (`09`, `12`) — compact, action button on the right ("Mark complete", "Cancel")
- **Receptionist view** (`13`, `14`, `15`) — wider, time prominent on the left
- **Patient view** (`05`) — friendly tone, action labelled "Reschedule" / "Cancel"
- **Admin view** (`18`, `19`) — neutral, link to doctor's profile

All variants share: date-block (left), body (patient + type + meta), status pill (right), optional action.

### 7.11 Meta cell

Used in section bodies (`07`, `14`, `17`). Two-column grid showing key → value.

```
.meta-cell { background: var(--surface-soft); border: 1px solid var(--border-default); border-radius: 8; padding: 10; }
.meta-cell .k { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; margin-bottom: 3px; }
.meta-cell .v { font-size: 13px; color: var(--text-heading); font-weight: 500; }
```

### 7.12 Segmented control

```
.seg { display: flex; gap: 4px; background: var(--neutral-bg); padding: 3px; border-radius: 6px; }
.seg button { padding: 5px 12px; background: transparent; border: none; border-radius: 4px; font-size: 12px; color: var(--text-muted); font-weight: 500; cursor: pointer; }
.seg button.active { background: white; color: var(--brand-primary); box-shadow: var(--elev-1); }
```

### 7.13 Step number

26×26 circle. Three states:

- **Future** — `background: #ccfbf1; color: #0f766e` (outlined)
- **Current** — `background: #0f766e; color: white; box-shadow: 0 0 0 4px #99f6e4`
- **Completed** — `background: #0f766e; color: white` (no halo)
- **Current danger** (cancel flow only) — `background: #dc2626; color: white; box-shadow: 0 0 0 4px #fca5a5`

---

## 8. Layout patterns

| Pattern | Width | When to use |
|---|---|---|
| **Stacked vertical** | 760px center | Step-by-step confirmations, forms, anything transactional |
| **Sidebar split** | `1fr 320px` | Patient self-service (form + summary), doctor day (list + filter) |
| **Card grid** | full, 3-col on `≥1024` | Admin lists (`18`, `19`) |
| **Kanban** | full, 3-col | Affected-appointments resolve (`06`) |
| **Agenda timeline** | full | Doctor calendar (`03`) |

**Rule:** every screen uses **at most one** layout pattern. Mixing a sidebar with a kanban = visual noise.

---

## 9. Iconography

Material pictographs in mockups today; no icon set dependency. The literal characters used:

| Glyph | Meaning |
|---|---|
| ✓ | Success / completed / will-create |
| ✕ | Destructive / skipped / remove |
| ● | Scheduled status dot |
| ◐ | In-progress / checked-in |
| ○ | Empty / unchecked / draft |
| ⚠ | Warning / no-show / outside hours |
| 🔒 | OTP / locked / private |
| 📅 | Calendar / date |
| ➜ | Forward arrow on CTAs ("Create 4 →") |
| ← | Back |
| ⓘ | Info (rare) |

**Rule:** an icon **always** carries the same meaning across screens. `✓` never means "delete" anywhere.

For production, replace these literal glyphs with a single icon library (Lucide or Phosphor recommended) at the same sizes (14–18px inline, 24–36px standalone).

---

## 10. Voice & tone

### 10.1 Principles

1. **Plain language.** "Cancel" not "Terminate appointment". "Save" not "Commit changes".
2. **Time-first.** Lead with the slot, then context: *"Sat, Aug 23 · 11:15 with Dr. Al-Rashid"*.
3. **Cite the rule when refusing.** Conflict copy must name the rule: *"Outside the 30-day booking window."* — never just "Not allowed."
4. **Action labels are verbs.** "Confirm cancellation", "Create 4 appointments", "Block & resolve". One verb per button.
5. **Never assume emotion.** "Cancel appointment" not "Are you sure you want to cancel?" — show what happens instead.
6. **Persona-respect.** Address patients by first name only after OTP verify. Address staff by full name in headers.

### 10.2 By role

| Role | Voice | Example |
|---|---|---|
| **Patient** | Friendly, plain, reassuring. Second-person. | "You're booked, Fatima." |
| **Doctor** | Concise, clinical. Third-person or imperative. | "Mark complete" / "Block 10:00–11:00". |
| **Receptionist** | Operational. Imperative + summary. | "Pick the appointment. Reason. Confirm." |
| **Admin** | Authoritative, system-y. Imperative + impact. | "Narrowing hours affects 14 appointments." |

### 10.3 Errors

Always three parts: **what happened**, **why**, **what you can do**. From UX-FLOWS §6.1, applied:

- ✗ "Slot not available."
- ✓ "That slot was just booked. Dr. Al-Rashid's Saturday 10:00 was claimed 12 seconds ago. Pick another time →"

### 10.4 Empty states

Never leave a section blank without a reason. Three patterns:

1. **Truly empty** — icon + "Nothing here yet." + CTA
2. **Filtered to nothing** — "No appointments match *Cardiology* this week." + "Clear filter"
3. **Permission blocked** — "Receptionists at Riyadh Malqa can only see Riyadh Olaya appointments." (always the rule, never just "No access")

---

## 11. Accessibility

The design system targets **WCAG 2.1 AA**.

### 11.1 Contrast

| Pair | Ratio | Pass |
|---|---|---|
| Body text (`#1a1d23`) on page (`#f5f6f8`) | 14.5:1 | AAA |
| Body text on card (`#fff`) | 16.1:1 | AAA |
| Muted (`#6b7280`) on white | 4.83:1 | AA |
| Faint (`#9ca3af`) on white | 2.85:1 | Fails AA — **never use faint for body**, only disabled/placeholder |
| Primary teal on white | 4.93:1 | AA — borderline; avoid primary teal for body text |
| White on primary teal | 4.93:1 | AA — OK for buttons |
| Danger text (`#991b1b`) on `(#fef2f2)` | 7.4:1 | AAA |

### 11.2 Focus

- Every interactive element gets a visible focus ring on `:focus-visible`. Default: `--ring-focus`.
- Never `outline: none` without a replacement.
- Tab order matches visual order. No `tabindex > 0` ever.

### 11.3 Keyboard

- All actions reachable by `Tab` + `Enter`/`Space`.
- Modal traps focus until dismissed. `Esc` closes.
- Conflict modals: `Enter` triggers primary, `Esc` triggers secondary.

### 11.4 Motion

- Hover transitions ≤150ms, ease-out.
- Modal in/out ≤200ms.
- Respect `prefers-reduced-motion`: remove the toast slide, the modal scale-in.

### 11.5 Touch targets

- All interactive elements ≥ 40×40px on mobile. The mockups are desktop-only but the components are spec'd to scale.

---

## 12. Demo data — canonical references

Every mockup **must** use the same person / phone / branch names. The ux-consistency-report §10 still flags drift in `12`/`13`/`14`/`15`; this table is the lock-down.

| Persona | Display name | Phone | Used in |
|---|---|---|---|
| Patient | **Fatima A. Al-Sayed** | `+966 5XX XXX 5555` | `04`, `05`, `07`, `12`, `13`, `14`, `15` |
| Doctor | **Dr. Ahmed Al-Rashid** | — | every doctor flow + admin |
| Receptionist | **Reem Al-Harbi** | — | `13`, `14`, `15`, `16` |
| Admin | **Salem Al-Mutairi** | — | `08`, `17`, `18`, `19` |

Branches (canonical):

| Token | Display |
|---|---|
| B1 | **Riyadh Olaya** |
| B2 | **Riyadh Malqa** |
| B3 | **Jeddah Corniche** |
| B4 | **Riyadh Diplomatic Quarter** |

Earlier mockups used "Branch A — Downtown" / "Branch B — Marina" — those are deprecated. Real names everywhere.

---

## 13. What this document is not

- **Not** a code library. The tokens map to CSS variables in production. The naming here is human-readable; the engineering team chooses the wire format (CSS vars, JS tokens, Tailwind config — whatever ships fastest).
- **Not** a one-time write. Every new mockup that introduces a new colour, radius, or component is a chance to either reuse or extend this document. New tokens must be added here before they're used.
- **Not** a substitute for Figma. Visual review still happens in Figma against `mockups/v1/`. This document is the **why**, the mockups are the **what**.

---

## 14. Companion file

`docs/mockups/v1/app/components.html` is the live HTML reference for the components in §7. Every component in this document has a rendered template there. If a component here doesn't match `components.html`, the HTML wins (it's the running source).
