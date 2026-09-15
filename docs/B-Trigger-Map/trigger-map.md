# Trigger Map & Personas — Multi-Branch Clinic Scheduling

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 2 — Trigger Mapping
**Date:** 2026-09-15
**Author:** Saga (WDS Analyst), in conversation with BS01719
**Companion documents:** `personas/01-patient.md`, `personas/02-doctor.md`, `personas/03-receptionist.md`, `personas/04-administrator.md`, `feature-impact-analysis.md`, `../A-Product-Brief/product-brief.md`

---

## 1. Vision

> **A clinic can promise every patient, every time, an appointment that is real and will still be real when they arrive.**

This is the product promise from the Product Brief, restated as a business vision. Every business goal, persona, and feature below serves it.

---

## 2. Business Goals (SMART)

These are the five business outcomes the product must move. Each is mapped to source documents.

| # | SMART goal | Target | Source / anchor |
|---|---|---|---|
| **BG-1 Easy adoption** | ≥ 70% of new patient bookings complete online (no phone fallback) within 60 days of clinic launch | Per-clinic | BRD §5.1, BRD §4 Patient Booking flow, PRD §16 Booking success rate |
| **BG-2 Trust at confirmation** | Average time-to-booking < 90 seconds (provisional) | Per-clinic, per-patient flow | PRD §16 Booking, NFR-008 (≤ 2s for availability queries) |
| **BG-3 Zero silent invalidation** | Zero double-booking incidents and zero schedule-conflict incidents per month | Global | PRD §18 principle, BRD §4.6, NFR-001 |
| **BG-4 Operational independence** | ≥ 80% of doctor schedule changes self-serve without staff intervention within 90 days | Per-doctor | BRD §5.5, PRD §5 doctor capability matrix |
| **BG-5 Patient self-service** | ≥ 60% of patient cancellations and reschedules happen via OTP self-service (vs. phone) within 60 days | Per-clinic | BRD §5.7, PRD §5 patient capability matrix |

**Why these five.** BG-1 + BG-2 are the *easy* half of the product promise. BG-3 is the *accuracy* half — the principle-defending number. BG-4 keeps the clinic's value proposition real. BG-5 proves the patient-side dashboard is being used.

**Honestly held back.** No-show reduction, completed-appointment rate, recurring-skip rate — these have no baselines in BRD/PRD. We baseline-collect for 30 days post-launch, then add SMART targets in Phase 8 (Evolution).

---

## 3. Target Groups

Each business goal is moved by a specific user group. The map below is how strategy becomes design surface.

| Business goal | Primary mover | Supporting mover | Why this mapping |
|---|---|---|---|
| **BG-1 Easy adoption** | Patient | Receptionist (for walk-ins) | Online booking is the growth engine; receptionist booking is the same flow on staff surfaces |
| **BG-2 Trust at confirmation** | Patient | Doctor (informs schedule correctness) | Speed is patient-side; underlying accuracy is doctor-side |
| **BG-3 Zero silent invalidation** | Doctor | Administrator | Doctor refuses destructive changes; admin flags-but-doesn't-silently-invalidate |
| **BG-4 Operational independence** | Doctor | — | Schedule changes self-serve at the doctor level |
| **BG-5 Patient self-service** | Patient | — | OTP is the only patient auth path; cancel/reschedule are patient-initiated |

**Cross-check against BRD/PRD.** Patient moves BG-1, BG-2, BG-5 — consistent with BRD §3.1 patient capabilities (browse, select, book, cancel, reschedule). Doctor moves BG-2 (via schedule correctness), BG-3, BG-4 — consistent with BRD §3.2. Administrator moves BG-3 (via branch-hours flag flow) — consistent with BRD §3.4 / BRD §4.6 clarification. Receptionist has no SMART goal of her own; she's the operational force-multiplier.

---

## 4. Personas (summary — depth in companion docs)

| # | Persona | Core psychological state | Trigger signature |
|---|---|---|---|
| 01 | **Patient — Maya** | Anxious, time-pressed, on mobile, distrustful of silent changes | PG: real confirmation, easy booking. NG: silent changes, fake slots |
| 02 | **Doctor — Dr. Ahmed** | Schedule-disciplined, doesn't want to be cleanup crew | PG: branch-aware control, single-screen edits. NG: invalidating changes, manual cleanup |
| 03 | **Receptionist — Hala** | Fast, branch-bound, multitasking | PG: branch-filtered queue, one-tap statuses. NG: cross-branch accidents, double-bookings she caused |
| 04 | **Administrator — Omar** | Structural, not operational | PG: impact previews, gated actions. NG: silently breaking patients, owning conflict resolution |

Each persona has a dedicated deep-dive in `personas/0X-name.md`. Those are the source of truth; this section is the summary for the trigger map.

---

## 5. Usage Goals — positive and negative

For each persona, the positive pulls (PG) and negative fears (NG) that drive behavior. Each row is connected to the business goal(s) it serves and the design surface it implies.

### 5.1 Patient

| # | Goal | BG served | Design implication |
|---|---|---|---|
| **PG-P1** | Find a doctor I trust, near me, soon | BG-1 | Search-first UX; doctor + branch + time in one screen |
| **PG-P2** | Book without friction | BG-1, BG-2 | 90s target; minimum fields; no account |
| **PG-P3** | Get a real confirmation | BG-2, BG-3 | Receipt-style confirmation screen |
| **PG-P4** | See my appointment any time | BG-5 | OTP-verified dashboard, mobile-first |
| **PG-P5** | Change my mind without guilt | BG-5 | Cancel-anytime, no reason required |
| **NG-P1** | A silent change to my appointment | BG-3 | All change surfaces must surface, not hide |
| **NG-P2** | A slot that turns out to be fake | BG-2, BG-3 | Atomic reservation; explicit unavailability messages |
| **NG-P3** | Having to call back to verify | BG-5 | OTP is the only verification; don't add phone callbacks |
| **NG-P4** | Carrying doctor info in my head | BG-5 | Doctor + branch + time always shown together |
| **NG-P5** | Tying a relative's phone to my booking | BG-5 | Surface this limitation; don't pretend it doesn't exist |

### 5.2 Doctor

| # | Goal | BG served | Design implication |
|---|---|---|---|
| **PG-D1** | Define availability once per branch | BG-4 | Branch-scoped schedule editor with reuse |
| **PG-D2** | See his day clearly | BG-4 | Day view grouped by branch |
| **PG-D3** | Block time without breaking patients | BG-3, BG-4 | Inline affected-appointment preview before save |
| **PG-D4** | Manage his own service menu | BG-4 | Doctor appointment-type CRUD |
| **PG-D5** | Move an affected patient to a slot that works | BG-3, BG-4 | One-tap reschedule to suggested slot |
| **NG-D1** | Being made the cleanup crew by admin | BG-3 | Conflict-resolution inbox, not ad-hoc calls |
| **NG-D2** | Saving a destructive change silently | BG-3 | System refuses, doesn't warn-and-proceed |
| **NG-D3** | A patient in a slot he thought was blocked | BG-3 | Blocks gate behind conflict check |
| **NG-D4** | Tools that show him everything the receptionist sees | BG-4 | Doctor UI ≠ receptionist UI |
| **NG-D5** | Cancellation drama | BG-4 | Reason is for audit, never shown to patient |

### 5.3 Receptionist

| # | Goal | BG served | Design implication |
|---|---|---|---|
| **PG-R1** | See today, at a glance | BG-1, BG-4 | Day queue home screen |
| **PG-R2** | Book for a walk-in as fast as the website | BG-1 | Same flow as patient, branch + doctor pre-selected |
| **PG-R3** | Cancel with a reason, audit clean | BG-3 | Quick-pick reasons + free text fallback |
| **PG-R4** | Mark statuses without typing | BG-4 | One-tap status transitions with confirm |
| **PG-R5** | Not see Branch B's patients | BG-1, BG-3 | Branch isolation as focus, not restriction |
| **NG-R1** | Accidentally booking Branch B's doctor | BG-1, BG-3 | Doctor picker is branch-filtered by default |
| **NG-R2** | Being the messenger for an admin change | BG-3 | Admin's branch-hours change shows in admin UI, not hers |
| **NG-R3** | A double-booking she made | BG-3 | System enforces atomic reservation; UI prevents conflict |
| **NG-R4** | Tools that look like the doctor's | BG-4 | Role surfaces are visually distinct |
| **NG-R5** | Typing cancellation reasons on a phone | BG-4 | Quick-pick reasons, tablet-optimized |

### 5.4 Administrator

| # | Goal | BG served | Design implication |
|---|---|---|---|
| **PG-A1** | Manage structure without entering the appointment loop | BG-3, BG-4 | No appointment screens in admin UI |
| **PG-A2** | See impact before saving | BG-3 | Impact preview on every structural change |
| **PG-A3** | Onboard a doctor in one sitting | BG-4 | Doctor-onboarding wizard with branch assignment + appointment types |
| **PG-A4** | Deactivate cleanly | BG-3, BG-4 | Gated deactivation: refuses if future appointments exist |
| **PG-A5** | Hand off conflict resolution to the right doctor | BG-3 | Affected appointments route to doctor's inbox, not admin's |
| **NG-A1** | Changing branch hours and silently invalidating | BG-3 | Branch-hours change flags affected appointments before save |
| **NG-A2** | Being asked to resolve appointment conflicts | BG-3 | Admin never sees patient details for conflict resolution |
| **NG-A3** | Deactivating a branch with future appointments | BG-3 | Deactivation refuses if any future appointment exists |
| **NG-A4** | Orphaned receptionists | BG-4 | Deactivation requires reassignment of future-touchable actions |
| **NG-A5** | Branch-hours change when assigned doctor no longer works there | BG-3 | Edge case surfaced in PRD §4.6; must be gated |

---

## 6. Visual Trigger Map

This is the strategic connection diagram in text form. Render in Excalidraw per project outline (`rendering-tool: excalidraw`).

```
                ┌───────────────────────────────────────────────┐
                │              BUSINESS VISION                  │
                │   "Real appointments. Always real."           │
                └───────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   ┌─────────┐              ┌─────────────┐              ┌──────────┐
   │  BG-1   │              │    BG-3     │              │  BG-4    │
   │  Easy   │              │  Zero       │              │  Ops     │
   │ adoption│              │  silent     │              │  indep.  │
   └─────────┘              │  invalid.   │              └──────────┘
        │                   └─────────────┘                   │
        ▼                           │                           ▼
   ┌─────────┐                      │                  ┌─────────────┐
   │  BG-2   │                      │                  │   BG-5      │
   │  Trust  │                      │                  │  Patient    │
   │  at     │                      │                  │  self-svc   │
   │ confirm │                      │                  └─────────────┘
   └─────────┘                      │                           │
        │                           │                           │
        └──────────────┬────────────┴───────────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │     PERSONAS         │
            ├──────────────────────┤
            │ 01 Patient  (Maya)   │──── moves BG-1, BG-2, BG-5
            │ 02 Doctor  (Ahmed)   │──── moves BG-2, BG-3, BG-4
            │ 03 Recep.  (Hala)    │──── operational force-multiplier
            │ 04 Admin   (Omar)    │──── moves BG-3 (via flag flow)
            └──────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │    USAGE GOALS       │
            │  PG + NG per persona │
            │  (see §5)            │
            └──────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │     FEATURES         │
            │  (see feature-       │
            │   impact-analysis)   │
            └──────────────────────┘
```

The key insight: **BG-3 (zero silent invalidation) is the principle-defending goal.** Every persona connects to it through their negative usage goals. That is the structural reason PRD §18 exists, and every feature that touches an existing appointment must serve it.

---

## 7. Strategic insights

These came out of the persona work and shape Phase 3.

1. **Patient and Clinic are mirrors.** Patient fears *silent changes*; clinic fears *being made responsible for them*. The same architectural decision (BRD §4.6 two-flow split) protects both. This symmetry should be visible in the UX — both audiences get the same *visibility*, expressed in their own surfaces.

2. **The receptionist is the silent partner.** She has no SMART goal of her own, but every other persona depends on her. If her UI is slow, the patient walks away from the front desk with a worse experience than the patient who booked online. The branch-isolation guarantee (BR-063) is also her *focus* guarantee.

3. **The administrator is the most fragile persona, structurally.** He has no appointment visibility (BR-065) but his edits are exactly the ones that can cause silent invalidation. The PRD §4.6 edge case — branch-hours change when the assigned doctor no longer works there — is the moment the product breaks trust if it isn't designed for. Admin UI must be the most gated surface in the system.

4. **Doctor conflict resolution is the highest-staff-cost surface.** If the doctor's inbox is poor, every branch-hours change becomes a phone-call chain. The conflict-resolution inbox is therefore the highest-leverage staff UX in the product, after the patient booking flow.

5. **The OTP path is the patient's only way home.** Every UX decision on the patient side must assume OTP is the only authentication. No "create account to skip OTP" shortcuts. The OTP failure path (NG-P3) must be designed for — even if it's "call the clinic," it must be a clear path.

---

## 8. Hand-off to Phase 3

The trigger map's job is done when:
- Each persona has at least one **positive** and one **negative** goal that maps to a business goal.
- Each business goal has at least one persona identified as the primary mover.
- The features that move each goal are ranked in `feature-impact-analysis.md`.

Phase 3 (UX Scenarios) will take the top scenarios from the feature impact analysis and run the 8-question dialog on each. The two must-have scenarios I flagged in the Product Brief (§11) remain the recommended starting points:

1. *I just need to book this one appointment* (Patient)
2. *I have to fix my schedule change without upsetting my patients* (Doctor)

WDS Project Outline status after this document:

```
phases:
  product-brief: complete
  trigger-map: complete       ← here now
  ux-scenarios: not-started   ← next
  ux-design: not-started
  development: not-started
```

---

*This trigger map is a living document. Phase 3 will surface gaps (personas without scenarios, scenarios without features) and Phase 4 will pressure-test the visual rendering of the map.*
