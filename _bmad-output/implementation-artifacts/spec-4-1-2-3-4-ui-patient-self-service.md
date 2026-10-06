---
id: spec-4-1-2-3-4-ui-patient-self-service
title: E4-S1 + E4-S2 + E4-S3 + E4-S4 UI — Patient self-service hub
epic: epic-4
status: done
review_loop_iteration: 0
created: 2026-10-06
last_updated: 2026-10-06
---

# E4-S1 + E4-S2 + E4-S3 + E4-S4 UI — Patient self-service hub

## Intent

Ship the patient-facing self-service surface that mirrors the receptionist
flow for the patient's own appointments: list upcoming appointments, cancel
one, reschedule one, and support deep-link entry from SMS / email so the
patient lands on the right action.

The four back-end stories are already shipped:

- **E4-S1** — `GET /patient/appointments` returns the verified patient's
  future Scheduled rows; the phone is bound from `req.auth.claim.sub`,
  never from the body or a query param (E7-S3 privacy filter).
- **E4-S2** — `POST /patient/appointments/:id/cancel` cancels a Scheduled
  appointment; atomic SELECT FOR UPDATE + UPDATE + audit INSERT; no
  reason required (FR-033 explicit).
- **E4-S3** — `POST /patient/appointments/:id/reschedule` reschedules a
  Scheduled appointment; doctor is LOCKED (FR-040, BR-042); branch, type,
  date, time can change (FR-041); the new slot's duration MUST equal the
  appointment type's `duration_minutes`.
- **E4-S4** — `GET /patient/appointments/:id/deep-link` is the routing
  hint used by SMS / email deep-links.

This story is the UI half: it builds the four corresponding pages on top
of those endpoints, wires them behind the patient role's `onSignOut`-able
shell, and gates the deep-link landing behind the verified session.

## Approach

The smallest end-to-end change that exercises every E4 surface:

1. **API client** — add the four endpoint wrappers and the four DTO
   types.
2. **`PatientFrame`** — surface the "Find a doctor" / "My appointments"
   nav toggle that mockups 02/03/04 only ever show one side of.
3. **`MyAppointments`** — the new self-service hub (mockup 05 post-OTP
   state). Renders the upcoming list, fires CancelModal, fires
   ReschedulePage, handles deep-link landing.
4. **`CancelModal`** — the patient cancel modal (mockup 22). Modal
   pattern, no reason select (FR-033 explicit).
5. **`ReschedulePage`** — the patient reschedule flow (mockup 20). Full
   page with a locked current-appointment card and a 30-day picker.
6. **`PatientApp`** — top-level patient container (W59 deferral:
   internal router). Switches between booking and self-service.
7. **`App.tsx`** — patient-role bypass now renders `<PatientApp />`
   instead of `<PatientBooking />`.
8. **No back-end changes.** Everything is already on the wire.

### 1. API client — patient self-service types and endpoints

**File:** `apps/web/src/api/client.ts` (EDIT).

Four type sets + four functions, all extending the existing
`request<T>()` wrapper:

```ts
export interface PatientAppointmentDto {
  id: string;
  doctor_id: string;
  branch_id: string;
  appointment_type_id: string;
  start_datetime: string; // ISO UTC
  end_datetime: string;   // ISO UTC
  status: 'Scheduled';
  tz: string;
}

export function listPatientAppointments(): Promise<PatientAppointmentsResponse> {
  return request<PatientAppointmentsResponse>('/patient/appointments', { method: 'GET' });
}

export function patientCancel(appointmentId: string): Promise<PatientCancelResponse> {
  return request<PatientCancelResponse>(
    `/patient/appointments/${encodeURIComponent(appointmentId)}/cancel`,
    { method: 'POST' },
  );
}

export interface PatientRescheduleInput {
  new_branch_id: string;
  new_appointment_type_id: string;
  new_start_datetime: string;
  new_end_datetime: string;
  new_slot_duration_minutes: number;
}

export function patientReschedule(
  appointmentId: string,
  input: PatientRescheduleInput,
): Promise<PatientRescheduleResponse> { /* … */ }

export function getPatientDeepLink(
  appointmentId: string,
): Promise<PatientDeepLinkResponse> { /* … */ }
```

`PatientAppointmentDto.status` is the literal `'Scheduled'` because the
E4-S1 server-side query is `WHERE status='Scheduled' AND start_datetime >
NOW()` — the union of remaining times is a Scheduled-row set by
construction. No `patient_name` field on the DTO (E7-S3).

### 2. `PatientFrame` — nav toggle

**File:** `apps/web/src/pages/PatientFrame.tsx` (EDIT).

Add `activeLink?: 'find-doctor' | 'my-appointments'` and
`onNavigate?: (link) => void`. The active item renders as a non-button
`<span>` (per mockup nav: the active item isn't clickable); the
inactive item is a real `<button>`. The CSS update mirrors the same
shape on `.patient-frame__link` (button reset to inherit font, color,
no border, transparent background).

### 3. `MyAppointments` — the new self-service hub

**File:** `apps/web/src/pages/MyAppointments.tsx` (NEW).

Header ("My appointments / Manage your appointments") + quicklink
("Book another appointment" → `onGoFindDoctor`) + a single section
("Upcoming appointments") containing a denormalised row per appointment.

Each row: small calendar tile (month / day / weekday, like mock 05) +
doctor + type / branch + time + Reschedule button + Cancel button.

Actions fire local state (`cancelId`, `rescheduleId`) — CancelModal and
ReschedulePage mount when their respective ids are non-null. On
success, the parent's `onCancelDone` / `onRescheduleDone` clear the id
+ show a toast (`+ "your appointment has been cancelled…"` /
`+ "your appointment has been moved"`) + refetch the list.

**Refresh** (`refresh()`) fans out four API calls:
- `listPatientAppointments()`
- `listPublicDoctors()`
- `listPublicAppointmentTypes()`
- one `listPublicBranches(doctor_id)` per distinct doctor

We can't `listPublicBranches()` without a doctor id (the route requires
it), so we issue one call per distinct doctor. The branch map is
keyed by branch_id and de-duplicates across doctors (defensive: if a
patient has appointments with the same doctor at multiple branches,
we'd fetch the same branches twice; in practice the de-dup map collapses
to a single row).

**Deep-link** (`E4-S4`): a `useEffect` reads `?action=cancel|reschedule&id=…`
once on mount. If both params are present and the deep-link lookup
succeeds with `can_cancel` or `can_reschedule` truthy, the matching
state is set; otherwise a toast surfaces the failure. After handling,
the URL is scrubbed via `window.history.replaceState({}, '',
window.location.pathname)` so the browser back button doesn't
re-trigger the deep link.

**Privacy (E7-S3)**: The list payload carries the patient's own
appointments; the UI never has to scope by patient name. Doctor /
branch / type names are denormalised from the public catalogue; the
patient cell on each row is the doctor only (no patient name on the
list — the patient IS the patient).

### 4. `CancelModal` — the cancel modal (mockup 22)

**File:** `apps/web/src/pages/CancelModal.tsx` (NEW).

A 480px modal over a scrim (`role="dialog"`, `aria-modal="true"`). The
title is "Cancel your appointment with Dr. {lastName} on {date}?". The
body is "Your slot will be released" + a row of (branch · type · time)
+ "Cancellation is final — we'll cancel the appointment immediately" +
"No reason needed from you. The slot will be released" helper. Two
actions: "Keep appointment" (`onClose`) and "Cancel appointment"
(fires `patientCancel(id)`; on failure, surfaces the API envelope
inline).

The cancel button uses `--danger-strong` for the fill (mock 22's red
CTA), the keep button uses the secondary outline style. The modal
auto-dismisses on success via `onDone(id)`.

The `lastName()` helper is the same as `recep-utils.lastNameOf` —
strips a "Dr." prefix and returns the last space-separated word.

### 5. `ReschedulePage` — the reschedule flow (mockup 20)

**File:** `apps/web/src/pages/ReschedulePage.tsx` (NEW).

A 760px stacked-vertical page rendered over the PatientFrame. Two
sections:
1. **Current appointment** (locked). The card displays the existing
   appointment as a date-block + body with the doctor / branch /
   type / time / duration. The "Doctor is locked" hint pill reinforces
   that the doctor can't change. Step number badge is "✓" (done).
2. **Pick a new slot** (active). Branch select (filtered to this
   doctor's branches via `listPublicBranches(doctor_id)`), appointment
   type select (via `listPublicAppointmentTypes()`), 30-day date rail
   (starting tomorrow per FR-019, 30 cells), and an agenda of slots
   via `getAvailability({doctor_id, branch_id, date,
   appointment_type_id})`.

When a slot is chosen, a summary card shows the new date, branch,
doctor, type. The "Confirm move" button fires
`patientReschedule(id, {new_branch_id, new_appointment_type_id,
new_start_datetime, new_end_datetime, new_slot_duration_minutes:
appointment.typeDuration})`.

`new_slot_duration_minutes` is HARDCODED to
`appointment.typeDuration` (E4-S3 invariant: the new slot's duration
MUST equal the appointment type's `duration_minutes`). This avoids a
race where the slot's stored duration drifts from the type's; we trust
the type table.

Every relevant 409 / 400 envelope is mapped:
- 409: `slot_raced` → "That slot was just booked by another patient",
  `patient_has_future_with_doctor` → "You already have a future
  appointment with this doctor", `patient_time_conflict` → "You
  already have another appointment at that time", `duration_mismatch`
  → "The slot's duration doesn't match the appointment type",
  `outside_30d_window` → "That date is more than 30 days out",
  `slot_in_past` → "That slot is in the past", `doctor_unavailable` →
  "The doctor isn't available then", `branch_closed` → "The branch
  is closed then".
- 400: `doctor_not_at_branch`, `doctor_inactive`, `branch_inactive`,
  `invalid_time_range`, `unknown_field`.
- 404: `not_found_appointment_in_terminal_state` → "This appointment
  is no longer Scheduled".
- 401: "Session expired. Please sign in again."

The page's `onClose` fires when the user clicks the breadcrumb ("‹
My appointments") or "Back" — both surface the page dismissal to
the parent. The parent (`MyAppointments`) clears `rescheduleId` and
refreshes the list on `onDone`.

### 6. `PatientApp` — top-level patient container (W59 deferral)

**File:** `apps/web/src/pages/PatientApp.tsx` (NEW).

Mirrors `ReceptionistApp`. View state machine:
- `view === 'find-doctor'` → `<PatientBooking />`
- `view === 'my-appointments'` → `<MyAppointments onGoFindDoctor={…} />`

Deep-link handling: on first mount, if `?action=<id>&id=<id>` is in
the URL, scrub the URL and switch view to `my-appointments`,
forwarding the action + id to MyAppointments. The MyAppointments
component then performs the deep-link API lookup and pre-opens the
correct modal / flow.

### 7. `App.tsx` — patient-role bypass

**File:** `apps/web/src/App.tsx` (EDIT).

Change `if (role === 'patient') { return <PatientBooking />; }` to
`return <PatientApp />;`. The `PatientApp` decides whether to render
the booking flow or the self-service hub.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/api/client.ts` | EDIT | PatientAppointmentDto + 4 endpoints |
| `apps/web/src/pages/PatientFrame.tsx` | EDIT | activeLink + onNavigate props |
| `apps/web/src/pages/styles/patient-frame.css` | EDIT | button reset on .patient-frame__link |
| `apps/web/src/pages/MyAppointments.tsx` | NEW | Main self-service hub |
| `apps/web/src/pages/MyAppointments.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/CancelModal.tsx` | NEW | Mock 22 modal |
| `apps/web/src/pages/CancelModal.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/ReschedulePage.tsx` | NEW | Mock 20 stacked-vertical flow |
| `apps/web/src/pages/ReschedulePage.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/PatientApp.tsx` | NEW | Top-level patient container |
| `apps/web/src/App.tsx` | EDIT | Patient bypass → `<PatientApp />` |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Surface | Input | API | UI |
|---------|-------|-----|----|
| My-appointments (E4-S1) | GET | 200 `{appointments: [...]}` | Denormalised row list (date-block + doctor + branch + time + Reschedule / Cancel actions) |
| My-appointments | — | 401 | "Session expired. Please sign in again." |
| My-appointments | — | 403 | "You do not have access to this view." |
| My-appointments | — | 5xx / network | "Could not load your appointments." |
| Cancel modal (E4-S2) | POST cancel | 200 | List refetches + toast |
| Cancel modal | — | 401 | "Session expired. Please sign in again." |
| Cancel modal | — | 404 `not_found_appointment_in_terminal_state` | "This appointment is no longer Scheduled." |
| Cancel modal | — | 4xx | Inline error |
| Reschedule page (E4-S3) | POST reschedule | 200 | List refetches + toast |
| Reschedule page | — | 409 `slot_raced` | "That slot was just booked by another patient. Pick another." |
| Reschedule page | — | 409 `patient_has_future_with_doctor` | "You already have a future appointment with this doctor." |
| Reschedule page | — | 409 `patient_time_conflict` | "You already have another appointment at that time." |
| Reschedule page | — | 409 `duration_mismatch` | "The slot's duration doesn't match the appointment type." |
| Reschedule page | — | 409 `outside_30d_window` | "That date is more than 30 days out." |
| Reschedule page | — | 409 `slot_in_past` | "That slot is in the past." |
| Reschedule page | — | 409 `doctor_unavailable` | "The doctor isn't available then." |
| Reschedule page | — | 409 `branch_closed` | "The branch is closed then." |
| Reschedule page | — | 400 `doctor_not_at_branch` | "The doctor doesn't work at that branch." |
| Reschedule page | — | 400 `doctor_inactive` / `branch_inactive` | "The doctor / branch is no longer accepting bookings." |
| Reschedule page | — | 400 `invalid_time_range` | "The slot duration is invalid." |
| Reschedule page | — | 400 `unknown_field` | "The form has an unknown field — refresh the page." |
| Reschedule page | — | 404 `not_found_appointment_in_terminal_state` | "This appointment is no longer Scheduled." |
| Deep-link (E4-S4) | GET deep-link | 200 `{can_cancel: true, …}` | CancelModal opens immediately |
| Deep-link | — | 200 `{can_cancel: false, can_reschedule: false}` | Toast: "This appointment can no longer be changed." |
| Deep-link | — | 200 `{can_reschedule: true, …}` for `action=reschedule` | ReschedulePage opens immediately |
| Deep-link | — | 200 mismatched (e.g. cancel target but only reschedule allowed) | Toast: "That action is not available for this appointment." |
| Deep-link | — | 404 | Toast: "We could not find that appointment." |

## Verification

Manual (no tests in this pass per user instruction):

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001);
   `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Sign in as the W10 patient (mock OTP `123456`) → land on Find a
   doctor (PatientBooking default). Click "My appointments" in the
   nav → MyAppointments renders with the seeded future appointment
   for patient 0001.
4. Click "Reschedule" → ReschedulePage opens (mock 20 stacked-
   vertical). Pick a new branch + type + date + slot → "Confirm
   move" → list refetches with the new time, toast: "Your appointment
   has been moved."
5. Click "Reschedule" again on the just-moved row → confirm same
   new dates → 200 + list refetches.
6. Click "Cancel" → CancelModal opens (mock 22 modal). Click
   "Cancel appointment" → list refetches (no rows), modal closed.
8. Cancel an already-Cancelled row by manipulating localStorage to
   point at a stale id (or by reschedule → cancel flow) → 404
   `not_found_appointment_in_terminal_state` → inline error.
9. **Deep-link.** Reschedule one more appointment, then cancel it
   from MyAppointments. Open a fresh tab, paste the deep-link URL
   `http://localhost:5173/?action=cancel&id=<appt-id>` (with the
   patient JWT in localStorage from the same browser). The tab lands on
   MyAppointments; the CancelModal pre-opens the matching
   appointment; the URL is scrubbed to `/my-appointments` after handling.
11. `pnpm --filter @clinic/web typecheck` — 0 new errors.
12. `pnpm --filter @clinic/web lint` — 0 new warnings.
13. Grep `apps/web/src` for hex literals outside `tokens.css` → 0
    (E7-S1 invariant).
14. **Privacy check.** In DevTools → Network, confirm the
    `/patient/appointments` response has no `patient_name` field
    and that the patient cells on each row show only the doctor (no
    patient label).

## Out of scope (deferred to later stories)

- **D-E4-S-UI-1** — Walk-in book surface (mock 26) is the
  receptionist's surface; this story is patient self-service only.
  The walk-in surface is in the E5-S-UI deferral set.
- **D-E4-S-UI-2** — Server-driven doctor-scope branch filtering for
  the reschedule picker. Today `listPublicBranches(doctor_id)` already
  returns only this doctor's branches (the route's WHERE clause does
  the filter); the UI just renders the whole list. No work to do
  here — kept in the deferral log in case a future hardening pass
  wants to swap to a dedicated `GET /patient/branches/:doctor_id`
  with privacy semantics.
- **D-E4-S-UI-3** — Per-doctor branch fetch is parallelised
  client-side via `Promise.all`, but it issues one HTTP request per
  distinct doctor. A future story could ship
  `GET /patient/appointments/branches` returning the union of
  branches across all the patient's appointment-doctors. Today's
  one-request-per-doctor pattern is acceptable for ≤10 appointments.
- **W59** (carry-over) — Real router. Today PatientApp uses an
  internal `view` state; MyAppointments's deep-link handling is also
  state-driven. W59 is the routing story.
- **W10c** (carry-over) — Rate limiting on
  `/patient/appointments/:id/cancel` and `…/reschedule`. Today
  nothing rate-limits a successful POST.
- **Toast integration with the global `ConflictModal`** (mock 29,
  E7-S4). The current toast is a per-page `<div>`; future work
  hoists it into the AppShell as a global component.

## Cross-references

- `apps/api/src/routes/patient-appointments.ts` (E4-S1)
- `apps/api/src/routes/patient-cancel.ts` (E4-S2)
- `apps/api/src/routes/patient-reschedule.ts` (E4-S3)
- `apps/api/src/routes/patient-deep-link.ts` (E4-S4)
- `docs/design/mockups/v1/mockups/05-patient-appointments.html`
- `docs/design/mockups/v1/mockups/20-patient-reschedule.html`
- `docs/design/mockups/v1/mockups/22-patient-cancel-modal.html`
- `docs/design/DESIGN-SYSTEM.md` (token-only CSS invariant, E7-S1)