# Product Requirements Document (PRD)

## 1. Product Overview

### 1.1 Product Name

**Multi-Branch Clinic Appointment Scheduling System**

### 1.2 Product Vision

Build a reliable, low-friction appointment scheduling platform for clinics with multiple branches and doctors.

Patients should be able to book and manage appointments without creating traditional accounts, while doctors and receptionists should have role-appropriate tools for managing schedules and appointments.

### 1.3 Primary Product Goal

The product must make it possible to:

> **Find a valid doctor/branch/time combination and reserve it without double booking.**

The system should also protect existing appointments when schedules or branch operating hours change.

---

# 2. User Roles

## 2.1 Patient

### Capabilities

* Browse doctors.
* Select branch.
* Select appointment type.
* View availability.
* Book appointment.
* Verify phone through OTP.
* View upcoming appointments.
* Cancel appointments.
* Reschedule appointments.

### Restrictions

* No password account.
* Cannot book same-day appointments.
* Cannot have multiple future appointments with the same doctor.
* Cannot have overlapping appointments.
* Cannot change doctor during rescheduling.
* Cannot directly create recurring appointments.

---

## 2.2 Doctor

### Capabilities

* Manage personal appointment types.
* Set appointment duration.
* Define branch-specific weekly schedules.
* Define multiple working periods per day.
* Block dates and time periods.
* Create recurring appointments.
* View own appointments.
* Mark appointments Completed.
* Mark appointments No-show.
* Cancel appointments with a reason.
* Resolve appointments affected by schedule changes.
* Move affected appointments between branches where the doctor works.

### Restrictions

* Cannot delete appointments.
* Cannot normally reschedule patient appointments.
* Cannot change the appointment type while resolving an affected appointment.
* Cannot save availability changes that invalidate existing appointments.

---

## 2.3 Receptionist

### Capabilities

* View appointments in assigned branch.
* Create appointments for doctors assigned to their branch.
* Cancel appointments on behalf of patients.
* Enter cancellation reason.
* Mark appointments Completed.
* Mark appointments No-show.
* View relevant doctor availability.

### Restrictions

* Assigned to one branch.
* Cannot see other branches' appointments.
* Cannot modify doctor schedules.
* Cannot reschedule appointments.
* Cannot book doctors outside assigned branch.

---

## 2.4 Administrator

### Capabilities

* Manage doctors.
* Manage receptionists.
* Manage branches.
* Assign doctors to branches.
* Assign receptionists to branches.
* Set branch operating hours.
* Change branch operating hours.
* Deactivate branches subject to business rules.

### Restrictions

* Does not participate in individual appointment management.
* Does not automatically resolve appointment conflicts caused by configuration changes.

---

# 3. Functional Requirements

## FR-001 — Clinic Management

The system shall support a clinic containing multiple branches.

## FR-002 — Branch Creation

The administrator shall be able to create a branch with:

* Branch name
* Location/address
* Operating hours
* Active/inactive status

## FR-003 — Branch Operating Hours

Each branch shall support its own weekly operating hours.

The system shall support multiple operating periods per day if required by the implementation.

## FR-004 — Doctor Management

The administrator shall be able to:

* Create doctors.
* Deactivate doctors.
* Assign doctors to one or more branches.

A doctor shall belong to only one clinic.

## FR-005 — Receptionist Management

The administrator shall be able to:

* Create receptionists.
* Deactivate receptionists.
* Assign a receptionist to exactly one branch.

## FR-006 — Doctor Appointment Types

Each doctor shall be able to define appointment types.

Each appointment type shall contain at minimum:

* Name
* Duration
* Active/inactive state

Appointment types are doctor-specific.

## FR-007 — Appointment Type Branch Availability

If a doctor offers an appointment type, it shall be bookable at every branch where that doctor works.

## FR-008 — Doctor Schedule

A doctor shall be able to define availability independently for each branch.

Example:

```text
Doctor: Dr. Ahmed

Branch A
Sunday: 09:00–13:00
Monday: 10:00–14:00

Branch B
Sunday: 15:00–19:00
Tuesday: 09:00–13:00
```

## FR-009 — Multiple Working Periods

The schedule engine shall support multiple working periods on the same day.

## FR-010 — Effective Date

A doctor shall be able to specify an effective date for a schedule.

## FR-011 — Schedule Conflict Validation

Before saving a schedule change, the system shall check whether existing appointments are affected.

If affected appointments exist, the schedule change shall not be saved.

## FR-012 — Blocked Periods

Doctors shall be able to create:

* Single-date blocks.
* Time blocks.
* Multi-day blocks.

## FR-013 — Block Conflict Validation

The system shall reject a block if it overlaps an existing appointment.

## FR-014 — Availability Engine

The system shall calculate availability using:

```text
Branch Operating Hours
        ∩
Doctor Branch Schedule
        -
Doctor Blocked Periods
        -
Existing Appointments
```

Only complete appointment durations shall be considered bookable.

## FR-015 — Slot Generation

Slots shall be generated based on appointment duration.

Example:

```text
30-minute appointment:
09:00–09:30
09:30–10:00
10:00–10:30

45-minute appointment:
09:00–09:45
09:45–10:30
10:30–11:15
```

## FR-016 — No Buffer

The scheduling engine shall not insert buffer time between appointments.

## FR-017 — Partial Remaining Time

If remaining working time cannot fit a complete appointment, it shall remain unused.

## FR-018 — Booking Window

The system shall expose availability only within the configured initial booking window of **30 days**.

## FR-019 — Same-Day Restriction

No appointment may be created for the current date.

The earliest bookable date is tomorrow.

This rule applies to both patients and receptionists.

## FR-020 — Patient Booking

The patient booking flow shall be:

```text
Doctor
  ↓
Branch
  ↓
Appointment Type
  ↓
Date
  ↓
Available Time
  ↓
Name + Phone
  ↓
Confirmation
```

## FR-021 — Guest Booking

Patients shall not need to create an account to make an appointment.

Required booking information:

* Name
* Phone number

## FR-022 — Patient Phone Uniqueness

Phone number shall uniquely identify a patient.

## FR-023 — Returning Patient

If a known phone number is entered:

* Existing patient name shall be displayed.
* User shall be allowed to modify the name.

## FR-024 — Immediate Confirmation

Once all booking validations pass, the appointment shall immediately become Scheduled.

## FR-025 — Atomic Booking

The system shall reserve a slot atomically.

If two users attempt to book the same slot, only one request shall succeed.

## FR-026 — Booking Race Condition

If the requested slot is no longer available when the transaction completes:

* The appointment shall not be created.
* The user shall be informed that the slot is unavailable.
* The user shall choose another slot.

The system shall not automatically select a different slot.

## FR-027 — Patient Appointment Limit

The system shall prevent a patient from having more than one future appointment with the same doctor.

The restriction applies across all branches.

## FR-028 — Cross-Doctor Booking

A patient may have future appointments with multiple doctors.

## FR-029 — Patient Overlap

The system shall prevent overlapping appointments for the same patient.

This applies across different doctors and branches.

## FR-030 — Back-to-Back Appointments

Back-to-back appointments are allowed even when the branches differ.

No travel-time calculation is required.

## FR-031 — Patient Authentication

Patients shall authenticate through SMS OTP.

## FR-032 — Upcoming Appointment Access

After successful OTP verification, a patient shall be able to view their upcoming appointments.

Cancelled appointments shall not appear in the patient-facing upcoming appointment list.

## FR-033 — Patient Cancellation

Patients may cancel appointments at any time.

No cancellation reason is required from the patient.

The appointment shall transition to Cancelled rather than being deleted.

## FR-034 — Receptionist Cancellation

Receptionists shall be able to cancel appointments on behalf of patients.

A cancellation reason shall be mandatory.

## FR-035 — Doctor Cancellation

Doctors shall be able to cancel appointments.

A cancellation reason shall be mandatory.

## FR-036 — Appointment Status

The system shall support:

| Status    | Description               |
| --------- | ------------------------- |
| Scheduled | Appointment is confirmed  |
| Completed | Consultation occurred     |
| Cancelled | Appointment was cancelled |
| No-show   | Patient did not attend    |

## FR-037 — Status Updates

Doctors and receptionists shall be able to update appointments to:

* Completed
* No-show

## FR-038 — Appointment Deletion

There shall be no normal appointment deletion function.

## FR-039 — Patient Rescheduling

Verified patients shall be able to reschedule appointments.

## FR-040 — Rescheduling Doctor Constraint

The doctor shall remain unchanged during normal patient rescheduling.

## FR-041 — Rescheduling Options

Patients may change:

* Branch
* Appointment type
* Date
* Time

The selected doctor remains unchanged.

## FR-042 — Rescheduling Transaction

The new slot shall be secured before the old appointment is released.

If the new slot cannot be secured, the original appointment shall remain unchanged.

## FR-043 — Rescheduling Conflict

If the new slot becomes unavailable:

> Show unavailable → retain original appointment → require another selection.

## FR-044 — Recurring Appointments

The system shall support recurring appointment creation.

## FR-045 — Recurring Appointment Actors

Doctors and receptionists may create recurring appointments.

Patients cannot directly create recurring appointments.

## FR-046 — Recurring Occurrence Validation

Each occurrence shall be independently validated against:

* Branch availability
* Doctor availability
* Doctor blocks
* Existing appointments
* Patient conflicts
* Booking window
* Same-doctor future appointment restrictions

## FR-047 — Partial Recurring Success

Available occurrences shall be created.

Unavailable occurrences shall be skipped.

## FR-048 — Recurring Result

The system shall clearly report:

* Number of successful occurrences.
* Dates that were skipped.
* Reason for each skipped occurrence where applicable.

## FR-049 — Recurring Occurrence Management

Individual occurrences shall be independently cancellable or reschedulable.

## FR-050 — Recurring Cancellation

Cancelling one occurrence shall immediately release its slot.

## FR-051 — Appointment Audit

The system shall maintain internal audit records for important appointment events, including:

* Creation
* Cancellation
* Rescheduling
* Status changes
* Relevant actor
* Timestamp

Detailed historical appointment versions are not required.

---

# 4. Appointment Conflict Management

## 4.1 Doctor Conflict

A doctor cannot have overlapping appointments.

## 4.2 Patient Conflict

A patient cannot have overlapping appointments.

## 4.3 Branch Conflict

An appointment cannot occur outside the operating hours of its branch.

## 4.4 Schedule Change Conflict

Doctor schedule changes that affect existing appointments must be rejected until affected appointments are resolved.

## 4.5 Doctor Block Conflict

Doctor blocks that overlap existing appointments must be rejected.

## 4.6 Branch Hours Conflict

Administrators may change branch hours even when appointments are affected.

Affected appointments shall be flagged for manual resolution.

The doctor associated with each affected appointment shall resolve it.

## 4.7 Doctor Absence Conflict

When a doctor attempts to become unavailable:

1. System identifies affected appointments.
2. Doctor resolves each affected appointment.
3. Doctor may reschedule the appointment.
4. The new slot may be at another branch where the doctor works.
5. Appointment type must remain unchanged.
6. Availability change becomes effective only after all affected appointments are resolved.

---

# 5. Access Control Requirements

| Capability                     | Patient |   Doctor | Receptionist | Admin |
| ------------------------------ | ------: | -------: | -----------: | ----: |
| Book appointment               |       ✓ |        — |            ✓ |     — |
| View own upcoming appointments |       ✓ |        ✓ |            — |     — |
| View doctor appointments       |       — | Own only |  Branch only |     — |
| Cancel appointment             |     Own |        ✓ |            ✓ |     — |
| Reschedule normal appointment  |     Own |        — |            — |     — |
| Resolve affected appointment   |       — |        ✓ |            — |     — |
| Manage doctor schedule         |       — |      Own |            — |     — |
| Manage appointment types       |       — |      Own |            — |     — |
| Create recurring appointments  |       — |        ✓ |            ✓ |     — |
| Manage doctors                 |       — |        — |            — |     ✓ |
| Manage receptionists           |       — |        — |            — |     ✓ |
| Manage branches                |       — |        — |            — |     ✓ |
| Manage branch hours            |       — |        — |            — |     ✓ |

---

# 6. User Stories

## Patient

### US-001 — Book Appointment

**As a patient,**
I want to select a doctor, branch, appointment type, and available time,
so that I can book an appointment without creating an account.

### US-002 — View Appointments

**As a patient,**
I want to verify my phone using OTP and view my upcoming appointments,
so that I know when and where I am scheduled.

### US-003 — Cancel

**As a patient,**
I want to cancel an appointment at any time,
so that I can release the slot when I no longer need it.

### US-004 — Reschedule

**As a patient,**
I want to change the branch, appointment type, date, or time while keeping the same doctor,
so that I can find a more convenient appointment.

### US-005 — Prevent Double Booking

**As a patient,**
I want the system to prevent me from booking an unavailable slot,
so that I don't receive an invalid appointment.

## Doctor

### US-006 — Configure Availability

**As a doctor,**
I want to configure my working hours separately for each branch,
so that patients see only my actual availability.

### US-007 — Block Time

**As a doctor,**
I want to block dates or periods when I am unavailable,
so that patients cannot book those periods.

### US-008 — Manage Services

**As a doctor,**
I want to define my appointment types and durations,
so that patients can book the correct type of consultation.

### US-009 — Resolve Schedule Conflicts

**As a doctor,**
I want to resolve appointments affected by my schedule changes,
so that existing patients are not silently disrupted.

## Receptionist

### US-010 — Branch Appointment Management

**As a receptionist,**
I want to see and manage appointments for my assigned branch,
so that I can support patients visiting that branch.

### US-011 — Cancel Appointment

**As a receptionist,**
I want to cancel an appointment on behalf of a patient with a reason,
so that the clinic has a record of why it was cancelled.

## Administrator

### US-012 — Manage Doctors

**As an administrator,**
I want to create, deactivate, and assign doctors to branches,
so that the clinic structure remains accurate.

### US-013 — Manage Receptionists

**As an administrator,**
I want to create, deactivate, and assign receptionists to branches,
so that each receptionist has the correct access.

### US-014 — Manage Branches

**As an administrator,**
I want to create, manage, and deactivate branches,
so that the clinic can operate across multiple locations.

---

# 7. Non-Functional Requirements

## NFR-001 — Reliability

The system shall prevent double booking under concurrent booking requests.

## NFR-002 — Data Integrity

An appointment shall never reference an invalid:

* Doctor
* Branch
* Appointment type
* Time period

## NFR-003 — Authorization

Every appointment and schedule operation shall be authorized according to role and branch/doctor ownership.

## NFR-004 — Transaction Safety

Booking and rescheduling operations shall use transactional logic to avoid race conditions.

## NFR-005 — Auditability

Important appointment changes shall be auditable with actor and timestamp information.

## NFR-006 — Security

Patient appointment access shall require SMS OTP verification.

## NFR-007 — Privacy

Patients shall only be able to access appointments associated with their verified phone number.

## NFR-008 — Performance

Availability searches should return results quickly enough for interactive patient booking.

A target of **≤2 seconds for typical availability queries** is recommended for the initial release.

## NFR-009 — Availability

The appointment booking service should remain highly available because booking failures directly affect clinic operations.

## NFR-010 — Consistency

The availability displayed to users should reflect current booking state as closely as technically possible.

---

# 8. Recommended Core Data Model

The following entities are recommended.

### Clinic

* id
* name
* status

### Branch

* id
* clinic_id
* name
* address
* operating_schedule
* status

### Doctor

* id
* clinic_id
* name
* status

### DoctorBranch

* doctor_id
* branch_id

### Receptionist

* id
* clinic_id
* branch_id
* name
* status

### Patient

* id
* phone_number
* name

### AppointmentType

* id
* doctor_id
* name
* duration
* status

### DoctorSchedule

* id
* doctor_id
* branch_id
* effective_from
* effective_to
* day_of_week
* start_time
* end_time

### DoctorBlock

* id
* doctor_id
* start_datetime
* end_datetime
* reason

### Appointment

* id
* patient_id
* doctor_id
* branch_id
* appointment_type_id
* start_datetime
* end_datetime
* status
* created_by
* created_at
* updated_at

### AppointmentAudit

* id
* appointment_id
* action
* actor_id
* actor_role
* timestamp
* metadata

### OTPVerification

* id
* phone_number
* code/reference
* expires_at
* verified_at
* attempt_count

---

# 9. Availability Algorithm

The system should calculate availability approximately as follows:

```text
1. Identify doctor.
2. Identify selected branch.
3. Load branch operating hours.
4. Load doctor's schedule for that branch.
5. Calculate intersection:
       Branch Hours ∩ Doctor Hours
6. Remove doctor's blocked periods.
7. Remove existing appointments.
8. Generate slots based on appointment duration.
9. Remove slots that violate:
       - 30-day booking window
       - Same-day restriction
       - Doctor conflict
       - Patient conflict
10. Return available slots.
```

The resulting slot must provide the **entire appointment duration**.

---

# 10. Booking Transaction

A booking request should follow this sequence:

```text
Validate patient
      ↓
Validate doctor
      ↓
Validate branch
      ↓
Validate appointment type
      ↓
Validate booking date
      ↓
Validate doctor availability
      ↓
Validate branch hours
      ↓
Validate doctor conflicts
      ↓
Validate patient conflicts
      ↓
Atomically reserve slot
      ↓
Create Scheduled appointment
```

If any validation fails, no appointment should be created.

---

# 11. Rescheduling Transaction

Recommended sequence:

```text
Existing Appointment
        ↓
Patient selects new slot
        ↓
Validate same doctor
        ↓
Validate new branch
        ↓
Validate appointment type
        ↓
Validate availability
        ↓
Validate patient conflicts
        ↓
Reserve new slot atomically
        ↓
Update existing appointment
        ↓
Release old slot
```

If reservation of the new slot fails, the original appointment remains unchanged.

---

# 12. Recurring Appointment Flow

```text
Doctor/Receptionist
        ↓
Select doctor
        ↓
Select branch
        ↓
Select appointment type
        ↓
Select recurrence pattern
        ↓
Generate occurrences
        ↓
Validate each occurrence
        ↓
Create valid occurrences
        ↓
Skip conflicts
        ↓
Show skipped occurrences
```

Partial success is allowed.

---

# 13. Appointment Lifecycle

Normal appointment lifecycle:

```text
                ┌──────────────┐
                │   Scheduled  │
                └──────┬───────┘
                       │
            ┌──────────┼──────────┐
            ↓          ↓          ↓
       Completed   Cancelled   No-show
```

Appointments are never deleted.

---

# 14. MVP Scope

## Must Have

* Multi-branch clinic.
* Administrator role.
* Doctor role.
* Receptionist role.
* Patient guest booking.
* Phone-number identification.
* SMS OTP.
* Doctor/branch selection.
* Appointment type selection.
* Doctor-specific appointment durations.
* Branch operating hours.
* Branch-specific doctor schedules.
* Doctor blocked periods.
* 30-day booking window.
* No same-day booking.
* Immediate booking confirmation.
* Double-booking prevention.
* Patient overlap prevention.
* One future appointment per patient per doctor.
* Patient cancellation.
* Patient rescheduling.
* Doctor/receptionist appointment status management.
* Recurring appointments.
* Appointment audit.
* Conflict detection for schedule changes.
* Role-based and branch-based access control.

## Should Have

* Clear conflict explanations.
* Efficient availability search.
* Schedule visualization for doctors.
* Calendar view for receptionists.
* Recurring appointment summary.
* Audit history for administrators/system operators if later required.

## Not in MVP

* Payment.
* Billing.
* SMS reminders.
* Email reminders.
* Medical records.
* Clinical notes.
* Patient-facing historical appointment records.
* Waiting lists.
* Travel-time optimization.
* Multi-clinic doctor accounts.

---

# 15. Acceptance Criteria — Critical Scenarios

### Scenario 1 — Successful Booking

**Given** a doctor is available at a branch
**And** the branch is open
**And** the slot is within the booking window
**When** the patient submits the booking
**Then** the appointment is created as Scheduled.

### Scenario 2 — Same-Day Booking

**Given** today is August 18
**When** a user attempts to book August 18
**Then** the system rejects the booking.

### Scenario 3 — Double Booking

**Given** two users select the same slot
**When** both requests are submitted concurrently
**Then** exactly one appointment succeeds.

### Scenario 4 — Patient Conflict

**Given** a patient has an appointment from 10:00–10:30
**When** they attempt to book another appointment from 10:15–10:45
**Then** the booking is rejected.

### Scenario 5 — Doctor Conflict

**Given** a doctor already has an appointment from 10:00–10:30
**When** another user attempts to book the same doctor during that period
**Then** the slot is unavailable.

### Scenario 6 — Schedule Change

**Given** existing appointments fall inside a proposed schedule change
**When** the doctor saves the change
**Then** the system rejects the change until the affected appointments are resolved.

### Scenario 7 — Blocked Period

**Given** an existing appointment from 10:30–11:00
**When** the doctor attempts to block 10:00–11:00
**Then** the block is rejected.

### Scenario 8 — Patient Rescheduling

**Given** a verified patient has an appointment
**When** the patient selects another valid slot with the same doctor
**Then** the appointment is moved to the new slot.

### Scenario 9 — Rescheduling Race Condition

**Given** a patient selects a slot
**And** another user books it first
**When** the patient confirms
**Then** the rescheduling operation fails and the original appointment remains intact.

### Scenario 10 — Recurring Booking

**Given** eight weekly occurrences are requested
**And** one occurrence conflicts with an existing appointment
**When** the series is created
**Then** seven occurrences are created and the conflicting occurrence is skipped and displayed to the user.

### Scenario 11 — Receptionist Access

**Given** a receptionist belongs to Branch A
**When** the receptionist accesses appointments
**Then** only Branch A appointments are visible.

### Scenario 12 — Doctor Access

**Given** a doctor works at multiple branches
**When** the doctor views appointments
**Then** only that doctor's appointments are visible.

### Scenario 13 — Patient OTP

**Given** a patient enters a registered phone number
**When** the correct SMS OTP is provided
**Then** the patient can access their upcoming appointments.

### Scenario 14 — Cancellation

**Given** a patient cancels an appointment
**When** cancellation is confirmed
**Then** the appointment becomes Cancelled and its slot becomes available.

### Scenario 15 — No Deletion

**Given** an existing appointment
**When** a user attempts to delete it
**Then** the system does not provide a normal delete operation.

---

# 16. Product Metrics

Recommended initial product metrics:

### Booking

* Booking success rate.
* Failed booking rate.
* Slot conflict rate.
* Average time to complete booking.

### Availability

* Availability query response time.
* Number of available slots returned.
* Percentage of searches resulting in booking.

### Appointment Management

* Cancellation rate.
* Rescheduling rate.
* No-show rate.
* Completed appointment rate.

### Recurring Appointments

* Recurring series creation success rate.
* Percentage of occurrences skipped due to conflicts.

### System Reliability

* Double-booking incidents.
* Schedule conflict incidents.
* Failed transaction rate.
* OTP verification success rate.

---

# 17. MVP Release Definition

The MVP is ready for production when:

1. A patient can book a valid appointment without an account.
2. SMS OTP successfully authenticates returning patients.
3. Doctor schedules generate correct availability.
4. Branch hours are respected.
5. Doctor blocks are respected.
6. Existing appointments cannot be double booked.
7. Patient conflicts are prevented.
8. Patient cancellation works.
9. Patient rescheduling works safely.
10. Doctor and receptionist permissions are enforced.
11. Recurring appointments work with partial conflicts.
12. Schedule changes cannot silently invalidate appointments.
13. Appointment statuses work correctly.
14. Audit records are generated.
15. No payment or medical-record functionality is required for release.

# 18. Product Principle

The central product principle is:

> **Never silently change, cancel, move, or overwrite a patient's confirmed appointment.**

Whenever availability changes conflict with existing appointments, the system should detect the conflict and require an explicit resolution by the appropriate user.
