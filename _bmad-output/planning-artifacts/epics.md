---
stepsCompleted: [1, 2]
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/ux.md
---

# Multi-Branch Clinic Appointment Scheduling System - Epic Breakdown

> **BMad planning artifact.** Decomposes the PRD, Architecture, and UX Design into implementable epics and stories. The architecture spine's ADs/ADRs are the binding guardrails on every story — no story may weaken an invariant.
>
> Source-of-truth for BRs (BR-001…BR-065), UX-FLOWS (F-01…F-19), and design tokens lives in `docs/specs/BRD.md`, `docs/specs/UX-FLOWS.md`, and `docs/design/DESIGN-SYSTEM.md` respectively; everything in those is distilled into `prd.md` / `ux.md` / `architecture.md` and cited inline.

## Overview

This document provides the complete epic and story breakdown for the Multi-Branch Clinic Appointment Scheduling System (working name: **MediSlot**), decomposing the requirements from the PRD, UX Design, and Architecture spine into implementable stories. The architecture's 13 ADs + 5 ADRs are the binding guardrails on every story.

## Requirements Inventory

### Functional Requirements

FR-001: Admin creates branches with name, address, weekly operating hours (multi-period per day), and active/inactive status (PRD §3.1).
FR-002: Admin edits branches (name, address, operating hours, active status) (PRD §3.1).
FR-003: Multi-branch clinic; branches have independent operating hours and timezone (PRD §3.1).
FR-004: Admin creates/deactivates doctors; assigns each to ≥1 branches. One clinic per doctor (PRD §3.1).
FR-005: Admin creates/deactivates receptionists; each assigned to exactly one branch (PRD §3.1).
FR-006: Doctor defines appointment types (name, duration, active/inactive) (PRD §3.2).
FR-007: Active appointment types are bookable at every branch the doctor works at (PRD §3.2).
FR-008: Doctor defines a branch-specific weekly schedule with multiple working periods per day (PRD §3.2).
FR-009: Doctor schedule supports an effective date; future-effective schedules are supported (PRD §3.2).
FR-010: Doctor schedule changes can target a specific branch only (branch-specific) (PRD §3.2).
FR-011: Schedule changes are rejected if they invalidate existing appointments (BR-009); doctor must resolve affected appts first (PRD §3.2).
FR-012: Doctor blocks (single date, time range) are supported (PRD §3.2).
FR-013: Blocks are rejected if they overlap existing appointments (BR-011) (PRD §3.2).
FR-014: Availability = (Branch Hours ∩ Doctor Schedule) − Doctor Blocks − Existing Appts (PRD §3.3).
FR-015: Slots are generated back-to-back from appointment duration; no buffer; partial remaining time is unused (PRD §3.3).
FR-016: Availability computation runs server-side and is never cached on the client (PRD §3.3).
FR-017: Availability reads from a server-side cache invalidated write-ahead in the same transaction as appointment writes (PRD §3.3, AD-5).
FR-018: Fixed 30-day booking window; configurable window is post-MVP (PRD §3.3).
FR-019: No same-day booking; applies to patients, doctors, receptionists, and recurring-occurrence generation (PRD §3.3, BR-021).
FR-020: Patient booking flow: Doctor → Branch → Type → Date → Slot → Name + Phone → Confirmation (PRD §3.4).
FR-021: Patient booking requires no account (PRD §3.4).
FR-022: Phone number uniquely identifies a patient (PRD §3.4).
FR-023: Known phone returns the stored name, which is editable (PRD §3.4).
FR-024: Valid bookings are immediately confirmed, with atomic slot reservation (PRD §3.4).
FR-025: If a slot is lost to concurrent booking, the operation fails and the user picks another (no auto-substitution) (PRD §3.4).
FR-026: Server returns 409/410 with ConflictModal-shaped body on slot loss, never a generic 500 (PRD §3.4, AD-4).
FR-027: One future appointment per patient per doctor (across all branches) (PRD §3.5, BR-031).
FR-028: A patient may have future appointments with multiple doctors (PRD §3.5).
FR-029: No patient-time overlap across doctors/branches (PRD §3.5, BR-033).
FR-030: Back-to-back appointments at different branches are allowed (no travel-time calculation) (PRD §3.5).
FR-031: SMS OTP authentication for patient self-service (PRD §3.6, BR-029).
FR-032: Verified patient sees upcoming Scheduled appointments only (cancelled/completed/no-show excluded) (PRD §3.6).
FR-033: Patient cancellation requires no reason; transitions to Cancelled (PRD §3.6).
FR-034: Receptionist/doctor cancellation requires a reason; transitions to Cancelled; slot released (PRD §3.7).
FR-035: Cancellation writes an audit row with reason metadata (PRD §3.7).
FR-036: Exactly four statuses: Scheduled, Completed, Cancelled, No-show (PRD §3.7).
FR-037: Doctors and receptionists may move Scheduled → Completed or No-show (PRD §3.7).
FR-038: No normal deletion function; Cancelled appointments remain (PRD §3.7).
FR-039: Patient rescheduling — same doctor, may change branch, type, date, time (PRD §3.6).
FR-040: New slot is reserved before the old slot is released (PRD §3.6).
FR-041: On reschedule race, the original appointment remains untouched (PRD §3.6, Scenario 9).
FR-042: Rescheduling validates branch/type/availability/patient conflicts before committing (PRD §3.6).
FR-043: Rescheduling preserves doctor identity (PRD §3.6).
FR-044: Doctors and receptionists can create recurring series; patients cannot (PRD §3.8).
FR-045: Recurring series defines a pattern and count/end-date (PRD §3.8).
FR-046: Each occurrence is validated independently (PRD §3.8).
FR-047: Partial success (some created, some skipped) is returned with skipped reasons (PRD §3.8).
FR-048: RecurrenceResultPanel surfaces created count + skipped with reasons (PRD §3.8).
FR-049: Individual occurrences are independently cancellable (PRD §3.8).
FR-050: Individual occurrences are independently reschedulable (PRD §3.8).
FR-051: Audit records for creation, cancellation, rescheduling, status changes — actor + timestamp + metadata (PRD §3.9).

### NonFunctional Requirements

NFR-001: Reliability — No double bookings under concurrent load (50 RPS sustained target) (PRD §5).
NFR-002: Data integrity — An appointment never references an invalid doctor/branch/type/time (PRD §5).
NFR-003: Authorization — Every operation authorized by role + branch/doctor ownership (PRD §5, AD-8).
NFR-004: Transaction safety — Booking and rescheduling are atomic (reserve-before-release) (PRD §5, ADR-2).
NFR-005: Auditability — Important changes audit-recorded (actor + timestamp + metadata) (PRD §5).
NFR-006: Security — Patient access requires SMS OTP (5-min TTL, 3-of-10 lockout) (PRD §5, §3.8).
NFR-007: Privacy — Patients see only their own appointments; filtered server-side via phone (PRD §5, AD-8).
NFR-008: Performance — Availability queries ≤ 2s for typical loads (PRD §5).
NFR-009: Availability — Booking service stays highly available (PRD §5).
NFR-010: Consistency — UI availability reflects current booking state as closely as possible (PRD §5, write-ahead cache invalidation per AD-5).

### Additional Requirements

These are derived from the architecture spine (§11 ADs + §12 ADRs). Each AD/ADR is a binding constraint — stories must cite the AD/ADR IDs they satisfy.

**From the stack (architecture §9, ADR-1…ADR-5):**
- AR-Stack-1: Next.js 15 App Router + React 19 + Tailwind v4 + Radix UI is the chosen frontend stack (architecture §9).
- AR-Stack-2: Next.js Route Handlers + Server Actions on Node runtime is the chosen backend stack — same repo, same auth boundary (architecture §9, ADR-3).
- AR-Stack-3: PostgreSQL 16 + Prisma 5 is the locked DB stack (architecture §9).
- AR-Stack-4: The Postgres EXCLUDE USING gist exclusion constraint on Appointment is delivered via one raw-SQL Prisma migration (ADR-1).
- AR-Stack-5: Booking, reschedule, and recurring-confirm use `prisma.$transaction` with `isolationLevel: Serializable`, with P2034 retry up to 3× with jittered backoff (ADR-2).
- AR-Stack-6: Server Actions for staff mutations; Route Handlers for `/patient/otp/*`, `/patient/appointments`, `/bookings`, `/availability`, `/recurring/*`, `/audits/:appointment_id` (ADR-3).
- AR-Stack-7: Radix UI primitives + Tailwind consuming design-system tokens by name (no literal hex outside `tokens.css`) (ADR-4 + F19).
- AR-Stack-8: Simulated OTP for v1 via `isOtpSimulator()` adapter; `OTP_TEST_CODE` default `000000`; SMS provider wiring deferred (ADR-5).
- AR-Stack-9: Edge runtime reserved for middleware (session decode, tz normalization to UTC per AD-9) only.

**From the invariants (architecture §11 ADs):**
- AR-AD-1: Schedule-lattice single-writer rule — one writer per `(branch_id, doctor_id, local_date)` cell; `FlagResolver` owns admin-origin flags (AD-1).
- AR-AD-2: Recurring-confirm is atomic per-row with `race_lost` skipped-reason; `will_create` rows must exist in storage (AD-2).
- AR-AD-3: OverrideOccurrence for series-materialized reschedules — pattern itself never retroactively rewritten (AD-3).
- AR-AD-4: Every error response uses `ErrorEnvelope = {code, what, why, can_do, details}` with closed-enum codes; 410 only for terminal availability codes (AD-4).
- AR-AD-5: `releaseSlot` is the same transaction that sets status to a non-Scheduled terminal state; cache invalidation is write-ahead (AD-5).
- AR-AD-6: Block creation validates against appointments AND existing blocks under the same SERIALIZABLE lock as §3.3 (AD-6).
- AR-AD-7: Schedule-change audit includes `affected_appointment_ids`; per-appointment resolutions carry `cause: "schedule_change:<id>"`; cause-replay walk reconciles abandoned changes (AD-7, AD-13).
- AR-AD-8: `/staff/appointments` filter is exactly the union of doctor-scope and receptionist-scope; admin scope on appointments is empty (AD-8).
- AR-AD-9: Response `tz` is always `appointment.branch.tz`; session branch tz never relabels another branch's event (AD-9).
- AR-AD-10: RoleFieldPolicy declares field-level access per role; `patient.phone` visibility is `{receptionist: same_branch, doctor: own_appointment, admin: never}` (AD-10).
- AR-AD-11: `skipped[].reason` is a closed enum mapped 1:1 to AD-4 codes (`race_lost`, `branch_closed`, `doctor_unavailable`, `patient_conflict`, `type_unavailable`, ...) (AD-11).
- AR-AD-12: Recurring series cancel tombstones `OverrideOccurrence` rows in the same transaction (AD-12).

**From data-model invariants (architecture §4):**
- AR-Data-1: `Branch.tz` is required; `Branch.active` is required; inactive branches excluded from `/availability` and `/bookings` at the data layer (PRD §8, UX-FLOWS §6.4).
- AR-Data-2: `Appointment.status ∈ {Scheduled, Completed, Cancelled, No-show}` — no other states.
- AR-Data-3: `Appointment` rows are never deleted — `Cancelled` is the terminal state.
- AR-Data-4: `AppointmentAudit` is append-only with ≥ 7-year retention (F18).
- AR-Data-5: `DoctorPatientLink` is populated on first booking; required for AD-8 doctor self-scope.
- AR-Data-6: `OverrideOccurrence` carries per-occurrence reschedule for series-materialized rows (`series_id` + `series_occurrence_index` preserved).

**From operational envelope (architecture §9.1) — deferred to sprint planning but each touches an invariant:**
- AR-Ops-1: dev / staging / prod parity required; CI/CD expectations per spine §9.1.
- AR-Ops-2: Double-booking counter remains 0 by definition; alerting thresholds per spine §9.1.
- AR-Ops-3: Audit retention ≥ 7 years with cold storage, encryption-at-rest, PII scrubbing for compliance exports.

**From the API surface (architecture §5):**
- AR-API-1: API endpoints expose only the canonical logical verbs listed in architecture §5; new endpoints must cite the AD/ADR that authorizes them.
- AR-API-2: Patient and `/bookings` endpoints live at `app/api/`; staff mutations live as Server Actions (ADR-3).

### UX Design Requirements

These are derived from `docs/design/DESIGN-SYSTEM.md` and `ux.md`. Each is a concrete implementation work item — not a vague summary.

**Components (13 per UX §6 / DESIGN-SYSTEM §7):**
- UX-DR-1: Implement Button with 4 variants (primary / secondary / ghost / danger) and the one-primary-per-region rule (UX §6, §7.1).
- UX-DR-2: Implement Status pill — round 999px, icon prefix, uppercase 10–11px, never brand teal (UX §6, §7.2).
- UX-DR-3: Implement Card with `.card.selected` halo on `#f0fdfa`, not border swap (UX §6, §7.3).
- UX-DR-4: Implement Section — numbered head + body + actions (UX §6, §7.4).
- UX-DR-5: Implement Field — 1.5px border, 10/12 padding, `:focus` brand ring, required = red asterisk (UX §6, §7.5).
- UX-DR-6: Implement Modal with the 3-part conflict shape (what / why / what you can do); no OK-only conflicts; primary action verb (UX §6, §7.6, §8).
- UX-DR-7: Implement Toast — top-right, auto-dismiss 3s, 4 tones (success / info / warn / error) (UX §6, §7.7).
- UX-DR-8: Implement Empty state — centered, icon + title + desc + optional CTA (UX §6, §7.8).
- UX-DR-9: Implement Audit drawer — right-side 480px, no patient PII across roles (UX §6, §7.9, AD-10).
- UX-DR-10: Implement Appointment card — date-block + body + status pill shared unit (UX §6, §7.10).
- UX-DR-11: Implement Meta cell — 2-col key→value grid (UX §6, §7.11).
- UX-DR-12: Implement Segmented control — pill track, inner button radius-xs, brand ring on active (UX §6, §7.12).
- UX-DR-13: Implement Step number — 26×26; future=light, current=filled+halo, completed=filled, danger=current-red (UX §6, §7.13).

**Tokens & styling:**
- UX-DR-14: Implement `tokens.css` generated from `DESIGN-SYSTEM.md`; every component consumes tokens by name (`bg-[var(--brand-primary)]`), never literal hex (UX §5, F19).
- UX-DR-15: CI lint rule fails build when literal hex appears outside `tokens.css` (F19).
- UX-DR-16: System font stack only — no web fonts; zero layout shift (UX §5).
- UX-DR-17: Tabular figures (`font-variant-numeric: tabular-nums`) on every time/duration/count (UX §4).
- UX-DR-18: Phone format `+966 5XX XXX 5555` (redacted X segments); 24-hour clock with zero-padded `09:00` (UX §4).

**Layout patterns (UX §7):**
- UX-DR-19: Implement Stacked vertical pattern (760px center) — used by most flows (UX §7).
- UX-DR-20: Implement Sidebar split pattern (`1fr 320px`) — patient self-service, doctor day (UX §7).
- UX-DR-21: Implement Card grid pattern (full, 3-col ≥1024) — admin lists (UX §7).
- UX-DR-22: Implement Kanban pattern (full, 3-col) — Resolve affected (F-09) (UX §7).
- UX-DR-23: Implement Agenda timeline pattern — Doctor calendar (UX §7).
- UX-DR-24: Enforce one-pattern-per-screen rule (UX §7).

**Conflict UX (UX §8):**
- UX-DR-25: Implement ConflictModal with the 3-part shape (what / why / what you can do); max 2 buttons with action verbs; no OK-only conflicts (UX §8, AD-4).
- UX-DR-26: Slot lost to concurrent booking → ConflictModal "That slot was just booked." (UX §12).
- UX-DR-27: Existing patient phone with future appt for same doctor → ConflictModal "You already have an appointment with Dr. X." (UX §12, FR-027).
- UX-DR-28: Patient overlap with another doctor → ConflictModal "You have another appointment at this time." (UX §12, FR-029).
- UX-DR-29: Same-day booking → calendar grays today with tooltip "Same-day booking unavailable" (UX §12, FR-019).
- UX-DR-30: Schedule change affects appts → save blocked, AffectedAppointmentsTable opens, routes into Resolve (UX §12, FR-011).
- UX-DR-31: Branch-hours change affects appts → saved, appts flagged for assigned doctor, doctor's dashboard shows "Resolve (N)" badge (UX §12, AD-1).
- UX-DR-32: Recurring mixed conflicts → RecurrenceResultPanel with created count + skipped with reasons (UX §12, FR-048).
- UX-DR-33: OTP doesn't arrive → Resend after 30s cooldown; 3-attempt cap with 10-min lockout (UX §12, §3.8).
- UX-DR-34: Deactivate branch with future appts → ConflictModal "Branch has N future appointments. Deactivation not allowed." (UX §12, BR-059).

**Atomicity discipline (UX §9):**
- UX-DR-35: UI never assumes a slot is bookable based on stale data — show "slot was just taken" gracefully (UX §9, FR-025).
- UX-DR-36: UI never holds tentative slots client-side; server is single source of truth (UX §9, §1.1 of spine).

**Accessibility (UX §10):**
- UX-DR-37: WCAG 2.1 AA — contrast body-on-page 14.5:1 (AAA); faint `#9ca3af` for disabled/placeholder only (UX §10).
- UX-DR-38: Visible focus ring on every interactive element via `:focus-visible` + `--ring-focus` (UX §10).
- UX-DR-39: Modal traps focus, Esc closes, Enter triggers primary in ConflictModal (UX §10).
- UX-DR-40: Touch targets ≥ 40×40 on mobile (mockups are desktop-only; production scales) (UX §10).
- UX-DR-41: Honor `prefers-reduced-motion` — toast slide and modal scale-in disabled (UX §10).

**Screens (19 winners, UX §11):**
- UX-DR-42: Implement Doctor picker (02) — Sidebar split, patient (UX §11).
- UX-DR-43: Implement Availability calendar (03) — Agenda timeline, patient (UX §11).
- UX-DR-44: Implement Patient confirm (04) — Stacked vertical, patient (UX §11).
- UX-DR-45: Implement Patient self-service (05) — Sidebar split, patient (UX §11).
- UX-DR-46: Implement Resolve affected (06) — Kanban, doctor (UX §11).
- UX-DR-47: Implement Recurring preview (07) — Stacked vertical, doctor/receptionist (UX §11).
- UX-DR-48: Implement Branch hours impact (08) — Stacked vertical, admin (UX §11).
- UX-DR-49: Implement Doctor schedule (09) — List + tabs, doctor (UX §11).
- UX-DR-50: Implement Doctor block time (10) — Stacked vertical, doctor (UX §11).
- UX-DR-51: Implement Appointment types (11) — Stacked vertical, doctor (UX §11).
- UX-DR-52: Implement Mark status (12) — Quick-action sidebar, doctor/receptionist (UX §11).
- UX-DR-53: Implement Receptionist today (13) — Card list by hour, receptionist (UX §11).
- UX-DR-54: Implement Receptionist create (14) — Stepped form, receptionist (UX §11).
- UX-DR-55: Implement Receptionist cancel (15) — Stacked vertical, receptionist (UX §11).
- UX-DR-56: Implement Receptionist availability (16) — Stacked vertical, receptionist (UX §11).
- UX-DR-57: Implement Admin branches (17) — Stacked vertical, admin (UX §11).
- UX-DR-58: Implement Admin doctors (18) — Card grid, admin (UX §11).
- UX-DR-59: Implement Admin receptionists (19) — Card grid, admin (UX §11).

### FR Coverage Map

Each FR maps to exactly one epic. The coverage is exhaustive (no FR unassigned) and non-overlapping where the boundary is unambiguous (cross-cutting FRs cite the primary epic and may surface in horizontal ones).

FR-001 → Epic 1 — Create branch (admin flow)
FR-002 → Epic 1 — Edit branch (admin flow)
FR-003 → Epic 1 — Multi-branch clinic + branch hours (admin flow)
FR-004 → Epic 1 — Create/deactivate doctors (admin flow)
FR-005 → Epic 1 — Create/deactivate receptionists (admin flow)
FR-006 → Epic 2 — Define appointment types (doctor flow)
FR-007 → Epic 2 — Active types bookable at every branch (doctor flow)
FR-008 → Epic 2 — Branch-specific weekly schedule (doctor flow)
FR-009 → Epic 2 — Effective date for schedule (doctor flow)
FR-010 → Epic 2 — Branch-specific schedule per branch (doctor flow)
FR-011 → Epic 6 — Reject schedule changes that invalidate appts (resolved via Epic 6 resolve flow)
FR-012 → Epic 2 — Doctor blocks single-date/range (doctor flow)
FR-013 → Epic 2 — Block rejected on appointment overlap (doctor flow)
FR-014 → Epic 3 — Availability formula (booking core)
FR-015 → Epic 3 — Back-to-back slot generation (booking core)
FR-016 → Epic 3 — Server-side availability, no client cache (booking core)
FR-017 → Epic 3 — Server-side write-ahead cache invalidation (booking core)
FR-018 → Epic 3 — Fixed 30-day window (booking core)
FR-019 → Epic 3 — No same-day booking across all roles (booking core)
FR-020 → Epic 3 — Patient booking flow (booking core)
FR-021 → Epic 3 — No account required (booking core)
FR-022 → Epic 3 — Phone number uniquely identifies patient (booking core)
FR-023 → Epic 3 — Known phone returns stored name (booking core)
FR-024 → Epic 3 — Atomic slot reservation on booking (booking core)
FR-025 → Epic 3 — Race lost → user picks another slot (booking core)
FR-026 → Epic 3 — 409/410 ErrorEnvelope on slot loss (booking core)
FR-027 → Epic 3 — One future appt per patient per doctor (booking core)
FR-028 → Epic 3 — Patient may have appts with multiple doctors (booking core)
FR-029 → Epic 3 — No patient-time overlap (booking core)
FR-030 → Epic 3 — Back-to-back at different branches allowed (booking core)
FR-031 → Epic 4 — SMS OTP authentication (patient self-service)
FR-032 → Epic 4 — Verified patient sees Scheduled-only (patient self-service)
FR-033 → Epic 4 — Patient cancellation (patient self-service)
FR-034 → Epic 5 — Staff cancellation with reason (staff appointment mgmt)
FR-035 → Epic 5 — Staff cancellation writes audit row (staff appointment mgmt)
FR-036 → Epic 5 — Four statuses only (staff appointment mgmt)
FR-037 → Epic 5 — Mark Completed / No-show (staff appointment mgmt)
FR-038 → Epic 5 — No deletion; Cancelled terminal (staff appointment mgmt)
FR-039 → Epic 4 — Patient reschedule (patient self-service)
FR-040 → Epic 4 — Reserve-new-before-release-old (patient self-service)
FR-041 → Epic 4 — Original untouched on race (patient self-service)
FR-042 → Epic 4 — Reschedule validates conflicts (patient self-service)
FR-043 → Epic 4 — Reschedule preserves doctor (patient self-service)
FR-044 → Epic 6 — Recurring series creation (recurring + conflict)
FR-045 → Epic 6 — Recurring pattern + count/end-date (recurring + conflict)
FR-046 → Epic 6 — Per-occurrence independent validation (recurring + conflict)
FR-047 → Epic 6 — Partial-success response (recurring + conflict)
FR-048 → Epic 6 — RecurrenceResultPanel skipped reasons (recurring + conflict)
FR-049 → Epic 6 — Per-occurrence cancellation (recurring + conflict)
FR-050 → Epic 6 — Per-occurrence reschedule via OverrideOccurrence (recurring + conflict)
FR-051 → Epic 7 — Audit records (cross-cutting)

**Cross-cutting coverage note:** NFRs (NFR-001…NFR-010) and the spine's ADs/ADRs are addressed across all epics as invariants rather than as story deliverables — every story cites the AD/ADR it satisfies. The 13 ADs + 5 ADRs from `architecture.md` §11-§12 are the binding guardrails, surfaced in the "Architecture binding" line of each epic below.

## Epic List

Seven epics, organized strictly by user value. Each epic delivers a complete user-facing capability. E7 is horizontal and runs in parallel with the others; E3 is the spine that other role-facing epics (E4 patient, E5 staff, E6 recurring) build upon.

**MVP sequencing recommendation (per `epics-and-stories.md` §Suggested sequencing):** E3 (booking spine) first, then E4 (patient self-service), then E2 (doctor schedule), then E5 (staff mgmt), then E6 (recurring), then E1 (admin), with E7 as a horizontal enabler.

### Epic 1: Clinic structure & admin operations

**Goal.** An administrator can model the clinic (branches, doctors, receptionists) and change branch operating hours, with the system flagging downstream impact for doctors to resolve — never silently invalidating an appointment.
**User value:** The clinic structure exists and can be operated on by its admin.
**Flows:** F-16, F-17, F-18, F-19
**FRs covered:** FR-001, FR-002, FR-003, FR-004, FR-005
**NFRs addressed:** NFR-003 (admin scope explicitly empty for individual appts), NFR-005 (audit)
**Architecture binding:** AD-1 (FlagResolver for branch-hours flags), AD-8 (admin appointments scope = empty), AD-10 (admin never sees `patient.phone`), §3.7 branch-hours impact flow
**Stories (4):**
- 1.1 Create / edit / deactivate branches (multi-period weekly hours, active flag)
- 1.2 Change branch operating hours (save + flag affected appointments, dispatch to FlagResolver per AD-1)
- 1.3 Create / deactivate / assign-branch doctors (multi-branch doctor; one clinic per doctor)
- 1.4 Create / deactivate / assign-branch receptionists (single-branch assignment)

### Epic 2: Doctor schedule, blocks & appointment types

**Goal.** A doctor can configure their appointment types, weekly schedule (per branch, multi-period per day), and time blocks — with the system **rejecting** changes that would invalidate existing appointments.
**User value:** Doctors own their schedule; existing patient appointments are protected from silent invalidation.
**Flows:** F-06, F-07, F-08
**FRs covered:** FR-006, FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013
**NFRs addressed:** NFR-003, NFR-005 (schedule/block audit)
**Architecture binding:** AD-1 (DoctorScheduleMutation — reject-if-conflicts single-writer rule), AD-6 (block validates against appts + existing blocks), AD-7 (schedule-change audit with `affected_appointment_ids` + `cause` link), AD-13 (cause-replay walk), §3.6 conflict resolution
**Stories (3):**
- 2.1 Configure weekly schedule with multi-period days and effective date
- 2.2 Block time (single date / range / multi-day) — rejected on overlap
- 2.3 Manage appointment types (create, edit, deactivate)

### Epic 3: Booking core

**Goal.** A patient (or receptionist on a patient's behalf) can book a valid appointment at a valid slot — atomically, with server as single source of truth — and never double-book or violate patient/doctor constraints.
**User value:** Booking works. Slots cannot be lost to races. Patient conflicts are prevented before commit.
**Flows:** F-01, F-02, F-13, F-15
**FRs covered:** FR-014, FR-015, FR-016, FR-017, FR-018, FR-019, FR-020, FR-021, FR-022, FR-023, FR-024, FR-025, FR-026, FR-027, FR-028, FR-029, FR-030
**NFRs addressed:** NFR-001 (no double bookings), NFR-002 (referential integrity), NFR-004 (transaction safety), NFR-008 (availability ≤2s), NFR-010 (UI reflects current state)
**Architecture binding:** ADR-1 (EXCLUDE USING gist raw-SQL migration), ADR-2 (Serializable + P2034 retry), AD-4 (ErrorEnvelope on 409/410), AD-5 (write-ahead cache invalidation), §3.2 availability engine, §3.3 slot reservation
**Stories (4):**
- 3.1 Availability engine (pure server-side function; `branch_hours ∩ doctor_hours − blocks − existing`; 30-day window; same-day exclusion; patient conflict filter)
- 3.2 Guest patient booking (doctor → branch → type → date → slot → name + phone → atomic confirm)
- 3.3 Receptionist booking on behalf of patient (branch picker locked to assigned branch)
- 3.4 Receptionist reads doctor availability (read-only `AvailabilityCalendar`, no patient PII)

### Epic 4: Patient self-service (OTP, cancel, reschedule)

**Goal.** A verified patient can view their upcoming appointments, cancel them, or reschedule them — without an account.
**User value:** Patients own their bookings.
**Flows:** F-03, F-04, F-05
**FRs covered:** FR-031, FR-032, FR-033, FR-039, FR-040, FR-041, FR-042, FR-043
**NFRs addressed:** NFR-006 (SMS OTP), NFR-007 (server-side phone filter)
**Architecture binding:** AD-5 (releaseSlot = status mutation in same tx), AD-8 (patient filtering is server-side only via verified session phone), AD-9 (response `tz = appointment.branch.tz`), ADR-5 (simulated OTP for v1), §3.6 rescheduling transaction, §3.8 OTP
**Stories (3):**
- 4.1 Patient OTP verification (5-min TTL, 3-of-10 lockout; simulated for v1 via `isOtpSimulator()` per ADR-5)
- 4.2 Patient cancellation (no reason; status → Cancelled; slot released; audit row)
- 4.3 Patient rescheduling (reserve-new-then-release-old; type/branch/date/time mutable; doctor locked; original untouched on race)

### Epic 5: Staff appointment management

**Goal.** Doctors and receptionists can manage their day — mark outcomes, cancel with reason, view their scope.
**User value:** Staff own their daily operations.
**Flows:** F-10, F-12, F-14
**FRs covered:** FR-034, FR-035, FR-036, FR-037, FR-038
**NFRs addressed:** NFR-003 (role+branch authz), NFR-007 (no cross-branch patient PII)
**Architecture binding:** AD-8 (doctor = `DoctorPatientLink`, receptionist = `branch_id`), AD-10 (RoleFieldPolicy for `patient.phone`), §3.7 cancellation with reason
**Stories (4):**
- 5.1 Mark Completed / No-show (doctor and receptionist; no reason; no slot release for past slots)
- 5.2 Doctor cancellation with reason (status → Cancelled; slot released; audit row with reason)
- 5.3 Receptionist cancellation with reason (single branch scope; audit row)
- 5.4 Today's branch view — receptionist dashboard (server-side branch filter; cross-branch URLs return 403)

### Epic 6: Recurring & conflict resolution

**Goal.** Doctors and receptionists can create recurring series with partial-success preview/confirm, and resolve the affected appointments that schedule/block/branch-hours changes produce.
**User value:** Repeating appointments work, and every "we have to change something" path ends in a saved appointment — never a silent drop.
**Flows:** F-09, F-11
**FRs covered:** FR-011 (resolve), FR-044, FR-045, FR-046, FR-047, FR-048, FR-049, FR-050
**NFRs addressed:** NFR-001 (no double bookings under race), NFR-005 (audit)
**Architecture binding:** AD-1 (FlagResolver consumes admin-origin flags), AD-2 (recurring-confirm atomic per-row with `race_lost`), AD-3 (OverrideOccurrence for series-occurrence reschedule), AD-5 (single-tx series cancel), AD-7 (cause-replay walk), AD-11 (`skipped[].reason` closed enum), AD-12 (OverrideOccurrence tombstone on series cancel), ADR-2 (Serializable + retry)
**Stories (3):**
- 6.1 Recurring appointment preview + partial-success create (per-occurrence validation; skipped reasons; one audit row per created)
- 6.2 Resolve affected appointments (doctor) — slot finder restricted; type locked; branch may change; on zero remaining, originating change may save
- 6.3 Branch-hours impact flag (admin counterpart) — affected appts surface with "Resolve" badge + `cause = "branch_hours_change"`

### Epic 7: Cross-cutting (design system, audit, privacy, accessibility, OTP infrastructure, branch timezone)

**Goal.** The horizontal invariants — token discipline, audit durability, privacy filtering, ConflictModal canonical shape, accessibility baseline, branch timezone support, OTP infrastructure — exist as platform-level stories so vertical epics can cite them.
**User value:** Every screen is consistent, accessible, auditable, and timezone-correct.
**Flows:** All (horizontal)
**FRs covered:** FR-051 (audit); FR-031 / FR-032 cross-cut privacy; UX-DR-1…UX-DR-13 components; UX-DR-14/15/16/17/18 tokens; UX-DR-19…24 layouts; UX-DR-25 conflict modal; UX-DR-37…41 accessibility
**NFRs addressed:** NFR-005 (audit durability), NFR-007 (privacy filter), NFR-009 (service availability), UX §10 accessibility (WCAG 2.1 AA), UX §14 cross-cutting invariants
**Architecture binding:** ADR-4 (Radix + Tailwind tokens), AD-4 (ErrorEnvelope closed enum), AD-9 (response tz), AD-10 (RoleFieldPolicy), ADR-5 (OTP simulator adapter), §7 frontend architecture
**Stories (6):**
- 7.1 Design system token wiring — `tokens.css` generated from DESIGN-SYSTEM.md; CI lint rule on literal hex (F19)
- 7.2 Appointment audit (append-only, ≥7-year retention; internal-only surface; cross-role access per AD-10)
- 7.3 Patient privacy filter (server-side phone filter; pen-test assertion no leak via deep links or query params)
- 7.4 ConflictModal global component (single shared shape; UX-DR-25 + AD-4)
- 7.5 Accessibility baseline — WCAG 2.1 AA (focus rings, modal focus trap, status pill icon prefix, `prefers-reduced-motion`, touch targets ≥ 40×40)
- 7.6 Branch timezone support (`Branch.tz` required; UTC storage; convert at `appointment.branch.tz` per AD-9)

## Epic 1: Clinic structure & admin operations

**Goal.** An administrator can model the clinic and change branch operating hours with the system flagging downstream impact for doctors — never silently invalidating an appointment.

<!-- Repeat for each story within Epic 1 -->

### Story 1.1: Create / edit / deactivate branches

As an **administrator**,
I want **to create, edit, and deactivate branches with name, address, weekly operating hours (multi-period per day), and an active flag**,
So that **the clinic can model its multi-branch footprint and patients see only valid locations**.

**Acceptance Criteria:**

**Given** an admin is signed in
**When** they create or edit a branch with name, address, multi-period weekly hours, and active status
**Then** the branch persists, audit row written, and it appears in active lists.
**And** deactivating a branch with future appointments is rejected with ConflictModal citing BR-059 (UX-DR-34).
**And** the branch's timezone is required (UX-DR-7.6 / AR-Data-1 / AD-9).
**Architecture binding:** AD-10 (admin never sees patient PII via this surface); AR-Data-1 (`Branch.active` required); UX-DR-57.

### Story 1.2: Change branch operating hours

As an **administrator**,
I want **to change branch operating hours**,
So that **the clinic's real hours are reflected, with affected appointments flagged for the assigned doctor to resolve**.

**Acceptance Criteria:**

**Given** an admin narrows or widens branch hours
**When** some Scheduled appointments fall outside the new hours
**Then** the new hours save (no rejection), affected appointments are **flagged for resolution** (status remains Scheduled), and an audit row records `flagged_for_resolution` with `{reason: "branch_hours_change"}`.
**And** each affected appointment surfaces on the assigned doctor's dashboard with a "Resolve (N)" badge (UX-DR-31).
**And** flags are durable work items owned by `FlagResolver` per AD-1.
**Architecture binding:** AD-1 (single-writer rule: BranchHoursMutation saves+flags; FlagResolver dispatches); AD-9 (response `tz = appointment.branch.tz`); UX-DR-48; Story 6.3 consumes these flags.

### Story 1.3: Create / deactivate / assign-branch doctors

As an **administrator**,
I want **to create, deactivate, and assign doctors to ≥1 branches**,
So that **the clinic's doctor roster is correct and each doctor appears at their branches**.

**Acceptance Criteria:**

**Given** an admin creates or edits a doctor
**When** they assign ≥1 branches
**Then** the doctor is active at all assigned branches and one clinic per doctor is enforced (FR-004).
**And** deactivating a doctor with future appointments raises a non-blocking warning per F-18.
**And** audit row is written.
**Architecture binding:** AD-8 (doctor → `doctor_id` scope for /staff/appointments); UX-DR-58.

### Story 1.4: Create / deactivate / assign-branch receptionists

As an **administrator**,
I want **to create and assign receptionists to exactly one branch**,
So that **each branch has a dedicated front-desk operator and cross-branch access is structurally prevented**.

**Acceptance Criteria:**

**Given** an admin creates a receptionist
**When** they assign exactly one branch
**Then** the receptionist's session carries that single `branch_id` (per ADR-3 staff auth).
**And** cross-branch reads/writes are blocked server-side; URL-based cross-branch access returns 403 (Scenario 11 / UX-DR-34).
**And** audit row is written.
**Architecture binding:** AD-8 (receptionist → `branch_id = session.branch_id`, no phone filter, no doctor filter); ADR-3; UX-DR-59.

---

## Epic 2: Doctor schedule, blocks & appointment types

**Goal.** A doctor owns their schedule, blocks, and appointment types — with the system rejecting any change that would invalidate an existing appointment.

### Story 2.1: Configure weekly schedule with multi-period days

As a **doctor**,
I want **to configure a branch-specific weekly schedule with multiple working periods per day and an effective date**,
So that **my availability matches how I actually work and patients see valid slots**.

**Acceptance Criteria:**

**Given** a doctor edits their branch-specific weekly schedule
**When** the change would invalidate any existing appointment
**Then** the save is **rejected** (FR-011 / BR-009) with `ScheduleConflict` ConflictModal and `AffectedAppointmentsTable` (UX-DR-30).
**And** the doctor must resolve each affected appointment via Story 6.2 before saving.
**And** schedule-change audit row carries `affected_appointment_ids` and per-resolution rows carry `cause: "schedule_change:<id>"` (AD-7).
**Architecture binding:** AD-1 (DoctorScheduleMutation = single-writer reject-if-conflicts), AD-7 (audit `cause` link), AD-13 (cause-replay walk on abandonment); UX-DR-49.

### Story 2.2: Block time (single date / range / multi-day)

As a **doctor**,
I want **to block time off (single date, range, or multi-day)**,
So that **patients cannot book me when I'm unavailable**.

**Acceptance Criteria:**

**Given** a doctor creates a block
**When** it overlaps any existing appointment OR any existing block for the same doctor
**Then** the block is **rejected** (FR-013 / BR-011) with ConflictModal and `AffectedAppointmentsTable`.
**And** block creation runs under the same `SERIALIZABLE` lock as booking (§3.3 / ADR-2), so a booking racing the block is serialized through the same lock target (AD-6).
**Architecture binding:** AD-6 (block validates against appts AND existing blocks under SERIALIZABLE); UX-DR-50.

### Story 2.3: Manage appointment types (create, edit, deactivate)

As a **doctor**,
I want **to define appointment types with name, duration, and active status**,
So that **patients can book me for the kinds of visits I offer at every branch where I work**.

**Acceptance Criteria:**

**Given** a doctor creates or edits an appointment type
**When** they save
**Then** the type is bookable at every branch the doctor works at (FR-007) and the audit row is written.
**And** deactivating a type with future appointments warns but does not cancel (per F-08).
**Architecture binding:** ADR-1 (no DB-level uniqueness constraint on type other than FK); UX-DR-51.

---

## Epic 3: Booking core

**Goal.** A patient (or receptionist on a patient's behalf) can book a valid slot atomically — never double-booked, never violated.

### Story 3.1: Availability engine

As the **system**,
I want **to compute bookable slots = `(Branch Hours ∩ Doctor Schedule) − Doctor Blocks − Existing Appts`, back-to-back from the type's duration**,
So that **the patient sees only slots that are actually bookable**.

**Acceptance Criteria:**

**Given** a request for `availability(doctor, branch, date, appointment_type)`
**When** the server computes the slot set
**Then** it honors branch hours, doctor schedule, blocks, and existing Scheduled appointments; applies the 30-day window (FR-018); excludes same-day (FR-019); excludes slots overlapping any patient Scheduled appt (FR-029); excludes slots where patient already has a future appt with same doctor (FR-027).
**And** computation is server-side, never cached on the client (FR-016); any server cache is invalidated write-ahead in the same transaction as the appointment write (AD-5).
**And** the route is `GET /availability` per architecture §5.
**Architecture binding:** ADR-1 (EXCLUDE constraint as backstop), ADR-2 (Serializable for writes), AD-5 (write-ahead invalidation); NFR-008 (≤2s).

### Story 3.2: Guest patient booking

As a **patient**,
I want **to book an appointment by selecting doctor → branch → type → date → slot → name + phone, with no account**,
So that **I have a confirmed appointment**.

**Acceptance Criteria:**

**Given** a patient completes the booking flow (F-01/F-02)
**When** all validations pass
**Then** the appointment is created atomically with `status = Scheduled`, audit row written (`actor = patient phone`), and a confirmation returns.
**And** on slot race, the operation fails with `ErrorEnvelope.code = SLOT_RACED` (AD-4) and the user picks another slot (FR-025) — no auto-substitution.
**And** same-day booking is rejected (FR-019, UX-DR-29).
**And** known phone returns the stored name, editable (FR-023).
**Architecture binding:** ADR-1 (EXCLUDE constraint enforces no-overlap at DB), ADR-2 (Serializable + P2034 retry), AD-4 (ErrorEnvelope on 409/410); UX-DR-42, UX-DR-43, UX-DR-44.

### Story 3.3: Receptionist booking on behalf of patient

As a **receptionist**,
I want **to book on behalf of a patient at my assigned branch**,
So that **walk-ins and phone bookings land in the same system**.

**Acceptance Criteria:**

**Given** a receptionist is signed in at branch X
**When** they book on behalf of a patient (new phone + name OR known phone prefilled)
**Then** the appointment is created atomically with `actor_role = "receptionist"` audit row; branch picker is locked to X (AD-8).
**And** all FR-019…FR-030 conflict rules apply identically.
**Architecture binding:** AD-8 (single branch scope); UX-DR-54.

### Story 3.4: Receptionist reads doctor availability

As a **receptionist**,
I want **a read-only view of doctor availability at my branch**,
So that **I can answer "when can Dr. X see them?" without leaving the front desk**.

**Acceptance Criteria:**

**Given** a receptionist picks a doctor (assigned to their branch only), an appointment type, and a date range within 30 days
**When** they view the result
**Then** a read-only `AvailabilityCalendar` is shown; no patient PII beyond first-name initial is visible (AD-10).
**Architecture binding:** AD-8 (single branch scope), AD-10 (no patient phone visibility); UX-DR-56.

---

## Epic 4: Patient self-service (OTP, cancel, reschedule)

**Goal.** A verified patient owns their bookings — view, cancel, reschedule — without an account.

### Story 4.1: Patient OTP verification

As a **patient**,
I want **to enter my phone number and a 6-digit code to access my upcoming appointments**,
So that **I can manage my bookings without creating an account**.

**Acceptance Criteria:**

**Given** a patient enters a registered phone and submits a valid 6-digit OTP
**When** verification succeeds
**Then** they receive a short-lived session and see only `Scheduled` upcoming appointments (FR-032 / NFR-007).
**And** OTP enforces 5-min TTL + 3-of-10 lockout (§3.8).
**And** for v1, OTP is simulated via `isOtpSimulator()` per ADR-5 (`OTP_TEST_CODE = 000000`); production wiring deferred without changing the §3.8 contract.
**Architecture binding:** ADR-5 (simulator adapter); §3.8 rate-limit exercised end-to-end; UX-DR-45.

### Story 4.2: Patient cancellation

As a **verified patient**,
I want **to cancel an upcoming appointment**,
So that **the slot frees up for someone else**.

**Acceptance Criteria:**

**Given** a verified patient cancels a Scheduled appointment
**When** they confirm
**Then** status → `Cancelled` (FR-038 — never deleted), slot released (BR-053), audit row written (`actor = patient phone`, no reason required).
**And** the cancelled row surfaces as a non-actionable record if the patient retries (per UX §14).
**Architecture binding:** AD-5 (`releaseSlot` = same-tx status mutation); UX-DR-33, UX-DR-22 (Patient self-service screen).

### Story 4.3: Patient rescheduling

As a **verified patient**,
I want **to reschedule an appointment to a new slot**,
So that **I can change my booking without losing it**.

**Acceptance Criteria:**

**Given** a verified patient selects a new slot (doctor locked; branch/type/date/time mutable)
**When** they confirm
**Then** the system performs the rescheduling transaction: reserve new → update → release old → audit (`metadata = {from, to, branch_change, type_change}`).
**And** if reserve-new fails, the original appointment is **untouched** (FR-043 / Scenario 9) and the user sees ConflictModal "That slot is no longer available. Your appointment is unchanged."
**And** response timestamps carry `tz = appointment.branch.tz` per AD-9 (never session-tz).
**Architecture binding:** AD-5 (release-then-update in same tx), AD-9 (response tz), ADR-2 (Serializable + retry); UX-DR-20.

---

## Epic 5: Staff appointment management

**Goal.** Doctors and receptionists manage their day — outcomes, cancellations, and their scoped view.

### Story 5.1: Mark Completed / No-show

As a **doctor or receptionist**,
I want **to mark an appointment Completed or No-show**,
So that **outcomes are recorded**.

**Acceptance Criteria:**

**Given** a doctor or receptionist updates a past Scheduled appointment
**When** they pick Completed or No-show
**Then** status updates atomically, audit row is written; no reason required; no slot release (slot is in the past).
**Architecture binding:** §3.6 status transition; UX-DR-52.

### Story 5.2: Doctor cancellation with reason

As a **doctor**,
I want **to cancel an upcoming appointment with a reason**,
So that **the slot is released with an audit trail**.

**Acceptance Criteria:**

**Given** a doctor cancels a Scheduled appointment
**When** they provide a reason and confirm
**Then** status → `Cancelled`, slot released, audit row `action = "cancelled"`, `metadata = {reason}`.
**And** concurrent change surfaces as ConflictModal "No longer Scheduled. Refresh."
**Architecture binding:** AD-5 (`releaseSlot` = same-tx mutation); AD-10 (reason metadata never leaks patient PII across roles).

### Story 5.3: Receptionist cancellation with reason

As a **receptionist**,
I want **to cancel an appointment at my branch with a reason**,
So that **the slot is released with an audit trail**.

**Acceptance Criteria:**

**Given** a receptionist cancels a Scheduled appointment at their assigned branch
**When** they provide a reason and confirm
**Then** status → `Cancelled`, slot released, audit row `action = "cancelled", metadata = {reason}, actor_role = "receptionist"`.
**And** cross-branch cancel attempts return 403 (AD-8).
**Architecture binding:** AD-5; AD-8; UX-DR-55.

### Story 5.4: Today's branch view — receptionist dashboard

As a **receptionist**,
I want **a dashboard showing today's appointments at my assigned branch**,
So that **I can run the day**.

**Acceptance Criteria:**

**Given** a receptionist signs in
**When** they open the dashboard
**Then** they see today's appointments for their assigned branch only (server-side filter per AD-8); cross-branch URLs return 403 (Scenario 11).
**And** `RoleFieldPolicy` per AD-10 is enforced — `patient.phone` is visible only when the appointment is staffed at this branch.
**Architecture binding:** AD-8, AD-10; UX-DR-53.

---

## Epic 6: Recurring & conflict resolution

**Goal.** Repeating appointments work, and every "we have to change something" path ends in a saved appointment — never a silent drop.

### Story 6.1: Recurring appointment preview + partial-success create

As a **doctor or receptionist**,
I want **to preview a recurring series and confirm creation with partial success**,
So that **patients get a known-good subset and skipped occurrences are reported, not silently dropped**.

**Acceptance Criteria:**

**Given** a doctor or receptionist defines a pattern + count/end-date (F-11)
**When** the server previews each occurrence (branch hours, doctor schedule, blocks, existing appts, patient overlap, same-doctor future restriction, 30-day window, same-day exclusion)
**Then** the response separates `will_create` from `skipped_with_reason` with `reason` as a closed enum tied to AD-4 codes (AD-11).
**And** on confirm, valid occurrences are created atomically per-row (AD-2 / ADR-2); rows that fail at confirm time land in `skipped:[{date, reason: "race_lost"}]` and are not counted as `will_create` for audit purposes.
**And** one audit row per created occurrence; the success response carries exactly the rows that succeeded.
**And** Scenario 10: 8 weekly occurrences with one conflict → 7 created + 1 skipped with reason shown to user.
**Architecture binding:** AD-2, AD-11, ADR-2 (Serializable + P2034 retry); UX-DR-32, UX-DR-47.

### Story 6.2: Resolve affected appointments (doctor)

As a **doctor**,
I want **to resolve affected appointments when my schedule/block/branch-hours change invalidated them**,
So that **no patient's appointment is silently dropped**.

**Acceptance Criteria:**

**Given** a doctor opens the Affected queue (from Story 2.1, Story 2.2, or Story 1.2)
**When** they move an appointment to a new slot
**Then** the slot finder is restricted to: doctor available · branch open · 30-day window · no doctor overlap · no patient overlap; **appointment type locked**; branch may change to another branch the doctor works at.
**And** the rescheduling transaction reuses Story 4.3 mechanics with `type` fixed.
**And** on zero remaining rows, the originating schedule/block/branch-hours change may save.
**And** for series-materialized rows, the reschedule creates an `OverrideOccurrence` (AD-3); pattern is never retroactively rewritten.
**Architecture binding:** AD-1 (FlagResolver consumes admin-origin flags for branch-hours changes), AD-3 (OverrideOccurrence), AD-7 (cause link), AD-13 (cause-replay walk); UX-DR-46 (Resolve Kanban).

### Story 6.3: Branch-hours impact flag (admin counterpart)

As the **system**,
I want **branch-hours-change flags to surface on the assigned doctor's dashboard with a Resolve badge**,
So that **no flagged appointment silently stays Scheduled past the change**.

**Acceptance Criteria:**

**Given** Story 1.2 saved branch hours with affected appointments
**When** the assigned doctor opens their dashboard
**Then** each affected appointment shows a "Resolve" badge with `reason = "branch_hours_change"` in audit metadata.
**And** clicking Resolve routes to Story 6.2 with the branch-hours flag as the `cause`.
**Architecture binding:** AD-1 (FlagResolver dispatches to flag owner); AD-7 (cause link); UX-DR-31.

---

## Epic 7: Cross-cutting (design system, audit, privacy, accessibility, OTP infrastructure, branch timezone)

**Goal.** The horizontal invariants exist as platform-level stories that vertical epics cite.

### Story 7.1: Design system token wiring

As an **engineer**,
I want **a single source of truth for design tokens and a CI lint that forbids literal hex outside the token file**,
So that **every screen uses the design system by name and drift is caught at CI**.

**Acceptance Criteria:**

**Given** the design tokens from DESIGN-SYSTEM.md
**When** tokens.css is generated and the CI lint rule is in place
**Then** every component consumes tokens by name (`bg-[var(--brand-primary)]`); CI fails on literal hex outside tokens.css (F19).
**And** system font stack only; zero web fonts; tabular figures on time/duration/count.
**Architecture binding:** ADR-4 (Radix + Tailwind tokens); UX-DR-14, UX-DR-15, UX-DR-16, UX-DR-17, UX-DR-18.

### Story 7.2: Appointment audit (append-only, internal-only)

As an **engineer**,
I want **an append-only `AppointmentAudit` table wired to every important event**,
So that **every state change is reconstructable from the audit log**.

**Acceptance Criteria:**

**Given** an appointment event (creation, cancellation, rescheduling, status change, schedule update, block create, branch-hours change flag)
**When** the event commits
**Then** one audit row is written in the same transaction as the appointment write (NFR-005); schedule-change rows carry `affected_appointment_ids` and per-resolution rows carry `cause: "schedule_change:<id>"` (AD-7).
**And** retention ≥ 7 years (F18).
**And** patients never read audit endpoints; cross-branch receptionists cannot read audits they don't own; admins see configuration audits only.
**Architecture binding:** AD-7, AD-10; NFR-005.

### Story 7.3: Patient privacy filter (server-side phone filter)

As an **engineer**,
I want **server-side filtering of `Appointment` queries by the verified session's phone**,
So that **no patient ever sees another patient's appointments**.

**Acceptance Criteria:**

**Given** a verified patient session
**When** they call any appointment endpoint
**Then** the server filters by `patient.phone_number = session.phone`; the client never receives appointments for other phones (NFR-007).
**And** the pen-test assertion checks deep links and query params for leaks.
**Architecture binding:** AD-8; NFR-007.

### Story 7.4: ConflictModal global component (ErrorEnvelope)

As an **engineer**,
I want **a single `ConflictModal` component used by every conflict surface**,
So that **the 3-part shape (what / why / what you can do) is consistent across the app and no OK-only conflicts exist**.

**Acceptance Criteria:**

**Given** any endpoint that returns 409/410 with `ErrorEnvelope`
**When** the response reaches the client
**Then** `ConflictModal` opens with `{what, why, can_do: [{label, action}]}`; `code` is a closed enum; `can_do.action` is a closed enum the modal can dispatch.
**And** test asserts F-01, F-02, F-05, F-06, F-07, F-13, F-16 surfaces use the shared component.
**Architecture binding:** AD-4; UX-DR-25.

### Story 7.5: Accessibility baseline — WCAG 2.1 AA

As an **engineer**,
I want **every interactive element accessible per WCAG 2.1 AA**,
So that **no user is excluded**.

**Acceptance Criteria:**

**Given** the app
**When** a user navigates by keyboard, screen reader, or with reduced motion
**Then** visible focus ring on every interactive element (`:focus-visible` + `--ring-focus`); modal traps focus, Esc closes, Enter triggers primary in ConflictModal; status pills carry icon prefix so meaning isn't color-only; contrast body ≥ 4.5:1, large text ≥ 3:1; faint `#9ca3af` for disabled/placeholder only; touch targets ≥ 40×40 mobile; `prefers-reduced-motion` honored.
**Architecture binding:** UX-DR-37, UX-DR-38, UX-DR-39, UX-DR-40, UX-DR-41; WCAG 2.1 AA.

### Story 7.6: Branch timezone support

As an **engineer**,
I want **`Branch.tz` required and all branch-local times stored as UTC and converted at the branch tz for display**,
So that **a doctor never schedules on the wrong day because of session-tz confusion**.

**Acceptance Criteria:**

**Given** a branch with `tz = "Asia/Riyadh"`
**When** an appointment is created or displayed
**Then** timestamps are stored UTC; response carries `tz = appointment.branch.tz` per AD-9; session branch tz never relabels another branch's event.
**And** edge gateway normalizes incoming timestamps to UTC only, never to a tz.
**Architecture binding:** AD-9; AR-Data-1 (`Branch.tz` required).
