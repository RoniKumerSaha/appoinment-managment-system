# Real User Flow — Receptionist

**Persona:** Reem, 29, receptionist at Riyadh Olaya branch
**Device:** Desktop at the front desk, sometimes iPad during lunch when the second receptionist covers
**Goal continuity:** A real working day — open the desk, check who's coming, check in walk-ins, book a phone-patient, cancel one, flag a no-show.

---

## Scenario: "Reem's Wednesday"

Reem opens the front desk at 7:45 AM. Eight appointments before noon. One walk-in. One phone call from a patient who wants to book for next week. One phone call from a patient who can't make today.

---

### Act 1 — Opening the day (7:45 AM)

**Mindset:** "Who's coming? Who's already here? Who needs a reminder call?"

1. Logs in → Today's branch view. Top of the page: **Riyadh Olaya Branch · Today, Aug 20 · 42 appointments**.
2. Toolbar: search, date picker (defaulted to today), doctor filter, status filter.
3. Hour-grouped list:
   - **08:00 — Morning** (6 appts)
   - **09:00 — Mid-morning** (7 appts)
   - **10:00 — Late morning** (5 appts)
4. Scans for status badges: 3 ✓ Done, 1 ✕ Cancelled, 1 ✕ No-show (Salman Al-Qahtani from yesterday's late batch — the system auto-flagged him).
5. Notices **Fatima Al-Sayed · 09:00 · In waiting** with a yellow badge — patient arrived, hasn't been called yet.
6. Top-right: **+ New appointment** button (visible all day for walk-ins and phone bookings).

**Emotional beat:** "I know exactly what the day looks like in 30 seconds."

---

### Act 2 — Walk-in at 8:15 AM

**Mindset:** "Aisha just walked in, no appointment, says she's been here before."

1. Clicks **+ New appointment**.
2. Booking form opens (5 steps, stepped layout):
   - **Doctor** — picks Dr. Al-Qahtani (Aisha's usual doctor per her recall).
   - **Branch & type** — locked to Riyadh Olaya (her branch). Picks **Follow-up · 20 min**.
   - **Date & time** — calendar. Tomorrow is the earliest. She picks **Thu, Aug 21 · 09:15**.
   - **Your details** — phone first. Enters Aisha's phone. **✓ Returning patient — Aisha M.** Name pre-filled, editable.
   - **Confirm** — summary card, **APT-2026-08-21-0915** reference. Booked.
3. Toast: "Appointment created on behalf of patient." Audit row written with actor_role = receptionist.

**Emotional beat:** "Five fields, two minutes, done."

---

### Act 3 — Phone patient wants to cancel (9:30 AM)

**Mindset:** "Mr. Hassan can't make his 10:00 today. He sounds sick."

1. From the Today list, locates **Hassan · 10:00 · Branch Olaya · Cardiology**.
2. Clicks **Cancel**. Modal: **Cancel appointment**.
3. Reason dropdown: **Patient ill** (custom option since none of the defaults fit). Required.
4. Helper text: "This slot will be released and offered to other patients immediately."
5. **Confirm cancellation**. Toast: "Cancelled. Slot released." Audit row written: actor = receptionist, reason captured.

**Emotional beat:** "Mandatory reason. Patients can't complain later that we cancelled without telling them why."

---

### Act 4 — Salman, who didn't show (10:45 AM)

**Mindset:** "Salman didn't come for his 8:45. The system already flagged him — I confirm."

1. Already flagged as ✕ No-show in the list (system auto-flagged at +15min past start).
2. Clicks his row → opens detail. Quick-action: **Mark No-show**.
3. Status pill flips to ✕ No-show. Audit row written.

**Emotional beat:** "The auto-flag is great. I used to forget to mark these and it threw off our weekly reports."

---

### Act 5 — Booking for next week (1:15 PM, after lunch)

**Mindset:** "Mrs. Al-Otaibi wants an ECG review next Tuesday afternoon. She prefers Dr. Hassan."

1. **+ New appointment**.
2. Doctor: Dr. Hassan.
3. Type: **ECG review · 15 min**.
4. Calendar: Tue, Aug 26. Earliest available slot in the afternoon: **14:30**.
5. Phone: enters Mrs. Al-Otaibi's number. **✓ Returning patient**.
6. Confirms. **APT-2026-08-26-1430**.

**Emotional beat:** "Two minutes. She'll get the SMS confirmation when we add that, but for now I just tell her verbally."

---

### Act 6 — Quick availability check (2:00 PM)

**Mindset:** "Walk-in asking 'is there anything today?' — let me see."

1. From the sidebar: **Doctor availability**.
2. Doctor picker: only doctors assigned to her branch appear (Dr. Al-Rashid, Dr. Al-Qahtani, Dr. Hassan — no Jeddah branch doctors).
3. Picks Dr. Al-Rashid. Type: Cardiology consultation · 45 min.
4. Read-only calendar: today mostly empty by 2 PM; one slot at 15:30.
5. **Book this slot** — pre-fills F-13 booking form with this slot.

**Emotional beat:** "I don't have to remember who's available — the system filters by my branch."

---

### What Reem never sees

- Other branches' appointments (security boundary — she wouldn't have access even if she URL-poked).
- Doctors' raw schedules (read-only availability, not the config).
- Audit logs from yesterday's branch-hours change.
- The atomic batch insert for recurring series (different actor).
- The reason dropdown in the doctor's cancel modal (different actor).

---

## Edge cases that interrupt this flow

| What happens | What Reem sees |
|---|---|
| She tries to URL-poke `/admin/branches` | 403 / "You don't have access." |
| Patient on phone overlaps with another patient they have | ConflictModal at booking time. "Patient has another appointment at this time." |
| Walk-in patient is from a different branch | Doctor picker filters by her branch. They have to call the other branch. |
| She tries to reschedule | No reschedule option. She cancels + rebooks, or tells patient to use the patient portal. |
| Cancellation reason left blank | Submit button disabled. "Reason required." |
| Booking same-day | Calendar grays today. |
| Doctor on the branch has no availability | Empty state. "No bookable slots in this window." |

---

## Open UX questions

1. **Check-in workflow** — patients just walk in; reception doesn't have a formal check-in step. Should they? Pro: paper trail for arrivals. Con: extra clicks for routine.
2. **Patient phone lookup** — currently a single input. What if Mrs. Al-Otaibi gives a different phone this time vs. last time? (Phone-uniqueness rule says one phone = one patient; this is the boundary.)
3. **Cancellation reason presets** — current 3 (Patient requested, Doctor unavailable, Scheduling conflict). Should "Patient ill" be its own preset?
4. **Walk-in vs appointment** — same flow, but visually different in the dashboard. Is "walk-in" a flag worth showing?
5. **Search by partial name** — current placeholder "Search patient name or phone…" — autocomplete or substring?