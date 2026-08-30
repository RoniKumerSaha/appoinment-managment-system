# UI/UX User Flows

**Project:** Multi-Branch Clinic Appointment Scheduling System
**Sources:** `docs/specs/BRD.md`, `docs/specs/PRD.md`
**Status:** Draft v2 — polished for clarity and traceability

> Every flow traces to BRD rules (`BR-NNN`) and PRD requirements (`FR-NNN`). Flow IDs (`F-NN`) are stable references for design and engineering.

---

## 1. Inventory

### 1.1 Flow index

| ID | Actor | Flow | Primary rules |
|----|-------|------|---------------|
| F-01 | Patient | First-time booking | BR-012…024, BR-025, BR-026, BR-031, BR-033 / FR-020…026, FR-027, FR-029 |
| F-02 | Patient | Returning booking (known phone) | BR-027 / FR-023 |
| F-03 | Patient | OTP verification → upcoming list | BR-029, BR-030 / FR-031, FR-032 |
| F-04 | Patient | Cancel appointment | BR-035, BR-038, BR-053 / FR-033, FR-050 |
| F-05 | Patient | Reschedule appointment | BR-041…045 / FR-039…043 |
| F-06 | Doctor | Manage weekly schedule | BR-005…009 / FR-008, FR-009, FR-010, FR-011 |
| F-07 | Doctor | Block dates / periods | BR-010, BR-011, BR-054 / FR-012, FR-013 |
| F-08 | Doctor | Manage appointment types | BR-014, BR-015, BR-016 / FR-006, FR-007 |
| F-09 | Doctor | Resolve affected appointments | BR-054…058 / FR-011, §4.7 |
| F-10 | Doctor | Cancel / mark status | BR-037, BR-039, BR-040 / FR-035, FR-036, FR-037 |
| F-11 | Doctor or Receptionist | Create recurring series | BR-047…053 / FR-044, FR-046…050 |
| F-12 | Receptionist | Today's branch view | BR-063 / §2.3 |
| F-13 | Receptionist | Create appointment on behalf of patient | BR-019, BR-031, BR-033 / FR-019, FR-027, FR-029 |
| F-14 | Receptionist | Cancel appointment | BR-036, BR-040 / FR-034, FR-037 |
| F-15 | Receptionist | View doctor availability | BR-012, BR-013 / §2.3, §5 |
| F-16 | Admin | Manage branches | BR-001, BR-005, BR-059 / FR-002, FR-003 |
| F-17 | Admin | Change branch operating hours | BR-060, BR-061, BR-062 / §4.6 |
| F-18 | Admin | Manage doctors | BR-002, BR-003 / FR-004 |
| F-19 | Admin | Manage receptionists | BR-004 / FR-005 |

### 1.2 Shared UI primitives

| Primitive | Purpose | Used in |
|-----------|---------|---------|
| **DoctorPicker** | Searchable doctor list | F-01, F-02, F-13 |
| **BranchPicker** | Branch selector (filtered by context) | F-01, F-02, F-05, F-13 |
| **AppointmentTypePicker** | Active types for the selected doctor | F-01, F-02, F-05, F-13 |
| **AvailabilityCalendar** | Day-view slot list with availability, buffer-free | F-01, F-02, F-05, F-13, F-15 |
| **PatientDetailsForm** | Name + phone capture | F-01, F-02, F-13 |
| **OTPModal** | 6-digit SMS OTP entry | F-03, F-05 |
| **ConflictModal** | Why an action was blocked + next steps | F-01, F-02, F-05, F-06, F-07, F-13, F-16 |
| **AffectedAppointmentsTable** | List of appointments flagged for resolution | F-06, F-07, F-09, F-17 |
| **RecurrencePatternForm** | Pattern + count + end date | F-11 |
| **RecurrenceResultPanel** | Created vs. skipped summary | F-11 |
| **AppointmentCard** | Single appointment with status, time, actions | F-03, F-04, F-05, F-10, F-12, F-14 |
| **AuditLogDrawer** | Actor + timestamp history (staff-only) | F-10, F-14 |

### 1.3 Legend for flow diagrams

```
[Start] / [End]            Terminal states
Screen: Name               Full screen
Modal: Name                Modal or dialog
↓                          Forward step
├── condition ──→ outcome  Conditional branch
[Button label]             User action
ConflictModal "..."        Conflict error surface
Atomic: action             Server-side atomic transaction
audit: action              Writes one audit record
```

---

## 2. Patient Flows

### F-01 — First-Time Booking

**Goal.** Patient books an appointment with no prior record.

```
[Start] Patient opens booking URL
   ↓
Screen: DoctorPicker
   ↓ select doctor
Screen: BranchPicker (only branches where doctor works)
   ↓ select branch
Screen: AppointmentTypePicker (active types only)
   ↓ select type
Screen: AvailabilityCalendar
   - 30-day window, tomorrow onward (BR-020, BR-021)
   - Doctor + branch + type filtered
   ↓ select slot
   │
   ├── slot lost to concurrent booking ──→ ConflictModal
   │                                        "That slot was just booked."
   │                                        [Pick another slot]
   │
   ↓ slot valid
Screen: PatientDetailsForm
   - Name (text, required)
   - Phone (tel, required, format-checked)
   [Book appointment]
   ↓ submit
   │
   ├── phone already on file ──→ continue F-02
   │
   ├── already has future appt with same doctor ──→ ConflictModal
   │   "You already have an appointment with Dr. X."
   │   [Pick another doctor]   [Manage existing]
   │
   ├── overlaps another future appt ──→ ConflictModal
   │   "You have another appointment at this time."
   │   [Pick another time]   [Cancel and rebook]
   │
   ↓ validations passed
Atomic: lock slot → create Appointment (status = Scheduled)
audit: action = "created", actor = patient phone
   ↓
Screen: Confirmation
   - Appointment summary
   - [Add to calendar (.ics)]   [Book another]   [Done]
[End]
```

### F-02 — Returning Booking (Known Phone)

**Goal.** Same booking flow, with stored name prefilled.

```
Trigger: entered in F-01 when phone matches an existing record

Screen: PatientDetailsForm (prefilled)
   - Name: stored value, editable (BR-027)
   - Phone: read-only
   [Continue]
   ↓
Resume F-01 at "validations passed"
```

### F-03 — OTP Verification → Upcoming Appointments

**Goal.** Returning patient accesses their appointments.

```
[Start] Patient taps "My appointments"
   ↓
Screen: PhoneInput
   - Phone (tel, required)
   [Send code]
   │
   ├── invalid format → inline error
   ├── SMS send fails → toast "Could not send code. [Try again]"
   ↓
OTPModal
   - 6-digit code (auto-advance inputs)
   - Resend after 30s cooldown
   [Verify]
   │
   ├── wrong code (3 attempts max) → inline error with attempt count
   ├── attempts exhausted → "Try again in 10 minutes."
   ├── code expired → "Send a new code"
   ↓ verified
Server loads upcoming appointments for this phone:
   - status = Scheduled
   - start > now
   - sorted ascending
   - cancelled / completed / no-show excluded (FR-032)
   ↓
Screen: MyAppointments
   - Empty state: "No upcoming appointments. [Book one]"
   - List of AppointmentCard
       Per card: [Cancel]   [Reschedule]
   ↓ action
Route into F-04 or F-05
[End]
```

**Privacy note (NFR-007).** All appointment filtering happens server-side. The client never receives appointments for other phone numbers.

### F-04 — Cancel Appointment

**Goal.** Patient cancels an existing Scheduled appointment.

```
Trigger: AppointmentCard → [Cancel] (from F-03 or post-OTP deep link)
   ↓
Modal: CancelConfirm
   - "Cancel your appointment with Dr. X on Aug 20 at 10:00?"
   - Helper: "No reason needed. The slot will be released."
   [Keep appointment]   [Cancel appointment]
   ↓ confirm
Atomic: verify ownership (phone) + status = Scheduled
        → status = Cancelled (never deleted, BR-038)
audit: action = "cancelled", actor = patient phone
        slot released (BR-053)
   │
   ├── status changed concurrently → modal "No longer available to cancel."
   │
   ↓ success
Toast: "Appointment cancelled."
List refreshes; card removed.
[End]
```

### F-05 — Reschedule Appointment

**Goal.** Patient moves an appointment to a new slot/branch/type, same doctor.

```
Prerequisite: OTP verified (F-03)
Trigger: AppointmentCard → [Reschedule]
   ↓
Screen: Reschedule
   - BranchPicker (doctor's branches only)
   - AppointmentTypePicker (active types)
   - AvailabilityCalendar (next 30 days, no same-day)
   - Doctor is locked — not selectable (BR-042, FR-040)
   ↓ select new slot
   │
   ├── patient overlap ──→ ConflictModal
   │   "This time conflicts with another appointment."
   │   [Pick another time]
   │
   ├── slot lost to concurrent booking ──→ ConflictModal
   │   "That slot was just booked."
   │   [Pick another slot]
   │
   ↓ confirm
Atomic (FR-042):
   1. Reserve new slot (lock)
   2. If lock fails → abort, original untouched
   3. Update appointment: branch / type / start / end
   4. Release old slot
   5. Audit: action = "rescheduled", actor = patient phone,
      metadata = {from, to, branch_change, type_change}
   │
   ├── new slot becomes unavailable mid-transaction (FR-043)
   │   → modal "That slot is no longer available.
   │          Your appointment is unchanged."
   │   → return to Reschedule screen
   │
   ↓ success
Screen: RescheduleSuccess
   - "Your appointment has been moved to Aug 22, 11:00."
   - [Done]
[End]
```

---

## 3. Doctor Flows

### F-06 — Manage Weekly Schedule

**Goal.** Doctor sets branch-specific working periods.

```
[Start] Doctor signs in
   ↓
Screen: DoctorDashboard → [Schedule]
   ↓
Screen: ScheduleEditor
   - Branch selector (any branch doctor works at)
   - Day-of-week tabs
   - Per day: list of working periods (start, end)
       [+ Add period]   ← multiple periods per day (BR-007, FR-009)
   - Effective date (FR-010, BR-008)
   [Save changes]
   ↓ save
Server validates each new/modified period against existing appointments (FR-011, BR-009)
   │
   ├── affected appointments found
   │   Modal: ScheduleConflict
   │     - AffectedAppointmentsTable (N rows)
   │     - "Resolve each appointment before saving."
   │     - [Resolve appointments]   [Cancel]
   │         ↓ Resolve
   │         Route into F-09 (one row at a time)
   │         After all resolved → return here, save re-enabled
   │
   ├── outside branch hours → soft warning
   │   "These hours fall outside branch operating hours."
   │   [Adjust]   [Continue anyway]
   │
   ↓ valid
Atomic: persist schedule
audit: action = "schedule_updated", actor = doctor
   ↓
Toast: "Schedule saved. Availability updated for new bookings."
[End]
```

### F-07 — Block Dates / Periods

**Goal.** Doctor blocks time off.

```
Trigger: DoctorDashboard → [Block time off]
   ↓
Screen: BlockForm
   - Type: Single date | Time range | Multi-day
   - Start / End datetime (end > start)
   - Reason (optional, internal only)
   [Block]
   ↓ submit
Server checks against existing appointments (BR-011, BR-054, FR-013)
   │
   ├── overlap with any appointment → ConflictModal
   │   "N appointments fall in this period. Resolve them first."
   │   AffectedAppointmentsTable
   │   [Resolve appointments]   [Cancel]
   │       ↓ Resolve → F-09
   │
   ├── outside doctor's working schedule → soft warning
   │   "This is outside your working hours. Block anyway?"
   │
   ↓ no conflicts
Atomic: insert DoctorBlock
audit: action = "block_created", actor = doctor
   ↓
Toast: "Time blocked. Slots will no longer be offered."
[End]
```

### F-08 — Manage Appointment Types

**Goal.** Doctor creates, edits, deactivates appointment types.

```
Trigger: DoctorDashboard → [Appointment types]
   ↓
Screen: AppointmentTypes
   - Table: Name | Duration | Status | [Edit]
   - [+ New appointment type]
   ↓ new / edit
Screen: AppointmentTypeForm
   - Name (required)
   - Duration (minutes, ≥ 5)
   - Status: Active | Inactive
   [Save]
   │
   ├── deactivating with future appointments → modal
   │   "Future appointments keep working. New bookings blocked once inactive."
   │   [Deactivate]   [Keep active]
   │
   ↓ save
Atomic: persist + audit
   ↓
List refreshes
[End]
```

**Note.** Inactive types are non-bookable at every branch the doctor works at (per conflict-resolution #3).

### F-09 — Resolve Affected Appointments

**Goal.** Doctor clears appointments affected by a schedule/block/branch-hours change.

```
Trigger: ConflictModal in F-06, F-07, or F-17 → [Resolve appointments]
   ↓
Screen: AffectedAppointmentsTable
   - Per row: date, time, branch, type, patient first name
   - Per row: [Resolve]
   ↓ resolve one
Screen: ResolveAffectedAppointment
   - Read-only: current details
   - SlotFinder restricted to:
       * doctor available
       * branch open
       * within 30-day window
       * no doctor-side overlap
       * no patient-side overlap
       * same appointment type (BR-058)
   - BranchPicker allowed (BR-057 — can move to another branch doctor works at)
   - AppointmentTypePicker NOT shown (BR-058 — type is locked here)
   [Move to selected slot]
   │
   ├── no slots available → "Cancel this appointment instead."
   │       ↓
   │   Modal: DoctorCancel (see F-10)
   │
   ↓ slot selected
Atomic:
   1. Reserve new slot
   2. Update appointment (branch, start, end — type unchanged)
   3. Release old slot
   4. Audit: action = "moved_by_doctor", actor = doctor,
      metadata = {reason: "conflict_resolution"}
   5. Mark row resolved
   ↓
AffectedAppointmentsTable refreshes (N-1 remaining)
   ↓ all resolved
Return to originating flow (F-06 / F-07 / F-17); save now permitted
[End]
```

### F-10 — Cancel / Update Status

**Goal.** Doctor cancels with reason, or marks Completed / No-show.

```
Trigger: DoctorAppointmentList → row → action
   │
   ├── [Mark Completed]
   ├── [Mark No-show]
   └── [Cancel]
       ↓
   Modal: DoctorCancel
      - Reason (required, BR-037, FR-035)
      [Confirm]
      │
      ├── status changed concurrently → modal "No longer Scheduled. Refresh."
      ↓ confirm
   Atomic: status = Cancelled
   audit: action = "cancelled", actor = doctor, metadata = {reason}
           slot released
   ↓
   Toast: "Updated."
   Optional: [View audit log] → AuditLogDrawer
[End]
```

**Mark Completed / No-show** follow the same shape with no reason and no slot release.

---

## 4. Receptionist Flows

### F-11 — Create Recurring Series

**Goal.** Doctor (or receptionist, see F-12 variant) creates a recurring appointment pattern.

```
Trigger: DoctorDashboard → [Create recurring]
   ↓
Screen: RecurringSetup
   - Patient phone (or new patient details)
   - Doctor (locked to current doctor)
   - Branch (any branch doctor works at)
   - Appointment type
   - Start date (tomorrow or later — FR-019)
   - Time of day
   - RecurrencePatternForm:
       * Pattern: Weekly | Every 2 weeks | Custom
       * Count: occurrences (capped by 30-day window)
       * Optional end date
   [Preview]
   ↓ preview
Server pre-validates each occurrence independently (FR-046):
   - Branch operating hours
   - Doctor schedule
   - Doctor blocks
   - Existing doctor appointments
   - Patient overlap across doctors
   - Patient dedup (one future per doctor)
   - 30-day booking window
   - Same-day exclusion
   ↓
Screen: RecurrenceResultPanel
   - Summary: "12 requested → 9 will be created, 3 skipped"
   - Tabs: [To be created]   [Skipped (with reason)]
   - Reasons (FR-048):
       * "Outside branch operating hours"
       * "Doctor blocked on this date"
       * "Patient has another appointment"
       * "Patient already has a future appointment with Dr. X"
       * "Outside 30-day booking window"
       * "Same-day not allowed"
   [Create 9 appointments]
   ↓ confirm
Atomic batch: insert valid occurrences, status = Scheduled
audit: one row per created occurrence
   ↓
Screen: Created
   - [View in calendar]   [Done]
[End]
```

**Per-occurrence independence (BR-052, FR-049).** Once created, each occurrence behaves as an independent appointment. F-04 and F-05 apply per occurrence.

### F-12 — Today's Branch View (Receptionist Dashboard)

**Goal.** Receptionist sees today's appointments at their assigned branch.

```
[Start] Receptionist signs in
   ↓
Server resolves branch_id from user record (BR-004, single-branch)
   ↓
Screen: ReceptionistDashboard
   - Header: "Branch A — Today, Aug 18"
   - Filters: Date | Doctor | Status
   - Agenda view of AppointmentCards for THIS branch only
   ↓
Empty state: "No appointments scheduled for today."
Cross-branch URL → 403 / "You don't have access to Branch B."
[End]
```

### F-13 — Create Appointment (on behalf of patient)

**Goal.** Receptionist books for a walk-in or phone patient.

```
Same shape as F-01 with these differences:
   - BranchPicker locked to receptionist's assigned branch
   - PatientDetailsForm allows:
       * Known phone → F-02 prefilled path
       * New phone + name
   - Confirmation: "Created on behalf of patient."
   - All conflict checks identical (FR-027, FR-029)
   - Same-day rule still applies (FR-019)
   - audit row actor_role = "receptionist"
```

### F-14 — Cancel Appointment (Receptionist)

**Goal.** Receptionist cancels on behalf of patient.

```
Trigger: AppointmentCard → [Cancel]
   ↓
Modal: ReceptionistCancel
   - Reason (required, BR-036, FR-034)
   [Confirm cancellation]
   ↓ confirm
Atomic: status = Cancelled
audit: action = "cancelled", actor = receptionist, metadata = {reason}
        slot released
   ↓
Toast: "Cancelled. Slot released."
[End]
```

### F-15 — View Doctor Availability

**Goal.** Receptionist checks open slots before booking.

```
Trigger: ReceptionistDashboard → [Doctor availability]
   ↓
Screen: DoctorAvailability
   - Doctor picker (only doctors assigned to receptionist's branch)
   - Appointment type
   - Date range (within 30-day window)
   - Read-only AvailabilityCalendar
       * Bookable slots visible
       * No PII beyond first-name initial
   ↓
[Book this slot] → enters F-13 pre-filled
[End]
```

**Note.** Receptionist cannot modify the schedule (per role capability matrix).

---

## 5. Administrator Flows

### F-16 — Manage Branches

**Goal.** Admin creates, edits, deactivates branches.

```
Trigger: Admin → Branches
   ↓
Screen: Branches
   - Table: Name | Address | Status | Doctors | Future appts | [Edit]
   - [+ New branch]
   ↓ new / edit
Screen: BranchForm
   - Name (required)
   - Address (required)
   - Operating hours editor (multi-period per day, FR-003)
   - Status: Active | Inactive
   [Save]
   │
   ├── deactivating with future appointments → ConflictModal
   │   "Branch A has 14 future appointments. Deactivation not allowed." (BR-059)
   │
   ↓ save
Atomic: persist + audit
List refreshes
[End]
```

### F-17 — Change Branch Operating Hours

**Goal.** Admin narrows/expands branch hours, possibly affecting existing appointments.

```
Trigger: Branches → [Edit hours]
   ↓
Screen: BranchHoursEditor
   - Same operating hours editor
   [Save]
   ↓ save
Server identifies affected future appointments (outside new hours)
   │
   ├── edge case: assigned doctor no longer works at this branch
   │   → admin must reassign or cancel before saving (per conflict-resolution #9)
   │
   ├── no affected appointments → silent save + audit
   │
   └── affected appointments found
        Modal: BranchHoursChangeAffected
          - "Saving will affect N appointments. They will NOT be auto-cancelled." (BR-061)
          - AffectedAppointmentsTable with [Mark for resolution] per row
          - [Save anyway]   [Cancel]
        ↓ Save anyway
        Atomic:
          - Persist new hours
          - Flag each affected appointment for resolution (status stays Scheduled)
          - Audit: action = "flagged_for_resolution", actor = admin,
            metadata = {reason: "branch_hours_change"}
          - Flagged appointments appear on the assigned doctor's dashboard with a "Resolve" badge
[End]
```

**Critical contrast.** Doctor schedule changes (F-06, F-07) are **rejected** if they conflict. Admin branch-hours changes (F-17) are **saved** with appointments flagged. The system never silently invalidates an appointment.

### F-18 — Manage Doctors

**Goal.** Admin creates/deactivates doctors and assigns branches.

```
Trigger: Admin → Doctors
   ↓
Screen: Doctors
   - Table: Name | Status | Branches | [Edit]   [Assign branches]
   - [+ New doctor]
   ↓ new
Screen: DoctorForm
   - Name
   - Status (Active / Inactive)
   - Clinic: locked (single clinic per doctor, BR-002)
   [Save]
   ↓ assign branches
Screen: DoctorBranchAssignment
   - Branch multi-select (clinic's branches only)
   [Save]
   │
   ├── deactivating doctor with future appointments → warning
   │   "Dr. X has 7 future appointments. Patients will not be able to
   │    reschedule into this doctor's slots while inactive."
   │
   ↓ save
Atomic: persist doctor + branch assignments + audit
[End]
```

### F-19 — Manage Receptionists

**Goal.** Admin creates/deactivates receptionists and assigns their single branch.

```
Trigger: Admin → Receptionists
   ↓
Screen: Receptionists
   - Table: Name | Branch | Status | [Edit]   [Assign branch]
   - [+ New receptionist]
   ↓ new / assign
Screen: ReceptionistForm
   - Name
   - Branch: single-select (BR-004, FR-005)
   - Status
   [Save]
   ↓ save
Atomic: persist + audit
[End]
```

---

## 6. Cross-Cutting Concerns

### 6.1 ConflictModal pattern

All conflict errors surface through a single pattern with three parts:

1. **What happened** — plain-language statement
2. **Why** — the rule citation (e.g., "one future appointment per doctor")
3. **What you can do** — concrete action verbs, never a dead end

Used by: F-01, F-02, F-05, F-06, F-07, F-13, F-16.

### 6.2 Atomicity discipline

The server is the single source of truth for availability. The UI must:

- Never assume a slot is bookable based on stale data
- Show "slot was just taken" gracefully, not as a system error
- Never hold tentative slots client-side

### 6.3 Audit visibility

Audit records are **internal only**. Surfaces:

- **Doctors and receptionists** — audit history for appointments they own
- **Administrators** — configuration audit events
- **Patients** — never see audit logs

### 6.4 Time zone

Branch operating hours and slots are in the **branch's local time zone**. The data model should store `tz` per branch (recommend adding to architecture phase). All UI timestamps are labeled with branch tz.

### 6.5 No buffer, fixed window

- **No buffer between appointments** (BR-017, FR-016) — slots are back-to-back
- **30-day fixed window** (BR-020, FR-018) — calendar grays out dates outside the window with a tooltip explaining the limit
- **No same-day** (BR-021, FR-019) — applies to all actors including recurring generation

---

## 7. Open Questions for Design

1. **Calendar visualization.** Day / week / month view? Recurring series rendering on the agenda?
2. **Bulk conflict resolution.** F-09 resolves one appointment at a time. Bulk mode for many affected rows?
3. **In-progress reschedule cancellation.** No tentative holds in the current design. Confirm.
4. **OTP UX.** SMS-only, or voice fallback? Copy for users without signal?
5. **Empty states.** Beyond booking empty states, what does an empty doctor schedule or empty receptionist day look like?
6. **Accessibility.** Keyboard navigation through AvailabilityCalendar, screen-reader labels for status badges, focus management in OTPModal and ConflictModal.

---

## 8. Traceability Summary

| Flow | BRD | PRD |
|------|-----|-----|
| F-01 | BR-012…024, BR-025, BR-026, BR-031, BR-033 | FR-020…026, FR-027, FR-029 |
| F-02 | BR-027 | FR-023 |
| F-03 | BR-029, BR-030 | FR-031, FR-032 |
| F-04 | BR-035, BR-038, BR-053 | FR-033, FR-050 |
| F-05 | BR-041…045 | FR-039…043 |
| F-06 | BR-005…009 | FR-008…011 |
| F-07 | BR-010, BR-011, BR-054 | FR-012, FR-013 |
| F-08 | BR-014, BR-015, BR-016 | FR-006, FR-007 |
| F-09 | BR-054…058 | FR-011, §4.7 |
| F-10 | BR-037, BR-039, BR-040 | FR-035, FR-036, FR-037 |
| F-11 | BR-047…053 | FR-044, FR-046…050 |
| F-12 | BR-063 | §2.3 |
| F-13 | BR-019, BR-031, BR-033 | FR-019, FR-027, FR-029 |
| F-14 | BR-036, BR-040 | FR-034, FR-037 |
| F-15 | BR-012, BR-013 | §2.3, §5 |
| F-16 | BR-001, BR-005, BR-059 | FR-002, FR-003 |
| F-17 | BR-060, BR-061, BR-062 | §4.6 |
| F-18 | BR-002, BR-003 | FR-004 |
| F-19 | BR-004 | FR-005 |

---

**End of document.**

Next recommended step: hand to design for wireframes on the highest-uncertainty flows (F-09 conflict resolution, F-11 recurring preview, F-17 branch-hours affected flow), or run `/bmad-create-epics-and-stories` to break these 19 flows into sprintable stories.