# Product Brief — Multi-Branch Clinic Appointment Scheduling

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 1 — Product Exploration
**Date:** 2026-09-15
**Author:** Saga (WDS Analyst), in conversation with BS01719
**Source documents:** `docs/specs/BRD.md`, `docs/specs/PRD.md`, WDS Project Outline (`_progress/wds-project-outline.yaml`)

---

## 1. Product Promise

> **Easy doctor appointment with accuracy.**

A two-word promise that has to earn its weight. Each word carries a strategic duty:

- **Easy** — booking is faster and lower-friction than the phone-call alternative we displace.
- **Accuracy** — the slot is real, the confirmation holds, and the appointment cannot move without the user knowing.

When easy and accuracy collide, accuracy wins — *but only when the user is told why.* This is the operational expression of the PRD §18 principle.

---

## 2. Emotional Outcome

| Audience | Before | After |
|---|---|---|
| **Patient** | "I think I have an appointment, somewhere." | "It's real, it's mine, I can see it any time." |
| **Clinic** | "We think we have 30 appointments today, across three diaries." | "We see what's true. Across every branch, every doctor, every slot." |

The before-state is dependence and doubt. The after-state is ownership and visibility. The product's job is to make that shift felt, not just technically true.

---

## 3. The World We're Replacing

### What patients do today
They search for a doctor, collect the phone number from Google / Maps / word of mouth / a sign outside, manually call the clinic to book, and have no way to track the appointment after they hang up.

### What clinics live with today
Paper diaries, scribbled notes, "the doctor said 3 but the receptionist wrote 4," no audit trail, disputes on the day of, callback churn.

### The cost both sides absorb
The patient pays in time tax, performance anxiety, and day-of doubt. The clinic pays in staff time, double-booking incidents, no-shows, and quiet distrust from patients. Neither cost is visible in a dashboard — both are felt.

---

## 4. Positioning

### Patient-facing line
> **Your appointment is real. It's yours. You can see it any time.**

### Clinic-facing line
> **What you see is what's true. Across every branch, every doctor, every slot.**

### Where we win
- Booking is simpler than phoning.
- After booking, the patient is no longer dependent on the clinic for the truth.
- The clinic stops relying on paper for the truth about its own schedule.

### Where we lose (if we fail)
- If the appointment becomes invisible again.
- If a change happens that the patient doesn't know about.
- If booking adds steps instead of removing them.

---

## 5. Defensibility

The trust contract is in the **architecture**, not the UI:

1. **Atomic slot reservation** — NFR-001 / FR-025. Two patients cannot bind to the same slot.
2. **Patient-side visibility by default** — BR-029 / FR-031–033. The patient can see their appointments without calling.
3. **Schedule-change protection** — BR-009, BR-011 / FR-011, FR-013. Doctor-initiated changes that would invalidate existing appointments are *rejected outright*.
4. **Branch-hours protection** — BR-060–062. Admin-initiated branch-hours changes are *saved but flagged for explicit doctor resolution* — never silently invalidating.
5. **Audit trail** — BR-046 / FR-051. Every important appointment change is recorded with actor and timestamp.

These five are the structural reasons phone-tree competitors can't copy us by improving their UI. They would have to rebuild the system.

---

## 6. The Rule That Resolves Trade-offs

> **When easy and accuracy conflict, accuracy wins — but only when the user is told why.**

This is the operational rule. It applies to every flow, every exception, every edge case:

- A doctor's schedule change that breaks a patient's appointment is *rejected.* The doctor has to resolve it first. (Easy-for-doctor loses to accuracy-for-patient.)
- An admin's branch-hours change that breaks existing appointments is *saved but flagged.* The doctor is shown the affected appointments and must explicitly resolve them. (Easy-for-admin loses to accuracy-for-patient, but with a different mechanism than doctor-initiated changes — this distinction matters; see BRD §4.6 clarification.)
- A patient's cancel-anytime intent is preserved even when the clinic would prefer a cancellation reason. (Patient-trust wins.)
- A doctor's reschedule-cancel on a patient appointment requires a reason; a patient's reschedule doesn't. (Asymmetric accountability, by design.)

---

## 7. 🚨 The Thing That Must Not Break

> **A last-moment update to an existing appointment, made without the patient's knowledge.**

Of all the failure modes this product could have, this is the killer. A booking that fails costs the patient 90 seconds. A last-moment change with no clear reason costs them their trust in every appointment on the platform — past and future. The damage compounds across the patient population.

This is the failure mode the PRD §18 principle exists to prevent. It is the single question every future design decision must be measured against:

> *"If this number moved silently, would the patient ever know?"*

If the answer is no, the design is wrong.

### What this means for the two distinct conflict flows
- **Doctor-initiated schedule change → rejected** if any existing appointment is invalidated (BR-009, BR-011, FR-011). The doctor must resolve each affected appointment before the change can be saved.
- **Admin-initiated branch-hours change → saved** if it affects existing appointments, *but* affected appointments are flagged for manual resolution by the assigned doctor (BR-060–062). Never silently.

These are not nuances. They are the architectural expression of the principle. Every UX surface that touches an existing appointment — the patient confirmation screen, the OTP dashboard, status transitions, recurring-series displays, the doctor's conflict-resolution inbox — must defend against silent updates.

---

## 8. Success Metrics

### North stars (the two numbers on the dashboard)

| Side | Metric | Source / target |
|---|---|---|
| **Patient** | Average time to complete booking | PRD §16 (Booking) — provisional target: **< 90 seconds** |
| **Clinic** | Schedule conflict incidents | PRD §16 (Reliability) — target: **zero per month** |

### Supporting metrics — full PRD §16 set retained
- **Booking:** success rate, failed rate, slot conflict rate, time-to-book.
- **Availability:** query response time (NFR-008 ≤ 2s), slots returned, % searches → bookings.
- **Appointment Management:** cancellation, rescheduling, no-show, completed rates.
- **Recurring:** series creation success rate, % occurrences skipped (BR-051 — skipped occurrences must be *clearly shown to the user*).
- **System Reliability:** double-booking incidents (= 0), schedule conflict incidents (= 0), failed transaction rate, OTP verification success rate.

### MVP ship gate
PRD §17, 15 numbered criteria. **All 15 must pass before launch.** This is the floor; the north stars are what we optimize for *after* launch.

### Honest gap in the spec
The BRD and PRD give a complete instrumented dashboard but **no baselines and no target thresholds** for most rates. Recommended approach:

- **Set provisional targets now** for north stars (booking time, conflicts) and for double-booking (= 0).
- **Baseline-collect only** for the rate metrics (cancellation, no-show, recurring skip rate) — set real targets 30 days post-launch.

---

## 9. MVP Scope Boundaries

### In scope (from BRD §2.1, PRD §14 Must-Have)
Multi-branch clinic with single-clinic-per-tenant. Four roles: patient (guest), doctor, receptionist, administrator. Doctor belongs to one clinic, may work multiple branches. Receptionist belongs to one branch. Branch operating hours. Branch-specific doctor schedules with multiple working periods per day. Doctor-defined appointment types and durations. Blocked periods. 30-day booking window. No same-day booking. Atomic slot reservation. Immediate confirmation on successful booking. Phone-number patient identity. SMS OTP for self-service. Patient cancellation. Patient rescheduling (doctor fixed, branch/type/date/time flexible). Receptionist cancellation with reason. Doctor and receptionist appointment status management. Recurring appointments with per-occurrence validation and partial success. Appointment audit. Schedule-change conflict detection. Role and branch access control.

### Out of scope (from BRD §2.2, PRD §14 Not-in-MVP)
Consultation fees, payments, billing. Medical records, clinical notes, patient medical history. Patient-facing historical appointment list. Email notifications. SMS appointment notifications. Push / in-app notifications. Automatic reassignment of affected appointments. Automatic cancellation caused by schedule changes. Travel-time calculations between branches. Password-based patient accounts. Multiple clinics per doctor.

### Future considerations (BRD §9)
SMS reminders, email notifications, payments, patient appointment history, advanced reporting, waiting lists, travel-time-aware scheduling, cross-clinic doctor accounts, configurable booking windows, advanced cancellation policies.

---

## 10. Personas (preview — full depth in Phase 2)

| Persona | Core psychological state | Strategic implication |
|---|---|---|
| **Patient** | Anxious, time-pressed, often on mobile, sometimes booking for a relative, distrustful of "your appointment was changed" surprises | Visibility by default. Confirmation has to feel like a receipt. Last-moment updates must surface, not hide. |
| **Doctor** | Schedule-disciplined, hates being the manual cleanup crew, wants predictable visibility into "what's coming" | Conflict-resolution inbox, not passive calendar. Easy schedule edits that *won't* break patients because the system refuses bad ones. |
| **Receptionist** | Fast, multitasking, supports many doctors, wants the calendar to tell them what to do next | Branch isolation must feel safe, not like a limitation. Status transitions one tap. |
| **Administrator** | Owns structural decisions, *not* in the appointment loop | Change-impact visibility without appointment-level access. Branch-hours edits must surface what changes — but not auto-resolve. |

These will be deepened into full personas and trigger maps in Phase 2.

---

## 11. Hand-off

This brief is the strategic foundation. It feeds:

- **Phase 2 — Trigger Map & Personas** (`B-Trigger-Map/`) — psychological depth, usage goals, trigger mapping, feature impact analysis.
- **Phase 3 — UX Scenarios** (`C-UX-Scenarios/`) — concrete user journeys via the 8-question dialog. Recommended MVP must-haves:
  1. *I just need to book this one appointment* — patient, mobile, anxious.
  2. *I have to fix my schedule change without upsetting my patients* — doctor, time-pressed, cautious.
- **Phase 4 — UX Design** (`D-UX-Design/`) — visual specifications of those scenarios, owned by Freya.

WDS Project Outline status after this document is written:

```
phases:
  product-brief: complete      ← here now
  trigger-map: not-started     ← next
  ux-scenarios: not-started
  ux-design: not-started
  development: not-started
```

---

*This brief is a living document. It will be revised as Phase 2 (Trigger Mapping) refines personas and Phase 3 (Scenarios) tests the positioning against real user journeys.*
