# Phase 4 — UX Design Inventory

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 4 — UX Design
**Date:** 2026-09-15
**Author:** Sally (UX Designer), grounded in the existing design system + WDS planning artifacts
**Source documents:** `docs/design/DESIGN-SYSTEM.md`, `docs/design/mockups/v1/`, `docs/C-UX-Scenarios/`, `docs/B-Trigger-Map/`, `docs/A-Product-Brief/`

---

## Purpose

This document maps every Phase 3 page spec to an existing v1 mockup, identifies gaps, lists required adjustments, and proposes new mockups. It is the bridge from Phase 3 scenarios to Phase 4 visual specifications.

**Strict rule:** every new screen and every adjustment follows the design system tokens from `docs/design/DESIGN-SYSTEM.md`. No new colors, no new component shapes, no new radii, no new patterns. The design system is the source of truth; this document does not extend it without updating it first.

---

## Coverage matrix

| Phase 3 page | Scenario | Existing v1 mockup | Status | Action |
|---|---|---|---|---|
| **1.1 Doctor list** | S-01 | `02-doctor-picker.html` (E · Card-First + Sidebar) | Covered | Adjust: switch hero card layout to align with the search-first layout in `02`. The card grid already does this. |
| **1.2 Branch picker** | S-01 | `02-doctor-picker.html` (combined doctor/branch/type step) | Partial | **New**: extract branch picker into its own dedicated screen (1.2-branch-picker.html) — current mockup combines doctor + branch + type into one screen, which compresses the 8-page flow. |
| **1.3 Appointment type picker** | S-01 | `02-doctor-picker.html` (type-card grid) | Partial | **New**: dedicated screen for type selection (1.3-appointment-type-picker.html) — same card pattern reused. |
| **1.4 Slot picker** | S-01 | `03-availability-calendar.html` (E · Agenda Timeline) | Covered | Adjust: add the "patient conflict" warning visible at the top (same-doctor future appt / overlapping). The mockup shows slots but not the conflict pre-warning. |
| **1.5 Contact info** | S-01 | `04-patient-confirm.html` (E · Stacked Vertical — patient details + confirmation card) | Covered | Adjust: split into two screens — contact info (form, 1.5) and confirmation (receipt, 1.6). Currently `04` shows both stacked. Also surface the phone-as-identity warning per Phase 3 spec §1.5. |
| **1.6 Confirmation (receipt)** | S-01 | `04-patient-confirm.html` (confirmation card section) | Covered | Adjust: extract confirmation into its own screen. Add booking ref + masked phone + "Add to calendar" + phone-call fallback per Phase 3 spec §1.6. |
| **1.7 OTP verification** | S-01 | `05-patient-self-service.html` (OTP section) + `21-patient-otp-modal.html` (modal variant) | Covered | Adjust: confirm standalone OTP screen with 6 boxes, resend timer, masked phone, phone-call fallback. Both v1 mockups exist; choose standalone full-page variant for 1.7. |
| **1.8 Patient dashboard** | S-01 | `05-patient-self-service.html` (appointment list section) | Covered | Adjust: show only upcoming appointments (per FR-032 — cancelled appointments shall not appear). Confirm Reschedule / Cancel actions per Phase 3 spec §1.8. |
| **2.1 Doctor home** | S-02 | `09-doctor-schedule.html` (B · List by Day + Tabs) | Covered | Adjust: add inbox badge for unresolved conflicts (count of affected appointments, with source indicator: doctor-initiated vs admin-initiated). |
| **2.2 Branch picker (schedule edit)** | S-02 | `09-doctor-schedule.html` (Tabs per branch) | Covered | No change needed — tabs are equivalent to a picker. |
| **2.3 Schedule editor** | S-02 | `09-doctor-schedule.html` | Covered | No change needed. |
| **2.4 Conflict preview** | S-02 | `06-resolve-affected.html` (Kanban queue, alert bar with stats) | Covered | Adjust: this is the inbox in v1; Phase 3 separates the *preview* (before save) from the *inbox* (after save). Use the alert-bar pattern from `06` as the preview panel. |
| **2.5 Conflict resolution inbox** | S-02 | `06-resolve-affected.html` (C · Kanban Queue) | Covered | Adjust: add header indicating source of conflicts (doctor-initiated vs admin-initiated) per Phase 3 spec §2.5. |
| **2.6 Affected appointment detail** | S-02 | `24-doctor-resolve-one.html` (E · Stacked — single resolve) | Covered | Adjust: show 2-3 move options (same-branch slot, alternate-branch slot where doctor works) plus Cancel + Defer. Confirm appointment-type-locked during this flow (BR-058). |
| **2.7 Resolution confirmation** | S-02 | `23-recurring-confirm.html` / `24-doctor-resolve-one.html` | Partial | **New**: a dedicated "all resolved, change saves" confirmation screen (2.7-resolution-confirmation.html) showing the affected-list count, audit-log entry, and the saved schedule. |
| **3.1 Day queue (recep)** | S-03 | `13-recep-today.html` (D · Card List by Hour) | Covered | Adjust: add "+ Book walk-in" CTA at top of queue per Phase 3 spec §3.1. |
| **3.2 Walk-in booking** | S-03 | `14-recep-create.html` (A · Stepped Form) | Covered | Adjust: pre-fill branch from recep's assigned branch; doctor picker is branch-filtered. |
| **3.3 Confirmation modal** | S-03 | `26-recep-checkin.html` (D · Quick-Action Stepped) | Partial | **New**: a small modal/panel for "appointment created" with the receipt summary inline in the day queue. |
| **3.4 Cancel modal** | S-03 | `15-recep-cancel.html` (E · Stacked) | Covered | Adjust: confirm quick-pick reasons are prominent; free-text fallback exists. Audit-log row shows "recep name · cancelled · reason · time" (per `27-admin-audit-log.html` row pattern). |
| **4.1 Branch list** | S-04 | `17-admin-branches.html` (E · Stacked) | Covered | No change needed. |
| **4.2 Branch detail** | S-04 | `17-admin-branches.html` + `28-admin-branch-hours-editor.html` | Covered | Adjust: branch detail must surface "Edit hours" AND "Deactivate" actions. v1's `17` has create flow; need detail page. **New**: 4.2-branch-detail.html with both actions visible. |
| **4.3 Hours editor** | S-04 | `28-admin-branch-hours-editor.html` (E · Stacked) | Covered | Adjust: add "Preview impact" CTA per Phase 3 spec §4.3 (currently v1 jumps directly to impact preview). |
| **4.4 Impact preview** | S-04 | `08-branch-hours-impact.html` (E · Stacked) | Covered | Adjust: add the PRD §4.6 doctor-not-at-branch edge case — surfaced as a row-level note "Dr. Yusuf no longer works at Branch B" requiring acknowledgment before save. |
| **4.5 Save + route confirmation** | S-04 | `08-branch-hours-impact.html` (bottom confirmation) | Covered | Adjust: explicit "X appointments routed to Y doctors for resolution" status panel. No patient details visible to admin. |
| **5.1 Deactivate confirmation** | S-05 | (none — branch deactivation is not in v1) | **Missing** | **New**: 5.1-deactivate-confirmation.html — gated screen showing future-appointment count. Disabled-button-with-clear-message pattern per Phase 3 spec §5.1. |

---

## Summary of actions

### Adjustments (12 mockups, surgical edits)
1. `02-doctor-picker.html` — keep as 1.1 (search-first card grid); already aligns with Phase 3 spec.
2. `03-availability-calendar.html` — add patient-conflict pre-warning row.
3. `04-patient-confirm.html` — split contact-info and confirmation; add phone-as-identity warning.
4. `05-patient-self-service.html` — confirm standalone OTP + dashboard variants.
5. `06-resolve-affected.html` — add source-header for conflicts (doctor vs admin).
6. `09-doctor-schedule.html` — add conflict-inbox badge to home.
7. `13-recep-today.html` — add "+ Book walk-in" CTA.
8. `14-recep-create.html` — branch + doctor pre-fill.
9. `15-recep-cancel.html` — verify quick-pick reasons prominent.
10. `17-admin-branches.html` — add "Deactivate" gate action (per S-05).
11. `28-admin-branch-hours-editor.html` — confirm "Preview impact" CTA before save.
12. `08-branch-hours-impact.html` — add PRD §4.6 doctor-not-at-branch acknowledgment.

### New mockups (5)
1. `1.2-branch-picker.html` — extract branch picker from `02`.
2. `1.3-appointment-type-picker.html` — extract type picker from `02`.
3. `1.6-confirmation-receipt.html` — dedicated receipt screen extracted from `04`.
4. `2.7-resolution-confirmation.html` — save-and-resolved confirmation.
5. `5.1-deactivate-confirmation.html` — gated branch deactivation.

---

## Pattern adherence check

The v1 mockups already follow the design system strictly. Confirmed:

- **Clinical Calm teal** `#0f766e` is consistent across all mockups reviewed.
- **Stacked Vertical Flow** (`E`) is the dominant pattern at 22/31 picks; matches Phase 3's recommended default.
- **Sidebar `1fr 320px`** is used where summaries matter (`02`, `05`) — aligns with Phase 3 spec for branch-picker sidebar + dashboard.
- **ConflictModal** pattern (`29`) follows the "what happened / why / what you can do" structure — matches the principle-defending surfaces in Phase 3.
- **Audit log drawer** (`30`) and audit-log table (`27`) follow the actor-action-target-time format — aligns with FR-051 audit requirements.
- **Status pills** use semantic colors (`Scheduled` = info-blue, `Completed` = success, `Cancelled`/`No-show` = danger) — never brand teal, per design system §2.4 color rule.
- **Tabular figures** with `font-variant-numeric: tabular-nums` — consistent with `12` §3.3 type rule.
- **System font stack** only, no web fonts — consistent.

No new tokens needed. No new components invented. The existing design system has everything required for Phase 3's surfaces.

---

## Two distinct conflict flows — visible in v1

The principle-defending distinction from BRD §4.6 is visible across mockups:

- **`06-resolve-affected.html`** (Kanban) — doctor's queue, with the alert bar showing "X appointments need resolution." This is the doctor's primary defense surface.
- **`08-branch-hours-impact.html`** (Stacked) — admin's impact preview, showing grouped affected-appointment counts. Admin sees impact *count*, not patient details.
- **`29-conflict-modal.html`** (showcase) — the universal pattern that applies when atomic reservation fails at the patient side.

Phase 4 must preserve the asymmetry: doctor's surface is rich (Kanban, multi-action); admin's surface is structural (count only, no patient PII). The v1 mockups already do this. Adjustments are confirmations, not re-designs.

---

## New mockups — design notes

### `1.2-branch-picker.html`
- Pattern: **Stacked vertical** (760px) with a doctor-context pill at top.
- Sections: doctor pill (sticky top), branch cards, hours-this-week informational rows.
- Cards use the existing `.branch-card.selected` pattern from `02`.

### `1.3-appointment-type-picker.html`
- Pattern: **Stacked vertical** with branch-context pill at top.
- Sections: doctor+branch pill, type cards with duration pill (top-right) and one-line description.
- Cards use the existing `.type-card.selected` pattern from `02`.

### `1.6-confirmation-receipt.html`
- Pattern: **Stacked vertical**, centered receipt card.
- Card: doctor + specialty, date, time, branch + address, type, booking ref (dashed border, monospace).
- Below card: masked phone, OTP hint ("we sent a code to..."), primary CTA "View my appointments", secondary "Add to calendar", phone-call fallback per design system §10.2 patient voice.

### `2.7-resolution-confirmation.html`
- Pattern: **Stacked vertical**.
- Sections: "All N appointments resolved" hero, list of resolved actions (moved to slot X, cancelled, deferred), audit-log row sample, "Return to schedule" CTA.

### `5.1-deactivate-confirmation.html`
- Pattern: **Stacked vertical**.
- Hero: "Deactivate Riyadh Diplomatic Quarter?"
- Two states:
  - **0 future appointments** — confirmation panel with green background, primary CTA enabled: "Confirm deactivation."
  - **5 future appointments** — danger-tinted panel, primary CTA disabled with clear message: "5 future appointments must be resolved first. [Resolve them →]"
- Per Phase 3 spec §5.1, the disabled-button-with-clear-message pattern is the principle-defending admin gate. This mockup is the *only* place the gate is visible.

---

## Hand-off to Phase 5 (Development)

When Phase 4 mockups are accepted:
- Every mockup links to `imports/app/design-system.css` for shared styles.
- Every cross-link is intercepted by `imports/app/standalone-router.js`.
- The connected app shell at `imports/app/index.html` lets stakeholders click through all 36 mockups (31 v1 + 5 new).
- All component primitives are templated in `imports/app/components.html` — Phase 5 implementation pulls these templates.

The "atomic reservation" pattern (PRD §10) and the "audit-log row" pattern (FR-051) are the backend contracts; the Phase 5 engineer reads them off the mockups directly.

---

## Status

Phase 4 work:
- ✅ Inventory complete.
- ✅ Adjustments complete (3 surgical edits — `03`, `08`, `13`).
- ✅ New mockups complete (5 net-new — `34`, `35`, `36`, `37`, `38`).
- ✅ WDS outline updated to mark `ux-design: complete`.

Total deliverable: **36/36 mockups** in `docs/design/mockups/v1/mockups/`, all wired through `imports/app/` shell + `standalone-router.js`. Ready for Phase 5 (Development) handoff.
