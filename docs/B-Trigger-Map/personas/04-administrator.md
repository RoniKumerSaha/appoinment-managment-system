# Persona 04 — The Administrator

> *Owns structure. Not in the appointment loop.*

---

## Snapshot

**Name:** Omar
**Age:** 41
**Lives:** runs clinic operations across four branches. Spends most days in meetings, spreadsheets, and staff 1:1s.
**Work:** hires/deactivates doctors and receptionists, creates branches, sets branch hours, assigns people to branches, deactivates branches when they have no future appointments.
**Tech comfort:** medium-high. Comfortable with admin tools. Will use a spreadsheet to plan a change before executing it in the system.

---

## The role, in one line

> *I need to change the clinic's structure safely — and not be the one who breaks patient appointments.*

He is **structural**, not operational. By BR-065, he does not access individual appointment records as part of the appointment workflow. He is the person who decides *what the clinic is* — not *what happens in it today*. His edits have consequences downstream, and he knows it.

---

## Context — when he shows up

- He's onboarding a new doctor who'll work at two branches.
- He's deactivating Branch D because it has no future appointments (BR-059 requires this).
- He's adjusting Branch B's hours — extending Saturday morning. He knows this might affect existing appointments. He needs to know *which* appointments before he saves.
- A receptionist resigned. He has to deactivate her account and reassign her patients.

---

## Goals — positive (what pulls him in)

| # | Positive goal | What it feels like |
|---|---|---|
| **PG-A1** | Manage structure without entering the appointment loop | "I don't want to see patients. I want to manage doctors, branches, hours." |
| **PG-A2** | See the impact of a structural change before saving | "If I change Branch B's hours, which appointments are affected?" |
| **PG-A3** | Onboard a doctor in one sitting | "Assign to branches. Set appointment types. Done." |
| **PG-A4** | Deactivate cleanly | "Branch D has no future appointments. Deactivate. Confirm. Done." |
| **PG-A5** | Hand off conflict resolution to the right doctor | "These 7 appointments are affected. Route them to the assigned doctors for resolution." |

## Goals — negative (what he fears)

| # | Negative goal | What it feels like |
|---|---|---|
| **NG-A1** | Changing branch hours and silently invalidating appointments | "I extended hours and didn't realize it broke 11 patients." |
| **NG-A2** | Being asked to resolve appointment conflicts | "I'm not the doctor. Don't make me rebook patients." |
| **NG-A3** | Deactivating a branch that still has future appointments | "I clicked deactivate and 30 appointments vanished." |
| **NG-A4** | Orphaned receptionists | "Receptionist left. Their patients are floating. Who's covering?" |
| **NG-A5** | Branch hours edit affecting appointments where the assigned doctor no longer works there | "I cut Branch B's hours. But Dr. Ahmed also got moved. Now what?" |

---

## Behavior patterns

- **Plans before he clicks.** Will run a scenario mentally or in a spreadsheet before saving a structural change.
- **Reads the impact panel.** If the system says "this affects 7 appointments across 2 doctors," he reads it carefully.
- **Trusts the system to refuse what shouldn't be allowed.** If branch deactivation requires "no future appointments," he expects the system to enforce it — not to warn and let him proceed.
- **Delegates conflict resolution.** His job ends at the structural change. The doctor's job begins at the conflict-resolution inbox.
- **Uses the system in focused sessions.** Monday morning he does admin. Tuesday he's in meetings. The system doesn't need to be live-updating for him.

---

## Technology comfort

- High for: admin tools, spreadsheets, dashboards.
- Medium for: anything requiring live multi-user collaboration.
- Low for: anything that requires him to micromanage individual patient records.

**Implication:** the administrator's screens are *structural*, not *operational*. His home screen shows branches, doctors, receptionists — not patients. His changes show impact previews, not raw lists.

---

## Quote

> *"Let me change the clinic. Show me what breaks. Hand the breakage to the doctors. Don't make me touch patients."*

---

## What this persona demands of the design

1. **No appointment screens in his UI.** Even accidentally. He's a structural user; appointment surfaces are operational. (BR-065.)
2. **Impact preview on every structural change.** Branch hours edit shows "X appointments affected across Y doctors" before save. Branch deactivation refuses if any future appointment exists. Doctor deactivation shows "X future appointments, Y recurring series."
3. **Conflict resolution is handed off, not owned.** When branch-hours change affects appointments, the system routes them to the assigned doctor's conflict-resolution inbox. Omar sees a status — "7 appointments routed to 2 doctors for resolution" — not the patient details.
4. **The "doctor no longer at this branch" edge case must be handled before save.** PRD §4.6 calls this out: if the assigned doctor no longer works at the affected branch, Omar must reassign or cancel before the branch-hours change is finalized. The UI must surface this constraint.
5. **Receptionist deactivation is a handoff, not an orphan.** When a receptionist is deactivated, her future-touchable actions (bookings, cancellations) must be reassigned or blocked — not silently disappear.
6. **Branch deactivation is gated, not warned.** If the branch has future appointments, the deactivate button is disabled, not clickable-with-a-warning. He trusts gates more than warnings.
