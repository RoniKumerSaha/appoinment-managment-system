# Scenario 02 — Doctor Resolves a Schedule Change

> *"I have to fix my schedule change without upsetting my patients."*
>
> — Dr. Ahmed

---

## The 8-Question Dialog

### Q1 — What transaction do we need to get really right?

**Edit a branch-specific weekly schedule, see which existing appointments are affected before saving, and resolve each one — without breaking a patient's confirmed appointment.**

This is the principle-defending transaction from the doctor's side. The patient side (S-01) is about creating real appointments. This is about *not breaking real appointments*.

### Q2 — Which business goal does it serve?

- **BG-3 — Zero silent invalidation.** The principle-defending goal. This scenario is the concrete expression of PRD §18 from the doctor's surface.
- **BG-4 — Operational independence** (≥ 80% of schedule changes self-serve). The doctor's ability to do this without staff intervention is the BG-4 promise.

### Q3 — Which user, and in what real-life situation?

**Dr. Ahmed** (Persona 02, works at two branches, owns his week).

He's between patients, on a tablet. He just realized his daughter's school event is Wednesday afternoon and he needs to cut his Branch A hours. He opens the schedule editor, removes Wednesday from Branch A, sees three patients affected, and moves each one. Total: under five minutes.

He has done this before — sometimes by phoning the receptionist, sometimes by asking patients to call back. He hates it. He wants this to be one screen, one workflow, no drama.

### Q4 — What do they want and fear going into this?

**Wants:**
- One screen to edit his branch-specific hours.
- See who is affected *before* he saves.
- One screen to resolve each affected appointment.
- Move the patient to a slot that works (same branch or branch where he also works).
- Save cleanly.

**Fears:**
- Saving a change that invalidates patients without knowing (NG-D2).
- Being made the cleanup crew for an admin's branch-hours change (NG-D1).
- A patient showing up for a slot he thought was blocked (NG-D3).
- Cancellation drama with patients (NG-D5).

### Q5 — What device are they on?

**Tablet first, phone acceptable, desktop workable.** A clinic doctor uses a tablet between patients. Phone is for quick checks. Desktop is fine but not primary.

### Q6 — What's the natural starting point?

**The doctor's home dashboard** — which shows his branch-aware week + a clear link to "edit schedule" + a clear inbox for any unresolved conflicts.

The schedule editor is not the entry point; it's one option from the home dashboard. The other option is the conflict-resolution inbox.

### Q7 — What's the best possible outcome — for both sides?

**For Dr. Ahmed:**
- Edit the schedule, see affected appointments inline, resolve each one in two taps, save once. Five minutes total.
- Never has to phone the receptionist to clean up.

**For the patient:**
- Every affected patient is contacted (out of scope for MVP — phone call by receptionist) but the system tells the doctor *why* each is affected and *where* the doctor moved them.
- The patient's appointment is never silently moved. If the doctor's resolution moves them, the patient sees the new appointment when she returns to her dashboard.

**For the clinic:**
- The schedule change is auditable (FR-051). Doctor's action is logged with reason and timestamp.
- No double-bookings, no invalidated patients, no callback chain.

### Q8 — What's the shortest path through the site?

```
[Doctor Home] (2.1)
    │   tap "Edit schedule"
    ▼
[Branch Picker] (2.2)
    │   pick Branch A
    ▼
[Schedule Editor] (2.3)
    │   edit weekly hours (e.g., remove Wednesday)
    │   tap "Save"
    ▼
[Conflict Preview] (2.4)
    │   shows "3 appointments affected"
    │   tap "Resolve"
    ▼
[Conflict Resolution Inbox] (2.5)
    │   appointment 1 of 3 → tap
    ▼
[Affected Appointment Detail] (2.6)
    │   "Move to Tue 4:00 PM at Branch A" [Move] [Cancel] [Skip]
    │   "Move to Wed 5:00 PM at Branch B" [Move]
    │   tap a move option → next appointment
    ▼
[Resolution Confirmation] (2.7)
    │   ─── exit: all 3 resolved, schedule change saves ───
```

**Seven pages. One loop.** Each affected appointment is one screen with 2–3 actions. The schedule change does not save until every affected appointment is resolved.

---

## Sunshines, clouds, and the silent-invalidation test

### Sunshine path
Dr. Ahmed edits Branch A, removes Wednesday afternoon, sees 3 patients affected, moves each to a Tuesday slot at the same branch or a Wednesday slot at Branch B, saves. Total: under 5 minutes. Audit log records the action.

### Cloud paths

| Cloud | How the design handles it |
|---|---|
| He tries to save before resolving all conflicts | Save button is disabled until inbox count is zero. Inline message: "3 appointments still need resolution before saving." |
| He picks a same-branch slot that's also busy | Slot suggestions are pre-validated. Only valid slots are shown. |
| He picks a slot at a branch where he works but the appointment type is the same (BR-058) | Appointment type is fixed during this flow — patient-initiated rescheduling is a separate flow (FR-041). The system doesn't let him change type here. |
| He picks a slot at a branch where he doesn't work | Branches offered are only branches where he works for this doctor–branch assignment. Branch picker pre-filtered. |
| He wants to cancel an affected appointment (instead of moving) | Each affected appointment has a "Cancel with reason" action — distinct from "Move." Patient won't be silently cancelled; the cancellation is logged and surfaces to the patient on her dashboard (and via the receptionist's phone-call fallback, out of MVP scope but listed for completeness). |
| He wants to skip an affected appointment (resolve later) | "Skip" option: marks as deferred. Won't block save — wait, this contradicts the principle. Let's clarify: Skip means "I'm not moving this; I'll rebook them by phone." Schedule change saves with an audit-flagged "X affected appointments deferred to manual rebook" count. This is acceptable because the doctor's *deferred* action is logged — it's not silent. PRD §4.7 requires the doctor to resolve before saving. So Skip is actually an audit-tagged deferral, not a "save anyway." |
| The system has zero valid alternative slots | "No available slots for these 3 patients in the next 30 days. Suggest one of: cancel with reason, extend the booking window (admin), or re-check affected list." The doctor cannot save until each is resolved one way or another. |
| Branch-hours change from admin (a separate flow, shown in inbox) | Admin's branch-hours change surfaces here with a header: "From admin: Branch A hours changed. 7 appointments need your attention." Same Conflict Resolution Inbox handles both doctor-initiated and admin-initiated conflicts. |
| Affected appointment is for a patient whose phone is on a different device | Not the doctor's concern in this flow. The patient will see the change on her next dashboard visit. (Receptionist phone-call is the operational bridge, out of MVP UI.) |

### The silent-invalidation test
The principle says: *never silently change, cancel, move, or overwrite a patient's confirmed appointment.* This flow is the concrete test of that principle from the doctor's side. The system **refuses** to save a schedule change that would invalidate patients until each affected appointment is explicitly resolved. That is the *opposite* of silent — every action is explicit, scoped, and logged.

The patient's awareness happens at her next dashboard visit; the receptionist's phone call bridges the gap in MVP. (Notification infrastructure is out of scope per BRD §2.2.)

---

## The conflict resolution inbox — two sources

This scenario's inbox handles conflicts from two sources:
1. **Doctor-initiated schedule changes** (this scenario's primary path).
2. **Admin-initiated branch-hours changes** (the doctor's role per PRD §4.7).

Both surface in the same inbox. The header tells the doctor where the conflict came from.

---

## Page folders

This scenario produces the following page folders:

| Page | Purpose | Exit action |
|---|---|---|
| `2.1-doctor-home/` | Branch-aware week view + entry to schedule editor + inbox | Tap "Edit schedule" → 2.2; tap inbox → 2.5 |
| `2.2-branch-picker/` | Pick the branch to edit | Tap branch → 2.3 |
| `2.3-schedule-editor/` | Edit weekly hours, multi-period per day, effective date | Tap "Save" → 2.4 |
| `2.4-conflict-preview/` | Show affected appointments before save | Tap "Resolve" → 2.5 |
| `2.5-conflict-resolution-inbox/` | One screen, list of affected appointments | Tap appointment → 2.6 |
| `2.6-affected-appointment-detail/` | Move / Cancel / Defer | Tap action → 2.7 or back to 2.5 |
| `2.7-resolution-confirmation/` | After all resolved; save succeeds | Done |

Each page folder has a per-page spec for Phase 4.

---

## Reusable patterns this scenario establishes

- **Conflict preview panel** (2.4) — reused for doctor's block-time edits (PRD FR-012/013), admin's branch-hours change preview (S-04), future feature-impact analysis.
- **Resolution inbox pattern** (2.5) — reused by any flow that surfaces "things needing your attention." Could be reused in Phase 8 for audit follow-ups.
- **Affected-appointment move modal** (2.6) — slot picker specialization that pre-selects valid alternative slots, hides the patient's other appointments for conflict, fixes the appointment type.

---

## Hand-off

Phase 4 (UX Design) takes these page folders and produces visual specifications. The patterns from this scenario (conflict preview, resolution inbox) are the principle-defending components of the design system.
