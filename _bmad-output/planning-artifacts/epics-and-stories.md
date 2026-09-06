# Epics & Stories — Multi-Branch Clinic Appointment Scheduling System

> **BMad planning artifact.** Breaks the 19 flows in `docs/specs/UX-FLOWS.md` into 7 epics and sprintable stories. Each story references the BR / FR / F-IDs it implements and the acceptance scenario from PRD §15 it covers.
>
> Story IDs use the `S-<epic>-<n>` format. Acceptance scenarios are written Given/When/Then so they can drop into a test runner unchanged.

## Source documents

- PRD: `_bmad-output/planning-artifacts/prd.md`
- UX: `_bmad-output/planning-artifacts/ux.md`
- Architecture: `_bmad-output/planning-artifacts/architecture.md`
- System flows: `docs/specs/UX-FLOWS.md` (F-01…F-19)
- Acceptance scenarios: PRD §15

---

## Epic index

| # | Epic | Flow coverage | BR/FR range |
|---|---|---|---|
| E1 | Clinic structure & admin | F-16, F-18, F-19 | BR-001…005, FR-001…005 |
| E2 | Doctor schedule & types | F-06, F-07, F-08 | BR-005…017, FR-008…017 |
| E3 | Booking core | F-01, F-02, F-13, F-15 | BR-012…024, FR-014…029 |
| E4 | Patient self-service | F-03, F-04, F-05 | BR-025…045, FR-023, FR-031…043 |
| E5 | Staff appointment management | F-10, F-12, F-14 | BR-035…040, FR-033…038 |
| E6 | Recurring & conflict resolution | F-09, F-11 | BR-047…062, FR-011, FR-044…050, §4.6 |
| E7 | Cross-cutting (OTP, audit, design system) | All | BR-029, FR-031, FR-051, NFR-005…007 |

**Suggested MVP sequencing:** E3 first (booking is the spine), then E4, E2, E5, E6, E7, E1 — though E7 is a horizontal enabler that runs in parallel with everything.

---

## E1 — Clinic structure & admin

### E1-S1 — Create / edit / deactivate branches

**Flow:** F-16
**Rules:** BR-001, BR-005, BR-059 / FR-002, FR-003

**Given** an admin is signed in
**When** they create a branch with name, address, weekly operating hours (multi-period per day), and active status
**Then** the branch persists, audit row written, and the branch appears in active lists.

**Branch hours** support multiple periods per day (BR-005, FR-003). Saved on its own — see E1-S2.

**Acceptance (PRD §15-aligned):**
- Deactivating a branch with future appointments is **rejected** with ConflictModal citing BR-059.

---

### E1-S2 — Change branch operating hours

**Flow:** F-17
**Rules:** BR-060, BR-061, BR-062 / §4.6

**Given** an admin narrows branch hours
**When** some Scheduled appointments fall outside the new hours
**Then** the new hours save, the affected appointments are **flagged for resolution** (status remains Scheduled), and an audit row records `flagged_for_resolution` with metadata `{reason: "branch_hours_change"}`.

Each affected appointment surfaces on the assigned doctor's dashboard with a "Resolve (N)" badge.

**Critical contrast (PRD §18):** unlike doctor schedule changes (E2), this **never rejects** — it saves and flags.

---

### E1-S3 — Create / deactivate / assign-branch doctors

**Flow:** F-18
**Rules:** BR-002, BR-003 / FR-004

**Given** an admin creates a doctor
**When** they assign one or more branches
**Then** the doctor is active at all assigned branches. Deactivating a doctor with future appointments raises a warning: "Patients will not be able to reschedule into this doctor's slots while inactive." (per F-18) but does not block.

---

### E1-S4 — Create / deactivate / assign-branch receptionists

**Flow:** F-19
**Rules:** BR-004 / FR-005

**Given** an admin creates a receptionist
**When** they assign exactly one branch
**Then** the receptionist can act only on that branch (server-side filter; URL-based cross-branch access returns 403 per Scenario 11).

---

## E2 — Doctor schedule & types

### E2-S1 — Configure weekly schedule with multi-period days

**Flow:** F-06
**Rules:** BR-006…009, BR-012 / FR-008…011

**Given** a doctor edits their branch-specific weekly schedule (multiple working periods per day, effective date)
**When** the schedule change would invalidate existing appointments
**Then** the system **rejects** the save (FR-011, BR-009) and surfaces `ScheduleConflict` modal with `AffectedAppointmentsTable`. The doctor must resolve each affected appointment (route to E6-S2) before saving.

**Acceptance (Scenario 6):**
- Existing appointments in the proposed change window → save rejected until all resolved.

---

### E2-S2 — Block time (single date / range / multi-day)

**Flow:** F-07
**Rules:** BR-010, BR-011, BR-054 / FR-012, FR-013

**Given** a doctor creates a block
**When** it overlaps any existing appointment
**Then** the block is rejected (BR-011) with `ConflictModal` and `AffectedAppointmentsTable`.

**Acceptance (Scenario 7):**
- Block 10:00–11:00 with existing 10:30–11:00 appointment → rejected.

---

### E2-S3 — Manage appointment types (create, edit, deactivate)

**Flow:** F-08
**Rules:** BR-014…017 / FR-006, FR-007

**Given** a doctor creates an appointment type with name, duration (≥5 min), and active status
**When** they save
**Then** the type is bookable at every branch where the doctor works (BR-016, FR-007). Deactivating a type with future appointments warns but does not cancel them (per F-08).

---

## E3 — Booking core

### E3-S1 — Availability engine

**Rules:** BR-012…019 / FR-014…019

A pure server-side function (see architecture §3.2). Slot generation must:
- Honor `(branch_hours ∩ doctor_hours) − blocks − existing`.
- Use the appointment-type duration.
- Apply the 30-day window (BR-020).
- Exclude same-day (BR-021).
- Exclude slots overlapping any patient `Scheduled` appointment (FR-029).
- Exclude slots where the patient already has a future appointment with the same doctor (FR-027).

Acceptance (Scenarios 4, 5): patient and doctor conflict paths return no overlapping slots.

---

### E3-S2 — Guest booking

**Flows:** F-01, F-02, F-13
**Rules:** BR-022…027 / FR-020…026

**Given** a patient selects doctor → branch → type → date → slot → name + phone
**When** all validations pass
**Then** the appointment is created atomically with status = Scheduled, audit row written (actor = patient phone), and a confirmation card returns.

**Acceptance (Scenarios 1, 2, 3, 4, 5):**
- Successful booking returns Scheduled with a reference id.
- Same-day booking is rejected with `ConflictModal` citing BR-021.
- Concurrent booking of the same slot → exactly one succeeds; the other receives `ConflictModal` "That slot was just booked." per F-01.

---

### E3-S3 — Receptionist booking on behalf of patient

**Flow:** F-13
**Rules:** BR-019, BR-031, BR-033 / FR-019, FR-027, FR-029

Same as E3-S2 with:
- Branch picker locked to the receptionist's assigned branch.
- PatientDetailsForm allows new phone + name or known-phone (F-02 prefilled).
- audit `actor_role = "receptionist"`.
- Same-day rule still applies (FR-019).

---

### E3-S4 — Receptionist reads doctor availability

**Flow:** F-15
**Rules:** §2.3, §5

**Given** a receptionist opens "Doctor availability"
**When** they pick a doctor (assigned to their branch only), an appointment type, and a date range within the 30-day window
**Then** they see a read-only `AvailabilityCalendar` showing bookable slots. No patient PII beyond first-name initial.

---

## E4 — Patient self-service

### E4-S1 — Patient OTP verification

**Flow:** F-03
**Rules:** BR-029, BR-030 / FR-031, FR-032

**Given** a patient enters a registered phone
**When** they submit a valid 6-digit OTP
**Then** they receive a short-lived session and access their upcoming appointments (status = Scheduled only; FR-032).

OTP must enforce:
- 5-min TTL.
- 3-attempt cap per phone per 10-min window → lockout.

**Acceptance (Scenario 13):** registered phone + correct OTP → upcoming list visible.

---

### E4-S2 — Patient cancellation

**Flow:** F-04
**Rules:** BR-035, BR-038, BR-053 / FR-033, FR-050

**Given** a verified patient cancels a Scheduled appointment
**When** they confirm
**Then** status → Cancelled (never deleted, BR-038), slot released (BR-053), audit row written (actor = patient phone).

**Acceptance (Scenario 14):** cancel → status Cancelled; slot becomes bookable again.

---

### E4-S3 — Patient rescheduling

**Flow:** F-05
**Rules:** BR-041…045 / FR-039…043

**Given** a verified patient reschedules to a new slot (doctor locked; may change branch / type / date / time)
**When** they confirm
**Then** the system performs the rescheduling transaction: reserve new → update → release old → audit (`metadata = {from, to, branch_change, type_change}`).

**Acceptance (Scenarios 8, 9):**
- Successful reschedule moves the appointment.
- If the new slot is lost mid-transaction (FR-043), the original appointment is **untouched** and the patient sees "That slot is no longer available. Your appointment is unchanged."

---

## E5 — Staff appointment management

### E5-S1 — Mark Completed / No-show

**Flow:** F-10 (subset)
**Rules:** BR-039, BR-040 / FR-036, FR-037

**Given** a doctor or receptionist updates an appointment
**When** they pick Completed or No-show
**Then** status updates atomically and audit row is written. No reason required; no slot release (the slot is in the past).

---

### E5-S2 — Doctor cancellation with reason

**Flow:** F-10 (Cancel branch)
**Rules:** BR-037 / FR-035

**Given** a doctor cancels a Scheduled appointment
**When** they provide a reason and confirm
**Then** status → Cancelled, slot released, audit row `action = "cancelled", metadata = {reason}`.

Concurrent change → ConflictModal "No longer Scheduled. Refresh."

---

### E5-S3 — Receptionist cancellation with reason

**Flow:** F-14
**Rules:** BR-036 / FR-034

Same shape as E5-S2 with `actor_role = "receptionist"`.

---

### E5-S4 — Today's branch view (receptionist dashboard)

**Flow:** F-12
**Rules:** BR-063

**Given** a receptionist signs in
**When** they open the dashboard
**Then** they see today's appointments for their assigned branch only (server-side filter; cross-branch URLs return 403 per Scenario 11).

---

## E6 — Recurring & conflict resolution

### E6-S1 — Recurring appointment preview + partial-success create

**Flow:** F-11
**Rules:** BR-047…053 / FR-044, FR-046…050

**Given** a doctor or receptionist previews a recurring series
**When** the server validates each occurrence independently (branch hours, doctor schedule, blocks, existing appts, patient overlap, same-doctor future restriction, 30-day window, same-day exclusion)
**Then** the response separates `will_create` from `skipped_with_reason`.

On confirm, valid occurrences are created atomically as `Scheduled`; one audit row per created occurrence. Per-occurrence independence (BR-052, FR-049): each created occurrence is an independent appointment thereafter.

**Acceptance (Scenario 10):** 8 weekly occurrences with one conflict → 7 created + 1 skipped with reason shown to user.

---

### E6-S2 — Resolve affected appointments (doctor)

**Flow:** F-09
**Rules:** BR-054…058 / FR-011, §4.7

**Given** a doctor opens the Affected queue (from E2-S1 / E2-S2 / E1-S2)
**When** they move an appointment
**Then** slot finder is restricted to:
- Doctor available.
- Branch open.
- 30-day window.
- No doctor overlap.
- No patient overlap.
- **Appointment type locked** (BR-058).
- Branch may change to another branch the doctor works at (BR-057).

The rescheduling transaction (E4-S3) is reused with type fixed. On zero remaining rows, the originating change (schedule/block) may save.

---

### E6-S3 — Branch-hours impact flag (admin)

See E1-S2; called out here because it's the doctor-facing counterpart of the resolve flow.

**Given** branch hours saved with affected appointments
**When** the assigned doctor opens their dashboard
**Then** the affected appointments show a "Resolve" badge and link to E6-S2 with `reason = "branch_hours_change"` in the audit metadata.

---

## E7 — Cross-cutting

### E7-S1 — Design system token wiring

**Rules:** DESIGN-SYSTEM.md §2–6, NFR-005

A single `tokens.css` (or framework equivalent) generated from `DESIGN-SYSTEM.md`. Every screen consumes tokens by name (`--brand-primary`, etc.). A test asserts that the token set matches the .md table.

---

### E7-S2 — Appointment audit (FR-051, NFR-005)

Every important appointment event writes one audit row: creation, cancellation, rescheduling, status change, schedule update, block create, branch-hours change flag. Audit is internal-only (UX §14).

**Acceptance:**
- Patients cannot read audit endpoints.
- Cross-branch receptionists cannot read audits for appts they don't own.
- Admins can read configuration audits but not individual appointment audits.

---

### E7-S3 — Patient privacy filter (NFR-007)

**Rules:** FR-031, FR-032 / NFR-007

Server-side filtering of `Appointment` queries by `patient.phone_number` for the verified session. The client never receives appointments for any other phone. Penetration test asserts no leak via deep links or query params.

---

### E7-S4 — Conflict modal global component

**Rules:** UX §8, architecture §5

A single `ConflictModal` component with three slots: what happened / why / what you can do. Forbidden: "OK"-only conflicts. Used by F-01, F-02, F-05, F-06, F-07, F-13, F-16. Test asserts each of these surfaces uses the shared component, not a bespoke modal.

---

### E7-S5 — Accessibility baseline (WCAG 2.1 AA)

**Rules:** NFR-006, UX §10

- Visible `:focus-visible` ring on every interactive element (default `--ring-focus`).
- Modal focus trap + `Esc` closes + `Enter` triggers primary in ConflictModal.
- Status pills never carry meaning via color alone — icon prefix always.
- Contrast: body text ≥ 4.5:1, large text ≥ 3:1; faint `#9ca3af` (2.85:1) **only** for disabled/placeholder.
- Touch targets ≥ 40×40 on mobile.
- `prefers-reduced-motion` honored.

---

### E7-S6 — Branch timezone support

**Rules:** UX §14, UX-FLOWS §6.4

Add `tz` to `Branch`. All branch-local times (operating hours, slot starts/ends) are stored as UTC and converted at the branch tz for display. UI labels always carry tz or are unambiguously local.

---

## Traceability summary

| Story | Flows | BR / FR | Acceptance scenario |
|---|---|---|---|
| E1-S1 | F-16 | BR-001, BR-005, BR-059 / FR-002, FR-003 | — |
| E1-S2 | F-17 | BR-060…062 / §4.6 | — |
| E1-S3 | F-18 | BR-002, BR-003 / FR-004 | — |
| E1-S4 | F-19 | BR-004 / FR-005 | Scenario 11 |
| E2-S1 | F-06 | BR-006…009 / FR-008…011 | Scenario 6 |
| E2-S2 | F-07 | BR-010, BR-011 / FR-012, FR-013 | Scenario 7 |
| E2-S3 | F-08 | BR-014…017 / FR-006, FR-007 | — |
| E3-S1 | (engine) | BR-012…019 / FR-014…019 | Scenarios 4, 5 |
| E3-S2 | F-01, F-02 | BR-022…027 / FR-020…026 | Scenarios 1, 2, 3 |
| E3-S3 | F-13 | BR-019, BR-031, BR-033 / FR-019, FR-027, FR-029 | — |
| E3-S4 | F-15 | §2.3, §5 | — |
| E4-S1 | F-03 | BR-029, BR-030 / FR-031, FR-032 | Scenario 13 |
| E4-S2 | F-04 | BR-035, BR-038, BR-053 / FR-033, FR-050 | Scenario 14 |
| E4-S3 | F-05 | BR-041…045 / FR-039…043 | Scenarios 8, 9 |
| E5-S1 | F-10 (mark) | BR-039, BR-040 / FR-036, FR-037 | — |
| E5-S2 | F-10 (cancel) | BR-037 / FR-035 | — |
| E5-S3 | F-14 | BR-036 / FR-034 | — |
| E5-S4 | F-12 | BR-063 | Scenario 11 |
| E6-S1 | F-11 | BR-047…053 / FR-044…050 | Scenario 10 |
| E6-S2 | F-09 | BR-054…058 / FR-011, §4.7 | — |
| E6-S3 | (admin counterpart) | BR-060…062 / §4.6 | — |
| E7-S1 | (horizontal) | DESIGN-SYSTEM.md §2–6 | — |
| E7-S2 | (horizontal) | FR-051 / NFR-005 | — |
| E7-S3 | (horizontal) | FR-031, FR-032 / NFR-007 | — |
| E7-S4 | (horizontal) | UX §8 | — |
| E7-S5 | (horizontal) | WCAG 2.1 AA | — |
| E7-S6 | (horizontal) | UX-FLOWS §6.4 | — |

---

## MVP definition check (PRD §17)

The MVP is ready when:

1. ✓ Patient can book without an account — E3-S2
2. ✓ SMS OTP authenticates returning patients — E4-S1
3. ✓ Doctor schedules generate correct availability — E3-S1
4. ✓ Branch hours respected — E3-S1
5. ✓ Doctor blocks respected — E2-S2
6. ✓ Existing appointments cannot be double-booked — E3-S1, E3-S2 (Scenario 3)
7. ✓ Patient conflicts prevented — E3-S1, E4-S2
8. ✓ Patient cancellation works — E4-S2
9. ✓ Patient rescheduling works safely — E4-S3 (Scenarios 8, 9)
10. ✓ Doctor and receptionist permissions enforced — E1-S3, E1-S4, E3-S3, E5-S4 (Scenario 11)
11. ✓ Recurring appointments work with partial conflicts — E6-S1 (Scenario 10)
12. ✓ Schedule changes cannot silently invalidate appointments — E2-S1, E1-S2 (Scenario 6)
13. ✓ Appointment statuses work correctly — E5-S1, E5-S2, E5-S3
14. ✓ Audit records generated — E7-S2
15. ✓ No payment or medical-record functionality — out of scope

All 15 MVP criteria are covered by the story set above.

---

**Next step:** `bmad-sprint-planning` — readiness gate + initial sprint status from these epics.
