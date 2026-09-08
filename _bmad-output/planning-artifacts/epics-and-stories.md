# Epics & Stories — Multi-Branch Clinic Appointment Scheduling System

> **BMad planning artifact.** Breaks the 19 flows in `docs/specs/UX-FLOWS.md` into 8 epics (E0–E7) and **44** sprintable stories. Each story references the BR / FR / F-IDs it implements and the acceptance scenario from PRD §15 it covers.
>
> Story IDs use the `E<n>-S<m>` format (e.g. `E1-S1`). Acceptance scenarios are written Given/When/Then so they can drop into a test runner unchanged.
>
> **Update (2026-09-08):** gap analysis pass against PRD + UX-FLOWS. Added missing stories (bootstrap, clinic, recurring-cancel, negative-capability tests, metrics, privacy invariants), sharpened ACs, and tied every story to its PRD §15 scenario where one exists. See "Change log" at the end of this file.

## Source documents

- PRD: `docs/specs/PRD.md`
- UX: `docs/specs/UX-FLOWS.md`
- Architecture: `_bmad-output/planning-artifacts/architecture.md`
- System flows: `docs/specs/UX-FLOWS.md` (F-01…F-19)
- Acceptance scenarios: PRD §15

---

## Epic index

| # | Epic | Flow coverage | BR/FR range |
|---|---|---|---|
| E0 | Bootstrap & platform | (none — greenfield) | Architecture §1, §11 ADs |
| E1 | Clinic structure & admin | F-16, F-17, F-18, F-19 | BR-001…005, BR-059…063 / FR-001…005 |
| E2 | Doctor schedule & types | F-06, F-07, F-08 | BR-005…017 / FR-006…017 |
| E3 | Booking core | F-01, F-02, F-13, F-15 | BR-012…033 / FR-014…029 |
| E4 | Patient self-service | F-03, F-04, F-05 | BR-025…045 / FR-023, FR-031…043 |
| E5 | Staff appointment management | F-10, F-12, F-14 | BR-035…040 / FR-033…038 |
| E6 | Recurring & conflict resolution | F-09, F-11 | BR-047…062 / FR-011, FR-044…050, §4.6, §4.7 |
| E7 | Cross-cutting (OTP, audit, design system, security, metrics) | All | BR-029, FR-031, FR-051, NFR-005…010 |

**Story total:** 6 (E0) + 5 (E1: S0–S4) + 4 (E2) + 5 (E3) + 4 (E4) + 5 (E5) + 4 (E6) + 10 (E7: S1–S10) = **43 stories** (was 24).

**Design coverage:** 32 / 43 stories reference a mockup via `**Design:**`. The 11 stories without one are listed in the "Stories needing design" table below.

**Suggested MVP sequencing:** E0 first (bootstrap), then E3 (booking is the spine), then E4, E2, E5, E6, E1, E7 — though E7 is horizontal and runs in parallel with everything.

---

## E0 — Bootstrap & platform

> Greenfield repo. The repository contains only design and planning artifacts today. These stories produce the runnable skeleton every other epic depends on.

### E0-S1 — Repo skeleton + starter template

**Rules:** Architecture §1.1 (greenfield spine), §11 ADs

**Given**
  the repo has no code yet
**When**
  the starter template is applied (chosen in Architecture §9 / §12)
**Then**
  the monorepo / single-repo skeleton runs locally: a backend service exposing a `/healthz` endpoint, a web app shell that renders a placeholder page, and a CI workflow that runs lint + unit tests on every push. A `seed` script provisions one clinic, one branch, one doctor, one receptionist, one admin, zero patients.

**Acceptance:**
- `make dev` (or equivalent) brings up the stack.
- CI is green on a clean commit.
- The web app's design tokens (E7-S1) load from the seed environment.

### E0-S2 — Data model & migrations

**Rules:** PRD §8 (recommended data model), Architecture §4 (data-model invariants)

Implement the entities from PRD §8 as a migration set: `Clinic`, `Branch` (+ `tz` per E7-S6), `Doctor`, `DoctorBranch`, `Receptionist`, `Patient`, `AppointmentType`, `DoctorSchedule`, `DoctorBlock`, `Appointment`, `AppointmentAudit`, `OTPVerification`. Each carries the invariants from Architecture §4 (FK integrity, status enum, unique constraints, `created_by` polymorphism).

**Acceptance:**
- Migrations run forward and roll back cleanly.
- A unit test asserts each invariant from Architecture §4.

### E0-S3 — Auth provider wiring

**Rules:** Architecture §3.1 (auth contract)

Pick and wire the auth library whose session tokens include `{role, branch_ids, scope, doctor_id?}`. Server must read `branch_ids` from the claim, never the request body.

**Acceptance:**
- A patient cannot authenticate through the staff login route and vice versa.
- A staff token with `branch_ids = []` is rejected at the middleware.
- A doctor token with `doctor_id` missing is rejected at the doctor-only routes.

### E0-S4 — SMS OTP gateway

**Rules:** PRD FR-031, Architecture §3.1 (identity & access)

Wire the SMS provider behind an interface so the dev environment can stub it. The interface must support: `send(phone, code)`, `verify(phone, code)`, attempt counting, TTL, lockout.

**Acceptance:**
- `send` failure surfaces a user-facing toast (UX-FLOWS F-03 path).
- Provider timeout does not corrupt OTP state.
- Dev environment uses a console logger instead of a real SMS send.

### E0-S5 — Seed data + role fixtures

**Rules:** PRD §14 (MVP scope)

A `seed` command populates: 1 clinic, 2 branches with distinct time zones, 3 doctors with appointment types, 2 receptionists (one per branch), 1 admin, and 5 patients (some with existing future appointments). Each role has a fixture file usable by tests.

**Acceptance:**
- The seed is idempotent.
- E2E tests load fixtures by path, not by inline JSON.

### E0-S6 — Observability baseline

**Rules:** PRD NFR-005, NFR-009

Structured logs with `request_id`, `actor_role`, `actor_id`, `appointment_id` (when in scope). One metrics endpoint exposing counters for: booking attempts, booking successes, slot conflicts, OTP verifications, recurring occurrences created vs skipped. Health and readiness probes return 200.

**Acceptance:**
- A booking attempt emits exactly one `booking.attempt` and one of `booking.success` / `booking.conflict` / `booking.failure` counter increment.

---

## E1 — Clinic structure & admin

### E1-S0 — Clinic management (single-clinic anchor)

**Rules:** PRD FR-001 ("system shall support a clinic containing multiple branches")

**Given**
  the platform is multi-tenant-ready but ships with a single clinic per deployment
**When**
  the admin opens clinic settings
**Then**
  they can edit clinic name, view branch count, and view doctor/receptionist/patient counts. Every other entity (branch, doctor, receptionist, patient) is FK-bound to exactly one clinic.

**Acceptance:**
- Inserting a branch without `clinic_id` is rejected at the DB layer.
- An admin scoped to clinic A cannot list branches of clinic B.

**Design:** [Mockup 32 — Admin clinic settings](../../docs/design/mockups/v1/mockups/32-admin-clinic-settings.html)

### E1-S1 — Create / edit / deactivate branches

**Flow:** F-16
**Rules:** BR-001, BR-005, BR-059 / FR-002, FR-003

**Given**
  an admin is signed in
**When**
  they create a branch with name, address, weekly operating hours (multi-period per day), and active status
**Then**
  the branch persists, audit row written, and the branch appears in active lists.

**Branch hours** support multiple periods per day (BR-005, FR-003). Saved on its own — see E1-S2.

**Acceptance (PRD §15-aligned):**
- Deactivating a branch with future appointments is **rejected** with ConflictModal citing BR-059.

**Design:** [Mockup 17 — Admin branches](../../docs/design/mockups/v1/mockups/17-admin-branches.html)

---

### E1-S2 — Change branch operating hours

**Flow:** F-17
**Rules:** BR-060, BR-061, BR-062 / §4.6

**Given**
  an admin narrows branch hours
**When**
  some Scheduled appointments fall outside the new hours
**Then**
  the new hours save, the affected appointments are **flagged for resolution** (status remains Scheduled), and an audit row records `flagged_for_resolution` with metadata `{reason: "branch_hours_change"}`.

Each affected appointment surfaces on the assigned doctor's dashboard with a "Resolve (N)" badge.

**Critical contrast (PRD §18):** unlike doctor schedule changes (E2), this **never rejects** — it saves and flags.

**Edge case (UX-FLOWS F-17):** if the assigned doctor no longer works at the affected branch (e.g. mid-reassignment or branch-deactivation), the admin must reassign the appointment or cancel it through a documented staff workflow before the branch-hours change finalizes. The save button stays disabled until that gap is closed.

**Design:** [Mockup 08 — Branch-hours impact](../../docs/design/mockups/v1/mockups/08-branch-hours-impact.html) · [Mockup 28 — Hours editor](../../docs/design/mockups/v1/mockups/28-admin-branch-hours-editor.html)

---

### E1-S3 — Create / deactivate / assign-branch doctors

**Flow:** F-18
**Rules:** BR-002, BR-003 / FR-004

**Given**
  an admin creates a doctor
**When**
  they assign one or more branches
**Then**
  the doctor is active at all assigned branches. Deactivating a doctor with future appointments raises a warning: "Patients will not be able to reschedule into this doctor's slots while inactive." (per F-18) but does not block.

A doctor belongs to exactly one clinic (BR-002); the assignment UI rejects multi-clinic selection.

**Acceptance:**
- Reassigning a doctor away from a branch where they have future appointments leaves those appointments intact (admin never touches individual appointments, per PRD §2.4) and surfaces a "doctor no longer at this branch" queue for the affected doctor (matches E1-S2 edge case).
- Audit row written: `actor_role = "admin"`, action on `Doctor` and on `DoctorBranch`.

**Design:** [Mockup 18 — Admin doctors](../../docs/design/mockups/v1/mockups/18-admin-doctors.html) · [Mockup 31 — Reassign branches](../../docs/design/mockups/v1/mockups/31-admin-doctors-reassign.html)

---

### E1-S4 — Create / deactivate / assign-branch receptionists

**Flow:** F-19
**Rules:** BR-004 / FR-005

**Given**
  an admin creates a receptionist
**When**
  they assign exactly one branch
**Then**
  the receptionist can act only on that branch (server-side filter; URL-based cross-branch access returns 403 per Scenario 11).

**Design:** [Mockup 19 — Admin receptionists](../../docs/design/mockups/v1/mockups/19-admin-receptionists.html)

---

## E2 — Doctor schedule & types

### E2-S1 — Configure weekly schedule with multi-period days

**Flow:** F-06
**Rules:** BR-006…009, BR-012 / FR-008…011

**Given**
  a doctor edits their branch-specific weekly schedule (multiple working periods per day, effective date)
**When**
  the schedule change would invalidate existing appointments
**Then**
  the system **rejects** the save (FR-011, BR-009) and surfaces `ScheduleConflict` modal with `AffectedAppointmentsTable`. The doctor must resolve each affected appointment (route to E6-S2) before saving.

**Acceptance (Scenario 6):**
- Existing appointments in the proposed change window → save rejected until all resolved.
- The effective-date input (FR-010) defaults to tomorrow and is required; past effective dates are rejected.
- If the proposed periods fall outside the branch's operating hours, a **soft warning** is shown ("These hours fall outside branch operating hours.") with [Adjust] / [Continue anyway] (UX-FLOWS F-06). Continuing anyway does not save unless validations pass.
- After all affected appointments resolve, the originating Save button re-enables (E6-S2 unlocks it).

**Design:** [Mockup 09 — Doctor schedule](../../docs/design/mockups/v1/mockups/09-doctor-schedule.html)

---

### E2-S2 — Block time (single date / range / multi-day)

**Flow:** F-07
**Rules:** BR-010, BR-011, BR-054 / FR-012, FR-013

**Given**
  a doctor creates a block (single date / time range / multi-day)
**When**
  it overlaps any existing appointment
**Then**
  the block is rejected (BR-011) with `ConflictModal` and `AffectedAppointmentsTable`.

**Acceptance (Scenario 7):**
- Block 10:00–11:00 with existing 10:30–11:00 appointment → rejected.
- If the block falls outside the doctor's working schedule, a **soft warning** is shown ("This is outside your working hours. Block anyway?") per UX-FLOWS F-07; the doctor confirms before saving.
- Block creation writes audit row `action = "block_created"`, `actor_role = "doctor"`.

**Design:** [Mockup 10 — Doctor block time](../../docs/design/mockups/v1/mockups/10-doctor-block-time.html)

---

### E2-S3 — Manage appointment types (create, edit, deactivate)

**Flow:** F-08
**Rules:** BR-014…017 / FR-006, FR-007

**Given**
  a doctor creates an appointment type with name, duration (≥5 min), and active status
**When**
  they save
**Then**
  the type is **bookable at every branch where the doctor works** (FR-007, BR-016). Deactivating a type with future appointments warns but does not cancel them (per F-08); inactive types are non-bookable everywhere (FR-007 + F-08 note).

**Acceptance:**
- Duration < 5 minutes is rejected at the form and the API.
- Booking against an inactive type is rejected at the server regardless of branch.
- Audit row written on create / edit / deactivate.

**Design:** [Mockup 11 — Appointment types](../../docs/design/mockups/v1/mockups/11-appointment-types.html)

### E2-S4 — Negative-capability: doctor cannot reschedule ordinary patient appointments

**Rules:** PRD §2.2 restrictions, BRD §3.2 (doctors cannot reschedule ordinary patient appointments)

A doctor's appointment actions are limited to: cancel (with reason), mark completed, mark no-show, resolve affected (E6-S2). A reschedule action against a normally-booked appointment must not exist in the doctor's UI and must 403 from the API.

**Acceptance:**
- A doctor-side integration test attempting a "reschedule ordinary appointment" against any patient appointment that is not flagged for resolution receives 403 with a clear error code.
- A static test asserts the doctor appointment row has no Reschedule button (only Resolve when flagged).

---

## E3 — Booking core

### E3-S1 — Availability engine

**Rules:** BR-012…019 / FR-014…019

A pure server-side function (see architecture §3.2). Slot generation must:
- Honor `(branch_hours ∩ doctor_hours) − blocks − existing`.
- Use the appointment-type duration (FR-015).
- Insert **no buffer** between consecutive slots (FR-016, BR-017).
- Apply the **30-day fixed window** (FR-018) — calendar grays out dates outside the window with a tooltip explaining the limit (UX-FLOWS §6.5).
- Exclude same-day (FR-019, BR-021).
- If remaining working time at the end of a day cannot fit a complete appointment duration, the partial remainder is unused (FR-017).
- Back-to-back appointments are allowed across branches (FR-030) — no travel-time calculation.
- Exclude slots overlapping any patient `Scheduled` appointment (FR-029, Scenario 4).
- Exclude slots where the patient already has a future appointment with the same doctor (FR-027).

**Acceptance (Scenarios 4, 5):** patient and doctor conflict paths return no overlapping slots. End-of-day remainder is asserted by a unit test against a doctor with a 25-min slot type ending at 17:00.

**Design:** [Mockup 03 — Availability calendar](../../docs/design/mockups/v1/mockups/03-availability-calendar.html)

---

### E3-S2 — Guest booking (first-time)

**Flow:** F-01
**Rules:** BR-022…027 / FR-020…026

**Given**
  a patient selects doctor → branch → type → date → slot → name + phone
**When**
  all validations pass
**Then**
  the appointment is created atomically with status = Scheduled (**immediate confirmation**, FR-024), audit row written (actor = patient phone), and a confirmation card returns with `.ics` download option.

**Acceptance (Scenarios 1, 2, 3, 4, 5):**
- Successful booking returns Scheduled with a reference id (Scenario 1, FR-021, FR-024).
- Same-day booking is rejected with `ConflictModal` citing FR-019 (Scenario 2).
- Concurrent booking of the same slot → exactly one succeeds; the other receives `ConflictModal` "That slot was just booked." per F-01 (Scenario 3, NFR-001, FR-025, FR-026).
- Patient-overlap and doctor-overlap paths return no overlapping slots (Scenarios 4, 5).
- Phone number is the patient key (FR-022). Storing two `Patient` rows for the same phone is rejected by a unique constraint.
- A patient may have future appointments with multiple doctors (FR-028); the per-doctor-future check (FR-027) is enforced per doctor, not across all doctors.

**Design:** [Mockup 01 — Layout direction](../../docs/design/mockups/v1/mockups/01-layout-direction.html) · [Mockup 02 — Doctor picker](../../docs/design/mockups/v1/mockups/02-doctor-picker.html) · [Mockup 04 — Patient confirmation](../../docs/design/mockups/v1/mockups/04-patient-confirm.html)

### E3-S3 — Returning patient booking (known phone)

**Flow:** F-02
**Rules:** BR-027 / FR-023

**Given**
  the patient has previously booked (F-01 detected a known phone)
**When**
  the booking continues past slot selection
**Then**
  the `PatientDetailsForm` shows the stored name **prefilled and editable**, phone is **read-only**, and on submit the existing `Patient` row is reused (no duplicate).

**Acceptance (FR-023):**
- Editing the name and submitting does **not** create a duplicate `Patient` row.
- Editing the name updates the patient's stored name.
- Phone field is not editable on this screen.

**Design:** [Mockup 01 — Layout direction](../../docs/design/mockups/v1/mockups/01-layout-direction.html)

### E3-S4 — Receptionist booking on behalf of patient

**Flow:** F-13
**Rules:** BR-019, BR-031, BR-033 / FR-019, FR-027, FR-029

Same as E3-S2 with:
- Branch picker locked to the receptionist's assigned branch.
- `PatientDetailsForm` allows new phone + name **or** known-phone → E3-S3 prefilled path.
- Confirmation surfaces "Created on behalf of patient."
- Audit `actor_role = "receptionist"`.
- Same-day rule still applies (FR-019).
- All conflict checks identical to patient self-booking (FR-027, FR-029).

**Design:** [Mockup 14 — Receptionist create](../../docs/design/mockups/v1/mockups/14-recep-create.html)

### E3-S5 — Receptionist reads doctor availability

**Flow:** F-15
**Rules:** §2.3, §5

**Given**
  a receptionist opens "Doctor availability"
**When**
  they pick a doctor (assigned to their branch only), an appointment type, and a date range within the 30-day window
**Then**
  they see a read-only `AvailabilityCalendar` showing bookable slots. No patient PII beyond first-name initial. The calendar grays out dates outside the window with a tooltip explaining the limit (UX-FLOWS §6.5).

The receptionist cannot modify the schedule from this surface (per role capability matrix).

**Design:** [Mockup 16 — Receptionist availability](../../docs/design/mockups/v1/mockups/16-recep-availability.html)

---

## E4 — Patient self-service

### E4-S1 — Patient OTP verification

**Flow:** F-03
**Rules:** BR-029, BR-030 / FR-031, FR-032

**Given**
  a patient enters a registered phone
**When**
  they submit a valid 6-digit OTP
**Then**
  they receive a short-lived session and access their upcoming appointments (status = Scheduled only; FR-032 — cancelled, completed, no-show excluded).

OTP must enforce:
- 5-min TTL.
- **3-attempt cap** per phone per 10-min window → lockout ("Try again in 10 minutes.").
- **30-second resend cooldown** (UX-FLOWS F-03).
- **Expired-code path:** "Send a new code" surfaces a fresh send.
- **SMS-send failure:** inline toast "Could not send code. [Try again]" without crashing the flow.
- **Wrong-code inline error** showing remaining attempt count.
- 6-digit input uses **auto-advance** between fields and accepts paste.

**Acceptance (Scenario 13):** registered phone + correct OTP → upcoming list visible.

**Design:** [Mockup 21 — Patient OTP](../../docs/design/mockups/v1/mockups/21-patient-otp-modal.html)

### E4-S2 — Patient cancellation

**Flow:** F-04
**Rules:** BR-035, BR-038, BR-053 / FR-033, FR-050

**Given**
  a verified patient cancels a Scheduled appointment
**When**
  they confirm
**Then**
  status → Cancelled (never deleted, BR-038), slot released (BR-053), audit row written (actor = patient phone).

**Acceptance (Scenario 14):** cancel → status Cancelled; slot becomes bookable again.

**Design:** [Mockup 22 — Patient cancel confirmation](../../docs/design/mockups/v1/mockups/22-patient-cancel-confirm.html) · [Mockup 05 — Patient self-service](../../docs/design/mockups/v1/mockups/05-patient-self-service.html)

---

### E4-S3 — Patient rescheduling

**Flow:** F-05
**Rules:** BR-041…045 / FR-039…043

**Given**
  a verified patient reschedules to a new slot (doctor locked; may change branch / type / date / time)
**When**
  they confirm
**Then**
  the system performs the rescheduling transaction: reserve new → update → release old → audit (`metadata = {from, to, branch_change, type_change}` per UX-FLOWS F-05).

**Acceptance (Scenarios 8, 9):**
- Successful reschedule moves the appointment (Scenario 8).
- If the new slot is lost mid-transaction (FR-043), the original appointment is **untouched** and the patient sees "That slot is no longer available. Your appointment is unchanged." (Scenario 9).
- The audit metadata actually surfaces `branch_change` and `type_change` flags in the audit drawer (E7-S2).
- The doctor is locked — the doctor picker is not rendered on the reschedule screen (BR-042, FR-040).
- The patient may change branch, appointment type, date, or time (FR-041). Doctor remains unchanged (FR-040).
- The transaction reserves the new slot **before** releasing the old slot (FR-042); if the new reservation fails, the original appointment remains unchanged.
- Calendar grays out same-day and out-of-window dates (FR-018, FR-019).

**Design:** [Mockup 20 — Patient reschedule](../../docs/design/mockups/v1/mockups/20-patient-reschedule.html) · [Mockup 05 — Patient self-service](../../docs/design/mockups/v1/mockups/05-patient-self-service.html)

### E4-S4 — Deep-link entry to cancel/reschedule

**Rules:** UX-FLOWS F-03 (deep-link trigger), F-04 / F-05 triggers

**Given**
  a patient has a link from a notification or email (out-of-app; for MVP these are out of scope, but the route must exist for staff-generated links)
**When**
  they tap the link
**Then**
  they are routed to the OTP screen (E4-S1), and after verification land directly on the cancel or reschedule modal for that appointment id.

**Acceptance:**
- A link with an unknown appointment id is treated as a 404.
- A link for an appointment the phone does not own is rejected at the server before any PII leaks (matches E7-S3 privacy filter).

---

## E5 — Staff appointment management

### E5-S1 — Mark Completed / No-show

**Flow:** F-10 (subset)
**Rules:** BR-039, BR-040 / FR-036, FR-037

**Given**
  a doctor or receptionist updates an appointment
**When**
  they pick Completed or No-show
**Then**
  status updates atomically and audit row is written. No reason required; **the slot is not released** (the slot is in the past).

**Acceptance (negative):**
- After marking Completed, the slot does **not** re-appear in the availability engine for the same day.
- A no-show cannot be applied to a future appointment (server rejects with 422).

**Design:** [Mockup 12 — Mark appointment status](../../docs/design/mockups/v1/mockups/12-mark-status.html)

---

### E5-S2 — Doctor cancellation with reason

**Flow:** F-10 (Cancel branch)
**Rules:** BR-037 / FR-035

**Given**
  a doctor cancels a Scheduled appointment
**When**
  they provide a reason and confirm
**Then**
  status → Cancelled, slot released, audit row `action = "cancelled", metadata = {reason}`.

Concurrent change → ConflictModal "No longer Scheduled. Refresh."

**Design:** [Mockup 25 — Doctor cancel reason](../../docs/design/mockups/v1/mockups/25-doctor-cancel-reason.html)

---

### E5-S3 — Receptionist cancellation with reason

**Flow:** F-14
**Rules:** BR-036 / FR-034

Same shape as E5-S2 with:
- `actor_role = "receptionist"`.
- `metadata = {reason}` recorded in the audit row (UX-FLOWS F-14).
- Cancellation is restricted to the receptionist's assigned branch (server-side).
- Confirmation modal text: "Cancelled. Slot released."

**Design:** [Mockup 15 — Receptionist cancel](../../docs/design/mockups/v1/mockups/15-recep-cancel.html)

---

### E5-S4 — Today's branch view (receptionist dashboard)

**Flow:** F-12
**Rules:** BR-063

**Given**
  a receptionist signs in
**When**
  they open the dashboard
**Then**
  they see today's appointments for their assigned branch only (server-side filter; cross-branch URLs return 403 per Scenario 11). Filters: Date | Doctor | Status. Empty state: "No appointments scheduled for today."

**Acceptance:**
- A receptionist navigating to `/branches/{other_branch_id}/appointments` receives 403 with no appointment data leaked.
- The branch header reads e.g. "Branch A — Today, Aug 18" with branch tz (E7-S6).

**Design:** [Mockup 13 — Receptionist today](../../docs/design/mockups/v1/mockups/13-recep-today.html)

### E5-S5 — No deletion (negative test)

**Rules:** PRD FR-038 ("no normal appointment deletion"), Scenario 15

**Given**
  any staff user
**When**
  they attempt to delete an appointment
**Then**
  the API does not provide a delete route; the UI does not render a delete button. A test asserts 404 on `DELETE /appointments/{id}`.

**Acceptance (Scenario 15):** no delete path exists for any role.

---

## E6 — Recurring & conflict resolution

### E6-S1 — Recurring appointment preview + partial-success create

**Flow:** F-11
**Rules:** BR-047…053 / FR-044, FR-045, FR-046, FR-047, FR-048, FR-049, FR-050

**Given**
  a doctor or receptionist (not a patient — FR-045) previews a recurring series (Weekly / Every 2 weeks / Custom; occurrence count capped by the 30-day window)
**When**
  the server validates each occurrence independently
**Then**
  the response separates `will_create` from `skipped_with_reason`.

Per-occurrence validation (FR-046): branch hours, doctor schedule, doctor blocks, existing doctor appointments, patient overlap across doctors, **same-doctor future restriction** (FR-027), **30-day window** (FR-018), and **same-day exclusion** (FR-019 — also applies to each individual occurrence).

Skip reasons surfaced to the user (FR-048):
- "Outside branch operating hours"
- "Doctor blocked on this date"
- "Patient has another appointment"
- "Patient already has a future appointment with Dr. X"
- "Outside 30-day booking window"
- "Same-day not allowed"

On confirm, valid occurrences are created atomically as `Scheduled`; one audit row per created occurrence. **Per-occurrence independence (BR-052, FR-049):** each created occurrence is an independent appointment thereafter (cancellable / reschedulable via E4-S2, E4-S3 individually — see E6-S4). Partial success: valid occurrences are created, unavailable ones skipped (FR-047).

**Acceptance (Scenario 10):** 8 weekly occurrences with one conflict → 7 created + 1 skipped with reason shown to user.
**Acceptance:** A 9th occurrence scheduled for "today + 0 days" (same-day) is skipped even if all other constraints pass.

**Design:** [Mockup 07 — Recurring preview](../../docs/design/mockups/v1/mockups/07-recurring-preview.html) · [Mockup 23 — Recurring confirmation](../../docs/design/mockups/v1/mockups/23-recurring-confirm.html)

### E6-S2 — Resolve affected appointments (doctor)

**Flow:** F-09
**Rules:** BR-054…058 / FR-011, §4.7

**Given**
  a doctor opens the Affected queue (from E2-S1 / E2-S2 / E1-S2)
**When**
  they move an appointment
**Then**
  slot finder is restricted to:
- Doctor available.
- Branch open.
- 30-day window.
- No doctor overlap.
- No patient overlap.
- **Appointment type locked** (BR-058 — type picker is not shown).
- Branch may change to another branch the doctor works at (BR-057 — branch picker shown).

**Audit and transaction.** This is a **doctor-initiated conflict move**, not a patient reschedule. Audit row is `action = "moved_by_doctor"`, `actor_role = "doctor"`, `metadata = {reason: "conflict_resolution"}`. The internal transaction reserves the new slot, updates the appointment (branch, start, end — type unchanged), releases the old slot.

**Edge case (UX-FLOWS F-09):** when no slots are available for a given affected row, the only path forward is to cancel the appointment (route to F-10). The UI surfaces this as a fallback button.

**Unlock condition.** When the affected queue is fully resolved (zero rows), the originating change (schedule / block / branch-hours) is unlocked and its Save button re-enables. The system must not allow the originating save while any affected row remains unresolved.

**Design:** [Mockup 06 — Resolve affected](../../docs/design/mockups/v1/mockups/06-resolve-affected.html) · [Mockup 24 — Resolve one](../../docs/design/mockups/v1/mockups/24-doctor-resolve-one.html)

### E6-S3 — Branch-hours impact flag (admin)

See E1-S2; called out here because it's the doctor-facing counterpart of the resolve flow.

**Given**
  branch hours saved with affected appointments
**When**
  the assigned doctor opens their dashboard
**Then**
  the affected appointments show a "Resolve" badge and link to E6-S2 with `reason = "branch_hours_change"` in the audit metadata.

**Design:** [Mockup 08 — Branch-hours impact](../../docs/design/mockups/v1/mockups/08-branch-hours-impact.html)

### E6-S4 — Per-occurrence recurring cancel / reschedule

**Rules:** PRD FR-049 ("individual occurrences shall be independently cancellable or reschedulable"), FR-050 ("cancelling one occurrence shall immediately release its slot"), UX-FLOWS §4.7 (per-occurrence independence)

**Given**
  an occurrence exists as part of a created recurring series
**When**
  the patient (post-OTP) or staff cancels or reschedules **one** occurrence
**Then**
  only that occurrence is affected; siblings are untouched. The cancel uses E4-S2 transaction; the reschedule uses E4-S3 transaction.

**Acceptance:**
- Cancelling one occurrence releases only its slot (FR-050); the sibling occurrences' slots remain reserved.
- Rescheduling one occurrence does not affect siblings.
- Audit metadata marks the action with a `recurring_origin` pointer (server-side join) so the original series can be reconstructed for reporting.

**Design:** [Mockup 33 — Per-occurrence recurring cancel](../../docs/design/mockups/v1/mockups/33-recurring-occurrence-cancel.html)

---

## E7 — Cross-cutting

### E7-S1 — Design system token wiring

**Rules:** DESIGN-SYSTEM.md §2–6, NFR-005

A single `tokens.css` (or framework equivalent) generated from `DESIGN-SYSTEM.md`. Every screen consumes tokens by name (`--brand-primary`, etc.). A test asserts that the token set matches the .md table.

**Design:** [Design system reference](../../docs/design/design-system.html) · [Shared CSS](../../docs/design/mockups/v1/imports/app/design-system.css)

---

### E7-S2 — Appointment audit (FR-051, NFR-005)

Every important appointment event writes one audit row: creation, cancellation, rescheduling, status change, schedule update, block create, branch-hours change flag, recurring-occurrence creation, doctor-initiated conflict move. Audit is internal-only (UX §14).

**Acceptance (audience per PRD §5 + UX §6.3):**
- **Patients** cannot read audit endpoints (NFR-007).
- **Doctors** can read audits only for appointments they own.
- **Receptionists** can read audits only for appointments at their branch.
- **Admins** can read configuration audits (Doctor / DoctorBranch / Branch / Receptionist / schedule / block / branch-hours) but **not individual appointment audits** (PRD §2.4).
- Audit metadata for patient reschedules (E4-S3) includes `branch_change` and `type_change` flags.
- Audit metadata for doctor-initiated conflict moves (E6-S2) is `action = "moved_by_doctor"`, `metadata = {reason: "conflict_resolution"}`.

**Design:** [Mockup 27 — Admin audit log](../../docs/design/mockups/v1/mockups/27-admin-audit-log.html) · [Mockup 30 — Doctor audit drawer](../../docs/design/mockups/v1/mockups/30-doctor-audit-drawer.html)

---

### E7-S3 — Patient privacy filter (NFR-007)

**Rules:** FR-031, FR-032, FR-022 / NFR-007

Server-side filtering of `Appointment` queries by `patient.phone_number` for the verified session. The client never receives appointments for any other phone. Penetration test asserts no leak via deep links, query params, response shape, or timing.

**Acceptance:**
- A patient cannot enumerate other patients' appointments by id (404 / empty list, never 200 with another patient's data).
- Phone is the sole patient key (FR-022): two `Patient` rows with the same phone is rejected by a unique constraint.
- The privacy filter is implemented at the data-access layer (e.g. a row-level filter or middleware), never in the client.

**Design:** [Mockup 05 — Patient self-service](../../docs/design/mockups/v1/mockups/05-patient-self-service.html)

---

### E7-S4 — Conflict modal global component

**Rules:** UX §8, architecture §5

A single `ConflictModal` component with three slots: what happened / why / what you can do. Forbidden: "OK"-only conflicts. Used by F-01, F-02, F-05, F-06, F-07, F-13, F-16. Test asserts each of these surfaces uses the shared component, not a bespoke modal.

**Design:** [Mockup 29 — Conflict modal](../../docs/design/mockups/v1/mockups/29-conflict-modal.html)

---

### E7-S5 — Accessibility baseline (WCAG 2.1 AA)

**Rules:** NFR-006, UX §10

- Visible `:focus-visible` ring on every interactive element (default `--ring-focus`).
- Modal focus trap + `Esc` closes + `Enter` triggers primary in ConflictModal.
- Status pills never carry meaning via color alone — icon prefix always.
- Contrast: body text ≥ 4.5:1, large text ≥ 3:1; faint `#9ca3af` (2.85:1) **only** for disabled/placeholder.
- Touch targets ≥ 40×40 on mobile.
- `prefers-reduced-motion` honored.

**Design:** [Design system reference](../../docs/design/design-system.html) · [Mockup 29 — Conflict modal](../../docs/design/mockups/v1/mockups/29-conflict-modal.html)

---

### E7-S6 — Branch timezone support

**Rules:** UX §14, UX-FLOWS §6.4

Add `tz` to `Branch`. All branch-local times (operating hours, slot starts/ends) are stored as UTC and converted at the branch tz for display. UI labels always carry tz or are unambiguously local.

**Design:** [Mockup 01 — Layout direction](../../docs/design/mockups/v1/mockups/01-layout-direction.html)

### E7-S7 — No tentative client-side slot holds

**Rules:** UX-FLOWS §6.2 (atomicity discipline), Architecture principle 2

The UI never assumes a slot is bookable based on stale data, never holds tentative slots client-side, and surfaces "slot was just taken" gracefully (ConflictModal) rather than as a system error. The availability calendar's "still showing" state must reconcile to server truth on every action.

**Acceptance:**
- A test that books a slot from session A while session B is mid-flight on the same slot observes: session B sees ConflictModal, not a 500.
- No client store or in-memory map treats a slot as "held" outside the booking transaction.

### E7-S8 — Performance & availability SLAs

**Rules:** NFR-008 (≤2 s availability query), NFR-009 (booking service availability), NFR-010 (consistency between availability and booking state)

**Given**
  a clinic of typical size (PRD §14 scope: multi-branch, multi-doctor, multi-receptionist)
**When**
  a patient or receptionist queries availability
**Then**
  p95 ≤ 2 s for the typical query (one doctor, one branch, one date range). The booking service stays ≥ 99.5% available per calendar month. Displayed availability reflects committed bookings within 1 s of the write (NFR-010).

**Acceptance:**
- A load test asserts p95 < 2 s for 50 concurrent availability queries.
- A chaos test asserts no booking-write succeeds without an audit row (consistency).
- Health/readiness probes (E0-S6) feed into this SLA.

### E7-S9 — Product metrics instrumentation

**Rules:** PRD §16 (product metrics)

Emit metrics covering: booking success rate, failed booking rate, slot conflict rate, average time to complete booking, availability-query response time, % searches → booking, cancellation rate, reschedule rate, no-show rate, completed rate, recurring series success rate, % recurring occurrences skipped, double-booking incidents, schedule-conflict incidents, failed-transaction rate, OTP verification success rate.

**Acceptance:**
- Each metric in PRD §16 has a corresponding counter or histogram emitted at the call site and surfaced on a `/metrics` endpoint.
- A dashboard definition (e.g. Grafana JSON) is checked into the repo.

### E7-S10 — Design open questions parking lot

The following items from UX-FLOWS §7 are **not yet decided** and need design input before the relevant story can be built:

1. Calendar visualization: day / week / month view for doctor and receptionist dashboards?
2. Bulk conflict resolution: can F-09 / E6-S2 resolve multiple affected rows in one go, or only one at a time?
3. In-progress reschedule cancellation: confirm no tentative holds (E7-S7) — already settled as "no holds"; no further decision needed.
4. OTP UX: SMS only, or voice fallback? Copy for users without signal?
5. Empty states: doctor schedule empty state, receptionist day empty state, recurring preview empty state.
6. Accessibility: keyboard navigation through AvailabilityCalendar, screen-reader labels for status badges, focus management in OTPModal and ConflictModal (partially covered by E7-S5).

Each item above should be answered or explicitly deferred before its story starts.

---

## Traceability summary

| Story | Flows | BR / FR | Acceptance scenario | Design reference |
|---|---|---|---|---|
| E0-S1 | (bootstrap) | Architecture §1.1, §11 ADs | — | — |
| E0-S2 | (bootstrap) | PRD §8 / Arch §4 | — | — |
| E0-S3 | (bootstrap) | Arch §3.1 | — | — |
| E0-S4 | (bootstrap) | FR-031 | — | — |
| E0-S5 | (bootstrap) | PRD §14 | — | — |
| E0-S6 | (bootstrap) | NFR-005, NFR-009 | — | — |
| E1-S0 | (admin) | FR-001 | — | [Mockup 32 — Admin clinic settings](../../docs/design/mockups/v1/mockups/32-admin-clinic-settings.html) |
| E1-S1 | F-16 | BR-001, BR-005, BR-059 / FR-002, FR-003 | — | [Mockup 17 — Admin branches](../../docs/design/mockups/v1/mockups/17-admin-branches.html) |
| E1-S2 | F-17 | BR-060…062 / §4.6 | — | [Mockup 08 — Branch-hours impact](../../docs/design/mockups/v1/mockups/08-branch-hours-impact.html); [Mockup 28 — Hours editor](../../docs/design/mockups/v1/mockups/28-admin-branch-hours-editor.html) |
| E1-S3 | F-18 | BR-002, BR-003 / FR-004 | — | [Mockup 18 — Admin doctors](../../docs/design/mockups/v1/mockups/18-admin-doctors.html); [Mockup 31 — Reassign branches](../../docs/design/mockups/v1/mockups/31-admin-doctors-reassign.html) |
| E1-S4 | F-19 | BR-004 / FR-005 | Scenario 11 | [Mockup 19 — Admin receptionists](../../docs/design/mockups/v1/mockups/19-admin-receptionists.html) |
| E2-S1 | F-06 | BR-006…009, BR-012 / FR-008…011, FR-010 | Scenario 6 | [Mockup 09 — Doctor schedule](../../docs/design/mockups/v1/mockups/09-doctor-schedule.html) |
| E2-S2 | F-07 | BR-010, BR-011, BR-054 / FR-012, FR-013 | Scenario 7 | [Mockup 10 — Doctor block time](../../docs/design/mockups/v1/mockups/10-doctor-block-time.html) |
| E2-S3 | F-08 | BR-014…017 / FR-006, FR-007 | — | [Mockup 11 — Appointment types](../../docs/design/mockups/v1/mockups/11-appointment-types.html) |
| E2-S4 | (negative) | PRD §2.2 | — | — |
| E3-S1 | (engine) | BR-012…019 / FR-014…019, FR-017, FR-018, FR-030 | Scenarios 4, 5 | [Mockup 03 — Availability calendar](../../docs/design/mockups/v1/mockups/03-availability-calendar.html) |
| E3-S2 | F-01 | BR-022…027 / FR-020…026, FR-022, FR-024 | Scenarios 1, 2, 3 | [Mockup 01 — Layout direction](../../docs/design/mockups/v1/mockups/01-layout-direction.html); [Mockup 02 — Doctor picker](../../docs/design/mockups/v1/mockups/02-doctor-picker.html); [Mockup 04 — Patient confirmation](../../docs/design/mockups/v1/mockups/04-patient-confirm.html) |
| E3-S3 | F-02 | BR-027 / FR-023 | — | [Mockup 01 — Layout direction](../../docs/design/mockups/v1/mockups/01-layout-direction.html) |
| E3-S4 | F-13 | BR-019, BR-031, BR-033 / FR-019, FR-027, FR-029 | — | [Mockup 14 — Receptionist create](../../docs/design/mockups/v1/mockups/14-recep-create.html) |
| E3-S5 | F-15 | §2.3, §5 | — | [Mockup 16 — Receptionist availability](../../docs/design/mockups/v1/mockups/16-recep-availability.html) |
| E4-S1 | F-03 | BR-029, BR-030 / FR-031, FR-032 | Scenario 13 | [Mockup 21 — Patient OTP](../../docs/design/mockups/v1/mockups/21-patient-otp-modal.html) |
| E4-S2 | F-04 | BR-035, BR-038, BR-053 / FR-033, FR-050 | Scenario 14 | [Mockup 22 — Patient cancel confirmation](../../docs/design/mockups/v1/mockups/22-patient-cancel-confirm.html); [Mockup 05 — Patient self-service](../../docs/design/mockups/v1/mockups/05-patient-self-service.html) |
| E4-S3 | F-05 | BR-041…045 / FR-039…043, FR-040 | Scenarios 8, 9 | [Mockup 20 — Patient reschedule](../../docs/design/mockups/v1/mockups/20-patient-reschedule.html); [Mockup 05 — Patient self-service](../../docs/design/mockups/v1/mockups/05-patient-self-service.html) |
| E4-S4 | (deep link) | UX-FLOWS F-03 trigger | — | — |
| E5-S1 | F-10 (mark) | BR-039, BR-040 / FR-036, FR-037 | — | [Mockup 12 — Mark appointment status](../../docs/design/mockups/v1/mockups/12-mark-status.html) |
| E5-S2 | F-10 (cancel) | BR-037 / FR-035 | — | [Mockup 25 — Doctor cancel reason](../../docs/design/mockups/v1/mockups/25-doctor-cancel-reason.html) |
| E5-S3 | F-14 | BR-036 / FR-034 | — | [Mockup 15 — Receptionist cancel](../../docs/design/mockups/v1/mockups/15-recep-cancel.html) |
| E5-S4 | F-12 | BR-063 | Scenario 11 | [Mockup 13 — Receptionist today](../../docs/design/mockups/v1/mockups/13-recep-today.html) |
| E5-S5 | (negative) | FR-038 | Scenario 15 | — |
| E6-S1 | F-11 | BR-047…053 / FR-044…050, FR-019 | Scenario 10 | [Mockup 07 — Recurring preview](../../docs/design/mockups/v1/mockups/07-recurring-preview.html); [Mockup 23 — Recurring confirmation](../../docs/design/mockups/v1/mockups/23-recurring-confirm.html) |
| E6-S2 | F-09 | BR-054…058 / FR-011, §4.7 | — | [Mockup 06 — Resolve affected](../../docs/design/mockups/v1/mockups/06-resolve-affected.html); [Mockup 24 — Resolve one](../../docs/design/mockups/v1/mockups/24-doctor-resolve-one.html) |
| E6-S3 | (admin counterpart) | BR-060…062 / §4.6 | — | [Mockup 08 — Branch-hours impact](../../docs/design/mockups/v1/mockups/08-branch-hours-impact.html) |
| E6-S4 | (recurring sibling) | FR-049, FR-050, UX §4.7 | — | [Mockup 33 — Per-occurrence recurring cancel](../../docs/design/mockups/v1/mockups/33-recurring-occurrence-cancel.html) |
| E7-S1 | (horizontal) | [DESIGN-SYSTEM.md §2–6](../../docs/design/DESIGN-SYSTEM.md#2-color-tokens) | — | [Design system reference](../../docs/design/design-system.html); [Shared CSS](../../docs/design/mockups/v1/imports/app/design-system.css) |
| E7-S2 | (horizontal) | FR-051 / NFR-005 | — | [Mockup 27 — Admin audit log](../../docs/design/mockups/v1/mockups/27-admin-audit-log.html); [Mockup 30 — Doctor audit drawer](../../docs/design/mockups/v1/mockups/30-doctor-audit-drawer.html) |
| E7-S3 | (horizontal) | FR-022, FR-031, FR-032 / NFR-007 | — | [Mockup 05 — Patient self-service](../../docs/design/mockups/v1/mockups/05-patient-self-service.html) |
| E7-S4 | (horizontal) | UX §8 | — | [Mockup 29 — Conflict modal](../../docs/design/mockups/v1/mockups/29-conflict-modal.html) |
| E7-S5 | (horizontal) | WCAG 2.1 AA | — | [Design system reference](../../docs/design/design-system.html); [Mockup 29 — Conflict modal](../../docs/design/mockups/v1/mockups/29-conflict-modal.html) |
| E7-S6 | (horizontal) | UX-FLOWS §6.4 | — | [Mockup 01 — Layout direction](../../docs/design/mockups/v1/mockups/01-layout-direction.html) |
| E7-S7 | (horizontal) | UX-FLOWS §6.2, Arch principle 2 | — | — |
| E7-S8 | (horizontal) | NFR-008, NFR-009, NFR-010 | — | — |
| E7-S9 | (horizontal) | PRD §16 | — | — |
| E7-S10 | (parking lot) | UX-FLOWS §7 | — | — |

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
10. ✓ Doctor and receptionist permissions enforced — E1-S3, E1-S4, E3-S4, E5-S4 (Scenario 11)
11. ✓ Recurring appointments work with partial conflicts — E6-S1 (Scenario 10)
12. ✓ Schedule changes cannot silently invalidate appointments — E2-S1, E1-S2 (Scenario 6)
13. ✓ Appointment statuses work correctly — E5-S1, E5-S2, E5-S3
14. ✓ Audit records generated — E7-S2
15. ✓ No payment or medical-record functionality — out of scope

All 15 MVP criteria are covered by the story set above.

### PRD §15 acceptance-scenario coverage

| Scenario | Story |
|---|---|
| 1 — Successful booking | E3-S2 |
| 2 — Same-day booking | E3-S2 |
| 3 — Double booking | E3-S2 |
| 4 — Patient conflict | E3-S1, E4-S2 |
| 5 — Doctor conflict | E3-S1 |
| 6 — Schedule change | E2-S1 |
| 7 — Blocked period | E2-S2 |
| 8 — Patient rescheduling | E4-S3 |
| 9 — Rescheduling race | E4-S3 |
| 10 — Recurring booking | E6-S1 |
| 11 — Receptionist access | E1-S4, E3-S4, E5-S4 |
| 12 — Doctor access | E5-S4 (own only), E6-S2 (own only) |
| 13 — Patient OTP | E4-S1 |
| 14 — Cancellation | E4-S2, E5-S2, E5-S3, E6-S4 |
| 15 — No deletion | E5-S5 |

---

## Change log

- **2026-09-08** — Gap analysis pass against `docs/specs/PRD.md` + `docs/specs/UX-FLOWS.md`.
  - Added **E0** (bootstrap & platform) with 6 stories covering greenfield repo, data model, auth wiring, SMS gateway, seed data, observability.
  - Added **E1-S0** (clinic management) for FR-001.
  - Split **E3-S2** (F-01 first-time) and added **E3-S3** (F-02 returning), **E3-S4** (F-13 receptionist create), **E3-S5** (F-15 receptionist availability).
  - Added **E2-S4** negative-capability test (doctor cannot reschedule ordinary appointments).
  - Added **E4-S4** (deep-link entry to cancel/reschedule).
  - Added **E5-S5** (no deletion, Scenario 15).
  - Added **E6-S4** (per-occurrence recurring cancel/reschedule, FR-049/050).
  - Added **E7-S7** (no tentative client-side holds, UX-FLOWS §6.2).
  - Added **E7-S8** (performance / availability / consistency SLAs, NFR-008/009/010).
  - Added **E7-S9** (product metrics, PRD §16).
  - Added **E7-S10** (UX-FLOWS §7 design open questions parking lot).
  - Sharpened ACs throughout: phone-uniqueness FR-022, immediate confirmation FR-024, FR-017 partial-time, FR-018 fixed-window tooltip, FR-027 same-doctor future, FR-030 back-to-back, FR-040 doctor-locked reschedule, FR-048 full skip-reason list, audit metadata per F-05 / F-09, branch-hours "doctor no longer at branch" edge case (F-17), doctor-initiated conflict move `action = "moved_by_doctor"` (F-09), audit audience per role.
  - Fixed header note: `S-<epic>-<n>` → `E<n>-S<m>` to match actual IDs.
  - Replaced the traceability table and added a PRD §15 scenario → story coverage matrix.
  - **2026-09-08 (later):** Audited every story for a related design link. **30 / 43 stories have one; 13 do not.** The 13 are listed in the "Stories needing design" table below for the design team to address.
- **2026-09-08 (UX pass):** Built the 2 needed mockups:
  - `docs/design/mockups/v1/mockups/32-admin-clinic-settings.html` (E1-S0)
  - `docs/design/mockups/v1/mockups/33-recurring-occurrence-cancel.html` (E6-S4)
  Both use the canonical SVG logo (matching all 31 existing pages) and are wired into `shell.js` as `/admin/clinic` and `/patient/recurring-cancel`. **Design coverage is now 32 / 43.**

---

## Stories needing design (design-link audit, 2026-09-08)

| Story | Title | UI surface | Reason missing | Suggested mockup(s) |
|---|---|---|---|---|
| E0-S1 | Repo skeleton + starter template | none | Backend / devops — no UI | n/a |
| E0-S2 | Data model & migrations | none | Backend — no UI | n/a |
| E0-S3 | Auth provider wiring | Login forms | Login / sign-in screens exist but aren't linked here | reference existing auth UI in `docs/design/mockups/` (not in v1/mockups) — confirm path |
| E0-S4 | SMS OTP gateway | none (uses E4-S1 modal) | Backend | inherits `Mockup 21 — Patient OTP` |
| E0-S5 | Seed data + role fixtures | none | Tooling | n/a |
| E0-S6 | Observability baseline | DevOps dashboard (out of MVP scope) | Backend | n/a |
| E1-S0 | Clinic management (single-clinic anchor) | Admin clinic settings screen | No mockup exists yet | **needs new mockup** — propose `mockup-32-admin-clinic-settings.html` (clinic name + counts panel) |
| E2-S4 | Negative-capability: doctor cannot reschedule ordinary appointments | none (negative test) | This is a test, not a UI flow | inherit `Mockup 25 — Doctor cancel reason` + `Mockup 24 — Resolve one` |
| E4-S4 | Deep-link entry to cancel/reschedule | Same as cancel / reschedule screens | Reuses existing screens | inherit `Mockup 22 — Patient cancel confirmation` and `Mockup 20 — Patient reschedule` |
| E5-S5 | No deletion (negative test) | none (negative test) | This is a test, not a UI flow | n/a |
| E6-S4 | Per-occurrence recurring cancel / reschedule | Reuses cancel / reschedule but with **per-occurrence identification** | Mockups 22 / 20 don't show per-occurrence treatment | **needs new mockup** — propose `mockup-33-recurring-occurrence-cancel.html` showing which occurrence was selected |
| E7-S7 | No tentative client-side slot holds | Behavioral rule, surfaces in the calendar + conflict modal | Already covered by E3-S1 and E7-S4 mockups | inherit `Mockup 03 — Availability calendar` and `Mockup 29 — Conflict modal` |
| E7-S8 | Performance & availability SLAs | none | Non-functional | n/a |
| E7-S9 | Product metrics instrumentation | none (Grafana dashboard in repo) | Backend | n/a |
| E7-S10 | Design open questions parking lot | none | Meta | n/a |

**Net design work needed:** **2 new mockups** (E1-S0 clinic settings, E6-S4 per-occurrence cancel). For the rest, the design link is either genuinely not applicable (backend / negative tests / non-functional) or can be inherited from an existing surface.

**Update (2026-09-08, later):** Both new mockups have been built and linked.

- **Mockup 32** → `docs/design/mockups/v1/mockups/32-admin-clinic-settings.html`
- **Mockup 33** → `docs/design/mockups/v1/mockups/33-recurring-occurrence-cancel.html`

Both use the canonical SVG logo (matching all 31 existing pages). Both are wired into `docs/design/mockups/v1/imports/app/shell.js` (routes `/admin/clinic` and `/patient/recurring-cancel`) and surface in the quick-jump dropdown. Design coverage is now **32 / 43 stories**.

---

**Next step:** `bmad-sprint-planning` — readiness gate + initial sprint status from these epics.
