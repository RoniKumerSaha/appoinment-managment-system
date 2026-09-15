# Scenario 01 — Patient Books an Appointment

> *"I just need to book this one appointment."*
>
> — Maya, the Patient

---

## The 8-Question Dialog

### Q1 — What transaction do we need to get really right?

**Find a valid doctor / branch / appointment-type / time combination and reserve it without an account, then give the patient a receipt they can return to.**

This is the single transaction that, if we get it right, makes the rest of the product feel earned. Every other surface exists to defend or extend this one.

### Q2 — Which business goal does it serve?

- **BG-1 — Easy adoption** (≥ 70% of bookings online within 60 days). This is the *easy* half of the product promise.
- **BG-2 — Trust at confirmation** (avg time-to-book < 90s). This is the *accuracy* half, surfaced at the moment the patient most needs it.
- **BG-3 — Zero silent invalidation.** The atomic reservation defends BG-3 from the patient's first interaction. If the slot is real here, the rest of the system has something to defend.

### Q3 — Which user, and in what real-life situation?

**Maya** (Persona 01, age 34, on mobile, often distracted, sometimes booking for a relative).

She's in a waiting room, on a smoke break, between meetings. She has a child's rash, a parent's blood pressure, a checkup she's been postponing. She searched Google for a doctor, saw the clinic's name, and tapped a link.

She has done this before at a different clinic and remembers it as "I had to call, they put me on hold, they asked for my name three times." She has low tolerance for any flow that feels like phoning.

### Q4 — What do they want and fear going into this?

**Wants:**
- A doctor she trusts, at a branch she can get to, soon.
- A real confirmation she can come back to.
- No account, no password, no email.
- A screen that looks like a receipt.

**Fears:**
- A slot that turns out to be fake (NG-P2).
- A silent change to her appointment (NG-P1).
- Having to call back to verify (NG-P3).
- Carrying the doctor's information in her head (NG-P4).

### Q5 — What device are they on?

**Mobile first. Browser, no app install.** Smartphones on cellular data, often one-handed, often interrupted. Layouts must be thumb-reach. Forms must minimize keyboard time. Confirmation screen must be screenshot-able.

A desktop browser is a secondary surface — the same flow, reflowed. Not a separate design.

### Q6 — What's the natural starting point?

**The clinic's marketing entry — Google search result, Maps link, WhatsApp share, or a sign outside the clinic with a QR code.**

The first screen is not "Welcome to our booking system." It is **a list of doctors** she can book with — searchable, with branch visibility. The list answers "who can I see?" before she has to commit to anything.

If the entry point is a specific doctor's profile (via a doctor-specific landing page — out of scope for MVP, future consideration), the doctor is pre-selected and Q6 collapses to Q1 of the booking flow.

### Q7 — What's the best possible outcome — for both sides?

**For Maya:** A confirmed appointment, with a screenshot-able receipt, that she can return to without an account. Less than 90 seconds total. She can leave the booking flow and come back tomorrow and still see her appointment.

**For the clinic:** A Scheduled appointment that respects every business rule — atomic reservation, branch open, doctor available, no patient conflict, no double-book, no same-day, within the 30-day window — with an audit record of who booked and when. Zero staff intervention.

**For both:** The next interaction is one of these — Maya returns to view/cancel/reschedule, or she shows up. Either way, nothing has changed silently.

### Q8 — What's the shortest path through the site?

```
[Doctor List] (1.1)
    │   tap a doctor
    ▼
[Branch Picker] (1.2)
    │   tap a branch
    ▼
[Appointment Type Picker] (1.3)
    │   tap a type
    ▼
[Slot Picker] (1.4)
    │   tap a slot
    ▼
[Contact Info] (1.5)
    │   enter name + phone, confirm
    ▼
[Confirmation] (1.6)
    │   ─── exit: appointment is Scheduled ───
    │   tap "view my appointments"
    ▼
[OTP Verification] (1.7)
    │   enter OTP
    ▼
[Patient Dashboard] (1.8)
    │   shows the appointment
```

**Eight pages. Six taps to confirmation.** Each page has exactly one decision. Errors are specific and resolvable. The OTP gate exists only when the patient wants to *return* to her appointment, not to book it.

---

## Sunshines, clouds, and the silent-invalidation test

### Sunshine path
Maya lands on the doctor list, picks Dr. Ahmed at Branch A, picks "30-min follow-up," picks Tuesday 3:30 PM, enters her name and phone, sees a receipt. Total: under 90 seconds. She screenshots it.

### Cloud paths (must be designed for, not just tolerated)

| Cloud | How the design handles it |
|---|---|
| The slot she picked was taken by someone else in the last 30 seconds | Slot picker is real-time. If a slot disappears, it disappears from her screen. On confirmation attempt: "This slot is no longer available. Choose another." with a re-pick button that returns to slot picker with the day pre-selected. |
| She already has an appointment with this doctor in the future | Slot picker warns upfront: "You have a future appointment with Dr. Ahmed on Aug 22 at 10:00. You can only have one upcoming appointment per doctor." If she proceeds, the booking is blocked at submit with the same message. |
| She already has an overlapping appointment | Slot picker hides slots that overlap her existing appointments. Submit blocked with a specific message. |
| She picks a same-day slot | Date picker disables today. Earliest bookable is tomorrow (BR-021). |
| She picks a slot outside the 30-day window | Date picker disables dates beyond 30 days (BR-020). |
| She has the wrong phone — different from a relative's number who actually has the appointment | Name is editable on confirmation. Phone is identity. Surface this constraint: "Your phone number is how you'll see this appointment later. If someone else will come, use their phone." |
| Returning patient | Phone field shows stored name as she types. She can edit it (BR-027). |
| Booking race condition (BR-024) | Atomic reservation at submit. If the slot is gone: explicit error, redirect to slot picker with day pre-selected. The system does NOT auto-pick another slot. |
| Doctor has no availability in the next 30 days at any branch | Slot picker shows "No availability in the next 30 days. Try another doctor or branch." |
| Branch has no future hours that overlap doctor's hours | Slot picker says "This branch has no upcoming availability. Try another branch." |

### The silent-invalidation test
After confirmation, the appointment is *real*. Every step in this flow must be designed against the question: **"If something about this appointment changes later, will Maya know before she arrives?"**

The confirmation screen is the receipt; the patient dashboard is the place she returns to; the cancellation/reschedule paths (designed in Phase 4) are how she learns of any change she didn't initiate. None of these surfaces hide. None of these surfaces surprise.

---

## Page folders

This scenario produces the following page folders, each with a per-page spec for Phase 4:

| Page | Purpose | Exit action |
|---|---|---|
| `01.1-doctor-list/` | Browse/search doctors | Tap doctor → branch picker |
| `01.2-branch-picker/` | Pick a branch where the doctor works | Tap branch → appointment-type picker |
| `01.3-appointment-type-picker/` | Pick appointment type (duration visible) | Tap type → slot picker |
| `01.4-slot-picker/` | Pick date + time from real availability | Tap slot → contact info |
| `01.5-contact-info/` | Name + phone, returning-patient handling | Submit → confirmation |
| `01.6-confirmation/` | Receipt-style summary | Tap "view my appointments" → OTP verification |
| `01.7-otp-verification/` | Verify phone to view dashboard | Enter OTP → patient dashboard |
| `01.8-patient-dashboard/` | Upcoming appointments + cancel/reschedule entry | Tap appointment → reschedule (Phase 4) |

Each page folder has a `.md` spec ready for Phase 4 design.

---

## Reusable patterns this scenario establishes

- **Receipt-style confirmation** (1.6) — reused in doctor resolution (S-02), receptionist walk-in (S-03).
- **Slot picker real-time validation** (1.4) — reused for reschedule, recurring creation, walk-in booking.
- **Atomic reservation submit pattern** (1.5) — the canonical "atomic at the moment of truth" interaction.
- **OTP-gated patient return** (1.7) — the single patient-auth pattern in MVP.
- **Specific, resolvable error messages** (1.4, 1.5) — the canonical error UX for the product.

---

## Hand-off

Phase 4 (UX Design) takes the eight page folders and produces visual specifications — sketches, component maps, interaction states, responsive behaviors.

The booking flow is also the source of the **canonical patterns** for: confirmation screen, slot picker, OTP gate, atomic-submit error. Every later flow reuses these.
