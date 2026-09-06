# PRD — Multi-Branch Clinic Appointment Scheduling System

> **BMad planning artifact.** This file mirrors the content of the source PRD and BRD under `docs/specs/` and is structured for downstream BMad skills (`bmad-architecture`, `bmad-create-epics-and-stories`). The docs/specs versions remain the human-authored source of truth.

## Source documents

- Business requirements: `docs/specs/BRD.md` (rules BR-001…BR-065)
- Product requirements: `docs/specs/PRD.md` (51 functional + 10 non-functional requirements)
- User flows: `docs/specs/UX-FLOWS.md` (F-01…F-19)
- Traceability: every FR below maps to one or more BRs; see `## 11. Traceability` at the end.

---

## 1. Vision & Goal

**Product:** Multi-Branch Clinic Appointment Scheduling System
**Tone:** "Boring software that gets appointments right." (DESIGN-SYSTEM.md §1)
**One-sentence goal:**

> Find a valid doctor / branch / time combination and reserve it without double booking, while protecting existing appointments from being silently invalidated by schedule or branch-hours changes.

### Out of scope (MVP)

Billing, payments, medical records, clinical notes, email/in-app notifications, automatic rebooking, travel-time calculations, password-based patient accounts, multi-clinic doctors.

---

## 2. Roles

| Role | Auth | Scope | Key limits |
|---|---|---|---|
| **Patient** | SMS OTP (BR-029) | Self-service only | No account; 1 future appt per doctor (BR-031); no overlap (BR-033); no same-day (BR-021) |
| **Doctor** | Signed-in staff | Own appointments + own branch schedules | Cannot delete; cannot normally reschedule patient appts (BR-022); availability changes that invalidate existing appts are rejected (BR-009, BR-011) |
| **Receptionist** | Signed-in staff | Single assigned branch | Branch-scoped reads/writes only; cannot modify schedules (BR-004, BR-063) |
| **Administrator** | Signed-in staff | Clinic structure | Does not see individual appointments (BR-065); branch-hours changes save even when appts are affected (BR-060) |

**Capability matrix:** see PRD §5. Held invariant; the matrix is the access-control contract.

---

## 3. Functional scope (FR-001…FR-051)

### 3.1 Clinic structure

- **FR-001 / FR-002 / FR-003** — multi-branch clinic; admin creates/edits branches with name, address, weekly operating hours (multi-period per day), and active/inactive status.
- **FR-004** — admin creates/deactivates doctors; assigns them to ≥1 branches. One clinic per doctor.
- **FR-005** — admin creates/deactivates receptionists; each assigned to exactly one branch.

### 3.2 Doctor-managed configuration

- **FR-006 / FR-007** — doctor defines appointment types (name, duration, active/inactive). Active types are bookable at every branch the doctor works at.
- **FR-008 / FR-009 / FR-010** — doctor defines a branch-specific weekly schedule with multiple working periods per day; an effective date can be set.
- **FR-011** — schedule changes are **rejected** if they invalidate existing appointments (BR-009); the doctor must resolve affected appts first.
- **FR-012 / FR-013** — blocks (single date, time range, multi-day) are also **rejected** if they overlap existing appts (BR-011).

### 3.3 Availability engine

- **FR-014 / FR-015 / FR-016 / FR-017** — availability = `(Branch Hours ∩ Doctor Schedule) − Doctor Blocks − Existing Appts`. Slots are generated back-to-back from appointment duration. No buffer. Partial remaining time is unused.
- **FR-018** — fixed 30-day booking window. Configurable window is post-MVP.
- **FR-019** — no same-day booking. Applies to patients, doctors, receptionists, and recurring-occurrence generation.

### 3.4 Patient booking

- **FR-020 / FR-021** — booking flow: Doctor → Branch → Type → Date → Slot → Name + Phone → Confirmation. No account required.
- **FR-022** — phone number uniquely identifies a patient.
- **FR-023** — known phone returns the stored name, editable.
- **FR-024 / FR-025 / FR-026** — valid bookings are immediately confirmed, with atomic slot reservation. If a slot is lost to concurrent booking, the operation fails and the user picks another (no auto-substitution).

### 3.5 Patient conflict rules

- **FR-027** — one future appointment per patient per doctor (across all branches).
- **FR-028** — a patient may have future appointments with multiple doctors.
- **FR-029 / FR-030** — no patient-time overlap across doctors/branches; back-to-back at different branches is allowed (no travel-time calculation).

### 3.6 Patient self-service

- **FR-031 / FR-032** — SMS OTP authentication; verified patient sees upcoming Scheduled appointments only (cancelled/completed/no-show excluded).
- **FR-033** — patient cancellation, no reason required, transitions to `Cancelled`.
- **FR-039 / FR-040 / FR-041 / FR-042 / FR-043** — patient rescheduling; doctor is locked; may change branch, type, date, time; new slot is reserved before the old slot is released; on race, the original remains untouched.

### 3.7 Staff cancellation & status

- **FR-034 / FR-035** — receptionist/doctor cancellation requires a reason; transitions to `Cancelled`, slot released.
- **FR-036 / FR-037** — exactly four statuses: Scheduled, Completed, Cancelled, No-show. Doctors and receptionists may move Scheduled → Completed or No-show.
- **FR-038** — no normal deletion function. Cancelled appointments remain.

### 3.8 Recurring appointments

- **FR-044 / FR-045** — doctors and receptionists can create recurring series. Patients cannot.
- **FR-046 / FR-047 / FR-048** — each occurrence is validated independently; partial success (available created, conflicting skipped); skipped occurrences are surfaced with reason.
- **FR-049 / FR-050** — individual occurrences are independently cancellable/reschedulable; cancellation immediately releases that slot.

### 3.9 Audit

- **FR-051** — audit records for creation, cancellation, rescheduling, status changes — actor + timestamp + metadata. No historical appointment versions.

---

## 4. Conflict management (PRD §4)

| Conflict | Behavior | Source |
|---|---|---|
| Doctor overlap | Slot unavailable | §4.1 |
| Patient overlap | Booking rejected | §4.2 |
| Branch-hours outside | Slot unavailable | §4.3 |
| Doctor schedule change affecting appts | **Rejected** until resolved | §4.4 / BR-009 |
| Doctor block overlap | **Rejected** | §4.5 / BR-011 |
| Branch hours change (admin) | **Saved**, appts flagged for manual resolution by assigned doctor | §4.6 / BR-060, BR-061 |
| Doctor absence (FR-011) | Doctor resolves each affected appt (reschedule to another valid slot; may change branch; type locked) | §4.7 |

**Core principle:** "Never silently change, cancel, move, or overwrite a patient's confirmed appointment." (PRD §18)

---

## 5. Non-functional requirements

| ID | Concern | Requirement |
|---|---|---|
| NFR-001 | Reliability | No double bookings under concurrent load |
| NFR-002 | Data integrity | An appointment never references an invalid doctor/branch/type/time |
| NFR-003 | Authorization | Every operation authorized by role + branch/doctor ownership |
| NFR-004 | Transaction safety | Booking and rescheduling are atomic |
| NFR-005 | Auditability | Important changes audit-recorded (actor + timestamp) |
| NFR-006 | Security | Patient access requires SMS OTP |
| NFR-007 | Privacy | Patients see only their own appointments (filtered server-side) |
| NFR-008 | Performance | Availability queries ≤ 2s for typical loads |
| NFR-009 | Availability | Booking service stays highly available |
| NFR-010 | Consistency | UI availability reflects current booking state as closely as possible |

---

## 6. Recommended data model (PRD §8)

Entities: `Clinic`, `Branch`, `Doctor`, `DoctorBranch`, `Receptionist`, `Patient`, `AppointmentType`, `DoctorSchedule`, `DoctorBlock`, `Appointment`, `AppointmentAudit`, `OTPVerification`.

Key invariants on `Appointment`:

- `(start_datetime, end_datetime, doctor_id)` is unique for `status = Scheduled` (no doctor overlap).
- A patient has at most one `Scheduled` appointment per `doctor_id` (FR-027).
- A patient has no time-overlapping `Scheduled` appointments (FR-029).
- `created_by` may be a staff user id **or** a patient phone number for guest bookings.

**Architectural note (UX-FLOWS §6.4):** branch operating hours and slots are in the branch's local timezone. Add `tz` to `Branch`.

---

## 7. Booking transaction (PRD §10)

```
Validate patient → doctor → branch → type → date
   → doctor availability → branch hours → doctor conflicts
   → patient conflicts
   → atomic slot reservation → create Scheduled appointment
```

Any failure → no appointment created.

## 8. Rescheduling transaction (PRD §11)

```
Existing appointment
   → select new slot (same doctor)
   → validate branch / type / availability / patient conflicts
   → atomic: reserve new slot → update appointment → release old slot
```

If new-slot reservation fails → original appointment untouched (FR-043).

## 9. Recurring flow (PRD §12)

Per-occurrence validation, partial-success result panel with skipped reasons, batch insert on confirm, audit row per created occurrence.

## 10. Acceptance criteria (PRD §15 — 15 critical scenarios)

The scenarios in PRD §15 are binding. Every story derived in `epics-and-stories.md` traces to one of these or to a documented BR/FR. Highlights:

- Scenario 3 — two concurrent bookings of one slot → exactly one succeeds.
- Scenario 9 — rescheduling race → original remains intact.
- Scenario 10 — recurring with one conflict → 7 of 8 created, conflicting one skipped + reported.
- Scenario 11 — receptionist cross-branch access → blocked.

---

## 11. Traceability

| BMad PRD section | Source |
|---|---|
| §3 Functional scope | PRD §3 (FR-001…051) |
| §4 Conflict management | PRD §4 (BR-009, BR-011, BR-021, BR-031, BR-033, BR-060) |
| §5 NFRs | PRD §7 |
| §6 Data model | PRD §8 |
| §7–9 Transactions | PRD §10, §11, §12 |
| §10 Acceptance | PRD §15 |
| All rules (BR-NNN) | BRD §4 |
| User-flow mapping | UX-FLOWS.md §1.1, §8 |
| Visual / UX rules | docs/design/DESIGN-SYSTEM.md |

---

**Next step:** `bmad-architecture` to derive the architectural spine from this PRD + the UX spec.
