# UX Scenarios — Overview

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 3 — UX Scenarios
**Date:** 2026-09-15
**Author:** Saga (WDS Analyst)
**Companion documents:** `01-patient-books-appointment/`, `02-doctor-resolves-schedule-change/`, `03-receptionist-walkin-and-cancel/`, `04-admin-branch-hours-change/`, `05-admin-branch-deactivation/`, `../B-Trigger-Map/trigger-map.md`, `../B-Trigger-Map/feature-impact-analysis.md`

---

## Purpose

This document is the cross-scenario index. It maps scenarios to personas, business goals, P0 features, and pages. Each scenario folder contains its own detailed 8-question dialog and per-page specifications for Phase 4.

---

## Scenario summary

| # | Scenario | Persona | Primary business goal | P0 features exercised | Pages |
|---|---|---|---|---|---|
| **S-01** | Patient books an appointment | Maya (Patient) | BG-1, BG-2, BG-3 | F-01, F-02, F-03, F-05, F-29 | 8 |
| **S-02** | Doctor resolves a schedule change | Dr. Ahmed (Doctor) | BG-3, BG-4 | F-08, F-09, F-10, F-29 | 7 |
| **S-03** | Receptionist manages today's branch | Hala (Receptionist) | BG-1, BG-3, BG-4 | F-16, F-17, F-18, F-19, F-20, F-29 | 4 |
| **S-04** | Admin changes branch hours | Omar (Administrator) | BG-3 | F-22, F-25, F-26, F-29 | 5 |
| **S-05** | Admin deactivates a branch | Omar (Administrator) | BG-3 | F-21, F-29 | 1 (reuses 2) |

---

## Page assignments by surface

### Patient-facing surfaces (mobile-first)

| Page | Scenario | Folder |
|---|---|---|
| Doctor list | S-01 | `01-patient-books-appointment/pages/01.1-doctor-list/` |
| Branch picker | S-01 | `01-patient-books-appointment/pages/01.2-branch-picker/` |
| Appointment type picker | S-01 | `01-patient-books-appointment/pages/01.3-appointment-type-picker/` |
| Slot picker | S-01 | `01-patient-books-appointment/pages/01.4-slot-picker/` |
| Contact info | S-01 | `01-patient-books-appointment/pages/01.5-contact-info/` |
| Confirmation (receipt) | S-01 | `01-patient-books-appointment/pages/01.6-confirmation/` |
| OTP verification | S-01 | `01-patient-books-appointment/pages/01.7-otp-verification/` |
| Patient dashboard | S-01 | `01-patient-books-appointment/pages/01.8-patient-dashboard/` |

### Doctor-facing surfaces (tablet-first)

| Page | Scenario | Folder |
|---|---|---|
| Doctor home | S-02 | `02-doctor-resolves-schedule-change/pages/2.1-doctor-home/` |
| Branch picker (schedule edit) | S-02 | `02-doctor-resolves-schedule-change/pages/2.2-branch-picker/` |
| Schedule editor | S-02 | `02-doctor-resolves-schedule-change/pages/2.3-schedule-editor/` |
| Conflict preview | S-02 | `02-doctor-resolves-schedule-change/pages/2.4-conflict-preview/` |
| Conflict resolution inbox | S-02 | `02-doctor-resolves-schedule-change/pages/2.5-conflict-resolution-inbox/` |
| Affected appointment detail | S-02 | `02-doctor-resolves-schedule-change/pages/2.6-affected-appointment-detail/` |
| Resolution confirmation | S-02 | `02-doctor-resolves-schedule-change/pages/2.7-resolution-confirmation/` |

### Receptionist-facing surfaces (tablet-first)

| Page | Scenario | Folder |
|---|---|---|
| Day queue (home) | S-03 | `03-receptionist-walkin-and-cancel/pages/3.1-day-queue/` |
| Walk-in booking | S-03 | `03-receptionist-walkin-and-cancel/pages/3.2-walk-in-booking/` |
| Confirmation modal | S-03 | `03-receptionist-walkin-and-cancel/pages/3.3-confirmation-modal/` |
| Cancel modal | S-03 | `03-receptionist-walkin-and-cancel/pages/3.4-cancel-modal/` |

### Administrator-facing surfaces (desktop-first)

| Page | Scenario | Folder |
|---|---|---|
| Branch list | S-04 | `04-admin-branch-hours-change/pages/4.1-branch-list/` |
| Branch detail | S-04 | `04-admin-branch-hours-change/pages/4.2-branch-detail/` |
| Hours editor | S-04 | `04-admin-branch-hours-change/pages/4.3-hours-editor/` |
| Impact preview | S-04 | `04-admin-branch-hours-change/pages/4.4-impact-preview/` |
| Save + route confirmation | S-04 | `04-admin-branch-hours-change/pages/4.5-save-route-confirmation/` |
| Deactivate confirmation | S-05 | `05-admin-branch-deactivation/pages/5.1-deactivate-confirmation/` |

---

## Two distinct conflict flows — visual summary

This is the BRD §4.6 distinction rendered as a flow:

```
                  ┌───────────────────────────┐
                  │     Doctor-initiated      │
                  │     schedule change       │
                  └─────────────┬─────────────┘
                                │
                                ▼
                  ┌───────────────────────────┐
                  │   Affected appointments?  │
                  └─────────────┬─────────────┘
                                │
              ┌────── YES ──────┴────── NO ──────┐
              ▼                                 ▼
      ┌─────────────────────┐         ┌─────────────────────┐
      │   CHANGE REJECTED  │         │   CHANGE SAVED      │
      │   Resolve all first│         │                     │
      └─────────────────────┘         └─────────────────────┘

                  ┌───────────────────────────┐
                  │     Admin-initiated       │
                  │     branch-hours change   │
                  └─────────────┬─────────────┘
                                │
                                ▼
                  ┌───────────────────────────┐
                  │   Affected appointments?  │
                  └─────────────┬─────────────┘
                                │
              ┌────── YES ──────┴────── NO ──────┐
              ▼                                 ▼
      ┌─────────────────────┐         ┌─────────────────────┐
      │   CHANGE SAVED      │         │   CHANGE SAVED      │
      │   Routed to doctors │         │                     │
      │   for resolution    │         │                     │
      └─────────────────────┘         └─────────────────────┘
```

Both flows defend BG-3 (zero silent invalidation). The asymmetry is intentional — doctor's schedule is *their* commitment to patients; admin's branch-hours are *structural* and may legitimately change. The UX surfaces make this asymmetry visible.

---

## Reusable patterns established

These patterns will be lifted into Phase 7 (Design System) for component-level reuse.

| Pattern | Established in | Reused by |
|---|---|---|
| **Slot picker with real-time availability** | S-01 (1.4) | S-02 (2.6), S-03 (3.2), Phase 4 reschedule, recurring creation |
| **Atomic reservation submit** | S-01 (1.5) | All booking flows; canonical "atomic at the moment of truth" |
| **Receipt-style confirmation** | S-01 (1.6) | S-03 (3.3), Phase 4 reschedule confirmation |
| **OTP gate** | S-01 (1.7) | Single patient-auth pattern; reused for any patient return |
| **Specific, resolvable error messages** | S-01 (1.4, 1.5) | All error surfaces across the product |
| **Conflict preview panel** | S-02 (2.4) | S-04 (4.4), doctor's block-time edits (Phase 4) |
| **Resolution inbox** | S-02 (2.5) | S-04 routes admin-flagged conflicts to the same inbox |
| **Affected-appointment move modal** | S-02 (2.6) | Slot picker specialization with type-locked + patient-conflict-aware variants |
| **Day queue list** | S-03 (3.1) | Doctor's day view (S-02); reusable "today" surface |
| **Quick-pick reasons + free-text fallback** | S-03 (3.4) | Doctor's cancel-with-reason (S-02), any future staff action that requires audit |
| **Branch-filtered picker** | S-03 (3.2) | All receptionist surfaces |
| **Impact preview before save** | S-04 (4.4) | Branch deactivation (S-05), any future admin structural change |
| **Group-by-doctor affected list** | S-04 (4.4) | Any structural change that affects appointments |
| **Disabled-button-with-clear-message** | S-05 (5.1) | All admin gates (principle-defending pattern) |
| **Future-appointment count gate** | S-05 | Reusable for any admin action that could affect existing appointments |

---

## What is *not* in MVP — explicitly deferred

These features appear in the BRD/PRD but are out of scope for MVP (BRD §2.2 / PRD §14 Not-in-MVP). They are not scenarios in this phase:

- Patient-initiated recurring appointment creation (BR-048; patients cannot create recurring)
- Doctor's recurring appointment creation is supported (F-15) but its scenario is deferred to Phase 4 because it reuses the slot picker + booking flow.
- Receptionist's recurring appointment creation (BR-048) — same.
- Reschedule flow for the patient dashboard — the entry point exists (1.8 has "Reschedule" button) but the reschedule sub-flow is Phase 4 (reuses slot picker + atomic reservation + confirmation).
- Audit history viewer (BR-046) — audit records are written but no MVP UI views them. Phase 8 surface.
- Admin's doctor-onboarding wizard (F-23) — Phase 4 with reused patterns.
- Admin's receptionist-onboarding with reassignment (F-24) — Phase 4.
- Doctor's appointment-type CRUD (F-11) — Phase 4.

These are all built on patterns established in this phase. The right thing to do was to design the principle-defending flows first, then derive the secondary ones.

---

## Hand-off

Phase 4 (UX Design) takes every page folder under each scenario and produces:
- Component maps (atomic/molecular/organism decomposition)
- Interaction states and transitions
- Responsive behavior specs
- Sketch annotations (per WDS project outline `rendering-tool: excalidraw`)

Phase 7 (Design System) extracts the reusable patterns (§reusable patterns established above) into a component library that Phase 4 also draws from.

The scenarios will be revisited in Phase 8 (Evolution) when real usage data informs refinements.