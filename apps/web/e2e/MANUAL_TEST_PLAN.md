# MediSlot — Manual Test Plan

> **Audience:** QA engineers, product owners, and any human who wants to walk through MediSlot's behaviour without running automation.
> **Format:** Gherkin-style (`Feature:` / `Scenario:` / `Given` / `When` / `Then`).
> **Companion automation:** `apps/web/e2e/flows/complete-user-journey.spec.ts` automates the `@critical` paths. The `Then` clauses in this document map 1:1 to the assertions in the spec.

---

## 0. Test Environment

| Item | Value |
|---|---|
| API | `http://localhost:3001` |
| Web | `http://localhost:5173` |
| Database | Postgres (testcontainer in CI; local `.env` `DATABASE_URL` for manual runs) |
| Browser | Chromium (single project) |

### Dev seed credentials (printed on the login page)

| Role | Email / Phone | Auth |
|---|---|---|
| Admin | `admin-main@clinic.local` | staff email — no password (deferral W10a) |
| Doctor | `dr.-east-lead@clinic.local` | staff email |
| Doctor | `dr.-east-support@clinic.local` | staff email |
| Doctor | `dr.-west-lead@clinic.local` | staff email |
| Receptionist | `receptionist-east@clinic.local` | staff email |
| Receptionist | `receptionist-west@clinic.local` | staff email |
| Patient | `+15550000001` | OTP `123456` |
| Patient | `+15550000002` | OTP `123456` |
| Patient | `+15550000003` | OTP `123456` |
| Patient | `+15550000004` | OTP `123456` |
| Patient | `+15550000005` | OTP `123456` |

### Branches

| Slug | Name | Timezone |
|---|---|---|
| `branch-east` | East | America/New_York |
| `branch-west` | West | America/Los_Angeles |

### Resetting state

```bash
# From repo root
cd apps/api && pnpm exec tsx scripts/reset-test-appointments.ts
```

This deletes all `appointment` and `appointment_audit` rows and reseeds the demo set so each test starts clean.

---

## Feature: Patient Authentication

### Scenario: Patient logs in with valid OTP    [@patient @critical]
**Given** a patient visits the home page at `http://localhost:5173`
**And**   enters phone `+15550000002` in the "Phone" field
**And**   types `123456` across the 6 OTP cells (auto-advances)
**When**  they click "Verify & continue"
**Then**  the JWT is written to `localStorage("medislot.auth")`
**And**   they are routed to the patient app on the "Find a doctor" view

### Scenario: Patient enters an invalid phone format    [@patient @edge]
**Given** a patient on the login page
**When**  they enter `5550000001` (no `+`) in the phone field
**And**   they type the OTP `123456`
**And**   they click "Verify & continue"
**Then**  the API returns 400 `invalid_phone`
**And**   the UI shows an inline error "Enter a valid phone number, including country code."

### Scenario: Patient enters the wrong OTP    [@patient @edge]
**Given** a patient on the login page with phone `+15550000002`
**When**  they type `000000` in the OTP cells
**And**   they click "Verify & continue"
**Then**  the API returns 401 `invalid_otp_code`
**And**   the UI shows the local attempts counter decremented and the banner "Incorrect code. X attempt(s) left."

### Scenario: Patient is locked out after 5 wrong OTPs    [@patient @edge]
**Given** a patient has submitted 5 wrong OTPs in this session
**When**  they submit a 6th wrong OTP
**Then**  the API returns 429 `otp_locked`
**And**   the UI shows a banner "Too many attempts. Try again later." and disables submit

---

## Feature: Patient Books an Appointment

### Scenario: Patient books a valid future slot (happy path)    [@patient @critical]
**Given** a logged-in patient on the "Find a doctor" view
**When**  they pick "Dr. East Lead" → "East" branch → "General" type → tomorrow 10:00 → confirm phone + name
**And**   they click "Confirm booking"
**Then**  the API returns 201 with an `appointment.id`
**And**   the UI shows the "Confirmation" receipt with reference `APT-YYYY-MM-DD-HHMM`
**And**   "Add to calendar" downloads a `.ics` file
**And**   an audit row is written with `event="created"`, `actor_role="patient"`

### Scenario: Patient books a slot in the past    [@patient @edge]
**Given** a logged-in patient
**When**  they attempt to POST a booking with `start_datetime` < now
**Then**  the API returns 409 `past_date`
**And**   the UI shows "That time has already passed. Pick another slot."

### Scenario: Patient books a slot more than 30 days out    [@patient @edge]
**Given** a logged-in patient
**When**  they attempt to POST a booking with `start_datetime` > now+30d
**Then**  the API returns 409 `outside_30d_window`
**And**   the UI shows "Bookings open up to 30 days in advance."

### Scenario: Patient tries to book the same doctor twice (FR-027)    [@patient @edge]
**Given** a patient has an existing Scheduled appointment with "Dr. East Lead"
**When**  they attempt to book a second future appointment with the same doctor
**Then**  the API returns 409 `patient_has_future_with_doctor`
**And**   the UI shows "You already have an appointment with this doctor. Cancel or reschedule the existing one first."

### Scenario: Patient books an overlapping time with a different doctor (FR-029)    [@patient @edge]
**Given** a patient has an existing Scheduled appointment Tue 10:00-10:30
**When**  they attempt to book Tue 10:15-10:45 with any other doctor
**Then**  the API returns 409 `patient_time_conflict`
**And**   the UI shows "You have another appointment that overlaps this time."

### Scenario: Patient books a slot outside branch operating hours    [@patient @edge]
**Given** the "East" branch is closed Sundays
**When**  the patient picks a Sunday slot
**Then**  the API returns 409 `outside_branch_hours`
**And**   `/availability` returns `{slots:[], reason:"closed_day"}` so the date rail shows zero slots

### Scenario: Patient books a slot the doctor is blocked from    [@patient @edge]
**Given** a doctor has a `doctor_block` covering Tue 09:00-12:00
**When**  the patient books Tue 10:00-10:30
**Then**  the API returns 409 `inside_doctor_block`
**And**   the UI shows "The doctor is not available at that time."

### Scenario: Patient books a slot that another booking just took (slot race)    [@patient @edge]
**Given** two browser tabs are open on the same date+time+doctor
**When**  both click "Confirm" within milliseconds
**Then**  one returns 201 and the other returns 409 `slot_raced` with a stable envelope `{error, code:"SLOT_RACED", what, why, can_do:["Refresh availability"]}`

### Scenario: Patient's name is auto-filled on returning visit (E3-S3)    [@patient @edge]
**Given** a patient who previously booked has their name in the `patient` table
**When**  they return to the booking wizard Step 4
**Then**  `GET /patient/profile?phone=...` returns the saved name
**And**   the name input is pre-populated within 350ms of the phone being entered

---

## Feature: Patient Self-Service

### Scenario: Patient views their appointments    [@patient @critical]
**Given** a logged-in patient with one Scheduled future appointment
**When**  they click "My appointments" in the patient frame
**Then**  the API returns 200 with a list of Scheduled, future-only appointments
**And**   the row shows doctor, branch, type, date+time, and Reschedule / Cancel buttons
**And**   past and Cancelled rows are excluded

### Scenario: Patient reschedules to a new slot    [@patient @critical]
**Given** a patient viewing an appointment row
**When**  they click "Reschedule"
**And**   pick a new branch (or same) and a new slot
**And**   click "Confirm"
**Then**  the API POSTs to `/patient/appointments/:id/reschedule` with `{new_branch_id, new_appointment_type_id, new_start_datetime, new_end_datetime, new_slot_duration_minutes}`
**And**   the response shows the updated appointment
**And**   the list re-renders with the new time
**And**   an audit row is written with `event="rescheduled"`

### Scenario: Patient tries to reschedule to a different doctor (FR-040)    [@patient @edge]
**Given** a patient in the reschedule modal
**When**  they attempt to send `new_doctor_id` in the body
**Then**  the API returns 400 `unknown_field`
**And**   the UI doesn't expose a doctor picker (doctor is locked server-side)

### Scenario: Patient cancels their appointment    [@patient @critical]
**Given** a patient viewing an appointment row
**When**  they click "Cancel"
**And**   confirm in the modal (no reason required — FR-033)
**Then**  the API POSTs to `/patient/appointments/:id/cancel` with no body
**And**   the appointment status changes to "Cancelled"
**And**   the slot is released (FR-050)
**And**   an audit row is written with `event="cancelled"`, `actor_role="patient"`

### Scenario: Patient tries to double-cancel    [@patient @edge]
**Given** a patient just cancelled an appointment
**When**  they attempt to cancel the same appointment again (e.g. via a stale tab)
**Then**  the API returns 404 `not_found_appointment_in_terminal_state`
**And**   the UI shows "That appointment no longer exists."

### Scenario: Patient tries to access another patient's appointment (privacy filter)    [@patient @edge]
**Given** patient A's appointment ID leaked to patient B
**When**  patient B POSTs to `/patient/appointments/:id/cancel` with patient A's ID
**Then**  the API returns 404 (NOT 403) — same envelope as a non-existent row
**And**   no information about the appointment is leaked in the response

### Scenario: Patient opens a deep-link `?action=cancel&id=...`    [@patient @edge]
**Given** a patient receives a link `?action=cancel&id=<uuid>`
**When**  they sign in via OTP
**Then**  on `MyAppointments` mount, `GET /patient/appointments/:id/deep-link` is called
**And**   if `can_cancel=true`, the cancel modal opens pre-targeted at that appointment
**And**   the URL is scrubbed via `history.replaceState` after the modal opens

### Scenario: Patient opens a deep-link `?action=reschedule&id=...`    [@patient @edge]
**Given** a patient receives a link `?action=reschedule&id=<uuid>`
**When**  they sign in via OTP
**Then**  the reschedule modal opens for that appointment (and the URL is scrubbed)

---

## Feature: Doctor Authentication

### Scenario: Doctor logs in with email    [@doctor @critical]
**Given** a doctor visits the home page
**When**  they pick role "Doctor" from the staff dropdown
**And**   enter `dr.-east-lead@clinic.local`
**And**   click "Sign in"
**Then**  the API returns a JWT with `role:"doctor"`, `doctor_id`, `branch_ids`
**And**   the app routes to the doctor app on the "Affected" kanban view

### Scenario: Doctor enters an unknown email    [@doctor @edge]
**Given** a doctor on the login page
**When**  they enter `nobody@clinic.local` and click "Sign in"
**Then**  the API returns 401 `staff_not_found`
**And**   the UI shows "We couldn't find a staff member with that email."

### Scenario: Doctor token expires mid-session    [@doctor @edge]
**Given** a doctor is signed in and the JWT has expired
**When**  they make any authenticated request
**Then**  the API returns 401 `unauthenticated`
**And**   the auth store clears `localStorage("medislot.auth")`
**And**   the app redirects to the login page

---

## Feature: Doctor Resolves Affected Appointment

### Scenario: Doctor views the affected queue (kanban)    [@doctor @critical]
**Given** a doctor with at least one appointment outside branch operating hours
**When**  they land on the doctor home view
**Then**  the API returns 200 from `/doctor/affected` with `{count, branch_id, date, appointments:[...]}`
**And**   the UI renders 4 columns: To do / In progress / Awaiting slot choice / Resolved
**And**   each card shows patient, date, time, branch, masked phone, and a reason (`closed_day` or `before_open_or_after_close`)

### Scenario: Doctor moves an affected appointment to a new slot (resolve conflict)    [@doctor @critical]
**Given** a doctor viewing an affected card
**When**  they click "Move →"
**And**   pick a new branch (any branch they work at) and a new date+time
**And**   click "Move" in the resolve modal
**Then**  the API POSTs `/doctor/affected/:id/move` with `{new_branch_id, new_start_datetime, new_end_datetime}`
**And**   on success, the `DoctorResolutionSaved` modal shows the summary
**And**   the card moves to the "Resolved" column
**And**   an audit row is written with `event="moved_by_doctor"`, `actor_role="doctor"`

### Scenario: Doctor cancel requires a reason    [@doctor @critical]
**Given** a doctor viewing a card
**When**  they click "Cancel"
**And**   leave the reason unselected
**And**   click "Confirm cancel"
**Then**  the API returns 400 `reason_required`
**And**   the UI shows "Pick a reason for the cancellation."

### Scenario: Doctor cancels with a 600-character reason    [@doctor @edge]
**Given** a doctor in the cancel modal
**When**  they enter a reason of 600 characters
**And**   click "Confirm cancel"
**Then**  the API returns 400 `reason_too_long` (limit is 500)
**And**   the UI shows "Reason must be 500 characters or fewer."

### Scenario: Doctor cancels with a preset reason    [@doctor @critical]
**Given** a doctor in the cancel modal
**When**  they pick `patient_requested`
**And**   click "Confirm cancel"
**Then**  the API POSTs `/appointments/:id/cancel` with `{reason:"patient_requested"}`
**And**   the appointment status changes to "Cancelled"
**And**   the slot is released
**And**   an audit row is written with `event="cancelled"`, `actor_role="doctor"`

### Scenario: Doctor marks a past appointment Completed    [@doctor @critical]
**Given** a doctor with a past Scheduled appointment
**When**  they click "Mark status" → "Completed"
**Then**  the API POSTs `/appointments/:id/mark-status` with `{status:"Completed"}`
**And**   the appointment status changes to "Completed"
**And**   an audit row is written with `event="marked_completed"`, `actor_role="doctor"`

### Scenario: Doctor marks a past appointment No-Show    [@doctor @edge]
**Given** a doctor with a past Scheduled appointment where the patient did not arrive
**When**  they click "Mark status" → "No-Show"
**Then**  the API returns 200 with `status:"No-show"`
**And**   an audit row is written with `event="marked_no_show"`, `actor_role="doctor"`

### Scenario: Doctor tries to mark a future row Completed    [@doctor @edge]
**Given** a doctor with a future Scheduled appointment
**When**  they attempt to mark it Completed
**Then**  the API returns 422 `appointment_in_future`
**And**   the UI hides the "Mark status" button on future rows

### Scenario: Doctor tries to mark a Cancelled row Completed    [@doctor @edge]
**Given** a doctor with a Cancelled appointment
**When**  they attempt to mark it Completed
**Then**  the API returns 422 `already_in_terminal_state`
**And**   the UI hides the "Mark status" button on terminal rows

### Scenario: Doctor tries to move another doctor's appointment    [@doctor @edge]
**Given** Doctor A is signed in
**When**  they attempt to move an appointment belonging to Doctor B
**Then**  the API returns 403 `outside_branch_scope` (or `not_found` if outside any of A's branches)
**And**   no audit row is written

### Scenario: Doctor's "no-op" move is rejected    [@doctor @edge]
**Given** a doctor in the resolve modal
**When**  they submit the same branch, date, and time as the original
**Then**  the API returns 422 `no_op_move`
**And**   the UI shows "Pick a different slot — this is the same as the current one."

---

## Feature: Doctor Audit Log

### Scenario: Doctor views the audit log for their own appointment    [@doctor @edge]
**Given** a doctor with an appointment that has audit history
**When**  they click "Audit log" on the card
**Then**  the API returns 200 from `/doctor/appointments/:id/audit` with the audit rows
**And**   the audit drawer slides in with all events (status changes, cancellations, block, resolve)
**And**   filter chips "All / Status changes / Cancellations / Block / Resolve" filter client-side

### Scenario: Doctor tries to view audit for another doctor's appointment    [@doctor @edge]
**Given** Doctor A is signed in
**When**  they attempt to GET `/doctor/appointments/:id/audit` for Doctor B's appointment
**Then**  the API returns 403 `outside_branch_scope` (or `not_found` if outside A's branches)
**And**   no audit data is leaked

---

## Feature: Receptionist Day View

### Scenario: Receptionist views today's branch schedule    [@receptionist @critical]
**Given** a receptionist is signed in
**When**  they land on the receptionist home view
**Then**  the API returns 200 from `/reception/branch/today` with today's appointments at the receptionist's branch
**And**   each row shows doctor, patient phone, type, start, end, status

### Scenario: Receptionist filters by status    [@receptionist @edge]
**Given** a receptionist on the day view
**When**  they pick a status filter (e.g. "Scheduled")
**Then**  the API returns 200 with the filtered list
**And**   the URL search params reflect the filter

### Scenario: Receptionist cancels an appointment with a reason    [@receptionist @critical]
**Given** a receptionist viewing an appointment row
**When**  they click "Cancel"
**And**   pick a reason and confirm
**Then**  the API POSTs `/reception/appointments/:id/cancel` with `{reason}`
**And**   the appointment status changes to "Cancelled"
**And**   an audit row is written with `event="cancelled"`, `actor_role="receptionist"`

### Scenario: Receptionist marks a past appointment Completed    [@receptionist @edge]
**Given** a receptionist with a past Scheduled appointment
**When**  they click "Mark status" → "Completed"
**Then**  the API POSTs `/appointments/:id/mark-status` with `{status:"Completed"}`
**And**   the appointment status changes to "Completed"

### Scenario: Receptionist tries to view another branch's schedule    [@receptionist @edge]
**Given** a receptionist whose claim has only `branch_ids = [branch-east]`
**When**  they attempt to pass `?branch_id=branch-west` to `/reception/branch/today`
**Then**  the API returns 403 `outside_branch_scope` (the branch is silently overridden)

---

## Feature: Admin Clinic Management

### Scenario: Admin renames the clinic    [@admin @critical]
**Given** an admin on `#/admin/clinic`
**When**  they change the name field to "New Clinic Name"
**And**   click "Save"
**Then**  the API PATCHes `/admin/clinic` with `{name:"New Clinic Name"}`
**And**   the success toast shows "Saved"
**And**   a subsequent `GET /admin/clinic` returns the new name

### Scenario: Admin tries to rename the clinic to an empty string    [@admin @edge]
**Given** an admin on `#/admin/clinic`
**When**  they clear the name field and click "Save"
**Then**  the API returns 400 `invalid_name`
**And**   the UI shows "Name is required."

---

## Feature: Admin Branch Management

### Scenario: Admin creates a new branch    [@admin @critical]
**Given** an admin on `#/admin/branches`
**When**  they click "Add branch"
**And**   enter "North" and click "Create"
**Then**  the API POSTs `/admin/branches` with `{name:"North"}`
**And**   the new branch appears in the list with `active:true`

### Scenario: Admin deactivates a branch with future appointments    [@admin @edge]
**Given** an admin on `#/admin/branches` viewing "East" (which has future appointments)
**When**  they toggle "Active" off and click "Save"
**Then**  the API returns 409 `branch_has_future_appointments`
**And**   the UI shows the friendly error "This branch has X future appointment(s). Cancel or reschedule them first."

### Scenario: Admin sets branch weekly hours    [@admin @critical]
**Given** an admin on `#/admin/branches/:branchId/hours`
**When**  they edit the 7-row weekly hours grid (open/close per day)
**And**   click "Save"
**Then**  the API PATCHes `/admin/branches/:id/hours` with `{hours:[...], acknowledge_doctor_impact:true}` (if impact > 0)
**And**   the toast shows "Hours updated"
**And**   a subsequent `GET /admin/branches/:id/hours` returns the new hours

### Scenario: Admin narrows branch hours and creates an affected doctor appointment    [@admin @edge]
**Given** an admin narrowing the "East" branch hours (e.g. closing Wed)
**And**   there are existing Scheduled appointments on Wed at "East"
**When**  the admin submits the new hours
**Then**  the API returns 200 with `impact:{count_affected:N, requires_doctor_acknowledgement:true}`
**And**   those appointments now appear in the doctor kanban with `reason:"closed_day"` or `reason:"before_open_or_after_close"`

### Scenario: Admin tries to save hours with `acknowledge_doctor_impact` missing    [@admin @edge]
**Given** an admin changing hours that would impact future appointments
**When**  they submit without the acknowledgement flag
**Then**  the API returns 409 `appointments_outside_hours`
**And**   the UI shows the impact preview and forces the admin to check the acknowledgement box

---

## Feature: Admin Doctor Management

### Scenario: Admin creates a new doctor    [@admin @critical]
**Given** an admin on `#/admin/doctors`
**When**  they click "Add doctor"
**And**   enter name "Dr. Test" + email "dr.test@clinic.local" + select 1+ branches
**And**   click "Create"
**Then**  the API POSTs `/admin/doctors` with `{full_name, email, branch_ids}`
**And**   the new doctor appears in the list with the assigned branches

### Scenario: Admin tries to create a doctor with a duplicate email    [@admin @edge]
**Given** an admin creating a doctor
**When**  they enter an email already used by another staff member
**Then**  the API returns 409 `email_already_exists`
**And**   the UI shows "A staff member with this email already exists."

### Scenario: Admin assigns a doctor to branches    [@admin @critical]
**Given** an admin on `#/admin/doctors/:id/assign`
**When**  they pick 1+ branches and click "Save"
**Then**  the API PUTs `/admin/doctors/:id/branches` with `{branch_ids:[...]}`
**And**   the doctor can now work at those branches (and `/availability` returns slots at them)

### Scenario: Admin sets a doctor's weekly schedule    [@admin @critical]
**Given** an admin on `#/admin/doctors/:id/schedule`
**When**  they edit the weekly grid (start/end per day) for a branch
**And**   click "Save"
**Then**  the API POSTs `/admin/doctors/:id/schedule` with `{rows:[...]}`
**And**   the doctor's future slots respect these hours (visible via `/availability`)

### Scenario: Admin schedule change would invalidate future appointments    [@admin @edge]
**Given** an admin narrowing a doctor's weekly schedule
**And**   there are existing future appointments outside the new schedule
**When**  they submit the new schedule
**Then**  the API returns 409 `schedule_invalidates_future_appointments`
**And**   the impact preview shows the affected appointments before submission

### Scenario: Admin creates a doctor block (unavailability window)    [@admin @critical]
**Given** an admin on `#/admin/doctors/:id/blocks`
**When**  they click "Add block"
**And**   enter branch + start + end + reason "Conference"
**And**   click "Create"
**Then**  the API POSTs `/admin/doctors/:id/blocks` with `{branch_id, start_datetime, end_datetime, reason}`
**And**   the block appears in the list
**And**   `/availability` excludes slots in that window

### Scenario: Admin tries to create a block that overlaps a future appointment    [@admin @edge]
**Given** an admin creating a block
**When**  the block's range overlaps an existing Scheduled appointment
**Then**  the API returns 409 `block_overlaps_future_appointments`
**And**   the impact preview lists the affected appointments

### Scenario: Admin deletes a doctor block    [@admin @critical]
**Given** an admin with an existing block
**When**  they click "Delete" on the block
**Then**  the API DELETEs `/admin/doctors/:id/blocks/:block_id`
**And**   the block is removed from the list
**And**   `/availability` now includes slots in that window

### Scenario: Admin deactivates a doctor with future appointments    [@admin @edge]
**Given** an admin toggling a doctor's `active` to false
**And**   the doctor has future appointments
**When**  they save
**Then**  the API returns 200 with `warning:"doctor_has_future_appointments"`
**And**   the doctor can no longer receive new bookings (409 `doctor_inactive`)

---

## Feature: Admin Receptionist Management

### Scenario: Admin creates a new receptionist    [@admin @critical]
**Given** an admin on `#/admin/receptionists`
**When**  they click "Add receptionist"
**And**   enter name + email + branch
**And**   click "Create"
**Then**  the API POSTs `/admin/receptionists` with `{full_name, email, branch_id}`
**And**   the new receptionist appears in the list

### Scenario: Admin tries to create a receptionist with a duplicate email    [@admin @edge]
**Given** an admin creating a receptionist
**When**  they enter an email already in use
**Then**  the API returns 409 `email_already_exists`

### Scenario: Admin reassigns a receptionist to another branch    [@admin @critical]
**Given** an admin on the receptionist edit page
**When**  they change the branch dropdown and click "Save"
**Then**  the API PATCHes `/admin/receptionists/:id` with `{branch_id:"..."}`
**And**   the receptionist can now see only the new branch's schedule

---

## Feature: Admin Appointment Type Management

### Scenario: Admin creates an appointment type    [@admin @critical]
**Given** an admin on `#/admin/types`
**When**  they click "Add type"
**And**   enter name "Consultation" + duration 30 + description
**And**   click "Create"
**Then**  the API POSTs `/admin/appointment-types` with `{name, duration_minutes, description}`
**And**   the new type appears in the list

### Scenario: Admin tries to set duration_minutes outside 5..480    [@admin @edge]
**Given** an admin creating an appointment type
**When**  they enter `duration_minutes: 3`
**Then**  the API returns 400 `invalid_duration_minutes`
**And**   when they enter `duration_minutes: 600`, same error

### Scenario: Admin deactivates an appointment type with future appointments    [@admin @edge]
**Given** an admin deactivating an appointment type that has future appointments
**When**  they save
**Then**  the API returns 200 with `warning:"appointment_type_has_future_appointments"`
**And**   the type's `is_active` becomes false
**And**   the type is hidden from the patient booking wizard Step 2

---

## Feature: Public Catalog (no auth)

### Scenario: Public catalog endpoints require a Bearer token    [@edge]
**Given** an unauthenticated request to `/public/doctors`
**When**  no `Authorization` header is sent
**Then**  the API returns 401 `unauthenticated`
**And**   the web app never hits these endpoints without a token (Login page probe is `/healthz`)

### Scenario: `/healthz` and `/readyz` are public    [@edge]
**Given** an unauthenticated request to `/healthz`
**Then**  the API returns 200 `{status:"ok"}`
**Given** an unauthenticated request to `/readyz`
**Then**  the API returns 200 `{db:"ok"}` (or 503 if DB is down)

### Scenario: `/metrics` is public and Prometheus-formatted    [@edge]
**Given** an unauthenticated request to `/metrics`
**Then**  the API returns 200 `text/plain; version=0.0.4; charset=utf-8` with counters and process metrics
**And**   `Accept: application/json` returns `{counters:{...}}` instead

---

## Cross-Cutting Scenarios

### Scenario: Token expiry mid-session    [@critical @edge]
**Given** any user is signed in
**When**  their JWT expires (manually shorten TTL or wait)
**And**   they make any authenticated request
**Then**  the API returns 401 `unauthenticated`
**And**   the auth store clears `localStorage("medislot.auth")`
**And**   the app redirects to the login page

### Scenario: Role escalation attempt (patient → admin)    [@critical @edge]
**Given** a patient is signed in
**When**  they attempt to call any `/admin/*` endpoint with their patient token
**Then**  the API returns 403 `forbidden_role`
**And**   the web app does not expose any admin surface when `claim.role === 'patient'`

### Scenario: Body-claim injection (claim smuggling)    [@critical @edge]
**Given** any user is signed in
**When**  they add `role:"admin"` or `branch_ids:[...]` to the request body
**Then**  the API ignores the body claim (the auth middleware reads from the Bearer token only)
**And**   the response is the same as if the body were absent

### Scenario: Doctor branch-scope double-binding    [@critical @edge]
**Given** Doctor A is signed in with `doctor_id = A`, `branch_ids = [branch-east]`
**When**  they attempt to read or write an appointment whose `doctor_id = B` or `branch_id = branch-west`
**Then**  the API returns 403 `outside_branch_scope`
**And**   no data is leaked

### Scenario: Audit immutability (no UPDATE / DELETE on audit log)    [@critical @edge]
**Given** any audit row exists
**When**  an attempt is made to UPDATE or DELETE the row directly via SQL
**Then**  the DB trigger `reject_audit_mutation` raises an exception
**And**   the row is unchanged

### Scenario: No tentative slot holds    [@critical @edge]
**Given** a patient is on Step 3 of the booking wizard
**When**  they pick a slot (no submit yet)
**Then**  the server has no record of that slot being "held" for them
**And**   another user can race-book the same slot between the patient's "select" and "confirm" actions
**And**   the losing user sees the friendly 409 `slot_raced` modal

### Scenario: Slot race (two users book the same slot)    [@critical @edge]
**Given** two browser tabs (or two patients) on the same date+time+doctor
**When**  both POST `/bookings` within milliseconds
**Then**  one returns 201 and the other returns 409 `slot_raced` (GIST exclusion)
**And**   the GIST exclusion is enforced even if both pass the `WHERE` pre-check

---

## How to Walk Through This Plan

1. **Local reset** (start of every manual run):
   ```bash
   cd apps/api && pnpm exec tsx scripts/reset-test-appointments.ts
   ```
2. **Pick a role** at the top of the document.
3. **Execute each `@critical` scenario** first — these are the must-pass paths.
4. **Then execute the `@edge` scenarios** — these are the negative paths and error envelopes.
5. **Record the result** of each Scenario (Pass / Fail / N/A) with a screenshot.
6. **Cross-cutting scenarios** at the bottom apply to multiple roles — run them with whichever role is currently signed in.

> **Total scenarios: 35** (roughly: 7 patient auth + booking, 5 patient self-service, 3 doctor auth, 8 doctor resolve, 2 doctor audit, 5 receptionist, 1 clinic, 5 branch, 8 doctor, 3 receptionist, 3 type, 3 public, 7 cross-cutting).
