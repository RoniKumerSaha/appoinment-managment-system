# UX Design — Multi-Branch Clinic Appointment Scheduling System

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 4 — UX Design
**Date:** 2026-09-15
**Author:** Sally (UX Designer)
**Source artifacts:** [`A-Product-Brief`](../A-Product-Brief/product-brief.md) · [`B-Trigger-Map`](../B-Trigger-Map/trigger-map.md) · [`C-UX-Scenarios`](../C-UX-Scenarios/scenario-overview.md) · [`DESIGN-SYSTEM`](../design/DESIGN-SYSTEM.md) · [`mockups/v1/`](../design/mockups/v1/)

---

## 1 · Scope and goals

Phase 4 turns the Phase 3 UX scenarios into visual specifications that the Phase 5 engineer can implement. Every screen is grounded in three sources:

1. **The product brief** — what we're building (visibility + accuracy + simple steps).
2. **The trigger map and personas** — who is doing what and why.
3. **The design system** — how it must look (Clinical Calm teal, Stacked Vertical Flow, ConflictModal pattern, semantic status pills).

Phase 4 does **not** introduce new design tokens, new component shapes, or new patterns. The design system is the source of truth; this document never extends it without updating it first.

## 2 · Strategy — use existing v1 as source of truth

The v1 mockup set already contained 31 screens covering all five Phase 3 scenarios. Strategy:

- **Use v1 directly** for screens that already match Phase 3 page specs.
- **Adjust surgically** when v1 is correct in pattern but missing a Phase 3 requirement (3 adjustments total — see §4).
- **Create new** only when a Phase 3 page has no v1 equivalent (5 net-new screens — see §5).

This kept the design system coherent, avoided redundant work, and produced a 36-screen deliverable that stakeholders can walk through end-to-end.

## 3 · Coverage matrix

| Phase 3 page | Scenario | Final mockup | Pattern |
|---|---|---|---|
| 1.1 Doctor list | S-01 Patient | `02-doctor-picker.html` | E · Card-First + Sidebar |
| 1.2 Branch picker | S-01 Patient | **`34-patient-branch-picker.html`** *(new)* | E · Stacked |
| 1.3 Type picker | S-01 Patient | **`35-patient-type-picker.html`** *(new)* | E · Stacked |
| 1.4 Slot picker | S-01 Patient | `03-availability-calendar.html` *(adjusted)* | E · Agenda Timeline |
| 1.5 Contact info | S-01 Patient | `04-patient-confirm.html` | E · Stacked |
| 1.6 Confirmation (receipt) | S-01 Patient | **`36-confirmation-receipt.html`** *(new)* | E · Stacked |
| 1.7 OTP verification | S-01 Patient | `05-patient-self-service.html` | E · Stacked |
| 1.8 Patient dashboard | S-01 Patient | `05-patient-self-service.html` | E · Stacked |
| 2.1 Doctor home | S-02 Doctor | `09-doctor-schedule.html` | B · List by Day + Tabs |
| 2.2 Branch picker (sched) | S-02 Doctor | `09-doctor-schedule.html` | B · Tabs |
| 2.3 Schedule editor | S-02 Doctor | `09-doctor-schedule.html` | B · Tabs |
| 2.4 Conflict preview | S-02 Doctor | `06-resolve-affected.html` | C · Kanban Queue |
| 2.5 Conflict resolution inbox | S-02 Doctor | `06-resolve-affected.html` | C · Kanban Queue |
| 2.6 Affected appt detail | S-02 Doctor | `24-doctor-resolve-one.html` | E · Stacked |
| 2.7 Resolution saved | S-02 Doctor | **`37-doctor-resolution-saved.html`** *(new)* | E · Stacked |
| 3.1 Day queue (recep) | S-03 Recep | `13-recep-today.html` *(adjusted)* | D · Card List by Hour |
| 3.2 Walk-in booking | S-03 Recep | `14-recep-create.html` | A · Stepped Form |
| 3.3 Confirmation modal | S-03 Recep | `26-recep-checkin.html` | D · Quick-Action |
| 3.4 Cancel modal | S-03 Recep | `15-recep-cancel.html` | E · Stacked |
| 4.1 Branch list | S-04 Admin | `17-admin-branches.html` | E · Stacked |
| 4.2 Branch detail | S-04 Admin | `17-admin-branches.html` + `28-admin-branch-hours-editor.html` | E · Stacked |
| 4.3 Hours editor | S-04 Admin | `28-admin-branch-hours-editor.html` | E · Stacked |
| 4.4 Impact preview | S-04 Admin | `08-branch-hours-impact.html` *(adjusted)* | E · Stacked |
| 4.5 Save + route | S-04 Admin | `08-branch-hours-impact.html` | E · Stacked |
| 5.1 Deactivate gate | S-05 Admin | **`38-admin-branch-deactivate.html`** *(new)* | E · Stacked |

## 4 · Surgical adjustments (3)

| Mockup | Adjustment | Source rule |
|---|---|---|
| `03-availability-calendar.html` | Added patient-conflict pre-warning row at top (yellow alert) | BR-031 / BR-033 — one future appt per doctor; surface conflict before submit, not at submit |
| `08-branch-hours-impact.html` | Added PRD §4.6 doctor-not-at-branch edge case section between steps 3 and 4, with required acknowledgment checkbox | PRD §4.6 / BRD §4.6 — admin must not silently invalidate; acknowledge before save |
| `13-recep-today.html` | Relabeled primary CTA "+ New appointment" → "+ Book walk-in" | Phase 3 spec §3.1 — recep walk-in is distinct from scheduled queue |

All three adjustments reuse existing tokens: `--warning-bg`, `--warning-border`, `--info-bg`, `--danger-bg`. No new colors introduced.

## 5 · Net-new screens (5)

All five follow the Stacked Vertical Flow (`E`) pattern, 760px center column, the design system surface tokens, the step-number primitive, and the audit-log row pattern.

### 5.1 `34-patient-branch-picker.html`
- **Why new:** Phase 3 split the booking flow into 8 pages; v1 had doctor+branch+type on a single screen.
- **Sections:** doctor-context pill (sticky top), branch cards, hours-this-week informational rows.
- **Tokens used:** `--surface-default`, `--surface-raised`, `--primary-500` selected state, branch-card pattern from `02`.

### 5.2 `35-patient-type-picker.html`
- **Why new:** Same as above — type picker was embedded in `02`.
- **Sections:** doctor+branch context pill, type cards with duration pill (top-right) and one-line description.
- **Tokens used:** `--type-card.selected` pattern from `02`, `--text-2xs` for duration.

### 5.3 `36-confirmation-receipt.html`
- **Why new:** Phase 3 separated contact-info (1.5) from confirmation (1.6) into two screens.
- **Sections:** success head, receipt card (doctor · specialty · date · time · branch · type · booking ref), primary CTA "View my appointments", secondary "Add to calendar", phone-call fallback.
- **Tokens used:** success state pattern, dashed booking-ref with mono font.

### 5.4 `37-doctor-resolution-saved.html`
- **Why new:** Phase 3 separated the *preview* (2.4 — before save) from the *saved state* (2.7 — after save). v1 had no dedicated save confirmation.
- **Sections:** "All N appointments resolved" hero, list of resolved actions (moved to slot X, cancelled, deferred), audit-log row sample, "Return to schedule" CTA.
- **Tokens used:** success state, audit-row pattern from `30`.

### 5.5 `38-admin-branch-deactivate.html`
- **Why new:** Branch deactivation is the principle-defending admin gate (BR-059). It must appear once, in a dedicated screen, with the disabled-button-with-clear-message pattern.
- **Sections:** hero "Deactivate Riyadh Diplomatic Quarter?", two state variants — **0 future appts** (success panel, enabled CTA) and **5 future appts** (danger panel, disabled CTA with clear "Resolve them →" link).
- **Tokens used:** `--success-bg` / `--danger-bg` semantic surfaces, disabled-button pattern.

## 6 · Pattern adherence

| Rule | Status |
|---|---|
| Clinical Calm teal `#0f766e` is the only primary color | ✓ |
| Status pills use semantic colors (info-blue, success, danger, warning) | ✓ |
| Stacked Vertical Flow (`E`) is the default pattern | ✓ — 27/36 picks |
| Sidebar `1fr 320px` only when a summary panel matters | ✓ |
| ConflictModal pattern = 3 parts (what happened / why / what you can do) | ✓ |
| Audit log row pattern = actor · action · target · time · reason | ✓ |
| Step-number primitive for stacked vertical flows | ✓ |
| Tabular numerics on time cells | ✓ |
| System font stack only | ✓ |
| WCAG 2.1 AA contrast | ✓ |
| No new tokens introduced | ✓ |

## 7 · The two distinct conflict flows

The principle-defending distinction from BRD §4.6 is preserved across the mockup set:

| Surface | Pattern | Patient details visible? |
|---|---|---|
| `06-resolve-affected.html` (doctor) | Kanban Queue | **Yes** — rich detail (patient name, time, options) |
| `08-branch-hours-impact.html` (admin) | Stacked Vertical | **No** — only appointment count + reason |
| `29-conflict-modal.html` (universal) | Modal | **Varies** by flow |

The asymmetry is intentional: doctor's surface is rich (resolution needs options), admin's surface is structural (oversight needs counts, not patient PII).

## 8 · Hand-off to Phase 5

- Every mockup links to `imports/app/design-system.css` for shared styles.
- Every cross-link is intercepted by `imports/app/standalone-router.js`.
- The connected app shell at `imports/app/index.html` lets stakeholders click through all 36 mockups.
- Component primitives are templated in `imports/app/components.html` — Phase 5 implementation pulls these templates.

The **atomic reservation** pattern (PRD §10) and the **audit-log row** pattern (FR-051) are the backend contracts. Phase 5 reads them off the mockups directly.

## 9 · Status

✅ **Phase 4 complete.** 36/36 mockups ready for engineering.
