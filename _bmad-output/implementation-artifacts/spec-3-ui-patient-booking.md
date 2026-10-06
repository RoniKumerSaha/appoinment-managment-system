---
title: 'E3-S1/S2/S3 UI — Patient booking flow (find a doctor → book)'
type: 'feature'
created: '2026-10-06'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-3-1-availability-engine.md'
  - '_bmad-output/implementation-artifacts/spec-3-2-guest-booking-first-time.md'
  - '_bmad-output/implementation-artifacts/spec-3-3-returning-patient-booking-known-phone.md'
  - '_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
---

## Intent

**Problem:** The E3 backend route family (`GET /availability`, `POST /bookings`, `GET /patient/profile`) shipped in specs 3-1..3-3, but the web client has no surface to drive them. The patient can sign in via OTP (W10) but lands on the admin AppShell's ClinicSettings page — there is no patient-facing booking flow today.

**Approach:** Add a pixel-perfect port of mockups 02 (doctor picker), 03 (availability calendar), 04 (confirm details), 36 (confirmation receipt). The flow lives in a new public-facing `PatientFrame` (distinct from the admin AppShell — thinner nav, 1200px-wide, no role-based sidebar). A new `PatientBooking` page implements the 5-step state machine and replaces the AppShell in `App.tsx` when the authenticated session has `role === 'patient'`.

To support the picker, this story also adds three new lightweight public-catalog routes (`GET /public/{doctors,branches,appointment-types}`) that return only active rows. These are the minimum surface the patient picker needs — no adminScope, but auth-gated (any authenticated caller).

Mockups 34 (branch picker), 35 (type picker), 41 (phone country picker) are folded inline — the design system says the picker IS the page for these three.

## Boundaries & Constraints

**Always:**
- A new top-level `PatientFrame` with a 1200px-wide layout, sticky nav (logo + 4 links + "Sign out"), and a sticky 5-step progress bar (mockup 02/03/04 lines 20-24).
- `App.tsx` bypasses the admin `AppShell` when `stored.claim.role === 'patient'` and renders `<PatientBooking />` directly.
- Five steps (mockup 04 progress):
    1. **Pick a doctor** (mock 02) — list of cards, click selects.
    2. **Pick branch + type** (mock 02) — 3-col branch cards + 3-col type cards.
    3. **Pick date + time** (mock 03) — date rail (30-day window) + agenda slots.
    4. **Add your details** (mock 04) — phone + name. E3-S3 returning-patient detection via debounced `GET /patient/profile?phone=`.
    5. **Confirm** (mock 04 stacked-vertical) — read-only summary + Confirm button.
- New API surface:
    - `GET /public/doctors` — list active doctors (id + full_name only).
    - `GET /public/branches?doctor_id=` — list active branches; when `doctor_id` is set, filters to the doctor's branches server-side.
    - `GET /public/appointment-types` — list active types (id + name + duration_minutes).
- All API errors are mapped through `describeApiError()` with friendly text for the E3 envelope codes (`slot_raced`, `patient_has_future_with_doctor`, `patient_time_conflict`, `duration_mismatch`, `slot_in_past`, `outside_30d_window`, `doctor_unavailable`, `branch_closed`, `invalid_patient_phone`, `invalid_patient_name`, `network_error`, 5xx).
- FR-027 / FR-029 surfaced via the engine's `patient_phone` query param so the agenda naturally hides slots the patient can't book (mock 03 lines 119-125).
- Token-only CSS via `var(--…)` (E7-S1 invariant).
- E.164 phone validation client-side + the server's `isValidE164Phone` (E3-S2 invariant).
- The booking always submits a `(start_datetime, end_datetime)` pair where `end - start === slot_duration_minutes × 60s` (P1-3 from spec-3-2 SC2).
- Returning-patient auto-fills `patient_name` from the profile response (only when the user hasn't already typed something — respects FR-023).

**Ask First:**
- (none — all scope decisions resolved at plan-time.)

**Never:**
- No doctor/branch/type mutation surfaces. The patient frame is read-only on those resources; admins manage via `/admin/*`.
- No my-appointments view in this pass — that's E4-S1 (`My appointments` nav link is rendered as a muted placeholder).
- No hard-delete / cancel from this page — that's E4-S2.
- No reschedule from this page — that's E4-S3.
- No TZ math; the engine runs in UTC and the UI mirrors that (D2 deferral to E7-S6). The branch.tz is rendered as a hint string in the branch card.
- No new design tokens — every CSS value uses `var(--…)` from `styles/tokens.css`.
- No tests (per user instruction).

## I/O & Edge-Case Matrix

| Scenario | UI Behavior |
|----------|-------------|
| Patient logs in (W10 OTP) | App.tsx routes to `<PatientBooking />` step 1. |
| Step 1, doctors load | 1 card per active doctor; click selects and advances to step 2. |
| Step 1, 0 active doctors | "No doctors are accepting bookings right now." |
| Step 2, branches load | 3-col grid; A/B/C letter badge; click selects branch. |
| Step 2, type card | Click selects type; Continue button enabled when both picked. |
| Step 3, date rail click | Agenda reloads via `GET /availability?...&patient_phone=`. |
| Step 3, slots loaded | Click a slot bar to select; Continue enabled. |
| Step 3, 0 slots for date | "No slots available on Wed, Oct 7." with the reason text from the engine. |
| Step 3, doctor_unavailable | "The doctor isn't available on Sun, Oct 11." |
| Step 4, phone typed (E.164) | 350ms debounced probe to `/patient/profile`. |
| Step 4, returning patient | "✓ Returning patient — {full_name}" pill + name pre-filled (only if user hadn't typed). |
| Step 4, new patient | No pill; name field is empty. |
| Step 5, confirm click | POST /bookings with `{doctor_id, branch_id, appointment_type_id, start_datetime, end_datetime, slot_duration_minutes, patient_phone, patient_name}`. |
| Step 5, 201 success | Render confirmation receipt (mock 36). |
| Step 5, 409 patient_has_future_with_doctor | Inline error banner. |
| Step 5, 409 slot_raced | Inline error banner + "Refresh availability" CTA (canDo hint). |
| Step 5, 400 invalid_patient_name | Inline error. |
| Step 5, network down | "Connection failed. Is the API running on :3001?" |
| Receipt, "Book another" | Reset draft + go back to step 1. |
| Sign out (any step) | `logout()` + re-render LoginPage. |

## Code Map

- `apps/api/src/routes/public-catalog.ts` (NEW) — `GET /public/{doctors,branches,appointment-types}`. Active-only, auth-gated, no adminScope.
- `apps/api/src/app.ts` (EDIT) — mount `publicCatalogRouter` after `authMiddleware`, before `availabilityRouter`.
- `apps/web/src/api/client.ts` (EDIT) — added `PublicDoctorDto` / `PublicBranchDto` / `PublicAppointmentTypeDto` types; added `listPublicDoctors`, `listPublicBranches`, `listPublicAppointmentTypes`; added `AvailabilitySlot` / `AvailabilityResponse` types + `getAvailability`; added `CreatedAppointment` / `CreatedBookingResponse` types + `createBooking`; added `PatientProfileDto` + `getPatientProfile`.
- `apps/web/src/pages/PatientFrame.tsx` (NEW) — patient frame with thin nav, progress bar, 1200px body.
- `apps/web/src/pages/styles/patient-frame.css` (NEW) — token-only CSS.
- `apps/web/src/pages/PatientBooking.tsx` (NEW) — 5-step state machine + receipt.
- `apps/web/src/pages/booking-utils.ts` (NEW) — date math, E.164 helpers, format helpers.
- `apps/web/src/pages/PatientBooking.module.css` (NEW) — token-only CSS.
- `apps/web/src/App.tsx` (EDIT) — patient-role bypass to `<PatientBooking />`.
- `_bmad-output/implementation-artifacts/spec-3-ui-patient-booking.md` (NEW) — this spec.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — story → done.

## Reuse of existing code

- `apps/api/src/availability/engine.ts` (E3-S1) — `/availability` route is the slot source.
- `apps/api/src/routes/bookings.ts` (E3-S2) — atomic POST /bookings is the commit.
- `apps/api/src/routes/patient-profile.ts` (E3-S3) — `GET /patient/profile` is the returning-patient probe.
- `apps/web/src/api/client.ts` `ApiError` + `describeApiError()` pattern — same shape as every other UI story.
- `apps/web/src/styles/tokens.css` — every CSS value is `var(--…)`.
- `docs/design/mockups/v1/mockups/02-doctor-picker.html` (frame + nav + progress bar), `03-availability-calendar.html` (agenda + slot bars), `04-patient-confirm.html` (stacked vertical + summary), `36-confirmation-receipt.html` (receipt).

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/routes/public-catalog.ts` — three GET routes.
- [x] `apps/api/src/app.ts` — mount public catalog router.
- [x] `apps/web/src/api/client.ts` — types + endpoints.
- [x] `apps/web/src/pages/PatientFrame.tsx` — frame.
- [x] `apps/web/src/pages/styles/patient-frame.css` — frame styles.
- [x] `apps/web/src/pages/booking-utils.ts` — date + E.164 helpers.
- [x] `apps/web/src/pages/PatientBooking.tsx` — booking page.
- [x] `apps/web/src/pages/PatientBooking.module.css` — page styles.
- [x] `apps/web/src/App.tsx` — patient-role bypass.
- [x] This spec.
- [x] Sprint status updated.

**Acceptance Criteria:**
- Given a patient signs in via OTP (W10), then the app routes to the patient frame and the doctor picker is shown.
- Given a click on a doctor card, then the page advances to the branch+type picker with the doctor's branches loaded.
- Given both branch and type are picked, then the Continue button enables and the page advances to the date+time step.
- Given a date in the next 30 days is selected, then `GET /availability?...&patient_phone=...` is called and the agenda renders the slots.
- Given the patient types a known phone, then after a 350ms debounce, `GET /patient/profile?phone=...` fires and the "Returning patient" pill renders.
- Given the patient clicks Confirm in step 5, then `POST /bookings` is called and a 201 renders the receipt (mock 36).
- Given a 409 `patient_has_future_with_doctor`, then an inline error banner surfaces the BR-031 message.
- Given a 409 `slot_raced`, then the error banner renders and a "Refresh availability" affordance is shown.
- Given a network-down error, then "Connection failed. Is the API running on :3001?" appears.
- The "Sign out" button in the patient frame clears the auth and returns to the login page.
- Token-only CSS: no hex literals outside `tokens.css` in any new file.
- `pnpm --filter @clinic/web typecheck` — 0 new errors.
- `pnpm --filter @clinic/web lint` — 0 new warnings.
- `pnpm --filter @clinic/api typecheck` — 0 new errors in `public-catalog.ts` (pre-existing OTP errors are out of scope).

## Spec Change Log

**SC1 — 2026-10-06, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Deferrals

- **D-E3-1 — My appointments surface.** The nav has a "My appointments" link rendered as a muted placeholder. The full read-list is E4-S1 (`spec-4-1-patient-my-appointments.md`).
- **D-E3-2 — Doctor picker for receptionist onboarding.** When the receptionist books on behalf of a patient (E3-S4), they share the same flow but with `claim.role === 'receptionist'`. The route is wired; the UI is gated to `role === 'patient'` today. Future story: branch the picker for the receptionist role.
- **D-E3-3 — Country-code chip for phone input.** Mockup 41 shows a `+966 ▾` country-code chip + national-number split. Today the phone input is a single E.164 field — the E.164 regex enforces the `+CC` prefix. The chip is cosmetic; no validation difference.
- **D-E3-4 — Week / Month view toggles.** The agenda toggle has Week / Month as disabled placeholders. The agenda view is the only one wired.
- **D-E3-5 — "Edit" affordance on completed steps.** The mockup stacked-vertical pattern (mock 04) shows "Edit" links on the done summary cards. The patient frame hides them because we don't have a router today (W59 deferral); clicking the link would do nothing.

## Cross-References

- E3-S1 backend: `spec-3-1-availability-engine.md`
- E3-S2 backend: `spec-3-2-guest-booking-first-time.md`
- E3-S3 backend: `spec-3-3-returning-patient-booking-known-phone.md`
- W10: `spec-w10-staff-login-patient-otp.md` (auth gate)
- E4-S1: my-appointments (deferred — D-E3-1)
- E7-S6: branch-tz support (deferred — D2 / spec-3-1)
