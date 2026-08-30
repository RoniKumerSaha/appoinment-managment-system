# Real User Flow — Patient

**Persona:** Fatima, 34, working mother in Riyadh
**Device:** iPhone 13, mobile-first
**Goal continuity:** One real scenario threaded across booking, managing, rescheduling, and cancelling — not isolated feature demos.

---

## Scenario: "Fatima books her cardiology follow-up and reshapes it twice"

Fatima saw Dr. Al-Rashid eight weeks ago for an arrhythmia work-up. She needs a 45-minute follow-up next month. She's juggling school pickup and a deadline at work — she books on the bus, manages the appointment between meetings, and reshapes it twice when life moves.

---

### Act 1 — First booking on the bus

**Where:** Browser tab, evening commute, 30-day window means she'll see options through mid-September.
**Mindset:** "Just get the slot, I'll confirm at home."

1. Lands on `medislot/`. Sees a search box labeled **Find a doctor**.
2. Types **Al-Rashid**. One doctor card appears: "Dr. Abdullah Al-Rashid · Cardiology".
3. Taps the card → Branch picker appears. Three branches. She picks **Riyadh Olaya** — closest to the office.
4. Three appointment types appear. She picks **Cardiology consultation · 45 min** (the one she had before).
5. Availability calendar opens. She sees a 30-day grid; today is grayed out with a tooltip ("Same-day booking unavailable").
6. She picks **Thu, Aug 21** at **14:45**. Slot turns teal.
7. Form: Name (prefilled because her phone is recognized — "Ahmed M. Al-Falasi" — wait, that's the demo name, but on her device it'd be *Fatima A.*), Phone (read-only), and a small **Returning patient** pill. Edits the name.
8. Hits **Confirm booking**. Page shows a confirmation card with a reference number (`APT-2026-08-21-145`), **Add to calendar**, **Book another**, **Done**.

**Emotional beat:** Relief. "Done in four minutes, didn't have to log in anywhere."

---

### Act 2 — A week later, she needs to move it

**Where:** Same phone, between meetings. She remembers she has a school event that runs into Thu afternoon.
**Mindset:** "I don't want to lose this slot, just shift it."

1. Opens `medislot/manage`. Phone input.
2. Enters her phone. **OTPModal** opens. SMS arrives (her phone auto-fills the 6-digit code).
3. Taps **Verify**. Card flips to a verified-pill ("Ahmed M. Al-Falasi · ✓ Verified").
4. List of upcoming appointments (1). Card for Thu, Aug 21 · 14:45 · Dr. Al-Rashid.
5. Taps **Reschedule**. Inline form: same doctor, any branch, any appointment type. Calendar appears.
6. Picks **Sat, Aug 23** at **11:15**. The **Confirm move** button pulses green.
7. Taps it. Toast: "Appointment moved." Card updates in place.

**Emotional beat:** "That was actually painless. No phone call, no waiting."

---

### Act 3 — The day before, panic

**Where:** Phone, at the school event, 8 PM the night before. She realises she double-booked herself — a meeting that ran late made Sat morning impossible.
**Mindset:** "Cancel, just cancel, I'll rebook next week when things settle."

1. Re-opens `medislot/manage`. Phone + OTP (same flow, code auto-fills again — no cooldown yet).
2. Same card. Taps **Cancel**. Modal: "Cancel your appointment with Dr. Al-Rashid on Sat, Aug 23 at 11:15?" Helper line: "No reason needed. The slot will be released."
3. **Keep appointment** (no, panic) / **Cancel appointment** (yes).
4. Toast: "Appointment cancelled." Card vanishes.

**Emotional beat:** "Whew. Now I just need to remember to rebook when I'm less of a mess."

---

### What Fatima never sees

- The validation engine checking 8 different things (branch hours ∩ doctor hours − blocks − appointments − 30-day window − same-day exclusion − patient overlap − same-doctor future).
- The atomic transaction that locks then releases slots.
- The audit log writing rows for every action.
- The doctor's branch-hours change that almost conflicted with her Aug 21 slot and was flagged for resolution on someone else's dashboard.

This is the point. **Fatima's experience is "I picked a slot, I changed it, I cancelled it." The system absorbs the rest.**

---

## Edge cases that interrupt this flow

| What happens | What Fatima sees |
|---|---|
| Someone else grabs her slot mid-reschedule | ConflictModal: "That slot was just booked." Card stays put. |
| She's already booked Thu Aug 21 with Dr. Al-Rashid (somehow) | ConflictModal: "You already have an appointment with Dr. Al-Rashid." |
| She overlaps with another doctor | ConflictModal: "You have another appointment at this time." |
| Her phone OTP doesn't arrive | Resend link after 30s cooldown. |
| She tries to book today | Calendar grays today with the tooltip. |

In each case, the system says **what happened, why, what she can do** — never a dead end.

---

## Open UX questions

1. **Pre-filled OTP** — phone keyboards auto-fill OTP from SMS. Should the input fields auto-advance, or rely on the keyboard auto-fill? Both? (Currently both — auto-advance per mockup, but real keyboards win.)
2. **Phone reuse across family members** — if Fatima's husband uses the same phone for his appointments, they see each other's. Phone-uniqueness assumption breaks for shared phones. Future problem.
3. **Add to calendar** — `.ics` download on mobile opens the calendar app. Confirm this is what users expect.
4. **Reschedule confirmation tone** — currently "Your appointment has been moved to Aug 22, 11:00." Friendly. Don't break this.
