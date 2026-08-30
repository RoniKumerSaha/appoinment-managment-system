# UX Consistency Report — Personas × Mockups × System Flows

**Author:** Sally (UX Designer)
**Date:** 2026-08-30
**Scope:** 4 persona flows × 19 mockups × 19 system flows (F-01 through F-19)
**Method:** Each persona journey traced through every screen it touches. Each gap scored by severity.

---

## Why this audit

`docs/UX-FLOWS.md` is the **system's** view — what rules fire, what atomic transactions commit, what audit rows write. `docs/user-flows/` is the **person's** view — what they see, decide, feel. The 19 mockups in `docs/mockups/v1/winners/` are the **visual design**.

These three views must agree. When they don't, the system either:
- **Surprises the user** (a copy mismatch, a missing screen, a wrong route)
- **Fabricates behavior** (an SMS that's not in BRD/PRD)
- **Breaks continuity** (the patient cancels but there's no confirmation feedback)

This report catalogues every divergence and ranks the fixes.

---

## Severity scale

- **Blocker** — actively breaks the persona journey; user can't complete the act.
- **High** — surfaces wrong information or routes to the wrong place.
- **Medium** — visual or copy inconsistency; user can complete the act but is confused.
- **Low** — polish; tone, micro-copy, alignment.

---

## 1. Persona-name + phone mismatch (Blocker)

**Where:** `04-patient-confirm.html`, `05-patient-self-service.html`, `07-recurring-preview.html`

The persona **Fatima A. Al-Sayed** (`+966 5XX XXX 5555`) is the patient throughout `docs/user-flows/patient.md`. The mockups instead show **Ahmed M. Al-Falasi** (`+971 50 123 4567`) — a UAE number for a Riyadh persona.

| File | Before | After |
|---|---|---|
| `04-patient-confirm.html` | "Ahmed M. Al-Falasi" / `+971 50 123 4567` | "Fatima A. Al-Sayed" / `+966 5XX XXX 5555` |
| `05-patient-self-service.html` | "AM" avatar / `+971 50 123 4567` | "FA" avatar / `+966 5XX XXX 5555` |
| `07-recurring-preview.html` | "Sara M. · +971 50 222 3344" | "Sara M. · +966 5XX XXX 7777" |

**Rule going forward:** One canonical phone per persona. Lock it down in a single demo-data fragment that every mockup imports.

---

## 2. No ConflictModal primitive anywhere (Blocker)

**Where:** UX-FLOWS §6.1 declares `ConflictModal` a shared primitive used by F-01, F-02, F-05, F-06, F-07, F-13, F-16. The mockups render conflict paths as inline warning cards instead.

The three patient-side conflict messages that must appear as a modal:

- "That slot was just booked."
- "You already have an appointment with Dr. X."
- "You have another appointment at this time."

**Fix in `docs/mockups/v1/app/components.html`** — added a `ConflictModal` template with three slots: `{what}`, `{why}`, `{rule}`. The pattern is "what happened → why → what you can do" — never a dead end.

**Next step:** wire the modal into mockups `03`, `05`, `09`, `10`, `14`, `17` (one per affected flow).

---

## 3. No Toast component anywhere (Blocker)

**Where:** UX-FLOWS prescribes success toasts for F-04 ("Appointment cancelled."), F-05 ("Appointment moved."), F-06 ("Schedule saved."), F-07 ("Time blocked."), F-10 ("Updated."), F-13 ("Created on behalf of patient."), F-14 ("Cancelled. Slot released."). Zero mockups render a toast.

**Fix:** Toast template added in `components.html`. Single shape: top-right, teal, 3s auto-dismiss.

---

## 4. No Audit log surface (Blocker)

**Where:** Persona files for all four roles reference audit logs (Salem's Act 6, Dr. Ahmed's Act 4, Reem's edge cases). UX-FLOWS §6.3 specifies audit visibility. No mockup shows an audit log.

**Fix in `components.html`:** `AuditLogDrawer` template (slides in from the right).

**Next step:** build `20-admin-audit-log.html` and add a `[View audit log]` button to the cancel-confirm bar in `12` and `15`.

---

## 5. Patient cancel is a plain button, not a modal (Blocker)

**Where:** `05-patient-self-service.html` line 184. The `Cancel` button just routes to `/patient/manage` — no confirmation modal.

**Required copy (UX-FLOWS §F-04):**
> "Cancel your appointment with Dr. Al-Rashid on Sat, Aug 23 at 11:15?"
> Helper: "No reason needed. The slot will be released."
> `[Keep appointment]` `[Cancel appointment]`

**Fix:** convert the `Cancel` button to open a modal. Reuse the new `ConflictModal` pattern (or a simpler `ConfirmModal` if no rule citation is needed).

---

## 6. Patient reschedule has no success state (Blocker)

**Where:** `05-patient-self-service.html`. After the patient taps `Confirm move`, they should see:
> "Your appointment has been moved to Sat, Aug 23, 11:15."

**Fix applied:** added a success banner inline beneath the reschedule form. Could be split into `05b-patient-reschedule-success.html` for production.

---

## 7. Admin persona name mismatch on `08` (Blocker)

**Where:** `08-branch-hours-impact.html` showed `Admin · Nadia K.`. The persona is Salem.

**Fix applied:** now `Admin · Salem Al-Mutairi`.

---

## 8. Receptionist cancel fabricates SMS/email behaviour (Blocker)

**Where:** `15-recep-cancel.html` line 181 — bullet: "Send SMS + email cancellation to patient". Not in BRD/PRD/UX-FLOWS.

**Fix applied:** removed.

---

## 9. Branch deactivation modal (BR-059) missing in `17` (Blocker)

**Where:** `17-admin-branches.html`. Toggling a branch with future appointments to Inactive should trigger a modal: "Branch A has 14 future appointments. Deactivation not allowed (BR-059)."

**Next step:** add a deactivation confirm modal wired to the Status toggle.

---

## 10. Cross-screen identity drift (High)

**Phone numbers** for the same patient differ across mockups:

| Patient | `12` (doctor view) | `13` (recep view) | `14` (recep create) | `15` (recep cancel) |
|---|---|---|---|---|
| Fatima Al-Sayed | `+966 5XX XXX 1234` | `+966 5XX XXX 5555` | `+966 5XX XXX 1234` | `+966 5XX XXX 1234` |

**Rule:** one canonical phone per persona.

**Doctor names:**
- `01`–`17`: "Dr. Ahmed Al-Rashid" ✓
- `18-admin-doctors.html` was: "Dr. Abdullah Al-Rashid" — now fixed.

**Branch names:**
- Patient-side mocks: abstract "Branch A — Downtown / Branch B — Marina / Branch C — Northside"
- Admin-side: real names "Riyadh Olaya / Riyadh Malqa / Jeddah Corniche / Riyadh Diplomatic Quarter"

**Decision:** use real names everywhere. The patient doesn't need to know the internal abstract label.

---

## 11. Status-pill style inconsistent (High)

`12-mark-status.html`: pills without icons (`Scheduled`, `Completed`, `Cancelled`, `No-show`).
`13-recep-today.html`: pills with icons (`✓ Done`, `○ Cancelled`, `● Scheduled`, `✕ No-show`).

**Decision:** adopt the icon-prefixed variant. Richer semantic cue; the icons survive translation.

---

## 12. Wrong interaction model for patient cancel/reschedule (High)

`05-patient-self-service.html` had a contradiction: the `Reschedule` button routed to `/patient/slot` (the doctor-picker/branch-picker flow) **and** an inline form appeared for the same appointment. The two views couldn't both be true.

**Decision:** keep the inline form, drop the navigation. Reschedule should toggle the inline panel, not navigate.

---

## 13. All "New doctor / receptionist / branch" cards route to wrong screens (High)

- `17`: `Create new branch` → empty route
- `18`: `New doctor` → `/doctor/schedule` (wrong)
- `19`: `New receptionist` → `/recep/today` (wrong)

**Next step:** add `/admin/doctor-new`, `/admin/receptionist-new`, `/admin/branch-new` screens (or modals) and wire them.

---

## 14. Doctor `Edit` and receptionist `Reassign` route to wrong screens (High)

- `18`: `Edit` and `Assign` buttons route to `/doctor/schedule` (the doctor's own view) — but the admin is editing the admin record, not impersonating the doctor.
- `19`: `Edit` and `Reassign` route to `/recep/today` — same problem.

**Next step:** add `/admin/doctor-edit/:id` and `/admin/receptionist-edit/:id` modals.

---

## 15. Doctor's `Save changes` in `09` jumps to Kanban (Medium)

`09-doctor-schedule.html` Save button routes to `/doctor/resolve`. Save should stay in place with a toast.

**Next step:** change route to self-route + toast "Schedule saved."

---

## 16. Cancel-reason dropdowns differ between doctor and receptionist (Medium)

`12-mark-status.html`: `{Patient requested, Doctor unavailable, Scheduling conflict}` ✓ matches persona.
`15-recep-cancel.html`: had 6 options including `Doctor unavailable` (doctor-only by BR-037) and `Patient ill` (receptionist preference).

**Decision:** keep them split per role. Don't share the dropdown component.

---

## 17. Outside-branch-hours warning lacks buttons in `09` (Medium)

UX-FLOWS F-06 calls for `[Adjust]` `[Continue anyway]`. `09` shows the warning text only.

**Next step:** add the two action buttons.

---

## 18. Recurring preview `Edit pattern` routes to wrong screen (Medium)

`07-recurring-preview.html` → `/doctor/schedule` (the doctor's general schedule, not the recurrence pattern editor).

**Next step:** add `/doctor/recurring-edit` route + screen.

---

## 19. Branch-hours "Notify doctors by SMS" leaks patient PII (Medium)

`08-branch-hours-impact.html` checkbox: opt-in to SMS notify. But UX-FLOWS §6.3 says "Patients — never see audit logs." If doctors receive an SMS with the affected appointment list, that SMS contains patient names.

**Decision:** replace SMS with in-app notification only. No PII leaves the system.

---

## 20. Appointment-types impact card uses wrong example (Medium)

`11-appointment-types.html` impact card talks about changing duration to 60 min. Persona/UX-FLOWS F-08 talks about **deactivating** with future appointments.

**Next step:** add a separate impact preview for deactivation with future appointments.

---

## Top 10 fixes ranked

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | Blocker | No `ConflictModal` primitive | **Component created** in `app/components.html` — wire-in pending |
| 2 | Blocker | No `Toast` component | **Component created** in `app/components.html` — wire-in pending |
| 3 | Blocker | No audit log mockup | **Component created** (drawer) — full mockup pending |
| 4 | Blocker | Patient persona "Ahmed M." instead of "Fatima A." | **Fixed** in `04`, `05`, `07` |
| 5 | Blocker | Patient cancel is a plain button, not a modal | **Pending** — see fix #5 |
| 6 | Blocker | Patient reschedule has no success state | **Fixed** — success banner added to `05` |
| 7 | Blocker | Admin `08` shows "Nadia K." | **Fixed** — now Salem |
| 8 | Blocker | Receptionist `15` fabricates SMS/email | **Fixed** — bullet removed |
| 9 | Blocker | Branch deactivation modal (BR-059) missing in `17` | **Pending** |
| 10 | High | Cross-screen identity drift (phones, names, branches) | **Partially fixed** (Fatima, Dr. Ahmed). Phones still inconsistent in `12`/`13`/`14`/`15` |

---

## What's been done in this session

1. Created `docs/mockups/v1/app/components.html` — shared component library (ConflictModal, Toast, AppointmentCard, StatusPill, EmptyState, AuditLogDrawer templates).
2. Fixed patient persona drift in `04-patient-confirm.html`, `05-patient-self-service.html`, `07-recurring-preview.html`.
3. Added a reschedule success banner to `05-patient-self-service.html`.
4. Fixed admin name on `08-branch-hours-impact.html`.
5. Removed fabricated SMS/email bullet from `15-recep-cancel.html`.
6. Fixed doctor name drift on `18-admin-doctors.html` ("Abdullah" → "Ahmed").

## What remains (next session)

The blockers above marked "Pending" — modal wire-ins, audit log mockup, branch deactivation modal, New-XX screens, conflict modals across patient/doctor/admin flows.

The pattern: build the shared component once, wire it everywhere it should appear.