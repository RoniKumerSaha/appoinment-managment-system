# Scenario 03 — Receptionist Manages Today's Branch

> *"Tell me who's coming. Help me move them. Don't make me type."*
>
> — Hala, the Receptionist

---

## The 8-Question Dialog

### Q1 — What transaction do we need to get really right?

**Run the day at Branch A: see today's queue, book walk-ins fast, cancel with a reason, mark statuses — all without ever leaving the branch.**

This scenario covers the receptionist's two highest-leverage flows: walk-in booking and cancellation. Together they account for the majority of her day.

### Q2 — Which business goal does it serve?

- **BG-1 — Easy adoption** (walk-in booking uses the same flow as the patient website, with branch defaults pre-selected).
- **BG-3 — Zero silent invalidation** (cancellation requires a reason; audit-clean; no cross-branch accidents).
- **BG-4 — Operational independence** (the receptionist is self-sufficient on booking + cancel + status; no staff escalation needed).

### Q3 — Which user, and in what real-life situation?

**Hala** (Persona 03, Branch A only, multitasking, knows her regulars).

Monday morning. Phone ringing. Three patients in the waiting room. A walk-in wants to book. A patient just called to cancel. The doctor is running late. She needs the system to tell her what to do next, not to make her figure it out.

### Q4 — What do they want and fear going into this?

**Wants:**
- See today, at a glance (PG-R1).
- Book a walk-in as fast as the website (PG-R2).
- Cancel with a reason, audit clean (PG-R3).
- Mark statuses without typing (PG-R4).
- Not see Branch B's patients (PG-R5).

**Fears:**
- Accidentally booking Branch B's doctor at her branch (NG-R1).
- Being the messenger for an admin change she didn't make (NG-R2).
- A double-booking she made (NG-R3).
- Typing cancellation reasons on a phone (NG-R5).

### Q5 — What device are they on?

**Tablet (10-inch, landscape), sometimes phone.** Thumb-reach controls. Quick-pick over typing.

### Q6 — What's the natural starting point?

**The day queue** — Branch A's appointments for today, sorted by time. Status pills. One-tap actions. This is her home screen.

### Q7 — What's the best possible outcome — for both sides?

**For Hala:** Open the tablet, see today, book a walk-in in under 60 seconds, cancel a phone-call cancellation with one quick-pick reason, mark a completed appointment with one tap. Never accidentally cross branches.

**For the patient (walk-in):** Same booking flow as the website, just faster because the branch and doctor are pre-selected from Hala's branch context.

**For the patient (cancellation):** Cancellation reason is logged for audit. The slot is freed immediately. The patient gets a confirmation (and her next dashboard visit shows the new state).

### Q8 — What's the shortest path through the site?

#### Walk-in booking

```
[Day Queue] (3.1)
    │   tap "Book walk-in"
    ▼
[Walk-in Booking] (3.2)
    │   doctor + branch pre-selected
    │   only doctors at this branch, only this branch's hours
    │   fills patient name + phone
    ▼
[Confirmation Modal] (3.3)
    │   ─── exit: appointment created ───
```

#### Cancellation

```
[Day Queue] (3.1)
    │   tap an appointment → [Cancel]
    ▼
[Cancel Modal] (3.4)
    │   quick-pick reasons
    │   tap a reason → [Confirm]
    ▼
[Day Queue] (3.1)  ← back to day queue, slot freed
```

#### Status transition

```
[Day Queue] (3.1)
    │   tap status pill → [Complete] or [No-show]
    ▼
[Confirm] (inline)
    │   ─── exit: status updated ───
```

**Four pages, one loop.** The day queue is the home; every action returns to it.

---

## Sunshines, clouds, and the silent-invalidation test

### Sunshine path
Hala opens the day queue at 8:55 AM. Six appointments today. A walk-in arrives at 9:10. She taps "Book walk-in," picks the doctor, picks the type, picks 9:30 AM, fills name and phone, confirms. Two minutes. At 9:25 a patient calls to cancel. She taps the appointment, taps "Cancel," picks "Patient travel," confirms. Slot freed. At 10:00 she marks the first appointment Complete. One tap.

### Cloud paths

| Cloud | How the design handles it |
|---|---|
| Walk-in wants a doctor who doesn't work at her branch | Doctor picker is branch-filtered. She can only pick doctors at Branch A. No "all doctors" view. |
| Walk-in has an appointment at another branch in the future | System does not block cross-branch patients. She books them at Branch A as normal. |
| Walk-in has an appointment with the same doctor in the future (BR-031) | Booking is blocked with specific message: "This patient already has a future appointment with Dr. Ahmed on Aug 22 at 10:00. You can have only one upcoming appointment per doctor." |
| Walk-in has an overlapping appointment (BR-033) | Booking is blocked: "This patient has an overlapping appointment on Aug 19 at 3:00 PM. Pick a different time." |
| Walk-in wants same-day booking | Blocked at slot picker (FR-019). "Same-day bookings are not available. Earliest is tomorrow." |
| Cancel reason is required but Hala wants to skip | The reason is mandatory for receptionist cancellations (BR-036). Quick-pick makes it fast. Free-text fallback exists but is not the default. |
| Hala wants to mark an appointment Completed before its end time | Status transition is allowed (FR-037). The system doesn't enforce a "wait until end time" rule. |
| Hala wants to mark a future appointment as No-show | Allowed — but unusual. The status transition is one tap regardless. |
| Hala tries to view Branch B's day queue | Filter is fixed to her branch. She can switch her "home" only to her assigned branch. No cross-branch view. |
| Doctor is running late | Out of system scope — Hala manages this conversationally. The system doesn't track doctor delays in MVP. |

### The silent-invalidation test
This scenario has no "silent" failure mode. Every status transition is explicit. Every cancellation requires a reason (for audit). Every booking is atomic. Branch isolation prevents cross-branch accidents. The receptionist's surface is built so that nothing can happen by mistake.

---

## Page folders

| Page | Purpose | Exit action |
|---|---|---|
| `3.1-day-queue/` | Home screen. Today's appointments, sorted by time, status pills, one-tap actions. | Walk-in booking → 3.2; tap appointment → 3.4 (cancel modal) or status inline; tap "Book walk-in" → 3.2 |
| `3.2-walk-in-booking/` | Same flow as patient S-01, with branch + doctor pre-filtered | Confirm → 3.3 |
| `3.3-confirmation-modal/` | Confirmation modal/panel; appointment created | Close → back to 3.1 |
| `3.4-cancel-modal/` | Quick-pick reasons + free-text fallback | Confirm → back to 3.1; slot freed |

---

## Reusable patterns this scenario establishes

- **Day queue list pattern** (3.1) — reused by doctor's day view (S-02).
- **Quick-pick reasons + free-text fallback** (3.4) — reused for doctor's cancel-with-reason (S-02), and any future staff action that requires audit.
- **Branch-filtered picker** (3.2) — the receptionist's doctor picker is branch-locked. Pattern reused for any receptionist-facing filter.

---

## Hand-off

Phase 4 takes these page folders and produces visual specs. The day queue and quick-pick cancellation are the highest-traffic receptionist surfaces and should be designed for thumb-reach, tablet-first interaction.
