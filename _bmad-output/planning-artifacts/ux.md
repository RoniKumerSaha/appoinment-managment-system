# UX — Multi-Branch Clinic Appointment Scheduling System

> **BMad planning artifact.** Derived from `docs/design/DESIGN-SYSTEM.md`, `docs/design/user-flows/*.md`, `docs/design/mockups/v1/winners/`, and the system flows in `docs/specs/UX-FLOWS.md`. The docs/design files remain the human-authored source.

## Source documents

- Visual language & tokens: `docs/design/DESIGN-SYSTEM.md` (canonical)
- Persona flows: `docs/design/user-flows/{patient,doctor,receptionist,admin}.md`
- Screen mockups (19 winners): `docs/design/mockups/v1/winners/01..19-*.html`
- System flows: `docs/specs/UX-FLOWS.md` (F-01…F-19)
- Consistency audit: `docs/design/user-flows/ux-consistency-report.md`
- Live reference HTML: `docs/design/mockups/v1/app/design-system.html`

---

## 1. Brand & tone

- **Working name:** MediSlot.
- **Archetype:** Modern clinical SaaS — Linear / Calendly, "not a hospital system."
- **Tone:** Clinical calm · confident · quietly precise · never cold.
- **One-sentence brand:** "Boring software that gets appointments right."
- **Anti-patterns:** skeuomorphic clipboards, red-alert over-use, stock-photo doctors, generic blue tech gradients.

---

## 2. Personas

| Persona | Role | Device | Core need |
|---|---|---|---|
| **Fatima A. Al-Sayed** (`+966 5XX XXX 5555`) | Patient (returning) | iPhone 13, mobile-first | Book/manage/cancel without an account |
| **Dr. Ahmed Al-Rashid** | Cardiologist across multiple branches | Desktop at clinic, iPad at home | See own schedule, mark outcomes, resolve flagged appts |
| **Reem Al-Harbi** | Receptionist at one branch | Desktop at front desk | Run the day for one branch only |
| **Salem Al-Mutairi** | Administrator | Desktop | Onboard/offboard, change branch hours, manage scope |

Voice by role (DESIGN-SYSTEM §10.2):

- **Patient** — friendly, plain, reassuring; second-person. "You're booked, Fatima."
- **Doctor** — concise, clinical. "Mark complete" / "Block 10:00–11:00."
- **Receptionist** — operational. "Pick the appointment. Reason. Confirm."
- **Admin** — authoritative, system-y. "Narrowing hours affects 14 appointments."

---

## 3. Canonical demo data (DESIGN-SYSTEM §12)

| Slot | Value |
|---|---|
| Patient | Fatima A. Al-Sayed · `+966 5XX XXX 5555` |
| Doctor | Dr. Ahmed Al-Rashid |
| Receptionist | Reem Al-Harbi |
| Admin | Salem Al-Mutairi |
| Branches | Riyadh Olaya, Riyadh Malqa, Jeddah Corniche, Riyadh Diplomatic Quarter |

Earlier mockups with "Branch A — Downtown / Branch B — Marina" are deprecated. Real names only.

---

## 4. Branches & visual scope

The repo currently has 4 canonical branches. Mockups v1 ship on a **single 1440 viewport**. Responsive breakpoints (`bp-sm/md/lg/xl`) are reserved for production but not yet visualized.

Phone format: `+966 5XX XXX 5555` (X segments are deliberately redacted).
Time: 24-hour clock everywhere; zero-padded `09:00`, never `9:00`.
Tabular figures: `font-variant-numeric: tabular-nums` on every time/duration/count.

---

## 5. Design tokens (binding)

Full table lives in `docs/design/DESIGN-SYSTEM.md` §2–6. The minimum that downstream skills must respect:

- **Primary:** `#0f766e` (teal). Status pills **never** use brand teal.
- **Status colors:** Scheduled = info-blue (`#dbeafe` / `#1e40af`); Completed = success; Cancelled & No-show = danger.
- **Type:** system stack only (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`). No web fonts.
- **Radii:** don't mix more than two on one screen; pick `radius-md` (8) **or** `radius-lg` (10) for cards; buttons always `radius-sm` (6).
- **Elevation:** clinical calm = flat by default. Use elevation only for hover/focus.
- **Selection halo:** ring on a `#f0fdfa` background — never a solid border swap.

---

## 6. Components (13)

| # | Component | Key rule |
|---|---|---|
| 7.1 | Button | 4 variants (primary / secondary / ghost / danger); **one** primary per visible region |
| 7.2 | Status pill | Round 999px, icon prefix, uppercase 10–11px |
| 7.3 | Card | `.card.selected` halo on `#f0fdfa`, not border swap |
| 7.4 | Section | Numbered head + body + actions for stacked-vertical flows |
| 7.5 | Field | 1.5px border, 10/12 padding, `:focus` brand ring; required = red asterisk |
| 7.6 | Modal | 3-part shape: what happened / why / what you can do. No OK-only conflicts |
| 7.7 | Toast | Top-right, auto-dismiss 3s, 4 tones (success / info / warn / error) |
| 7.8 | Empty state | Centered, icon + title + desc + optional CTA |
| 7.9 | Audit drawer | Right-side 480px, no patient PII across roles |
| 7.10 | Appointment card | Shared unit: date-block + body + status pill |
| 7.11 | Meta cell | 2-col key→value grid inside section bodies |
| 7.12 | Segmented control | Pill track, inner button radius-xs, brand ring on active |
| 7.13 | Step number | 26×26; future=light, current=filled+halo, completed=filled, danger=current-red |

---

## 7. Layout patterns (one per screen)

| Pattern | Width | Used by |
|---|---|---|
| Stacked vertical | 760px center | Most flows (F-04, F-06–F-11, F-13–F-19) |
| Sidebar split | `1fr 320px` | Patient self-service (F-03/F-05), doctor day (F-10) |
| Card grid | full, 3-col on ≥1024 | Admin lists |
| Kanban | full, 3-col | Resolve affected (F-09) |
| Agenda timeline | full | Doctor calendar |

**Rule:** every screen uses at most one pattern. Don't mix sidebar with kanban.

---

## 8. Conflict UX — the universal pattern

All conflicts surface through **ConflictModal** with three parts:

1. **What happened** — present-tense, plain language. "That slot was just booked."
2. **Why** — the rule. "Dr. Al-Rashid's Saturday 10:00 was claimed 12 seconds ago."
3. **What you can do** — two buttons max, with action verbs.

Forbidden: "OK"-only conflicts. The user must always have a "what's next" path.

---

## 9. Atomicity discipline

The server is the single source of truth for availability. The UI must:

- Never assume a slot is bookable based on stale data.
- Show "slot was just taken" gracefully, not as a system error.
- Never hold tentative slots client-side.

Rescheduling is reserve-new-then-release-old. If reserve fails, the original appointment is untouched.

---

## 10. Accessibility

- Target: **WCAG 2.1 AA**.
- Contrast: body on page 14.5:1 (AAA); faint `#9ca3af` is for disabled/placeholder only.
- Every interactive element has a visible focus ring (`:focus-visible` + `--ring-focus`).
- Modal traps focus; `Esc` closes; `Enter` triggers primary in ConflictModal.
- Touch targets ≥ 40×40 on mobile (mockups are desktop-only; production scales).
- Honor `prefers-reduced-motion`.

---

## 11. Screen inventory (mockups v1, 19 winners)

| # | Screen | Pattern | Persona |
|---|---|---|---|
| 01 | Layout direction | Sidebar split | (Pattern) |
| 02 | Doctor picker | Sidebar split | Patient |
| 03 | Availability calendar | Agenda timeline | Patient |
| 04 | Patient confirm | Stacked vertical | Patient |
| 05 | Patient self-service | Sidebar split | Patient |
| 06 | Resolve affected | Kanban | Doctor |
| 07 | Recurring preview | Stacked vertical | Doctor / Receptionist |
| 08 | Branch hours impact | Stacked vertical | Admin |
| 09 | Doctor schedule | List + tabs | Doctor |
| 10 | Doctor block time | Stacked vertical | Doctor |
| 11 | Appointment types | Stacked vertical | Doctor |
| 12 | Mark status | Quick-action sidebar | Doctor / Receptionist |
| 13 | Receptionist today | Card list by hour | Receptionist |
| 14 | Receptionist create | Stepped form | Receptionist |
| 15 | Receptionist cancel | Stacked vertical | Receptionist |
| 16 | Receptionist availability | Stacked vertical | Receptionist |
| 17 | Admin branches | Stacked vertical | Admin |
| 18 | Admin doctors | Card grid | Admin |
| 19 | Admin receptionists | Card grid | Admin |

---

## 12. Edge-case UX (from persona flows)

| Edge case | Surface |
|---|---|
| Slot lost to concurrent booking | ConflictModal: "That slot was just booked." |
| Existing phone has a future appt with same doctor | ConflictModal: "You already have an appointment with Dr. X." |
| Patient overlap with another doctor | ConflictModal: "You have another appointment at this time." |
| Same-day booking attempt | Calendar grays today with tooltip "Same-day booking unavailable" |
| Schedule change affects appts | Save blocked; AffectedAppointmentsTable opens; routes into Resolve |
| Branch-hours change affects appts | Saved, appts flagged for the assigned doctor; doctor's dashboard shows "Resolve (N)" badge |
| Recurring with mixed conflicts | RecurrenceResultPanel: created count + skipped with reasons |
| OTP doesn't arrive | Resend after 30s cooldown; 3-attempt cap with 10-min lockout |
| Deactivate branch with future appts | ConflictModal: "Branch has 14 future appointments. Deactivation not allowed." (BR-059) |

---

## 13. Open UX questions (carried from DESIGN-SYSTEM / persona flows)

1. Calendar visualization granularity (day/week/month) — DESIGN-SYSTEM.md §7.13.
2. Bulk conflict resolution for many affected appointments.
3. Tentative holds during in-progress reschedule (current design: none).
4. Phone reuse across family members (NFR-007 edge case).
5. iPad ergonomics for Kanban (cramped on smaller viewports).
6. Block & resolve atomicity: should blocks behave like schedule changes (rejected until resolved) or like branch-hours changes (saved + flagged)? Current mockups pick the former; designers are split.

---

## 14. Cross-cutting invariants for engineering

- **Time zone:** branch-local. Add `tz` to `Branch` (UX-FLOWS §6.4). UI timestamps labeled with branch tz.
- **No buffer, fixed window:** no buffer between appts; 30-day window fixed for MVP; same-day exclusion applies to recurring generation too.
- **Audit visibility:** internal-only. Doctors and receptionists see audit for appts they own; admins see configuration audits; patients never see audit.
- **Patient filtering:** all PII filtering is server-side. The client never receives appointments for other phone numbers.

---

**Next step:** `bmad-architecture` to derive the system architecture from this UX spec + the PRD.
