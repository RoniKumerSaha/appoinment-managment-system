# Persona 02 — The Doctor

> *Owns their week. Doesn't want to be the manual cleanup crew.*

---

## Snapshot

**Name:** Dr. Ahmed
**Age:** 47
**Lives:** works at two branches of the same clinic — downtown on Sundays and Mondays, the suburban branch on Tuesdays and Thursdays.
**Work:** sees 12–18 patients per working day. Consultation types: 30-minute follow-up, 45-minute first-visit, 60-minute procedure.
**Tech comfort:** medium — uses a clinic tablet for notes, uses WhatsApp for staff messages, has learned the existing admin system reluctantly.

---

## The role, in one line

> *I want to control my own schedule. I do not want to be the person who breaks my patients' plans.*

He is **schedule-disciplined**. He knows which weeks are heavy. He plans time off a month ahead. He hates being the manual cleanup crew when admin changes a branch's hours and suddenly his afternoon is full of patients he can't see.

---

## Context — when he shows up

- He's between patients, on a tablet, sometimes on a phone.
- He's tired. Cognitive load is real. He's not in a "play with the app" mood.
- He just had to resolve a schedule conflict because someone in admin changed branch hours. He's annoyed.
- He's considering whether to take Wednesday afternoon off for his daughter's school event.

---

## Goals — positive (what pulls him in)

| # | Positive goal | What it feels like |
|---|---|---|
| **PG-D1** | Define his availability once per branch and trust it | "Set Sundays 9–1 at Branch A. Don't make me re-enter." |
| **PG-D2** | See his day clearly, in one place | "What's coming. Who's coming. How long." |
| **PG-D3** | Block time without breaking patients | "I want Wednesday afternoon off. Show me who I have to rebook, then I'll fix it." |
| **PG-D4** | Manage his own service menu | "30-minute follow-up. 45-minute first-visit. 60-minute procedure. Add/remove as I need." |
| **PG-D5** | Move an affected patient to a slot that works | "Reschedule Mrs. K to next Tuesday at 3, same branch. Done." |

## Goals — negative (what he fears)

| # | Negative goal | What it feels like |
|---|---|---|
| **NG-D1** | Being made the manual cleanup crew by admin | "Branch hours changed again. Now I have to rebook 11 patients." |
| **NG-D2** | Saving a schedule change that invalidates patients | "I cut my hours and didn't realize I'd broken three appointments." |
| **NG-D3** | A patient showing up for a slot he thought was blocked | "Wait, who is this? I blocked Tuesday." |
| **NG-D4** | Tools that show him everything the receptionist sees | "I don't need to manage the reception desk. Don't make me." |
| **NG-D5** | Cancellation drama | "I cancelled an appointment. Now the patient is upset and the receptionist is asking why." |

---

## Behavior patterns

- **Planned, not reactive.** Schedules a week ahead. Doesn't check the app hourly.
- **Decisive when blocked.** When he can't take a Wednesday, he wants to know in one place who is affected, then rebook all of them, then save.
- **Doesn't read instructions.** If a workflow takes more than 5 minutes to learn, it's wrong.
- **Defensive about patient trust.** He carries the patient relationship. He will not save a change that might break it.
- **Cross-branch mental model.** He thinks in branches, not in clinics. "Sunday at Branch A" is a unit of thought.

---

## Technology comfort

- High for: WhatsApp, calendar apps, email.
- Medium for: clinic admin systems — uses, doesn't enjoy.
- Low for: anything requiring multi-step wizards, anything that times out.

**Implication:** schedule edits must be **single-screen where possible**, **branch-aware by default**, and **never silently destructive**. The conflict resolution inbox must be obvious, not hidden behind a tab.

---

## Quote

> *"Let me change my hours. Show me what breaks. Let me fix it. Don't make me phone the front desk."*

---

## What this persona demands of the design

1. **The system refuses destructive changes upfront.** BR-009 — *"A doctor cannot save a schedule change if it would invalidate an existing appointment."* This must feel protective, not paternalistic. The doctor's edit form must show the affected appointments inline *before* the save button is enabled.
2. **Cross-branch is the default mental model.** His dashboard shows his week grouped by branch, not as one undifferentiated list.
3. **Conflict resolution is one screen, one action per appointment.** "Move to Tuesday 3pm at Branch A" should be a single tap when there's an obvious slot. Wizard flows will be abandoned.
4. **Cancellation requires a reason** (BR-037) — but the reason is for the *audit trail*, not for the patient. The UX must not surface the reason to the patient. The doctor writes it once and moves on.
5. **He is *not* a power user.** Don't give him features the receptionist has. He's a doctor; the receptionist is the operational hub.
6. **The "branch hours changed" notification is high-stakes UX.** When admin changes a branch's hours and his patients are affected, he needs a clear, scannable inbox — not an email, not a banner on a screen he doesn't open.
