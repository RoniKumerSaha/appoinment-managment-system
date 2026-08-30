# Real User Flow — Doctor

**Persona:** Dr. Ahmed Al-Rashid, 47, cardiologist, 18 years in practice
**Device:** Desktop at clinic between patients; iPad at home on Sundays
**Goal continuity:** A real working week — set up Monday morning's hours, block a conference afternoon, see the dashboard, mark outcomes, and resolve one flagged appointment.

---

## Scenario: "Dr. Ahmed's Monday"

Dr. Ahmed arrives at his Riyadh Olaya branch at 7:30 AM. The first patient is at 8:00. Before the day starts, he has 12 minutes to confirm his schedule is right, block an upcoming conference, and check whether his branch-hours change last Friday broke anyone's appointment.

---

### Act 1 — Opening the schedule (7:35 AM, desktop)

**Mindset:** "Same as last week. Two periods, no surprises."

1. Logs in → Doctor Dashboard. Sidebar shows: **Schedule editor**, **Today**, **Block time**, **Appointment types**, **Recurring preview**, **Resolve affected (3)**.
2. That red badge — 3 affected appointments — has been sitting there since Friday's branch-hours change.
3. Goes to **Schedule editor** first. Branch dropdown: Riyadh Olaya. Effective date: today. Side panel summarizes: **Mon–Thu, 2 periods/day, 28h/week**.
4. Day tabs: Mon (active, 2 periods), Tue, Wed, Thu, Fri (off), Sat (off), Sun (off).
5. Period cards: 09:00–13:00 (morning), 14:00–17:00 (afternoon).
6. Confirms, no edits. **Save changes** is greyed out (nothing changed — good).

**Emotional beat:** "Twelve seconds, all confirmed. Move on."

---

### Act 2 — Blocking a conference (7:40 AM)

**Mindset:** "Cardiology conference Sep 8–12. Need to block 5 days, all branches, all day."

1. From the sidebar, taps **Block time**. Form opens.
2. **Type:** picks **Multi-day**.
3. **When:** Start Sep 8, End Sep 12.
4. **Where:** "All my branches (Branch A + Branch B)". Reason: "cardiology conference".
5. Taps **Block & resolve**.
6. **Impact preview** loads: "5 appointments fall in this period. You'll resolve them before saving."
7. Lists them — Mohammed K. on the 8th, Layla S. on the 10th, three others.
8. He's caught off-guard by how many. Decides to deal with them after the morning clinic. Hits **Block & resolve 3 →** (or whatever count shows).
9. Lands on the Kanban board (Resolve Affected). All 5 cards in the **To do** column.
10. Drags the most-urgent one (Mohammed K., who has a follow-up scheduled for Wednesday morning) into **In progress**.

**Emotional beat:** "I thought blocking the conference would be a one-click thing. It wasn't — but at least the system caught it before patients showed up to a closed clinic."

---

### Act 3 — The day's first patient (8:00 AM)

**Mindset:** Back to clinical work. Mark outcomes as he goes.

1. Sidebar → **Today**. List of 8 appointments, hour-grouped. First card: Fatima Al-Sayed, 09:00 (NOW).
2. Clicks the card. Right-side detail panel: phone, type, branch, booked 3 days ago.
3. After Fatima's appointment ends at 9:45, he clicks **Completed**. Quick toast, card dims.
4. Moves to Mohammed Al-Harbi at 9:45. Patient doesn't show. Marks **No-show**.
5. Layla Ibrahim at 10:30. She's 12 minutes late. He sees her anyway, marks **Completed** at 11:05.

**Emotional beat:** "The Quick-Action sidebar saves me from clicking through a million sub-screens. Just tap, tap, tap."

---

### Act 4 — One patient needs to cancel (10:35 AM, between patients)

**Mindset:** "Khalid just called — he can't make today."

1. Sidebar → **Today**. Khalid's card is at 10:30 (currently in waiting).
2. Card detail → **Cancel this appointment**.
3. Confirmation bar appears: "Confirm cancellation" with a reason dropdown (Patient requested / Doctor unavailable / Scheduling conflict).
4. Picks **Patient requested**. **Confirm cancel + release slot**.
5. Slot released. Audit row written.

**Emotional beat:** "Anyone could do this — receptionist, me. The reason dropdown forces accountability."

---

### Act 5 — Friday afternoon, the flagged appointments

**Where:** iPad at home. The conference is 3 weeks away, but he's tidying up.
**Mindset:** "Get this off my dashboard."

1. Sidebar → **Resolve affected**. Kanban: To do (4 — he moved one to In progress Friday), In progress (1), Resolved (1).
2. Picks Mohammed K. Card shows: original date/time/branch. He clicks **Move**.
3. Slot finder restricted to: same appointment type (45-min cardiology consult), any branch he works at, within 30-day window, no patient overlap.
4. He picks **Tue, Sep 9 · 10:00 · Branch B (Marina)**. Same doctor available — he's now seeing Marina patients Tue mornings.
5. Confirms. Card moves to **Resolved**. Atomic transaction: reserve new → update → release old → audit → flag row resolved.

**Emotional beat:** "The system refused to let me save the schedule change until I cleaned this up. Annoying at the time, but right."

---

### What Dr. Ahmed never sees

- The atomic transaction locking 5 slots simultaneously during the recurring series preview.
- The branch-hours-change flag from Friday that triggered the original Resolve badge.
- The audit log rows being written for every Cancel / No-show / Move.
- The atomic 9-of-12 success rate on his recurring series last month (he just sees "9 created, 3 skipped" — and the 3 reasons).

---

## Edge cases that interrupt this flow

| What happens | What Dr. Ahmed sees |
|---|---|
| Tries to save schedule with affected appointments | Save blocked. Kanban queue appears. |
| Tries to block time overlapping an appointment | ConflictModal: "3 appointments fall in this period. Resolve them first." |
| Patient overlap when moving affected appointment | Slot finder hides overlapping slots. |
| The doctor assigned to a branch-hours-flagged appointment no longer works that branch | Admin must reassign or cancel. Dr. Ahmed sees a different surface (or a coordinator handles it). |
| Recurring series preview, all 12 valid | "All 12 will be created." He approves. |
| Recurring series preview, 8 of 12 valid | "4 will be skipped: doctor blocked (2), outside branch hours (1), patient has another (1)." He approves what works. |

---

## Open UX questions

1. **Kanban vs list view for Resolve Affected** — Kanban is great for status tracking, but with 5 items the list is denser. Should the toggle exist?
2. **Audit visibility** — currently `[View audit log]` in the cancel flow. Doctors see it for their own appointments only. Is that the right level?
3. **Bulk resolution** — F-09 is one-appointment-at-a-time. For 5+ affected rows, a "pick same new date for all" is in the mockup. Should this ship in MVP?
4. **Block & resolve atomicity** — current design: block cannot save until all conflicts resolved. Alternative: block saves, appointments flagged. Which do doctors prefer? (Branch-hours-style is the alternative.)
5. **Mobile/iPad** — Kanban works on desktop but is cramped on iPad. The home screens here are desktop-first; mobile patients exist but staff are mostly desktop.
