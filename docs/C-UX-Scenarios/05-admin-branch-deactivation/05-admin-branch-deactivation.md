# Scenario 05 — Admin Deactivates a Branch

> *"Let me change the clinic. Don't let me break it."*
>
> — Omar, the Administrator

---

## The 8-Question Dialog

### Q1 — What transaction do we need to get really right?

**Deactivate a branch that has no future appointments — and refuse to deactivate one that does, with a clear path to handle the future appointments first.**

This is the principle-defending transactional boundary on the admin side. The "no future appointments" rule (BR-059) is a gate, not a warning.

### Q2 — Which business goal does it serve?

- **BG-3 — Zero silent invalidation.** A deactivated branch with future appointments would *silently invalidate* them — they couldn't be honored at a branch that doesn't operate. The gate prevents this.
- **BG-4 — Operational independence.** The admin can complete this flow without escalation.

### Q3 — Which user, and in what real-life situation?

**Omar** is closing Branch D — its lease ended, no more appointments are being taken. He wants to deactivate it cleanly.

### Q4 — What do they want and fear going into this?

**Wants:**
- Deactivate cleanly (PG-A4).
- Manage structure without entering the appointment loop (PG-A1).

**Fears:**
- Deactivating a branch with future appointments (NG-A3) — the trust-breaking failure mode.

### Q5 — What device are they on?

**Desktop or laptop primary.**

### Q6 — What's the natural starting point?

**Branch detail** (reuses 4.2 from S-04).

### Q7 — What's the best possible outcome — for both sides?

**For Omar:**
- Tap "Deactivate," see "0 future appointments. Safe to deactivate," confirm, done.
- If there *are* future appointments: the button is disabled with a clear message. He must first resolve those (via the affected-appointment flow with each assigned doctor, or by reassigning patients to other branches).

**For the patients:**
- No future appointments at the deactivated branch means no silent invalidation. If future appointments exist, they remain Scheduled until resolved.

### Q8 — What's the shortest path through the site?

```
[Branch Detail] (4.2 reused)
    │   tap "Deactivate"
    ▼
[Deactivate Confirmation] (5.1)
    │   "0 future appointments. Confirm deactivation?"
    │   [Confirm] [Cancel]
    ▼
[Done]
```

Or, if future appointments exist:

```
[Branch Detail] (4.2)
    │   "Deactivate" button is disabled
    │   shows "5 future appointments must be resolved first"
    │   tap "Resolve these 5 appointments" → doctor reassignment flow
    ▼
[Doctor Reassignment] (out of scope for this scenario)
```

---

## Sunshines, clouds, and the silent-invalidation test

### Sunshine path
Omar taps "Deactivate" on Branch D. System shows "0 future appointments. Safe to deactivate." He confirms. Branch is deactivated. Audit log records the action.

### Cloud paths

| Cloud | How the design handles it |
|---|---|
| 1+ future appointments exist | Deactivate button is disabled. Inline message: "5 future appointments must be resolved first. [Resolve them →]" |
| Doctor has appointments at this branch in the future | Same — those are the "5 future appointments." Doctor must resolve via reassignment or cancellation. |
| Branch has no operating hours (data integrity violation) | Surfaced in branch detail; deactivation may proceed with a warning. |
| Branch is referenced by audit history | Audit history is preserved. Deactivation does not delete records (consistent with FR-038: appointments are never deleted). |

### The silent-invalidation test
The principle says: never silently change a patient's appointment. Deactivating a branch *with* future appointments *would* silently invalidate them — they cannot be honored. The gate (deactivation refused until future appointments are resolved) is the principle expressed as a transactional boundary.

The disabled-button-with-clear-message pattern is intentional. Per persona analysis (NG-A3), Omar trusts gates more than warnings. A clickable "Deactivate anyway" button would be wrong.

---

## Page folders

| Page | Purpose | Exit action |
|---|---|---|
| `5.1-deactivate-confirmation/` | Confirmation modal/panel; shows future-appointment count | Confirm → done; Cancel → back |

This scenario reuses:
- `4.1-branch-list/`
- `4.2-branch-detail/` (extended with "Deactivate" action and disabled state)

---

## Reusable patterns this scenario establishes

- **Disabled-button-with-clear-message** — the principle-defending admin pattern. Used wherever an action must be blocked, not warned.
- **Future-appointment count gate** — reusable for any admin action that could affect existing appointments.

---

## Hand-off

Phase 4 takes these page folders and produces visual specs. The deactivation gate is the simplest of all admin flows but the most important — it is the place where "the system protects the patient from the admin's good intentions" is most visible.
