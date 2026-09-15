# Persona 03 — The Receptionist

> *Branch-bound. Fast. Multitasking. Owns the day.*

---

## Snapshot

**Name:** Hala
**Age:** 29
**Lives:** works full-time at Branch A. Has been there three years. Knows every regular by face.
**Work:** greets patients, answers the phone, books appointments on behalf of walk-ins and phone-callers, handles cancellations, marks statuses.
**Tech comfort:** medium-high. Comfortable with admin tools. Lives in the clinic's front-desk tablet. Multitasks between phone, tablet, and patient.

---

## The role, in one line

> *I need to know what's happening today, who needs me next, and not to break branch boundaries by accident.*

She is **branch-bound**. By BR-063, she sees appointments for her assigned branch only. That restriction is not a limitation she resents — it's a safety boundary. She does not want to see Branch B's patients. She does not want to be able to book a doctor at Branch C. The product must make this safety feel like *clarity*, not like a wall.

---

## Context — when she shows up

- Monday morning. Phone ringing. Three patients in the waiting room.
- A patient just called to cancel. She has to cancel on the system, type a reason, mark a slot as freed.
- A walk-in wants to book. She has to do the same flow as the patient website, faster, on the tablet.
- The doctor just told her "I'm running 20 minutes late." She has to mentally re-plan the queue.

---

## Goals — positive (what pulls her in)

| # | Positive goal | What it feels like |
|---|---|---|
| **PG-R1** | See today, at a glance | "What's the queue. Who's late. Who's next." |
| **PG-R2** | Book for a walk-in as fast as the website | "Don't make me do extra steps because I'm staff." |
| **PG-R3** | Cancel with a reason, audit clean | "Mrs. K cancelled. Reason: travel. Slot freed. Audit logged." |
| **PG-R4** | Mark statuses without typing | "Tap to mark complete. Tap to mark no-show. Done." |
| **PG-R5** | Not see Branch B's patients | "Less noise. Less risk of clicking the wrong thing." |

## Goals — negative (what she fears)

| # | Negative goal | What it feels like |
|---|---|---|
| **NG-R1** | Accidentally booking Branch B's doctor at her branch | "The doctor I picked doesn't work here. Why didn't it stop me?" |
| **NG-R2** | Being the messenger for an admin change she didn't make | "Branch hours changed. Now I have to apologize to ten patients." |
| **NG-R3** | A double-booking she made | "Two patients at the same time. How did that happen?" |
| **NG-R4** | Tools that look the same as the doctor's | "I'm not the doctor. Don't show me doctor stuff." |
| **NG-R5** | Typing cancellation reasons on a phone | "The patient is in front of me. Don't make me type a paragraph." |

---

## Behavior patterns

- **Speed over completeness.** She will tap "no reason needed" if it's offered, even when the audit wants one. The system must require the reason *at the right moment*, not as a friction footnote.
- **One-tablet-fits-all.** She does not switch between devices. The system must work on a 10-inch tablet, in landscape, with thumb-reach controls.
- **Pattern-matches names.** She knows regulars. Search-by-name must be instant.
- **Stops when blocked.** She cannot "save and figure it out later." If the system tells her a slot is unavailable, she needs an alternative in one tap — not a re-do of the booking flow.
- **Reads the queue, not the dashboard.** She wants today. Tomorrow is tomorrow.

---

## Technology comfort

- High for: tablet-based admin tools, WhatsApp, calendars.
- Medium for: typing on touch (not her strongest).
- Low for: complex multi-step workflows.

**Implication:** the receptionist's primary screen is a *day view*, not a *dashboard*. Status transitions are one tap. Cancellation reason entry offers *quick-pick reasons* (e.g., "Patient travel," "Doctor unavailable," "Patient request") with a free-text fallback — not a blank textarea.

---

## Quote

> *"Tell me who's coming. Help me move them. Don't make me type."*

---

## What this persona demands of the design

1. **Branch isolation must feel like focus, not restriction.** Her home screen shows only her branch's doctors, only her branch's patients, only her branch's hours. If she sees Branch B at all, it's because she filtered for it.
2. **Status transitions are one tap.** Complete, No-show, Cancelled — each is a single action with confirmation, not a form.
3. **Cancellation reasons are quick-pick.** Predefined reasons with one-tap selection. Free text is a fallback, not the default. (BR-036 mandates the reason for receptionist-initiated cancellations; the design must respect that without making it friction.)
4. **Doctor selection is branch-filtered.** She cannot pick a doctor who doesn't work at her branch. If she tries, the system prevents it before she gets to slot selection.
5. **The doctor view is different from her view.** Even if some screens look similar, her version doesn't show "manage my schedule" or "create recurring series for myself." Those are doctor's surfaces.
6. **Walk-in booking mirrors the patient flow, but faster.** Same fields, same validations, but quick-pick defaults for branch and doctor since she's standing in the branch. No double entry.
7. **The day queue is the home screen.** Not a calendar with monthly grid. A vertical list of today's appointments with status pills, time, patient name, and one-tap actions.
