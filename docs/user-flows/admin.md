# Real User Flow — Administrator

**Persona:** Salem, 41, clinic operations manager, oversees 4 branches
**Device:** Desktop at HQ, occasionally iPad during travel
**Goal continuity:** A real working morning — confirm a new doctor onboarding, fix a branch-hours issue, deactivate a branch with no doctors, audit the changes.

---

## Scenario: "Salem's Tuesday morning"

Salem has three things on his list this week: Dr. Al-Khalil is starting next month and needs branches assigned; Friday's branch-hours change at Riyadh Olaya flagged 5 appointments that need admin sign-off before the change can be finalised; and the Riyadh DQ branch has been empty for 5 months and he wants to deactivate it.

---

### Act 1 — Onboarding Dr. Al-Khalil (9:00 AM)

**Mindset:** "She's a pediatrician. We want her at Riyadh Malqa and Jeddah Corniche. Active status."

1. Sidebar → **Doctors**. Card grid of 10 doctors. **+ New doctor** placeholder card.
2. Clicks it. Form:
   - **Name** — "Dr. Fatima Al-Khalil"
   - **Email** — "f.alkhalil@clinic.sa"
   - **Status** — Active
   - **Specialty** — Pediatrics
   - **Branches** — multi-select: Riyadh Malqa, Jeddah Corniche. (Single clinic per doctor — clinic is locked.)
3. Saves. New card appears in the grid.
4. **Receptionists** sidebar → no changes for this onboarding.

**Emotional beat:** "30 seconds. Card appears, she's searchable. Audit row written."

---

### Act 2 — Branch-hours change at Riyadh Olaya (9:20 AM)

**Mindset:** "We're narrowing Saturday hours from 09:00–17:00 to 09:00–13:00. Need to know how many patients are affected before I commit."

1. Sidebar → **Branches**. Card grid: Riyadh Olaya (selected), Riyadh Malqa, Jeddah Corniche, Riyadh DQ (inactive).
2. Clicks **Riyadh Olaya**. Edit form opens.
3. **Operating hours** editor — weekly schedule grid. Saturday currently 09:00–17:00.
4. Edits Saturday: 09:00–13:00.
5. **Save changes** → triggers impact preview.
6. **Impact preview** loads:
   - **5 appointments will be flagged** (14:00, 15:30 on Aug 23; 13:30, 14:00, 15:00 on Sep 6, 13, 20).
   - Status stays Scheduled. Doctors see "Resolve" badges.
7. **Confirm what happens on save** checkboxes:
   - ✓ New hours are persisted.
   - ✓ 5 appointments are flagged (status preserved, metadata = "branch_hours_change").
   - ✓ Doctors see "Resolve" badge.
   - ☐ Notify doctors by SMS (optional).
8. Clicks **Save anyway & flag 5 →**.
9. Atomic: persist new hours + flag 5 appointments + audit row.

**Emotional beat:** "This is the kind of admin action where the system pushes back appropriately. Five appointments survive — they don't get silently cancelled. Dr. Al-Rashid and Dr. Sara will each see their own subset on their Resolve dashboard."

---

### Act 3 — Edge case: a flagged appointment's doctor no longer works the branch (9:35 AM)

**Mindset:** "Wait — Layla S. is one of the flagged appointments, and Dr. Sara is moving to Jeddah next month."

1. From the impact preview list, examines each flagged appointment.
2. Realises: Dr. Sara's last day at Riyadh Olaya is Aug 31. The Sep 13 appointment with Layla S. will become orphaned.
3. Two paths:
   - **Reassign Layla S.** to Dr. Sara's replacement (Dr. Al-Khalil, who's onboarding).
   - **Cancel Layla S.** through a documented staff workflow.
4. Goes to **Doctors** → Dr. Al-Khalil → her assigned branches list shows Riyadh Malqa, Jeddah Corniche. **Reassign branches** — adds Riyadh Olaya temporarily.
5. Goes to **Doctors** → Dr. Sara → **Reassign** (the action that resolves the appointment through the staff workflow).
6. Confirms the branch-hours change can now be finalised.

**Emotional beat:** "This is the boring-but-critical work. The system catches the edge case, I fix it manually, then commit."

---

### Act 4 — Deactivating Riyadh DQ (10:00 AM)

**Mindset:** "Empty for 5 months, zero future appointments, no doctors assigned. Should be a clean deactivation."

1. Sidebar → **Branches** → **Riyadh Diplomatic Quarter** (already shown inactive / 0 doctors / 0 future appts).
2. Clicks it. Edit form.
3. Toggles Status → **Inactive**. Confirms.
4. Modal appears: "This branch has 0 future appointments and 0 active doctors. Deactivation will permanently close it." (BR-059.)
5. **Deactivate anyway**. Card dims. Audit row written.

**Emotional beat:** "Clean break. No surprise fallout. Audit history will tell anyone who later asks why it closed."

---

### Act 5 — Receptionist change (10:30 AM)

**Mindset:** "Layla Al-Mutairi transferred from Riyadh Olaya to Riyadh Malqa yesterday. Need to update her branch."

1. Sidebar → **Receptionists**. Card grid.
2. Finds Layla's card. **Branch** cell shows Riyadh Olaya. Click → **Reassign**.
3. Modal: "Receptionists are assigned to exactly one branch (BR-004). New branch: Riyadh Malqa?"
4. Confirms. Card updates. Audit row.

**Emotional beat:** "Single-branch rule is enforced. No temptation to give one receptionist two branches."

---

### Act 6 — End of morning: audit and visual check (11:00 AM)

**Mindset:** "Confirm all my changes landed."

1. Opens **audit log** (admin-only, hypothetical sidebar item — currently in `app/dudit.log` or future admin screen).
2. Sees:
   - `branch.changed` Riyadh Olaya Saturday hours
   - `doctor.created` Fatima Al-Khalil
   - `branch.deactivated` Riyadh DQ
   - `receptionist.updated` Layla Al-Mutairi (branch reassignment)
3. All atomic, all timestamped, all with actor = admin.

**Emotional beat:** "If anyone ever asks 'who changed what when,' it's all here. Not just for me — for compliance."

---

### What Salem never sees

- Individual appointment management (he's not a participant).
- Patient PII (he's a config role, not a clinical role).
- The resolve-affected flow on the doctor's side (he flags; doctors resolve).
- The booking or rescheduling flows.
- Patient phone numbers or appointment details.

---

## Edge cases that interrupt this flow

| What happens | What Salem sees |
|---|---|
| Tries to deactivate a branch with future appointments | Modal: "Branch has N future appointments. Deactivation not allowed (BR-059)." |
| Branch-hours change with no affected appointments | Silent save + audit. Quick confirmation. |
| Tries to assign one receptionist to two branches | Single-branch rule enforced (BR-004). |
| Tries to assign a doctor to a clinic they don't belong to | Single-clinic rule (BR-002). Locked in UI. |
| Edge case: flagged appointment's doctor no longer works the branch | Edge case surfaced in branch-hours impact preview. Admin reassigns or cancels manually. |
| Tries to delete a doctor with future appointments | No delete. Only deactivate. Patients keep existing appointments, no new bookings. |

---

## Open UX questions

1. **Audit visibility** — admins should see a config-audit log. Currently a placeholder. Should it be in MVP?
2. **Doctor reassignment vs deactivation** — sometimes the right move is reassignment (move doctor to a different branch), sometimes deactivation. UI distinction?
3. **Branch-hours preview detail** — currently lists 5 appointments but doesn't group by doctor. Should it?
4. **Bulk deactivation** — if 3 branches are empty, can Salem select all and deactivate in one click?
5. **Receptionist transfer workflow** — current UI shows just "Reassign". Should it include a handover note / training checklist?