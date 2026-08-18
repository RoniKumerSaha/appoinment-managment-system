# Business Requirements Document (BRD)

## 1. Document Overview

### 1.1 Purpose

This BRD defines the business requirements for a multi-branch clinic appointment scheduling system. The system will enable patients to discover doctor availability and book appointments, while allowing doctors and branch-based receptionists to manage appointments and availability within clearly defined business rules.

The system is intended to provide reliable appointment scheduling without double bookings, unnecessary patient account creation, billing functionality, or medical-record management.

### 1.2 Business Objective

The primary objective is to provide a simple, reliable appointment management platform that:

* Allows patients to book appointments without creating an account.
* Allows patients to view, cancel, and reschedule appointments through phone-number verification.
* Allows doctors to manage their own branch-specific availability.
* Allows receptionists to manage appointments within their assigned branch.
* Allows administrators to manage clinic structure, branches, doctors, and receptionists.
* Prevents double booking and appointment conflicts.
* Supports recurring appointments.
* Protects existing appointments from unintended schedule changes.
* Provides an internal audit trail for appointment changes.

## 2. Business Scope

### 2.1 In Scope

The system will support:

* Multi-branch clinics.
* Multiple doctors per clinic.
* Multiple receptionists per clinic.
* Doctor-to-multiple-branch assignments.
* Branch-specific operating hours.
* Doctor branch-specific weekly schedules.
* Multiple working periods per day.
* Doctor-specific appointment types.
* Doctor-specific appointment durations.
* Patient guest booking.
* Phone-number-based patient identification.
* SMS OTP verification.
* Appointment booking.
* Appointment cancellation.
* Patient self-service rescheduling.
* Recurring appointments.
* Appointment status management.
* Availability generation.
* Conflict prevention.
* Schedule blocking.
* Appointment audit records.
* Role-based access control.

### 2.2 Out of Scope

The following are explicitly outside the initial scope:

* Consultation fees.
* Payments.
* Billing.
* Medical records.
* Clinical notes.
* Patient medical history.
* Patient-facing historical appointment list.
* Email notifications.
* SMS appointment notifications.
* Push/in-app notifications.
* Automatic reassignment of appointments to another doctor.
* Automatic cancellation caused by schedule changes.
* Travel-time calculations between branches.
* Password-based patient accounts.
* Multiple clinics per doctor.

## 3. Business Users and Roles

### 3.1 Patient

Patients are guest users and do not require traditional accounts.

Patients can:

* Search/select doctors.
* Select a branch.
* Select an appointment type.
* View available slots.
* Book appointments.
* View upcoming appointments after phone verification.
* Cancel appointments.
* Reschedule appointments.
* Create recurring appointments only through supported staff workflows, not directly.

Patient identity is based on a unique phone number.

### 3.2 Doctor

Doctors belong to exactly one clinic but may work at multiple branches within that clinic.

Doctors can:

* Define appointment types.
* Define appointment durations.
* Create and manage their branch-specific working schedules.
* Define multiple working periods per day.
* Create multi-day blocked periods.
* View their own appointments.
* Mark appointments Completed or No-show.
* Cancel appointments with a mandatory reason.
* Resolve appointments affected by their own availability changes.
* Reschedule affected appointments to another available slot.
* Move affected appointments to another branch where they work.
* Create recurring appointments.

Doctors cannot:

* Reschedule ordinary patient appointments.
* Change the appointment type while resolving an affected appointment.
* Delete appointments.

### 3.3 Receptionist

A clinic can have any number of receptionists.

Each receptionist belongs to exactly one branch.

Receptionists can:

* View appointments for their assigned branch.
* Create appointments for patients with doctors assigned to their branch.
* Cancel appointments on behalf of patients.
* Provide a cancellation reason when cancelling.
* Mark appointments Completed or No-show.
* View doctor availability for their branch.

Receptionists cannot:

* Modify doctor schedules.
* Reschedule appointments.
* Book doctors outside their assigned branch.
* View appointments belonging to other branches.

### 3.4 Administrator

The administrator manages the clinic configuration and users.

Administrators can:

* Create/deactivate doctors.
* Assign doctors to branches.
* Create/deactivate receptionists.
* Assign receptionists to branches.
* Create and manage branches.
* Set and modify branch operating hours.
* Deactivate branches when they have no future appointments.

Administrators do not have access to individual appointment records as part of the operational appointment workflow.

## 4. Business Rules

### BR-001 — Multi-Branch Clinic

A clinic may contain multiple physical branches.

### BR-002 — Doctor Clinic Assignment

A doctor belongs to exactly one clinic.

### BR-003 — Doctor Branch Assignment

A doctor may work at multiple branches within their clinic.

### BR-004 — Receptionist Branch Assignment

A receptionist belongs to exactly one branch.

### BR-005 — Branch Operating Hours

Each branch has its own operating hours.

### BR-006 — Doctor Schedule

Doctor availability is defined separately for each branch.

### BR-007 — Multiple Daily Periods

A doctor may have multiple working periods on the same day at a branch.

### BR-008 — Effective Schedule Date

A doctor can define an effective date for a schedule change.

### BR-009 — Schedule Conflict Protection

A doctor cannot save a schedule change if it would invalidate an existing appointment.

### BR-010 — Doctor Blocking

Doctors may block specific dates/times or multi-day periods.

### BR-011 — Blocking Conflict Protection

A blocked period cannot be created if it conflicts with an existing appointment.

### BR-012 — Branch and Doctor Availability

A bookable appointment requires both:

1. The branch to be open.
2. The selected doctor to be available at that branch.

### BR-013 — Branch Operating Boundary

Branch operating hours define the outer boundary of possible appointment availability.

### BR-014 — Appointment Types

Each doctor defines their own appointment types.

### BR-015 — Appointment Duration

Each doctor defines the duration of their appointment types.

### BR-016 — Appointment Type Branch Availability

An appointment type offered by a doctor is available at every branch where that doctor works.

### BR-017 — No Buffer

There is no buffer between appointments.

### BR-018 — Slot Generation

The next slot starts immediately after the previous appointment duration.

### BR-019 — Partial Period

Unused time that cannot fit a complete appointment remains unavailable.

### BR-020 — Booking Window

Appointments may only be booked within the fixed future booking window, initially defined as 30 days.

### BR-021 — No Same-Day Booking

No user may create a same-day appointment. Booking starts from the following day.

### BR-022 — Immediate Confirmation

Valid bookings are immediately confirmed.

### BR-023 — Double Booking Prevention

A slot can only be successfully assigned to one appointment.

### BR-024 — Concurrent Booking

If a requested slot becomes unavailable before confirmation, the booking fails and the user must select another slot.

### BR-025 — Patient Phone Identity

A patient phone number is unique and identifies the patient.

### BR-026 — Patient Information

Minimum patient information is:

* Name
* Phone number

### BR-027 — Returning Patient Name

When an existing phone number is used, the stored name is displayed but may be changed.

### BR-028 — No Patient Account

Patients do not require passwords or traditional accounts.

### BR-029 — Patient Verification

Patients must verify their phone number using SMS OTP before accessing their upcoming appointments.

### BR-030 — Patient Self-Service

Verified patients can view, cancel, and reschedule appointments.

### BR-031 — Patient Appointment Limit

A patient may have a maximum of one future appointment with the same doctor, regardless of branch.

### BR-032 — Different Doctors

A patient may have future appointments with different doctors.

### BR-033 — Patient Overlap Prevention

A patient cannot have overlapping appointments, even when appointments are with different doctors.

### BR-034 — Branch Travel

Back-to-back appointments at different branches are permitted. Travel time is not considered.

### BR-035 — Patient Cancellation

Patients can cancel appointments at any time without providing a reason.

### BR-036 — Receptionist Cancellation

Receptionists may cancel appointments on behalf of patients. A reason is mandatory.

### BR-037 — Doctor Cancellation

Doctors may cancel appointments. A reason is mandatory.

### BR-038 — Appointment Deletion

Appointments cannot be permanently deleted.

### BR-039 — Appointment Statuses

The system supports exactly:

* Scheduled
* Completed
* Cancelled
* No-show

### BR-040 — Appointment Status Management

Doctors and receptionists may update appointment status to Completed or No-show.

### BR-041 — Patient Rescheduling

Patients can reschedule their own appointments.

### BR-042 — Rescheduling Doctor

A patient must keep the same doctor when rescheduling.

### BR-043 — Rescheduling Options

A patient may change:

* Branch
* Appointment type
* Date
* Time

provided the selected combination is available.

### BR-044 — Rescheduling Race Condition

If the selected new slot becomes unavailable, the operation fails and another slot must be selected.

### BR-045 — Rescheduling History

Rescheduling updates the appointment rather than preserving a detailed historical version of the appointment.

### BR-046 — Appointment Audit

The system maintains internal audit information for appointment changes.

### BR-047 — Recurring Appointments

Recurring appointments are supported.

### BR-048 — Recurring Appointment Creation

Doctors and receptionists can create recurring appointments.

### BR-049 — Recurring Availability

Every occurrence of a recurring appointment is checked independently.

### BR-050 — Recurring Conflicts

Available occurrences are created while conflicting occurrences are skipped.

### BR-051 — Recurring Conflict Visibility

Skipped occurrences must be clearly shown to the user.

### BR-052 — Individual Recurring Occurrence

An individual occurrence may be cancelled or rescheduled independently.

### BR-053 — Released Slot

A cancelled recurring occurrence immediately releases its slot.

### BR-054 — Doctor Absence

A doctor cannot create an absence/block that conflicts with existing appointments.

### BR-055 — Resolving Doctor Conflicts

The doctor must resolve affected appointments before the availability change is saved.

### BR-056 — Doctor Conflict Resolution

For an affected appointment, the doctor can reschedule it to another available slot.

### BR-057 — Affected Appointment Branch

An affected appointment may be moved to another branch where the doctor works.

### BR-058 — Affected Appointment Type

The appointment type must remain unchanged when resolving an affected appointment.

### BR-059 — Branch Deactivation

A branch can only be deactivated if it has no future appointments.

### BR-060 — Branch Hours Change

The administrator can change branch operating hours even if future appointments are affected.

### BR-061 — Branch Hours Conflict

Affected appointments are marked for manual resolution rather than automatically cancelled or moved.

### BR-062 — Branch Conflict Resolution

The doctor associated with an affected appointment resolves it.

### BR-063 — Receptionist Visibility

A receptionist sees appointments for their assigned branch only.

### BR-064 — Doctor Visibility

A doctor sees their own appointments.

### BR-065 — Administrator Visibility

The administrator does not access individual appointments as part of the appointment workflow.

## 5. Business Success Criteria

The system will be considered successful when:

1. Patients can book appointments without creating accounts.
2. Patients can reliably find real available slots.
3. Double bookings are prevented.
4. Schedule and branch changes cannot silently invalidate existing appointments.
5. Doctors can independently manage their branch-specific availability.
6. Receptionists can efficiently manage appointments within their branch.
7. Patients can self-manage upcoming appointments using OTP verification.
8. Recurring appointments can be created without creating conflicting bookings.
9. Appointment status and audit information remain reliable.
10. The system does not require billing, medical records, or notification infrastructure for the initial release.

## 6. Key Assumptions

* The initial booking window is 30 days.
* SMS OTP infrastructure will be available for patient verification.
* SMS appointment notifications are not required.
* The system operates within a single clinic organization per tenant.
* Each doctor belongs to exactly one clinic.
* A clinic may have multiple branches.
* Each receptionist belongs to exactly one branch.
* Appointment duration is defined by the doctor.
* No appointment buffer is required.
* No payment processing is required.

## 7. Major Business Risks

### Scheduling Conflicts

Changes to doctor schedules or branch hours can affect existing appointments. The system must detect these conflicts before changes become effective or must flag affected appointments for manual resolution.

### Concurrent Booking

Multiple users may attempt to book the same slot. The system must enforce atomic slot reservation.

### Recurring Booking Complexity

Some occurrences in a recurring series may be unavailable. The system must handle partial success and clearly communicate skipped occurrences.

### Access Control

Receptionists are restricted to their assigned branch while doctors may work across multiple branches. Role and branch authorization must therefore be enforced consistently.

### Patient Identity

Phone numbers are unique patient identifiers, so duplicate or conflicting patient data must be handled carefully.

## 8. Business Process Summary

### Patient Booking

1. Patient selects doctor.
2. Patient selects branch.
3. Patient selects appointment type.
4. System displays valid future availability.
5. Patient selects a slot.
6. Patient provides name and phone.
7. System validates conflicts.
8. System confirms the appointment.

### Patient Self-Service

1. Patient enters phone number.
2. System sends OTP.
3. Patient verifies OTP.
4. System displays upcoming appointments.
5. Patient may cancel or reschedule.

### Doctor Scheduling

1. Doctor defines branch-specific working hours.
2. Doctor defines appointment types and durations.
3. Doctor may block dates/times.
4. System generates valid slots.
5. Conflicting schedule changes are rejected.

### Receptionist Workflow

1. Receptionist signs in.
2. System limits access to assigned branch.
3. Receptionist views branch appointments.
4. Receptionist can create or cancel appointments.
5. Receptionist can update appointment status.
6. Receptionist cannot modify doctor schedules or reschedule appointments.

## 9. Future Considerations

The following may be considered after the initial release:

* SMS appointment reminders.
* Email notifications.
* Payments and billing.
* Medical records.
* Patient appointment history.
* Advanced reporting.
* Waiting lists.
* Travel-time-aware scheduling.
* Cross-clinic doctor accounts.
* Configurable booking windows.
* Advanced cancellation policies.
