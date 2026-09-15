# UX Experience Specification — Multi-Branch Clinic Appointment Scheduling System

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 4 — UX Design
**Date:** 2026-09-15
**Author:** Sally (UX Designer)
**Companion to:** [`DESIGN.md`](./DESIGN.md) — this document is the *why* behind each surface; DESIGN.md is the *what*.

---

## 1 · What is the experience?

A patient should be able to book a confirmed appointment with the right doctor at the right branch in five steps or fewer — and trust the booking enough to show up. A doctor should walk into their clinic in the morning and see today's queue, today's conflicts, and a clear path to resolve each one. A receptionist should be able to walk-in a patient, check them in, and cancel without leaving the day queue. An admin should be able to change branch hours without silently invalidating anyone's appointment.

The product brief calls it **visibility + accuracy + simple steps**. This document explains how every surface in `mockups/v1/` delivers those three properties — and where the design defends a principle.

## 2 · Three experience principles

| # | Principle | Surface that defends it |
|---|---|---|
| **P-01** | **Visibility** — every actor sees exactly the appointments and conflicts relevant to their scope, with no patient detail leaked across scopes. | Doctor's Kanban (`06`), admin's count-only impact preview (`08`), audit log scope rules (`27`, `30`) |
| **P-02** | **Accuracy** — the system never silently invalidates an appointment. Either reject the change (doctor schedule edits) or save the change and flag the affected appointments (admin branch-hours changes). | `06` Kanban, `08` Stacked impact, `38` branch-deactivation gate |
| **P-03** | **Simple steps** — the patient booking flow is eight focused screens, not a single long form; the receptionist's queue puts the most-used actions one click away. | `02–05, 34–36` patient flow, `13` recep today |

These three principles are the *why* for every layout decision in the v1 mockups.

## 3 · Persona-level experience narratives

### 3.1 Maya — Patient (S-01)

Maya has a cardiology follow-up she needs to schedule in the next two weeks. She has used the clinic twice before but doesn't remember her doctor's exact schedule.

**The eight-page flow:**
1. **Doctor list** (`02`) — Maya searches "cardiology" and sees Dr. Ahmed's card with branch list and available-this-week count. Sidebar shows she's a returning patient. One click into Dr. Ahmed.
2. **Branch picker** (`34`) — Maya sees the four branches where Dr. Ahmed works, each card showing hours-this-week and a quick fact like "morning + afternoon available." She picks Downtown because it's near work.
3. **Type picker** (`35`) — Three types: Consultation (45 min, $200), Follow-up (20 min, $90), ECG review (15 min, $60). She picks Follow-up.
4. **Slot picker** (`03`) — Agenda view shows the next 30 days. She sees a yellow warning at the top: "You already have a future appointment with Dr. Ahmed on Aug 22." She can still pick — but submitting will be blocked. She chooses Aug 21, 14:45.
5. **Contact info** (`04`) — Phone-as-identity form. She enters her phone number (already masked on file). The form is short: name, phone, reason-for-visit (optional).
6. **Confirmation receipt** (`36`) — A clean receipt: booking ref, masked phone, "Add to calendar" button. Primary CTA: "View my appointments." Secondary: phone-call fallback if she needs to change.
7. **OTP verification** (`05`) — When she opens "my appointments," the system asks for a 6-digit OTP. Resend timer, phone-call fallback.
8. **Patient dashboard** (`05`) — Her single upcoming appointment, with Reschedule and Cancel buttons.

**Where the experience defends a principle:**
- The yellow pre-warning in `03` is **P-02** — the system surfaces BR-031 conflict *before* Maya wastes 90 seconds entering her details.
- The booking ref + masked phone in `36` is **P-01** — she has a stable identifier without her raw PII being displayed back at her.
- Eight focused screens instead of one long form is **P-03** — Maya can stop and resume after any step without losing context.

### 3.2 Dr. Ahmed Al-Rashid — Doctor (S-02)

Dr. Ahmed works at two branches. He typically logs in 30 minutes before his first appointment to review the day.

**The schedule-editing flow when he needs to take Friday off:**
1. **Doctor home** (`09`) — Schedule editor with tabs per branch. He sees a count badge on his branch tabs: "3 conflicts to resolve."
2. **Schedule editor** (`09`) — He selects Friday, removes the 09:00–13:00 block. The editor prevents the change until he previews impact.
3. **Conflict preview** (`06` Kanban) — Three appointments show up in his queue, each with a card showing: patient name, time, type, and three actions: move to alternate slot at same branch, move to alternate branch where he works, cancel.
4. **He works the queue** — Kanban columns for: To resolve, Moved, Cancelled. He moves each appointment one at a time, confirming each move with the affected patient.
5. **Resolution saved** (`37`) — Hero says "All 3 appointments resolved." A summary card lists each action taken. Audit-log row sample: "Dr. Ahmed · moved appt · Aug 22 09:00 → Aug 23 14:00 · Aug 21 16:45." Primary CTA: "Return to schedule."

**Where the experience defends a principle:**
- The Kanban with patient detail is **P-01** — Dr. Ahmed needs to call patients to confirm moves; he must see their names and times.
- The schedule editor blocks the change until preview is reviewed is **P-02** — the system never silently invalidates.
- The audit-log row in `37` is **P-01** — he has a paper trail for every action.

### 3.3 Hala Al-Harbi — Receptionist (S-03)

Hala manages the front desk at Riyadh Olaya Branch. Her day is dominated by: walk-ins, check-ins, cancellations, and the occasional "doctor is running late" reschedule.

**The walk-in flow at 09:15 when a patient arrives without an appointment:**
1. **Day queue** (`13`) — She sees the day grouped by hour, each appointment a card with: time, patient, doctor, type, status pill, and quick actions.
2. **CTA: "+ Book walk-in"** — She clicks it. Form (`14`) is pre-filled with her branch (Riyadh Olaya).
3. **Stepped form** — Doctor picker (branch-filtered), type picker, slot picker (today's remaining slots), contact info.
4. **Created confirmation** (`26`) — Quick-action stepped modal/panel: "Appointment created. Patient: Ahmed Y. · 09:30 · Dr. Al-Rashid." Returns to the queue with the new card highlighted.

**Cancellation later in the day:**
- `15` stacked vertical: pick from quick reasons ("Patient request," "Doctor unavailable," "Clinic closure") + free-text fallback. The save button is disabled until a reason is picked.

**Where the experience defends a principle:**
- The day queue grouped by hour is **P-03** — at-a-glance for Hala who is multi-tasking at the desk.
- Branch-pre-fill in walk-in form is **P-01** — Hala can never accidentally book at the wrong branch.
- Required reason on cancellation is **P-01** — every cancellation is auditable.

### 3.4 Salem Al-Mutairi — Administrator (S-04, S-05)

Salem owns the clinic structure. He typically logs in once a week to review branch performance and once a month to adjust hours or add branches.

**Branch-hours change flow:**
1. **Branch list** (`17`) — He clicks "Edit hours" on Riyadh Olaya.
2. **Hours editor** (`28`) — Per-day time pickers, with a "Preview impact" CTA at the bottom.
3. **Impact preview** (`08`) — Shows "5 appointments will be flagged" (counts only, no patient detail). One section per the change, what it means, affected appointments (counts), the doctor-not-at-branch edge case (PRD §4.6), and confirm-on-save.
4. **Save** — Branch-hours change saves; 5 appointments are flagged; doctors see "Resolve" badges on next login; in-app notification (no SMS, per PII rules).

**Branch deactivation flow:**
- `38` — Gated screen. If 0 future appointments, the deactivate button is enabled. If 5 future appointments, the button is disabled with a clear message: "5 future appointments must be resolved first." The disabled state is the principle-defending surface for BR-059.

**Where the experience defends a principle:**
- The admin's impact preview shows counts only (no patient names) is **P-01** — Salem has oversight, not patient-PII access.
- The PRD §4.6 doctor-not-at-branch acknowledgment is **P-02** — Salem cannot save a change that would silently invalidate an appointment assigned to a doctor who no longer works at that branch.
- The branch deactivation gate is **P-02** — same principle, different surface.

## 4 · Cross-actor consistency

Across all four personas, the experience holds three patterns constant:

1. **The audit row format** — actor · action · target · time · reason. Visible in `27`, `30`, `37`.
2. **The conflict-modal pattern** — what happened / why / what you can do. Showcased in `29`, used in `06` (Kanban cards), `08` (impact preview).
3. **The atomic reservation pattern** — every change is all-or-nothing. Visible in the confirmation cards in `04`, `08`, `36`, `37`.

These three patterns are the *grammar* of the system. Phase 5 implementation should not invent new ones.

## 5 · Voice and tone

- **Patient-facing** — warm, brief, in the patient's voice. Example: "We sent a code to +966 5XX XXX 1234. Enter it below to see your appointments." (from `05`)
- **Doctor-facing** — professional, direct. Example: "3 appointments need resolution." (from `06`)
- **Recep-facing** — task-focused, fast. Example: "Check in" appears as a single-click action next to each row in `13`.
- **Admin-facing** — structural, count-first. Example: "5 appointments will be flagged." Never shows patient names.

The Clinical Calm teal `#0f766e` is the brand color across all voices; the system font stack (no web fonts) keeps the product fast and predictable.

## 6 · Failure-mode experience

When the system fails an atomic reservation (e.g., a doctor just took the slot Maya was trying to book), the experience follows the ConflictModal pattern from `29`:

1. **What happened** — "This slot was just booked by another patient."
2. **Why** — "Slots refresh in real time. We couldn't reserve it."
3. **What you can do** — three buttons: "Pick another slot," "Join the waitlist," "Call the clinic."

The principle: never fail silently. Every failure shows the user what happened, why, and what they can do next.

## 7 · Hand-off

This experience specification is the *intent* behind every Phase 4 mockup. Phase 5 engineers should:

- Read the persona narratives in §3 before implementing the corresponding screens.
- Use the cross-actor consistency patterns in §4 when in doubt about a new screen.
- Use the failure-mode experience in §6 for any flow that needs a ConflictModal variant.
- Add new screens only after consulting the design system tokens.

## 8 · Status

✅ **Phase 4 experience specification complete.** All four personas have a coherent journey; all three principles are defended by visible surfaces.
