# Scenario 04 — Admin Changes Branch Hours

> *"Let me change the clinic. Show me what breaks. Hand the breakage to the doctors. Don't make me touch patients."*
>
> — Omar, the Administrator

---

## The 8-Question Dialog

### Q1 — What transaction do we need to get really right?

**Change a branch's weekly operating hours, see the impact on existing appointments before saving, and route the affected appointments to the assigned doctors for explicit resolution — without ever touching patient details.**

This is the principle-defending transaction from the admin side. It pairs with S-02 (doctor schedule change). Together they cover the two distinct conflict flows in BRD §4.6.

### Q2 — Which business goal does it serve?

- **BG-3 — Zero silent invalidation.** The branch-hours change is *saved* (the admin's edit stands) but affected appointments are *flagged* for manual doctor resolution. The principle is preserved because no patient is silently invalidated.
- **BG-4 — Operational independence.** The admin is structural; conflict resolution is delegated. BG-4 includes doctor's ability to handle the inbox without staff intervention.

### Q3 — Which user, and in what real-life situation?

**Omar** (Persona 04, structural, plans before clicking).

He's extending Branch B's Saturday morning hours. He knows this might affect appointments. He needs to know *which* doctors and *how many* appointments before he saves, but he does not need to see patient details.

### Q4 — What do they want and fear going into this?

**Wants:**
- Manage structure without entering the appointment loop (PG-A1).
- See the impact before saving (PG-A2).
- Hand off conflict resolution to the right doctor (PG-A5).

**Fears:**
- Changing branch hours and silently invalidating (NG-A1).
- Being asked to resolve appointment conflicts (NG-A2).
- Branch-hours change when the assigned doctor no longer works there (NG-A5) — PRD §4.6 edge case.

### Q5 — What device are they on?

**Desktop or laptop primary, tablet acceptable.** Admin work happens in a focused session at a desk. Mobile is not primary.

### Q6 — What's the natural starting point?

**Branch management** — list of branches, branch detail, "Edit hours" link.

### Q7 — What's the best possible outcome — for both sides?

**For Omar:**
- Edit Branch B's hours, see "7 appointments affected across 3 doctors," confirm, save.
- Each affected appointment is routed to the assigned doctor's conflict-resolution inbox. He sees a status panel: "7 routed to 3 doctors for resolution. None resolved yet." (Status updates without patient details.)

**For the affected patients:**
- Their appointments are flagged, not silently changed. They see the change when they return to their dashboard. The receptionist's phone call bridges the gap in MVP.

**For the doctors:**
- They see the admin's branch-hours change in their conflict-resolution inbox, with a header indicating the source: "From admin: Branch B hours changed. 7 appointments need your attention."

### Q8 — What's the shortest path through the site?

```
[Branch List] (4.1)
    │   tap Branch B
    ▼
[Branch Detail] (4.2)
    │   tap "Edit hours"
    ▼
[Hours Editor] (4.3)
    │   edit weekly hours
    │   tap "Preview impact"
    ▼
[Impact Preview] (4.4)
    │   "7 appointments affected across 3 doctors"
    │   [Confirm change]
    ▼
[Save + Route Confirmation] (4.5)
    │   ─── exit: hours saved, 7 routed ───
```

**Five pages, one save.** The admin sees structural impact, not patient impact.

---

## Sunshines, clouds, and the silent-invalidation test

### Sunshine path
Omar extends Branch B's Saturday morning from 9–12 to 9–14. Preview shows "7 appointments affected across 3 doctors (Dr. Khalil, Dr. Mansour, Dr. Yusuf)." He confirms. Hours save. 7 appointments routed to those 3 doctors' inboxes. Status panel: "7 pending. None resolved yet."

### Cloud paths

| Cloud | How the design handles it |
|---|---|
| The assigned doctor no longer works at this branch (PRD §4.6 edge case) | Impact preview shows the affected appointments AND surfaces the doctor-not-at-branch issue: "Of these 7 appointments, 2 are assigned to Dr. Yusuf who no longer works at Branch B. Reassign or cancel these 2 before saving, or proceed and they will be routed to Dr. Yusuf regardless." Omar must acknowledge this constraint explicitly. |
| Affected appointments span multiple doctors | Impact preview groups by doctor: "Dr. Khalil: 3 · Dr. Mansour: 2 · Dr. Yusuf: 2 (1 of these may not be at this branch)." |
| No appointments are affected | "0 appointments affected. Safe to save." |
| The new hours conflict with branch operating hours boundary | (This is a contradiction in terms — the admin IS setting the operating hours. No edge case.) |
| The new hours reduce branch hours, invalidating more appointments | Same flow. The system cannot refuse the save (BR-060). It can only flag. |
| Doctor reassignment needed | Admin sees a separate "Doctor reassignment" screen (out of scope for this scenario but linked from the impact preview). |

### The silent-invalidation test
The principle says: never silently change a patient's appointment. This flow explicitly *does not* silently change anything — the change is *saved* but the affected appointments are *flagged and routed* to the assigned doctor for explicit resolution. The patient's awareness is delayed (she finds out at her next dashboard visit, or via the receptionist's phone call), but it is not silent — the system's audit log records the change with actor (admin), timestamp, and the routing decision.

This is the BRD §4.6 distinction in action: doctor's schedule changes are *rejected* (S-02). Admin's branch-hours changes are *saved but flagged*. Both flows defend BG-3.

---

## Page folders

| Page | Purpose | Exit action |
|---|---|---|
| `4.1-branch-list/` | List of branches, status | Tap branch → 4.2 |
| `4.2-branch-detail/` | Branch info, hours, doctors assigned, "Edit hours" | Tap "Edit hours" → 4.3 |
| `4.3-hours-editor/` | Edit weekly operating hours | Tap "Preview impact" → 4.4 |
| `4.4-impact-preview/` | Group by doctor; doctor-not-at-branch edge case surfaced | Tap "Confirm change" → 4.5 |
| `4.5-save-route-confirmation/` | Status panel: hours saved, X routed to Y doctors | Done |

---

## Reusable patterns this scenario establishes

- **Impact preview before save** (4.4) — reused by branch deactivation (S-05), future admin actions.
- **Group-by-doctor affected list** (4.4) — surface for any structural change that affects appointments.
- **PRD §4.6 doctor-not-at-branch edge case handling** — the trust-breaking edge case handled by explicit acknowledgment, not silent acceptance.

---

## Hand-off

Phase 4 takes these page folders and produces visual specs. The impact-preview surface is the principle-defending admin component and should be designed to make the impact *unavoidable* — Omar cannot save without seeing how many patients are affected and across how many doctors.
