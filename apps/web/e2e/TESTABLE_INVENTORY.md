# Testable-Feature Inventory — `apps/web` (Playwright E2E plan, PR-1+)

> Scope: every web page, every API endpoint reachable from a logged-in
> session, every seed fixture, and a derived list of NEW E2E specs
> beyond the 8 already shipped in `apps/web/e2e/specs/01..11`.
> Citations are file:line pointers into the source. No code is changed.

## A. Web pages → testable actions

> The web app ships 32 React pages under `apps/web/src/pages/`. Only
> the "live" surfaces (wired to a backend) appear in the matrix below
> with concrete testable actions. Static mock-only screens (F-13,
> F-15, F-17, F-25, F-30, mock 33 cancel-recurring, mock 36 receipt)
> are noted for completeness at the end of the section.

| Page (file) | Testable actions (UI ↔ API) | Source |
|---|---|---|
| `LoginPage.tsx` | • Staff sign-in: `POST /auth/login/staff` with `{role,email}` (dev stub) | `apps/web/src/pages/LoginPage.tsx:14-180` |
| | • Patient OTP: `POST /patient/otp/verify-now` with `{phone,code}` (mock 123456) | `LoginPage.tsx:120-180` |
| `ClinicSettings.tsx` | • Load `GET /admin/clinic` (counts + name) | `ClinicSettings.tsx:1-180` |
| | • `PATCH /admin/clinic` with `{name}`; rejects 1..120 char whitespace-only | `apps/api/src/routes/admin-clinic.ts:160-196` |
| `AdminBranches.tsx` | • List `GET /admin/branches?active=` | `apps/api/src/routes/admin-branches.ts:179-217` |
| | • Create `POST /admin/branches` | `admin-branches.ts:140-176` |
| | • Deactivate 409 `branch_has_future_appointments` per BR-059 | `admin-branches.ts:259-424` |
| `AdminBranchHours.tsx` | • Read `GET /admin/branches/:id/hours` (tz, hours[]) | `apps/api/src/routes/admin-branch-hours.ts:62-115` |
| | • Impact preview `POST /admin/branches/:id/hours-impact` | `admin-branch-hours.ts:118-180` |
| | • Save `PATCH /admin/branches/:id/hours` (acknowledge flag for doctor impact) | `admin-branch-hours.ts:183-468` |
| `AdminDoctors.tsx` | • List/create/patch: `GET/POST/PATCH /admin/doctors` | `apps/api/src/routes/admin-branch-doctors.ts` (see file head `:1-100`) |
| | • Branch assignment `PUT /admin/doctors/:id/branches` | `admin-branch-doctors.ts` head |
| | • Deactivate emits `warning: doctor_has_future_appointments` (F-18) | `admin-branch-doctors.ts:30-34` |
| `AdminReceptionists.tsx` | • `GET/POST/PATCH /admin/receptionists` (single branch) | `apps/api/src/routes/admin-branch-receptionists.ts:1-100` |
| | • Deactivate warning `receptionist_has_future_appointments` (F-19) | `admin-branch-receptionists.ts:30-34` |
| `AdminAppointmentTypes.tsx` | • `GET/POST/PATCH /admin/appointment-types` | `apps/api/src/routes/admin-appointment-types.ts:138-428` |
| | • PATCH deactivates → `warning: appointment_type_has_future_appointments` (F-08) | `admin-appointment-types.ts:347-360` |
| | • `duration_minutes` mutable 5..480 (CHECK 0005) | `admin-appointment-types.ts:280-288` |
| `AdminAuditPage.tsx` | • `GET /admin/audit` returns policy envelope (no rows) | `apps/api/src/routes/admin-audit.ts:33-64` |
| `PatientBooking.tsx` | 5-step wizard; each step is API-bound: | `apps/web/src/pages/PatientBooking.tsx` |
|  | Step 1: `GET /public/doctors` | `apps/api/src/routes/public-catalog.ts:108-147` |
|  | Step 2: `GET /public/branches?doctor_id=` | `public-catalog.ts:149-223` |
|  | Step 3: `GET /public/appointment-types` | `public-catalog.ts:225-263` |
|  | Step 4: `GET /availability?doctor_id=&branch_id=&date=&appointment_type_id=&patient_phone=` | `apps/api/src/routes/availability.ts:43-151` |
|  | Step 5: `POST /bookings` (atomic; codes 400/404/409) | `apps/api/src/routes/bookings.ts` (full file) |
| `MyAppointments.tsx` | • `GET /patient/appointments` (Scheduled + future only) | `apps/api/src/routes/patient-appointments.ts:60-103` |
| | • Cancel modal → `POST /patient/appointments/:id/cancel` (no reason) | `apps/api/src/routes/patient-cancel.ts:94-196` |
| | • Deep-link landing `?action=cancel|reschedule&id=` → `GET /patient/appointments/:id/deep-link` | `apps/api/src/routes/patient-deep-link.ts:59-130` |
| `CancelModal.tsx` | • Renders terminal-state copy on 404 `not_found_appointment_in_terminal_state` | `patient-cancel.ts:144-150` |
| `DoctorApp.tsx` | • Deep-link routing via `?page=preview|confirm|backout` | `apps/web/src/pages/DoctorApp.tsx` (head) |
| `DoctorAffected.tsx` | • `GET /doctor/affected?branch_id=&date=` (kanban source) | `apps/api/src/routes/doctor-affected.ts:115-231` |
| | • Move: `POST /doctor/affected/:id/move` (BR-058 type lock) | `apps/api/src/routes/staff-doctor-move.ts:126-432` |
| | • Cancel: `POST /appointments/:id/cancel` with `reason` (FR-035) | `apps/api/src/routes/staff-doctor-cancel.ts:83-230` |
| | • Mark status: `POST /appointments/:id/mark-status` (Completed/No-Show) | `apps/api/src/routes/staff-mark-status.ts:80-227` |
| `DoctorAuditDrawer.tsx` | • `GET /doctor/appointments/:id/audit` (200 row window) | `apps/api/src/routes/doctor-appointment-audit.ts:74-159` |
| | • Filter chips: all / status / cancel / block / resolve | `DoctorAuditDrawer.tsx:163-189` |
| `ReceptionistApp.tsx` | Router for today/cancel/create/availability | `apps/web/src/pages/ReceptionistApp.tsx` |
| `ReceptionistToday.tsx` | • `GET /reception/branch/today?status=&doctor_id=&date=` | `apps/api/src/routes/receptionist-today.ts:92-271` |
| | • Branch-id query IGNORED (privacy) | `receptionist-today.ts:151-153` |
| | • Phone visible, no patient name (E7-S3) | `receptionist-today.ts:243-253` |
| `ReceptionistCancel.tsx` | • `POST /reception/appointments/:id/cancel` with `reason` (FR-034, 6 preset reasons + Other) | `apps/api/src/routes/staff-receptionist-cancel.ts:92-232` |
| `RecurringOccurrenceCancel.tsx` | Static mock 33 — per-occurrence cancel surface (not wired) | `apps/web/src/pages/RecurringOccurrenceCancel.tsx:1-257` |
| `ConfirmationReceipt.tsx` | Static mock 36 — receipt after booking (not wired to data) | `apps/web/src/pages/ConfirmationReceipt.tsx:1-110` |

**Mock-only / scaffold pages** (no live backend; smoke-only):
`Mock9`, `Mock11`, `Mock12`, `Mock14`, `Mock15` (receptionist create),
`Mock30` (receptionist availability), `RecurringOccurrenceCancel`,
`ConfirmationReceipt`. These render a 520-px layout for design QA but
do not call an endpoint. PR-1's gate tests already skip them.

## B. API endpoints (matrix)

> All paths below are mounted under the API at `apps/api/src/app.ts`.
> Auth is JWT-only (`req.auth.claim`). Patient `sub` = phone; staff
> `sub` = email. Role gate: `claim.role`. Branch gate: `claim.branch_ids`.

### Auth / session
| Method | Path | Role | Codes | Source |
|---|---|---|---|---|
| POST | `/auth/login/staff` | public | 200, 400 `invalid_role`/`invalid_email`, 401 `staff_not_found` | `auth-staff.ts:148-232` |
| GET | `/auth/me` | any | 200, 401 | `auth-staff.ts:238-298` |
| POST | `/patient/otp/verify-now` | public (dev/test only) | 200, 400 `invalid_phone`, 401 `invalid_otp_code` | `patient-otp.ts:49-102` |

### Public catalog (patient picker)
| Method | Path | Role | Codes | Source |
|---|---|---|---|---|
| GET | `/public/doctors` | any | 200, 401 | `public-catalog.ts:108-147` |
| GET | `/public/branches?doctor_id=` | any | 200, 400 `invalid_doctor_id`, 401 | `public-catalog.ts:149-223` |
| GET | `/public/appointment-types` | any | 200, 401 | `public-catalog.ts:225-263` |
| GET | `/availability` | any (receptionist branch-locked) | 200; 400 `past_date`/`outside_30d_window`/`invalid_*`/`invalid_date`; 401; 403 `outside_branch_scope`; 404 `doctor_not_found`/`branch_not_found`/`appointment_type_not_found` | `availability.ts:43-183` |

### Bookings
| Method | Path | Role | Codes | Source |
|---|---|---|---|---|
| POST | `/bookings` | any (receptionist branch-locked) | 200; 400 `unknown_field`/`invalid_*`/`doctor_not_at_branch`/`doctor_inactive`/`branch_inactive`; 401; 403 `outside_branch_scope`; 404 `*_not_found`; 409 `past_date`/`outside_30d_window`/`duration_mismatch`/`patient_has_future_with_doctor`/`patient_time_conflict`/`slot_raced` (carries `can_do:refresh_availability`)/`outside_branch_hours`/`doctor_unavailable`/`inside_doctor_block` | `bookings.ts` (full file) |

### Patient self-service (E4)
| Method | Path | Role | Codes | Source |
|---|---|---|---|---|
| GET | `/patient/appointments` | patient | 200; 401; 403 `forbidden_role` | `patient-appointments.ts:60-103` |
| POST | `/patient/appointments/:id/cancel` | patient | 200; 401; 403 `forbidden_role`; 404 `not_found`; 404 `not_found_appointment_in_terminal_state` | `patient-cancel.ts:94-196` |
| POST | `/patient/appointments/:id/reschedule` | patient | 200; 400; 401; 403; 404; 409 (FR-043 atomic) — codes mirror `/bookings` | `patient-reschedule.ts:498-789` |
| GET | `/patient/appointments/:id/deep-link` | patient | 200; 401; 403; 404 | `patient-deep-link.ts:59-130` |

### Staff actions (E5)
| Method | Path | Role | Codes | Source |
|---|---|---|---|---|
| POST | `/appointments/:id/cancel` | doctor (doubly-bound) | 200; 400 `reason_required`/`reason_too_long`; 401; 403 `forbidden_role`/`outside_branch_scope`; 404 `not_found`; 422 `already_in_terminal_state` | `staff-doctor-cancel.ts:83-230` |
| POST | `/appointments/:id/mark-status` | doctor or receptionist | 200; 400 `invalid_status`; 401; 403; 404; 422 `already_in_terminal_state`/`appointment_in_future` | `staff-mark-status.ts:80-227` |
| POST | `/reception/appointments/:id/cancel` | receptionist (branch-only) | 200; 400 `reason_required`/`reason_too_long`; 401; 403; 404; 422 | `staff-receptionist-cancel.ts:92-232` |
| GET | `/reception/branch/today` | receptionist | 200; 400 `invalid_status`/`invalid_doctor_id`/`invalid_date`; 401; 403 | `receptionist-today.ts:92-271` |

### Doctor resolve (E6)
| Method | Path | Role | Codes | Source |
|---|---|---|---|---|
| GET | `/doctor/affected?branch_id=&date=` | doctor | 200; 400 `invalid_branch_id`/`invalid_date`; 401; 403 | `doctor-affected.ts:115-231` |
| POST | `/doctor/affected/:id/move` | doctor | 200; 400 `unknown_field`/`invalid_*`/`duration_mismatch`/`branch_inactive`/`doctor_not_at_branch`; 401; 403; 404; 409 (`slot_raced`/`patient_time_conflict`/`patient_has_future_with_doctor`/`doctor_unavailable`/`outside_branch_hours`/`inside_doctor_block`/`branch_closed`/`outside_30d_window`/`slot_in_past`); 422 `already_in_terminal_state`/`appointment_in_past`/`no_op_move` | `staff-doctor-move.ts:126-432` |
| GET | `/doctor/appointments/:id/audit` | doctor (owner) | 200; 401; 403; 404 | `doctor-appointment-audit.ts:74-159` |
| GET | `/reception/appointments/:id/audit` | receptionist (branch) | 200; 401; 403; 404 | `reception-appointment-audit.ts:71-154` |
| POST | `/recurring/preview` | doctor or receptionist | 200; 400 (validated shape); 401; 403 | `recurring-preview.ts:1-80` |
| POST | `/recurring/confirm` | doctor or receptionist | 200; 404 `preview_not_found`; 403; 401 | `recurring-confirm.ts:1-80` |

### Admin (E1 / E2)
| Method | Path | Role | Codes | Source |
|---|---|---|---|---|
| GET | `/admin/clinic` | admin | 200; 500 `clinic_row_missing` | `admin-clinic.ts:120-158` |
| PATCH | `/admin/clinic` | admin | 200; 400 `invalid_name`; 500 | `admin-clinic.ts:160-196` |
| GET/POST | `/admin/branches` | admin | 200/201; 400; 500 | `admin-branches.ts:140-217` |
| GET | `/admin/branches/:id` | admin | 200; 400 `invalid_branch_id`; 404 | `admin-branches.ts:220-256` |
| PATCH | `/admin/branches/:id` | admin | 200; 400 `unknown_field`/`no_fields_to_update`/`invalid_name`/`invalid_active`; 404; 409 `branch_has_future_appointments` | `admin-branches.ts:259-424` |
| GET | `/admin/branches/:id/hours` | admin | 200; 400; 404 | `admin-branch-hours.ts:62-115` |
| POST | `/admin/branches/:id/hours-impact` | admin | 200; 400; 404 | `admin-branch-hours.ts:118-180` |
| PATCH | `/admin/branches/:id/hours` | admin | 200; 400; 404; 409 `appointments_outside_hours` (+ `requires_doctor_acknowledgement` flag) | `admin-branch-hours.ts:183-468` |
| GET/POST | `/admin/doctors` | admin | 200/201; 400; 404 | `admin-branch-doctors.ts` |
| GET | `/admin/doctors/:id` | admin | 200; 404 | `admin-branch-doctors.ts` |
| PATCH | `/admin/doctors/:id` | admin | 200; 400; 404; warning `doctor_has_future_appointments` | `admin-branch-doctors.ts:30-34` |
| PUT | `/admin/doctors/:id/branches` | admin | 200; 400; 404 | `admin-branch-doctors.ts:1-100` |
| GET | `/admin/doctors/:id/schedule` | admin | 200; 400; 404 | `admin-doctor-schedule.ts:217-251` |
| POST | `/admin/doctors/:id/schedule-impact` | admin | 200; 400; 404 | `admin-doctor-schedule.ts:256-351` |
| POST | `/admin/doctors/:id/schedule` | admin | 201; 400; 404; 409 `schedule_invalidates_future_appointments` | `admin-doctor-schedule.ts:356-500` |
| GET | `/admin/doctors/:id/blocks` | admin | 200; 400 `invalid_from_filter`/`invalid_to_filter`; 404 | `admin-doctor-block.ts:168-219` |
| POST | `/admin/doctors/:id/blocks-impact` | admin | 200; 400; 404 | `admin-doctor-block.ts:224-291` |
| POST | `/admin/doctors/:id/blocks` | admin | 201; 400; 404; 409 `block_overlaps_future_appointments` | `admin-doctor-block.ts:296-400` |
| DELETE | `/admin/doctors/:id/blocks/:block_id` | admin | 204; 400; 404 | `admin-doctor-block.ts:405-437` |
| GET/POST/PATCH | `/admin/appointment-types` | admin | 200/201; 400; 404; warning `appointment_type_has_future_appointments` | `admin-appointment-types.ts:138-428` |
| GET/PATCH | `/admin/receptionists` | admin | 200/201; 400; 404; warning `receptionist_has_future_appointments` | `admin-branch-receptionists.ts:1-100` |
| GET | `/admin/audit` | admin | 200 (policy envelope); 401; 403 | `admin-audit.ts:33-64` |

### Health
| Method | Path | Role | Source |
|---|---|---|---|
| GET | `/health` | public | `health.ts` |
| GET | `/metrics` | public | `metrics.ts` |

## C. Seed fixtures (typed loader)

> Path loader: `apps/api/test/fixtures/loader.ts`. Tests must call
> `loadClinic()`, `loadBranch('east'|'west')`, `loadDoctor(slug)`,
> `loadReceptionist(slug)`, `loadAdmin(slug)`, `loadPatient(slug)`.

| Slug | File | id | name | key fields | Source |
|---|---|---|---|---|---|
| `clinic` | `fixtures/clinic.json` | `clinic-main` | "Test Clinic" | singleton | `loader.ts:50-53,144-151` |
| `branches/east` | `fixtures/branches/east.json` | `branch-east` | "East Branch" | `tz: America/New_York` | `loader.ts:55-60,154-166` |
| `branches/west` | `fixtures/branches/west.json` | `branch-west` | "West Branch" | `tz: America/Los_Angeles` | same |
| `admins/main` | `fixtures/admins/main.json` | `admin-main` | "Admin Main" | `email: admin-main@clinic.local` | `loader.ts:76-80,199-` |
| `doctors/east.lead` | `fixtures/doctors/east.lead.json` | `doctor-east-lead` | "Dr. East Lead" | at `branch-east`; types: general, followup | `loader.ts:62-67,169-181` |
| `doctors/east.support` | `fixtures/doctors/east.support.json` | `doctor-east-support` | "Dr. East Support" | at `branch-east`; type: general | same |
| `doctors/west.lead` | `fixtures/doctors/west.lead.json` | `doctor-west-lead` | "Dr. West Lead" | at `branch-west`; types: consult, followup | same |
| `receptionists/east` | `fixtures/receptionists/east.json` | `receptionist-east` | "Receptionist East" | single branch `branch-east` | `loader.ts:69-74,184-196` |
| `receptionists/west` | `fixtures/receptionists/west.json` | `receptionist-west` | "Receptionist West" | single branch `branch-west` | same |
| `patients/0001` | `fixtures/patients/0001.json` | n/a (keyed by phone) | "Patient One" | `+15550000001`, `has_future_appointment: true` | `loader.ts:82-86` |
| `patients/0002` | `fixtures/patients/0002.json` | n/a | "Patient Two" | `+15550000002` | same |
| `patients/0003` | `fixtures/patients/0003.json` | n/a | "Patient Three" | `+15550000003` | same |
| `patients/0004` | `fixtures/patients/0004.json` | n/a | "Patient Four" | `+15550000004` | same |
| `patients/0005` | `fixtures/patients/0005.json` | n/a | "Patient Five" | `+15550000005` | same |

**Mock OTP** for all patient flows: `123456` (constant-time compared
in `patient-otp.ts:36-44`). E.164 form required (`+15550000001`).

## D. Cleanup strategy (FR-038)

> The no-deletion contract is **status-only**: every appointment row
> is append-only. There is **no DELETE route** for any role on any
> appointment path. Pinned by `apps/api/test/no-deletion.test.ts`.

| Surface | Clean-up mechanism | Source |
|---|---|---|
| All appointment rows (any role path) | `DELETE /appointments/:id` → 404 `not_found` (test pins absence) | `no-deletion.test.ts:165-200` |
| Cancel / mark-status / reschedule | `UPDATE appointment SET status = 'Cancelled' \| 'Completed' \| 'No-Show'`; row stays in DB | `patient-cancel.ts:152, staff-mark-status.ts:190` |
| Audit log | Trigger `reject_audit_mutation` (migration 0009) blocks UPDATE/DELETE on `appointment_audit`; rows only INSERTed | referenced in `patient-cancel.ts:74-77` |
| GIST exclusion `0008` (`appointment_no_overlap`) | Scoped on `status='Scheduled'`, so Cancelled rows release their slot for re-booking | `patient-cancel.ts:30-37` |
| Seed-cleanup in tests | `DELETE FROM appointment_audit WHERE patient_phone LIKE '+1555999%'` + same on `appointment` (the test prefix only) | `no-deletion.test.ts:48-53` |
| Test fixture policy | `loader.ts` (rebuild from JSON each test run; no cross-test mutation) | `loader.ts:1-100` |

**Implication for E2E**: tests must **not assert row absence** after
a cancel/reschedule. Instead assert the new `status` value, and the
row's continued presence in the API (e.g. via
`/patient/appointments/:id/deep-link`).

## E. Suggested NEW E2E specs (numbered)

> PR-1 already ships specs 01..11 (auth + admin nav + logout). The
> matrix below adds specs 12..N to cover every "live" page in
> Section A. Each row maps to a Playwright `.spec.ts` file.

| # | Spec | Pages exercised | API exercised | Key invariants |
|---|---|---|---|---|
| 12 | `patient-booking-happy-path` | `PatientBooking` 1..5 | `GET /public/*`, `GET /availability`, `POST /bookings` | wizard completes; receipt shown; 200 row in DB |
| 13 | `patient-booking-fr-027-future-with-same-doctor` | `PatientBooking` | `POST /bookings` | 409 `patient_has_future_with_doctor`; UI offers "view my appointments" |
| 14 | `patient-booking-fr-029-time-overlap` | `PatientBooking` | `POST /bookings` | 409 `patient_time_conflict`; UI surfaces the conflict |
| 15 | `patient-booking-slot-raced` | `PatientBooking` (two tabs) | `POST /bookings` | 409 `slot_raced`; `can_do.refresh_availability`; client refreshes |
| 16 | `patient-booking-outside-branch-hours` | `PatientBooking` step 4 | `GET /availability` | empty `slots` + `reason` |
| 17 | `patient-my-appointments-list` | `MyAppointments` | `GET /patient/appointments` | only Scheduled+future rows render |
| 18 | `patient-cancel-no-reason` | `MyAppointments` + `CancelModal` | `POST /patient/appointments/:id/cancel` | status flips; slot free again |
| 19 | `patient-cancel-terminal-state` | `MyAppointments` | `POST /patient/appointments/:id/cancel` (twice) | second call 404 `not_found_appointment_in_terminal_state` |
| 20 | `patient-reschedule-doctor-locked` | `MyAppointments` | `POST /patient/appointments/:id/reschedule` with `new_doctor_id` | 400 `unknown_field` (FR-040) |
| 21 | `patient-reschedule-fr-027-self` | `MyAppointments` | `POST /patient/appointments/:id/reschedule` | succeeds; doesn't collide with itself |
| 22 | `patient-deep-link-cancel` | `MyAppointments` + URL `?action=cancel&id=` | `GET /patient/appointments/:id/deep-link` then cancel | modal opens; lands in cancel state |
| 23 | `patient-deep-link-reschedule` | `MyAppointments` + URL `?action=reschedule&id=` | deep-link + reschedule | modal opens with prefilled slot |
| 24 | `patient-privacy-enumeration-block` | direct API | `GET /patient/appointments/:id` from a stranger's JWT | 403 `forbidden_role`; phone-bound list never leaks |
| 25 | `doctor-affected-kanban-load` | `DoctorApp` + `DoctorAffected` | `GET /doctor/affected` | 4 columns; "Resolve (N)" badge correct |
| 26 | `doctor-move-conflict` | `DoctorResolve` | `POST /doctor/affected/:id/move` | success; old slot released; new slot blocked |
| 27 | `doctor-move-no-op` | `DoctorResolve` | same with identical body | 422 `no_op_move` |
| 28 | `doctor-move-type-locked` | `DoctorResolve` | same with `new_appointment_type_id` | 400 `unknown_field` (BR-058) |
| 29 | `doctor-move-outside-30d-window` | `DoctorResolve` | same with slot > 30d out | 409 `outside_30d_window` |
| 30 | `doctor-cancel-reason-required` | `DoctorCancel` | `POST /appointments/:id/cancel` (empty / >500) | 400 `reason_required` / `reason_too_long` (FR-035) |
| 31 | `doctor-cancel-foreign-doctor` | `DoctorCancel` | same with another doctor's row | 403 `outside_branch_scope` (doubly-bound) |
| 32 | `doctor-mark-completed-past-only` | `DoctorMarkStatus` | `POST /appointments/:id/mark-status` future row | 422 `appointment_in_future` (BR-040) |
| 33 | `doctor-mark-no-show-idempotent` | `DoctorMarkStatus` | same row twice | 422 `already_in_terminal_state` |
| 34 | `doctor-audit-drawer-load` | `DoctorAuditDrawer` | `GET /doctor/appointments/:id/audit` | rows render with WCAG glyphs |
| 35 | `doctor-audit-drawer-foreign` | `DoctorAuditDrawer` | same with another doctor's id | 403 `outside_branch_scope` |
| 36 | `doctor-audit-drawer-filter-chips` | `DoctorAuditDrawer` | client-side filter | each chip narrows the row set |
| 37 | `receptionist-today-load-default-date` | `ReceptionistToday` | `GET /reception/branch/today` | response `date` = branch-local today |
| 38 | `receptionist-today-navigate-date` | `ReceptionistToday` | `?date=YYYY-MM-DD` | response `date` echoes |
| 39 | `receptionist-today-branch-tamper` | `ReceptionistToday` | `?branch_id=other` | branch-id query IGNORED (still own branch) |
| 40 | `receptionist-today-doctor-filter` | `ReceptionistToday` | `?doctor_id=` | only that doctor's rows |
| 41 | `receptionist-cancel-reason-required` | `ReceptionistCancel` | `POST /reception/appointments/:id/cancel` | 400 `reason_required` (FR-034) |
| 42 | `receptionist-cancel-cross-branch` | `ReceptionistCancel` | other branch's row | 403 `outside_branch_scope` |
| 43 | `receptionist-cancel-terminal` | `ReceptionistCancel` | cancelled row | 422 `already_in_terminal_state` |
| 44 | `reception-appointment-audit-foreign-branch` | (drawer) | `GET /reception/appointments/:id/audit` | 403 `outside_branch_scope` |
| 45 | `admin-clinic-rename-validation` | `ClinicSettings` | `PATCH /admin/clinic` | rejects "", " ", > 120 chars |
| 46 | `admin-branches-create-deactivate` | `AdminBranches` | `POST/PATCH /admin/branches` | happy path + 409 `branch_has_future_appointments` (BR-059) |
| 47 | `admin-branch-hours-impact` | `AdminBranchHours` | `POST .../hours-impact` | non-zero `count_affected`; ack required iff doctor at branch |
| 48 | `admin-branch-hours-save-ack` | `AdminBranchHours` | `PATCH .../hours?acknowledge_doctor_impact=true` | 200 with `requires_doctor_acknowledgement:true` flag echoed |
| 49 | `admin-doctor-schedule-impact` | `AdminDoctorSchedule` | `POST /admin/doctors/:id/schedule-impact` | lists future Scheduled rows that would be invalidated |
| 50 | `admin-doctor-schedule-save` | `AdminDoctorSchedule` | `POST /admin/doctors/:id/schedule` | 201 with `inserted_count`; 409 on conflict |
| 51 | `admin-doctor-block-create` | `AdminDoctorBlocks` | `POST /admin/doctors/:id/blocks` | 201; 409 `block_overlaps_future_appointments` |
| 52 | `admin-doctor-block-delete` | `AdminDoctorBlocks` | `DELETE /admin/doctors/:id/blocks/:block_id` | 204; 404 on second |
| 53 | `admin-appointment-types-create-deactivate` | `AdminAppointmentTypes` | `POST/PATCH /admin/appointment-types` | future-count warning on deactivate (F-08) |
| 54 | `admin-appointment-types-duration-bounds` | `AdminAppointmentTypes` | `PATCH` with `duration_minutes: 0\|1000` | 400 (CHECK 5..480) |
| 55 | `admin-receptionists-create-reassign` | `AdminReceptionists` | `POST/PATCH /admin/receptionists` | single-branch enforced; warning on deactivate (F-19) |
| 56 | `admin-doctors-branch-assignment` | `AdminDoctorAssign` | `PUT /admin/doctors/:id/branches` | full-set replace; idempotent |
| 57 | `admin-doctors-deactivate-warning` | `AdminDoctors` | `PATCH /admin/doctors/:id` with future appts | 200 + `warning: doctor_has_future_appointments` (F-18) |
| 58 | `admin-audit-policy-envelope` | `AdminAuditPage` | `GET /admin/audit` | 200 policy envelope (no rows) |
| 59 | `no-deletion-cross-role` | direct API | `DELETE /appointments/:id` × {doctor, receptionist, admin, anon} | 404 or 401 (FR-038) — pin absence |
| 60 | `patient-booking-future-doctor` | `PatientBooking` | `POST /bookings` | 400 `invalid_doctor_id` / 404 `doctor_not_found` |
| 61 | `patient-booking-doctor-inactive` | `PatientBooking` | `POST /bookings` | 400 `doctor_inactive` |
| 62 | `patient-booking-branch-inactive` | `PatientBooking` | `POST /bookings` | 400 `branch_inactive` |
| 63 | `patient-booking-30-day-window` | `PatientBooking` | `POST /bookings` > 30d | 409 `outside_30d_window` |
| 64 | `patient-booking-past-date` | `PatientBooking` | `POST /bookings` today | 409 `past_date` |
| 65 | `patient-booking-duration-mismatch` | `PatientBooking` | `POST /bookings` with wrong `slot_duration_minutes` | 409 `duration_mismatch` |
| 66 | `receptionist-book-outside-branch-hours` | (receptionist create) | `POST /bookings` branch_id mismatched | 403 `outside_branch_scope` |
| 67 | `recurring-preview-then-confirm` | (mock 33 → confirm) | `POST /recurring/preview` + `/recurring/confirm` | all `will_create` rows land Scheduled |
| 68 | `recurring-confirm-partial-skip` | (mock 33) | `/recurring/confirm` with one slot raced | skipped row reported; others succeed |
| 69 | `staff-doctor-move-future-only` | `DoctorResolve` | `POST /doctor/affected/:id/move` past row | 422 `appointment_in_past` |
| 70 | `staff-doctor-move-doctor-unavailable` | `DoctorResolve` | same on doctor's day off | 409 `doctor_unavailable` |

**Count**: 59 NEW specs (12..70) in addition to PR-1's 11.

## F. Hardening notes

1. **CSV export** on `DoctorAuditDrawer` is intentionally a no-op
   (`disabled` + `title` text) — deferral D-E7-S-UI-2. Spec 34 should
   assert `disabled`, not a click action.
2. **`ConfirmationReceipt.tsx` and `RecurringOccurrenceCancel.tsx`**
   are static mocks. Their post-booking flow today lands on
   `ConfirmationReceipt` with hard-coded data; tests should target
   the BOOKED state via the `MyAppointments` "View receipt" path
   once E5 wires the live receipt.
3. **Mock OTP** (`123456`) is gated by `NODE_ENV ∈ {development,test}`
   per `patient-otp.ts:11-22` — tests must run with the right env.
4. **Branch timezone**: the test fixtures have east=`America/New_York`
   and west=`America/Los_Angeles`. Tests that compare wall-clock
   times must use `branch.tz` (see E7-S6 partial threading in
   `patient-reschedule.ts:271-307`).
5. **Test isolation**: every E2E run seeds with the same JSON
   fixtures and a fresh DB. Specs that need a "future appointment"
   must use `patients/0001.json` (`has_future_appointment: true`)
   or seed via API.

## G. How to map an E2E spec to source

```
spec name → {role} + {action} + {expected code/envelope}
   |
   v
open apps/web/src/pages/<Page>.tsx → find API call → grep
apps/api/src/routes/<file>.ts for the exact code string
```

Example: `patient-cancel-no-reason` → `MyAppointments.tsx` →
`patient-cancel.ts:144-150` → expect `200` and row.status flips to
`Cancelled` (no reason field on request body — `FR-033`).
