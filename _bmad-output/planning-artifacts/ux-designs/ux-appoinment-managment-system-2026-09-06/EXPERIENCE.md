---
name: MediSlot
description: Behavioral spine — information architecture, voice, component patterns, state patterns, interaction primitives, accessibility floor, key flows. Cross-references DESIGN.md for all visual specs.
status: draft
created: 2026-09-06
updated: 2026-09-06
design_md: ./DESIGN.md
sources:
  - docs/specs/PRD.md
  - docs/specs/BRD.md
  - docs/specs/UX-FLOWS.md
  - docs/design/user-flows/*.md
  - docs/design/DESIGN-SYSTEM.md
mockups_dir: ./mockups
imports_dir: ./imports
---

# MediSlot — Experience Spine

How the product **works**, not how it looks. All visual specs (color, typography, elevation, components-as-rendered) are owned by `DESIGN.md`. This file owns behavior, IA, microcopy, state machines, and accessibility floor. Spines win on conflict with any mockup or wireframe.

## Foundation

- **Form factor:** Web, desktop-first (mockups target 1440 px wide). Touch targets ≥ 40×40 px on mobile per architecture §7. Reserved breakpoints: `--bp-sm` 640 / `--bp-md` 768 / `--bp-lg` 1024 / `--bp-xl` 1280 (`DESIGN.md` §spacing).
- **UI system:** Next.js 15 App Router + React 19 + Tailwind v4 + Radix UI primitives on Node runtime (architecture ADR-3, ADR-4). Server Components are the default render mode; Server Actions for staff mutations; Route Handlers for public cross-origin surfaces (`/patient/otp/*`, `/bookings`, `/availability`).
- **Design system:** `docs/design/DESIGN-SYSTEM.md` is the human source of truth; `DESIGN.md` (this workspace) is the BMad mirror. Token names referenced by `{path.to.token}` syntax throughout this file resolve via `DESIGN.md` §Components.
- **Locale / language:** English (default; no i18n in MVP per `docs/specs/PRD.md` §scope).

## Information Architecture

Five entry points — one per role — plus a landing page. Each entry is a stacked-vertical dashboard with role-specific navigation. The `app/` connected shell in `imports/app/` shows the navigation graph (`shell.js` route table).

| Role | Entry surface | Primary flow |
|---|---|---|
| **Patient** | `04-patient-confirm.html` (booking) / `05-patient-self-service.html` (my appts) | Doctor → Branch → Type → Date → Slot → Phone+Name |
| **Doctor** | `12-mark-status.html` (today) / `09-doctor-schedule.html` (week editor) | Mark status / edit schedule / resolve conflicts |
| **Receptionist** | `13-recep-today.html` (branch today) | Card-by-hour view + quick actions |
| **Administrator** | `17-admin-branches.html` / `18-admin-doctors.html` | Clinic structure |
| **Landing** | `01-layout-direction.html` | Sign-in + role chooser |

Cross-actor flows (F-09, F-17, F-18) live in both actor's IA; the canonical "active" side is doctor (they own the resolution per architecture AD-1).

## Voice and Tone

- **Authoritative but warm.** Clinical context, but the user is a person, not a record.
- **Always-actionable.** Every conflict surface (ConflictModal, error toasts, empty states) has at least one action verb the user can take. "OK" alone is forbidden (`UX-DR-25`).
- **Atomicity cues.** Booking, cancel, reschedule, recurring-confirm all expose the "Atomic: `<op>`" + "audit: `<event>`" inline hint (see `04-patient-confirm.html`, `23-recurring-confirm.html`).
- **No medical jargon.** "Doctor schedule" not "practitioner availability matrix". "Booked" not "appointment created".
- **Time and dates.** 24-hour clock, zero-padded `09:00`. Branch-local timezone on every timestamp (`{DESIGN.md colors.text-default}` for muted tz label). Phone format `+966 5XX XXX 5555`.

## Component Patterns

Component **visual** specs live in `DESIGN.md` §Components. This section is the behavioral delta.

### Buttons

- **One primary per region.** A form footer with two CTAs is `[secondary] [primary]`. Promote uses `--button-primary`; cancel/close uses `--button-secondary` (NEVER `--button-ghost-danger`).
- **Destructive actions** (cancel appointment, drop block, etc) use `--button-danger` only. Always preceded by a confirmation step (UX-DR-44).
- **Disabled state** uses `--brand-light` background and `--text-faint` foreground — never grays-out into invisibility.

### Cards

- `.card` is a generic content container. `.card.selected` (or `.card.hoverable:hover`) signals current selection.
- **Selected card** uses `--ring-success` halo on `--brand-light-50` (DESIGN.md §Components / §Selection halos).
- **Hoverable cards** add `--elev-3` on hover (cards 02, 06, 17).

### Status pills

| Status | Background | Text | Mockup reference |
|---|---|---|---|
| Scheduled | `--info-bg` | `--info-text` | `12-mark-status.html` |
| Cancelled | `--danger-bg` | `--danger-dark` | `12-mark-status.html` |
| Completed | `--success-badge-bg` | `--success-text` | `12-mark-status.html` |
| No-show | `--danger-bg` | `--danger-dark` | `12-mark-status.html` |
| Now (recep active row) | `--warning-bg` | `--warning-text` | `13-recep-today.html` |

Pill text is **uppercase** with implicit letter-spacing, 10–11 px, 700 weight. Never uses brand teal.

### ConflictModal

Universal conflict surface (`29-conflict-modal.html`). Three-part pattern:

1. **What happened** — neutral statement of the failed operation.
2. **Why** — the rule that was violated (cite rule id: BR-009, BR-021, FR-027).
3. **What you can do** — max 2 action buttons with action verbs (`Pick another slot`, `Resolve affected`, `Back to date`).

Focus trap on open, `Esc` closes, `Enter` triggers primary. Touch targets ≥ 40×40.

### AuditLogDrawer

Right-rail drawer (`30-doctor-audit-drawer.html`). Scope is role-limited: doctor sees own appointments, receptionist sees own branch, admin sees clinic-structure audits only (AD-10).

## State Patterns

Closed-set state machines per surface. Status pills are the canonical status surface.

### Appointment status

```
[Scheduled] ─────> [Completed]
     │                  ↑
     │                  │
     ├────> [Cancelled] ┘
     │
     └────> [NoShow] ────> [Resolved] (audit row)
```

Per `BRD.md §3.1.3` and `architecture.md §3.3`. No other states. `Cancelled` is terminal — `Appointment` rows are never deleted (architecture §4).

### Booking flow

```
Step 1: Doctor       ─[pick]─>  Step 2: Branch
Step 2: Branch       ─[pick]─>  Step 3: Type
Step 3: Type         ─[pick]─>  Step 4: Date (1..30 days, today excluded)
Step 4: Date         ─[pick]─>  Step 5: Slot (from availability engine)
Step 5: Slot         ─[pick]─>  Step 6: Phone+Name
Step 6: Phone+Name   ─[submit]─> [Scheduled] | [ConflictModal]
```

Same-day booking is rejected at step 4 with calendar gray + tooltip "Same-day booking unavailable" (`FR-019`, `UX-DR-29`).

### Form stepped (recep create / cancel)

```
Step 1 (reason) ─[continue]─> Step 2 (review) ─[confirm]─> [Scheduled|Cancelled]
       │                            │
       └────── [back] ──────────────┘
```

`14-recep-create.html` shows the canonical stepped form (locked to receptionist's branch per `AD-8`). `15-recep-cancel.html` shows the danger-stepped variant with `--ring-danger` glow on the current step.

## Interaction Primitives

| Primitive | Mockup ref | Notes |
|---|---|---|
| Date picker | `03-availability-calendar.html` | 30-day calendar, today grayed, agenda timeline below |
| Time slot grid | `03-availability-calendar.html` | Back-to-back from appointment-type duration, no buffer |
| Phone input | `04-patient-confirm.html` | Format `+966 5XX XXX 5555`; known phone returns stored name (FR-023) |
| Doctor picker | `02-doctor-picker.html` | Card-first with sidebar; branch + specialty chips |
| Step indicator | `14-recep-create.html`, `15-recep-cancel.html` | Filled current / outlined future / brand-light completed; `--ring-danger` on danger step |
| OTP modal | `21-patient-otp-modal.html` | 6 digits, 5-min TTL, 3-of-10 lockout (architecture §3.8) |
| Audit drawer | `30-doctor-audit-drawer.html` | Right-rail; `RoleFieldPolicy` governs phone visibility (AD-10) |
| Conflict modal | `29-conflict-modal.html` | 3-part pattern; universal |

## Accessibility Floor

Behavior-level accessibility (visual contrast, color choice, focus rings) is in `DESIGN.md`. This is the **behavioral** floor.

- **WCAG 2.1 AA.** ConflictModal traps focus; `Esc` closes; `Enter` triggers primary; `Tab` cycles within the modal.
- **Touch targets ≥ 40×40 px** on mobile, even though mockups target 1440 px desktop.
- **Keyboard navigation.** Every interactive element reachable via Tab. Arrow keys for radio groups, segmented controls, calendar grids. `Enter` / `Space` activates. `Esc` closes overlays.
- **Live regions.** ConflictModal opens announces itself via `role="alertdialog"`. Status changes announce via `aria-live="polite"`.
- **Reduced motion.** Honor `prefers-reduced-motion`: toast slide and modal scale-in disabled (architecture §7).
- **Tabular figures** on every time / duration / count surface.
- **Color is never the sole signal.** Status pills always include text. Cancelled always uses text + icon, never just red.

## Key Flows

Numbered journey per the spine convention — a named protagonist with a climax beat. Mirror source-spec flow IDs verbatim where defined (`F-01`…`F-20` per `docs/specs/UX-FLOWS.md`).

### F-02 / F-03 — Mary, 32, books her daughter's pediatrician (Patient)

Mary opens the booking flow on her phone during lunch. She picks Dr. Aisha (pediatrics) at the Riyadh branch, Consultation (30 min), picks tomorrow (today is excluded), sees 4 slots between 09:00 and 10:00, picks 09:30, types her phone `+966 50X XXX 1234`, name `Mary`, taps Confirm. **Climax:** atomic confirmation — `Scheduled` pill, audit row written. Mary sees "Booked · 09:30 · Dr Aisha · Riyadh" with no ambiguity.

→ `02-doctor-picker.html` → `03-availability-calendar.html` → `04-patient-confirm.html`

### F-09 — Dr Aisha resolves 3 affected appointments after schedule change (Doctor)

Dr Aisha removed a 14:00–16:00 Wednesday period. Three existing appointments fall outside her new schedule. She opens the doctor's today view, sees the Kanban queue (`06-resolve-affected.html`) with 3 cards bucketed by `Patient Conflict / Type Change / Branch Move`. She resolves each one — two by branch move, one by reschedule. **Climax:** last card resolved, server re-runs schedule validation, persists, audits with `cause: "schedule_change:<id>"`.

→ `06-resolve-affected.html` → `24-doctor-resolve-one.html`

### F-13 — Receptionist Layla handles a walk-in (Receptionist)

Layla at the Jeddah branch gets a walk-in: Mr. Khalid needs Dr Omar today. She opens the walk-in stepped form (`26-recep-checkin.html`), types phone (existing patient), name auto-fills, picks the only available slot in 15 minutes, taps Confirm. **Climax:** atomic write; branch picker is locked to Jeddah (AD-8); audit row `actor_role = "receptionist"`.

→ `26-recep-checkin.html` → `14-recep-create.html` (parallel flow)

### F-11 — Admin previews a 12-week recurring series (Patient/Doctor)

Dr Aisha wants a 12-week Wednesday 09:00 follow-up series. She opens the recurring preview (`07-recurring-preview.html`), picks the pattern, sees 8 of 12 will_create, 4 skipped_with_reason (one holiday, three branch-closed). She taps Confirm. **Climax:** server runs the §3.3 booking transaction per occurrence with Serializable + P2034 retry; rows that succeed become `Scheduled`; rows that fail are returned in `skipped[]`, **never** in `will_create[]` (architecture §3.5).

→ `07-recurring-preview.html` → `23-recurring-confirm.html`

### F-20 — Admin Sana audits last week's changes (Admin)

Sana opens the admin audit log (`27-admin-audit-log.html`), filters by `actor_role=doctor`, last 7 days. She sees 14 schedule-mutation audit rows, 6 cancellation rows, 0 booking rows (admin never sees individual patient bookings — `BR-065`). **Climax:** one row shows `affected_appointment_ids=[…3 ids…]`; she drills in, sees the per-appointment resolutions.

→ `27-admin-audit-log.html`

---

**Status:** `draft`. Spine structure + sourced pointers. Full behavioral distillation (every state, every microcopy) requires a real Discovery run. Source-of-truth microcopy lives in `mockups/*.html` line-by-line; this spine indexes them by flow.

**Cross-references:** Visual specs → `DESIGN.md`. Source documents → `docs/specs/*`, `docs/design/*`. Mockup library → `./mockups/`.
