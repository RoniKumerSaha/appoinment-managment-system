# Feature Impact Analysis — Multi-Branch Clinic Scheduling

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 2 — Trigger Mapping (Feature Impact Analysis)
**Date:** 2026-09-15
**Author:** Saga (WDS Analyst)
**Companion documents:** `trigger-map.md`, `personas/*.md`, `../A-Product-Brief/product-brief.md`

---

## Purpose

Score the MVP candidate features by **trigger alignment** (does this feature serve a persona's positive goal or defend a negative goal?) and **business goal impact** (does moving this feature move a SMART business goal?). Features with high scores on both are the ones Phase 3 (UX Scenarios) should design first.

---

## Scoring rubric

### Trigger Alignment (TA) — 0 to 3
How strongly does this feature serve a persona's stated usage goal?

| Score | Meaning |
|---|---|
| **0** | No persona goal served |
| **1** | Tangentially serves one persona's goal |
| **2** | Directly serves one persona's goal, or tangentially serves two |
| **3** | Directly serves multiple personas' positive goals, or directly defends a negative goal (NG) |

### Business Goal Impact (BG) — 0 to 3
How directly does this feature move one or more SMART business goals?

| Score | Meaning |
|---|---|
| **0** | No SMART goal moved |
| **1** | Tangentially moves one SMART goal |
| **2** | Directly moves one SMART goal |
| **3** | Directly moves two or more SMART goals, OR defends BG-3 (zero silent invalidation) — the principle-defending goal |

### Combined Priority Score — TA × BG

| Range | Tier | Action |
|---|---|---|
| **9** | **P0 — Principle** | Phase 3 must-have scenario; design first |
| **6–8** | **P1 — Strategic** | Phase 3 scenario; design in this phase |
| **3–5** | **P2 — Operational** | Phase 4 design; smaller scenarios, reused components |
| **1–2** | **P3 — Utility** | Phase 4 / 7 design system; component-driven |
| **0** | Drop or defer | Out of scope for MVP |

---

## Feature inventory

The MVP must-have list comes from BRD §2.1 + PRD §14 "Must Have." I've grouped features into design surfaces so scoring reflects user-visible units, not backend capabilities.

### Patient-facing surfaces

| # | Feature surface | Personas | TA | BG | Score | Tier |
|---|---|---|---|---|---|---|
| **F-01** | **Guest booking flow** (Doctor → Branch → Appointment Type → Date → Time → Name + Phone → Confirmation) | Patient | 3 (PG-P1, PG-P2, PG-P3) | 3 (BG-1, BG-2, BG-3) | **9** | **P0** |
| **F-02** | **Receipt-style confirmation screen** | Patient | 3 (PG-P3, PG-P4) | 2 (BG-2, BG-3) | **6** | **P1** |
| **F-03** | **OTP verification & patient dashboard** (upcoming appointments, mobile-first) | Patient | 3 (PG-P4, NG-P3) | 3 (BG-3, BG-5) | **9** | **P0** |
| **F-04** | **Patient cancel-anytime** (no reason required) | Patient | 2 (PG-P5, NG-P1) | 2 (BG-3, BG-5) | **4** | **P2** |
| **F-05** | **Patient reschedule** (same doctor, branch/type/date/time flexible) | Patient | 3 (PG-P5, NG-P2) | 3 (BG-3, BG-5) | **9** | **P0** |
| **F-06** | **Returning-patient name lookup** (phone → stored name, editable) | Patient | 2 (PG-P2) | 1 (BG-1) | **2** | **P3** |
| **F-07** | **Booking error messages** (specific, resolvable) | Patient | 3 (NG-P2) | 2 (BG-2, BG-3) | **6** | **P1** |

### Doctor-facing surfaces

| # | Feature surface | Personas | TA | BG | Score | Tier |
|---|---|---|---|---|---|---|
| **F-08** | **Doctor branch-scoped schedule editor** (multi-period per day, effective date) | Doctor | 3 (PG-D1, PG-D2) | 3 (BG-3, BG-4) | **9** | **P0** |
| **F-09** | **Conflict preview on schedule save** (affected appointments shown inline) | Doctor | 3 (NG-D2) | 3 (BG-3) | **9** | **P0** |
| **F-10** | **Doctor conflict-resolution inbox** (one screen, one action per appointment) | Doctor | 3 (NG-D1, PG-D5) | 3 (BG-3, BG-4) | **9** | **P0** |
| **F-11** | **Doctor appointment-type CRUD** (name, duration, active/inactive) | Doctor | 2 (PG-D4) | 2 (BG-4) | **4** | **P2** |
| **F-12** | **Doctor day view** (grouped by branch) | Doctor | 3 (PG-D2) | 2 (BG-4) | **6** | **P1** |
| **F-13** | **Doctor block time** (single-date, time, multi-day) with conflict check | Doctor | 2 (PG-D3, NG-D3) | 3 (BG-3) | **6** | **P1** |
| **F-14** | **Doctor appointment status transitions** (Completed, No-show, Cancelled with reason) | Doctor | 2 (PG-D5, NG-D5) | 2 (BG-3, BG-4) | **4** | **P2** |
| **F-15** | **Doctor recurring appointment creation** (per-occurrence validation, partial success display) | Doctor | 3 (PG-D1) | 2 (BG-4) | **6** | **P1** |

### Receptionist-facing surfaces

| # | Feature surface | Personas | TA | BG | Score | Tier |
|---|---|---|---|---|---|---|
| **F-16** | **Receptionist day queue home** (today, branch-filtered, status pills, one-tap actions) | Receptionist | 3 (PG-R1, PG-R5) | 3 (BG-1, BG-4) | **9** | **P0** |
| **F-17** | **Receptionist walk-in booking** (mirrors patient flow, branch + doctor pre-selected) | Receptionist | 3 (PG-R2) | 2 (BG-1) | **6** | **P1** |
| **F-18** | **Receptionist cancellation with quick-pick reason** | Receptionist | 3 (PG-R3) | 3 (BG-3) | **9** | **P0** |
| **F-19** | **Receptionist status transitions** (one-tap Complete, No-show, with confirm) | Receptionist | 3 (PG-R4) | 2 (BG-4) | **6** | **P1** |
| **F-20** | **Receptionist branch-isolation guarantee** (UI filters by assigned branch) | Receptionist | 3 (PG-R5, NG-R1) | 3 (BG-3) | **9** | **P0** |

### Administrator-facing surfaces

| # | Feature surface | Personas | TA | BG | Score | Tier |
|---|---|---|---|---|---|---|
| **F-21** | **Admin branch management** (create, deactivate with future-appointment gate) | Administrator | 3 (PG-A4, NG-A3) | 3 (BG-3) | **9** | **P0** |
| **F-22** | **Admin branch-hours edit with impact preview** (X appointments affected across Y doctors) | Administrator | 3 (PG-A2, NG-A1) | 3 (BG-3) | **9** | **P0** |
| **F-23** | **Admin doctor onboarding & assignment** (create, branch assign, deactivate) | Administrator | 2 (PG-A3) | 2 (BG-4) | **4** | **P2** |
| **F-24** | **Admin receptionist onboarding** (create, branch assign, deactivate with reassignment) | Administrator | 2 (NG-A4) | 2 (BG-4) | **4** | **P2** |
| **F-25** | **Admin branch-hours flag-and-route** (affected appointments routed to doctor's inbox, admin sees status only) | Administrator | 3 (PG-A5, NG-A2) | 3 (BG-3) | **9** | **P0** |
| **F-26** | **Admin doctor-no-longer-at-branch edge case** (gated, refuses edit until reassigned/cancelled) | Administrator | 3 (NG-A5) | 3 (BG-3) | **9** | **P0** |

### Cross-cutting surfaces

| # | Feature surface | Personas | TA | BG | Score | Tier |
|---|---|---|---|---|---|---|
| **F-27** | **Atomic slot reservation engine** (backend) | All | 3 (NG-P2, NG-R3) | 3 (BG-3) | **9** | **P0** |
| **F-28** | **Audit log surface** (admin/system operator view of changes) | Doctor, Administrator | 1 (NG-D5) | 1 (BG-3) | **1** | **P3** |
| **F-29** | **Role-based & branch-based access control** (enforced at API + UI) | All | 3 (PG-R5, NG-R1, NG-A1) | 3 (BG-3) | **9** | **P0** |
| **F-30** | **30-day booking window + no-same-day rule** (engine constraint, surfaced in UX) | Patient, Doctor, Receptionist | 2 (PG-P2, NG-P2) | 2 (BG-1, BG-3) | **4** | **P2** |

---

## P0 priority list (must design first)

These 12 features are the principle-defending, business-defining MVP core. Phase 3 must produce scenarios for every one.

| # | Feature | Primary persona | Why P0 |
|---|---|---|---|
| **F-01** | Guest booking flow | Patient | The growth engine; 90s target lives here |
| **F-03** | OTP verification & patient dashboard | Patient | The visibility half of the promise |
| **F-05** | Patient reschedule | Patient | Where silent invalidation would hurt most |
| **F-08** | Doctor branch-scoped schedule editor | Doctor | Self-service independence |
| **F-09** | Conflict preview on schedule save | Doctor | Defends BG-3 from the doctor's side |
| **F-10** | Doctor conflict-resolution inbox | Doctor | The highest-leverage staff UX |
| **F-16** | Receptionist day queue home | Receptionist | Operational force-multiplier |
| **F-18** | Receptionist cancellation with quick-pick reason | Receptionist | Branch-isolated, audit-clean |
| **F-20** | Receptionist branch-isolation guarantee | Receptionist | Safety as focus, not restriction |
| **F-21** | Admin branch management | Administrator | Structural safety |
| **F-22** | Admin branch-hours edit with impact preview | Administrator | Defends BG-3 from the admin side |
| **F-25** | Admin branch-hours flag-and-route | Administrator | Handoff, not ownership |
| **F-26** | Admin doctor-no-longer-at-branch edge case | Administrator | The trust-breaking edge case |
| **F-27** | Atomic slot reservation engine | All | The architectural core |
| **F-29** | Role-based & branch-based access control | All | Defends every persona's negative goal |

That's 15 P0 features. Phase 3 will produce scenarios for each.

---

## P1 features (design in this phase, but secondary)

These 8 features are strategic but secondary — design them in Phase 3 or 4 with reused components from P0 work.

| # | Feature | Notes |
|---|---|---|
| F-02 | Receipt-style confirmation screen | Pattern; reuse from F-01 |
| F-07 | Booking error messages | Pattern; reuse across all flows |
| F-12 | Doctor day view | Reuse receptionist's queue pattern (F-16) |
| F-13 | Doctor block time | Reuse conflict-preview pattern (F-09) |
| F-15 | Doctor recurring appointment creation | Reuse booking flow (F-01) with series wrapper |
| F-17 | Receptionist walk-in booking | Reuse patient flow (F-01) with branch defaults |
| F-19 | Receptionist status transitions | Reuse doctor status pattern (F-14) |

---

## P2 / P3 features (utility, design-system-driven)

- **P2 (operational):** F-04, F-11, F-14, F-23, F-24, F-30
- **P3 (utility):** F-06, F-28

These are addressable in Phase 4 / 7 (Design System) work and don't need their own Phase 3 scenarios.

---

## Recommended Phase 3 starting scenarios

Two scenarios I'd recommend running first via the WDS 8-question dialog. These are the highest-leverage journeys and exercise the principle-defending surfaces directly.

### Scenario S-01 — *I just need to book this one appointment*
- **Persona:** Maya (Patient)
- **Exercises:** F-01 → F-02 → F-03 (booking → confirmation → dashboard)
- **Defends:** BG-1, BG-2, BG-3 (visibility, speed, accuracy at confirmation)
- **Pages produced:** doctor list, branch picker, appointment-type picker, slot picker, contact-info, confirmation screen, OTP verification, patient dashboard.

### Scenario S-02 — *I have to fix my schedule change without upsetting my patients*
- **Persona:** Dr. Ahmed (Doctor)
- **Exercises:** F-08 → F-09 → F-10 (schedule edit → conflict preview → resolution inbox)
- **Defends:** BG-3, BG-4 (zero silent invalidation, operational independence)
- **Pages produced:** branch schedule editor, conflict preview panel, conflict-resolution inbox, affected-appointment detail, reschedule-affected modal.

These two scenarios cover the principle-defending surfaces from the patient side and the doctor side. After they are designed, the receptionist and admin scenarios (S-03 through S-07) can follow with reused components.

---

## Hand-off

Phase 2 is complete when:
- Personas exist with psychological depth (`personas/*.md`).
- Business goals are SMART and source-anchored (`trigger-map.md` §2).
- Each business goal has a primary mover persona (`trigger-map.md` §3).
- Each persona has at least one positive and one negative goal with design implications (`trigger-map.md` §5).
- Features are ranked by trigger alignment × business goal impact (this document).

Phase 3 (UX Scenarios) takes the P0 features and runs the 8-question dialog on each recommended scenario.
