---
id: spec-6-2-ui-doctor-conflict-move
title: E6-S2 UI — Doctor conflict move + affected queue
epic: epic-6
status: done
review_loop_iteration: 0
created: 2026-10-06
last_updated: 2026-10-06
---

# E6-S2 UI — Doctor conflict move + affected queue

## Intent

Ship the doctor-facing surface that consumes the back-end
E6-S2 + E6-S3 routes:

- **E6-S3** — `GET /doctor/affected` returns the doctor's
  future Scheduled appointments that fall OUTSIDE the current
  branch operating hours. Each row carries
  `reason: 'closed_day' | 'before_open_or_after_close'` — the
  same vocabulary as E1-S2's admin impact-preview.
- **E6-S2** — `POST /doctor/affected/:id/move` is the doctor's
  atomic conflict-move endpoint. The appointment TYPE is LOCKED
  (BR-058); the branch may change to any branch the doctor
  works at (BR-057). The doctor is server-trusted (FR-040).

The UI half: a Kanban-style "Resolve affected appointments"
board (mock 06), a stacked-vertical "Resolve this appointment"
flow (mock 24), and a success modal (mock 37). The doctor
sees all their affected Scheduled rows at once, picks one,
moves it to a valid new slot, and the row moves into the
"Resolved" column.

## Approach

1. **API client** — add the affected queue types + endpoint
   (`getDoctorAffected`) and the move endpoint (`doctorMove`).
2. **`DoctorFrame`** — the doctor-side top-level frame
   (logo + actor chip + role pill + Sign out). Distinct from
   PatientFrame (1200px), ReceptionistFrame (1100px), and the
   admin AppShell.
3. **`DoctorAffected`** — the kanban board (mock 06). 4-column
   grid: To do / In progress / Awaiting slot choice / Resolved.
   Cards show masked patient phone (E7-S3), branch, original
   time, and the affected reason. "Move" launches `DoctorResolve`.
5. **`DoctorResolve`** — stacked-vertical flow (mock 24). Step 1
   = read-only current appointment card. Step 2 = new branch +
   30-day date rail + slot grid. The TYPE is read from the
   source row (BR-058); the UI renders a type-lock banner so
   the constraint is impossible to miss.
6. **`DoctorResolutionSaved`** — success modal (mock 37). Shown
   when one move completes; "Resolve next" loops back to the
   queue.
7. **`DoctorApp`** — top-level doctor container (W59 deferral).
   Today there's only one doctor surface; future stories add
   weekly schedule (mock 09), audit drawer (mock 30), and
   today queue (mock 12).
8. **App.tsx** — doctor-role bypass renders `<DoctorApp />`
   instead of falling through to the admin AppShell.

### 1. API client — doctor self-service endpoints

**File:** `apps/web/src/api/client.ts` (EDIT).

```ts
export type DoctorAffectedReason =
  | 'closed_day'
  | 'before_open_or_after_close';

export interface DoctorAffectedAppointment {
  appointment_id: string;
  branch_id: string;
  doctor_id: string;
  patient_phone: string;
  appointment_type_id: string;
  start_datetime: string;  // ISO UTC
  end_datetime: string;    // ISO UTC
  status: string;
  reason: DoctorAffectedReason;
}

export interface DoctorAffectedResponse {
  count: number;
  branch_id: string | null;
  date: string | null;
  appointments: DoctorAffectedAppointment[];
}

export interface DoctorAffectedInput {
  branch_id?: string;
  date?: string;
}

export function getDoctorAffected(input?): Promise<DoctorAffectedResponse>;

export interface DoctorMoveInput {
  new_branch_id: string;
  new_start_datetime: string;
  new_end_datetime: string;
}

export function doctorMove(id, input): Promise<DoctorMoveResponse>;
```

### 2. `DoctorFrame` — top-level frame

**File:** `apps/web/src/pages/DoctorFrame.tsx` (NEW),
**File:** `apps/web/src/pages/styles/doctor-frame.css` (NEW).

Sticky nav: brand "MediSlot" + role pill "Doctor" + actor
chip (full name + initials) + "Sign out". 1100px body matches
the receptionist frame. No section nav (the doctor's surface
is just the affected queue today).

### 3. `DoctorAffected` — kanban board (mock 06)

**File:** `apps/web/src/pages/DoctorAffected.tsx` (NEW),
**File:** `apps/web/src/pages/DoctorAffected.module.css` (NEW).

Layout: alert-bar at top ("X appointments affected") with
counter pills ("X to do · 1 in progress · X resolved"),
followed by the page header, followed by the 4-column board:

- **To do** (red dot) — affected rows the doctor hasn't touched.
- **In progress** (amber dot) — the row the doctor is currently
  resolving (mirrors mock 06's "active" card).
- **Awaiting slot choice** (teal dot) — empty today; reserved
  for future patient-time-conflict flows that need a manual
  slot choice.
- **Resolved** (green dot) — session-local list of moved
  appointments (one entry per success modal dismiss).

Each card: patient label (masked phone + last 4 digits — the
E6-S3 response carries `patient_phone` but NOT `patient_name`,
E7-S3 invariant), masked phone, original time, branch name,
affected reason. "Move →" / "Continue →" buttons.

On `Move` click: `setMoveId(id)` + `setInProgressId(id)` —
the kanban's "In progress" column lights up; the DoctorResolve
overlay opens.

### 4. `DoctorResolve` — stacked-vertical flow (mock 24)

**File:** `apps/web/src/pages/DoctorResolve.tsx` (NEW),
**File:** `apps/web/src/pages/DoctorResolve.module.css` (NEW).

760px stacked-vertical page rendered over the kanban (no
PatientFrame — the DoctorFrame is implicit; the modal is a
`position: fixed` overlay). Two step cards + a banner:

- **Step 1 (read-only)**: patient · phone · original date ·
  original branch · doctor · type. Step badge is "✓ done".
- **Type-lock banner** (Q1 from design review): full-width
  amber card with lock icon, "Appointment type · locked",
  the type name + duration, and the reason
  "Type cannot change during resolve. Only branch and slot
  may change. BR-058".
- **Step 2 (active)**: branch select (filtered to doctor's
  branches via `listPublicBranches(doctor_id)`), 30-day date
  rail (tomorrow onward), slot grid (via `getAvailability`),
  summary card with new date + branch + type, "Back to queue"
  + "Move to …" buttons.

Type is LOCKED: the UI passes the source row's
`appointment_type_id` to `getAvailability` — there is no type
select. The body schema for `doctorMove` accepts only
`(new_branch_id, new_start_datetime, new_end_datetime)`; the
`new_appointment_type_id` is rejected as `unknown_field` on the
back-end (defense-in-depth).

On confirm: `doctorMove(id, {new_branch_id, new_start_datetime,
new_end_datetime})`. On success, the parent (DoctorAffected)
appends to the resolved list + refreshes.

### 6. `DoctorResolutionSaved` — success modal (mock 37)

**File:** `apps/web/src/pages/DoctorResolutionSaved.tsx` (NEW),
**File:** `apps/web/src/pages/DoctorResolutionSaved.module.css` (NEW).

Centered modal over the kanban. Success icon (✓ in a teal
circle) + "All N appointments resolved" (or "1 of N resolved"
if more remain) + summary card with the moved row + actions
("← Back to queue" / "Resolve next"). Bottom note explains
the audit-trail promise.

### 7. `DoctorApp` — internal router

**File:** `apps/web/src/pages/DoctorApp.tsx` (NEW).

Mirrors `ReceptionistApp` / `PatientApp`. View machine with
one entry today (`'affected'` → `<DoctorAffected />`).
Future stories can extend with `'schedule'` (mock 09),
`'audit'` (mock 30), and `'today'` (mock 12).

### 8. App.tsx — doctor-role bypass

**File:** `apps/web/src/App.tsx` (EDIT).

Add `if (role === 'doctor') { return <DoctorApp />; }` after
the patient + receptionist bypasses. Previously the doctor
fell through to the admin AppShell — wrong because the admin
surface never lets the doctor touch their own appointments.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/api/client.ts` | EDIT | DoctorAffected* types + getDoctorAffected + DoctorMove* types + doctorMove |
| `apps/web/src/pages/DoctorFrame.tsx` | NEW | Doctor top-level frame |
| `apps/web/src/pages/styles/doctor-frame.css` | NEW | Token-only CSS |
| `apps/web/src/pages/doctor-utils.ts` | NEW | tz-aware formatters + patient label |
| `apps/web/src/pages/DoctorAffected.tsx` | NEW | Kanban board (mock 06) |
| `apps/web/src/pages/DoctorAffected.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/DoctorResolve.tsx` | NEW | Stacked-vertical flow (mock 24) |
| `apps/web/src/pages/DoctorResolve.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/DoctorResolutionSaved.tsx` | NEW | Success modal (mock 37) |
| `apps/web/src/pages/DoctorResolutionSaved.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/DoctorApp.tsx` | NEW | Top-level doctor container |
| `apps/web/src/App.tsx` | EDIT | Doctor bypass → `<DoctorApp />` |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done |

## I/O & Edge-Case Matrix

| Surface | Input | API | UI |
|---------|-------|-----|----|
| Affected board (E6-S3) | GET | 200 `{count, appointments}` | Kanban: To do / In progress / Awaiting / Resolved |
| Affected board | — | 401 | "Session expired. Please sign in again." |
| Affected board | — | 403 | "You do not have access to this view." |
| Affected board | — | 5xx / network | "Could not load the affected queue." |
| Resolve page (E6-S2) | POST move | 200 `{appointment}` | Modal closes; kanban refreshes; success modal appears |
| Resolve page | — | 422 `already_in_terminal_state` | "This appointment is no longer Scheduled." |
| Resolve page | — | 422 `appointment_in_past` | "That appointment is already in the past." |
| Resolve page | — | 422 `no_op_move` | "You did not change anything — pick a different slot." |
| Resolve page | — | 409 `slot_raced` | "That slot was just booked by another patient." |
| Resolve page | — | 409 `patient_time_conflict` | "The patient already has another appointment at that time." |
| Resolve page | — | 409 `doctor_unavailable` | "You're not available at that slot." |
| Resolve page | — | 409 `branch_closed` | "The branch is closed at that slot." |
| Resolve page | — | 409 `outside_30d_window` | "That date is more than 30 days out." |
| Resolve page | — | 409 `slot_in_past` | "That slot is in the past." |
| Resolve page | — | 400 `duration_mismatch` | "The slot's duration doesn't match this appointment." |
| Resolve page | — | 400 `doctor_not_at_branch` | "You don't work at that branch." |
| Resolve page | — | 400 `branch_inactive` | "That branch is no longer accepting bookings." |
| Resolve page | — | 400 `invalid_time_range` | "Invalid time range." |
| Resolve page | — | 400 `unknown_field` | "The form has an unknown field." |
| Resolve page | — | 403 | "You do not have access to this appointment." |
| Resolve page | — | 404 | "That appointment no longer exists." |

## Verification

Manual (no tests in this pass per user instruction):

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001);
   `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Sign in as `dr.-east-lead@clinic.local` (role=doctor). Land
   on DoctorApp → DoctorAffected kanban.
3. Empty state: "0 appointments affected. No appointments need
   your attention right now."
4. Seed an affected row by narrowing the doctor's branch hours
   (E1-S2 admin path) past a future Scheduled appointment.
   Re-sign-in / refresh. The kanban now shows the row in
   "To do".
5. Click "Move →" → DoctorResolve opens. Verify the type-lock
   banner is present, the type name + duration match the
   source row, and the new branch select lists only branches
   the doctor works at.
6. Pick a new branch + date + slot → "Move to …" → success
   modal. "Resolve next" loops back to the queue; the resolved
   row appears under "Resolved" with the new time / branch.
7. Cancel an already-Cancelled row by manipulating the affected
   id (or by completing the move first then retrying). 422
   `already_in_terminal_state` surfaces inline.
8. Past rows: seed an affected row in the past. 422
   `appointment_in_past` surfaces inline.
9. No-op: pick the same branch + same time as the source. 422
   `no_op_move` surfaces inline.
10. `pnpm --filter @clinic/web typecheck` — 0 new errors.
11. `pnpm --filter @clinic/web lint` — 0 new warnings.
12. Grep `apps/web/src` for hex literals outside `tokens.css` → 0
    (E7-S1 invariant).
13. **Privacy check.** In DevTools → Network, confirm
    `/doctor/affected` response carries `patient_phone` but no
    `patient_name`. The kanban card's patient label is the
    synthetic "Patient ···{last4}" (E7-S3 invariant).
14. **Branch scope check.** In DevTools → Network, confirm the
    `/doctor/affected` response only lists appointments at
    branches the doctor works at (the WHERE clause uses
    `a.doctor_id = $1 AND a.branch_id = ANY($2)`).

## Out of scope (deferred to later stories)

- **D-E6-S-UI-1** — Patient-aware scheduling (KPI for E6-S2):
  when the doctor moves an appointment to a slot where the
  patient has another booking, the back-end returns
  `patient_time_conflict` (FR-029). The UI surfaces it; the
  doctor must then choose another slot or cancel. Today the
  error is rendered; the "Awaiting slot choice" kanban column
  is reserved for future use (e.g. auto-resolution offers).
- **D-E6-S-UI-2** — Bulk resolve (mock 06's "Bulk: pick same
  new date" link). Out of scope; the E6-S2 route is a
  per-appointment `POST /doctor/affected/:id/move`. A bulk
  endpoint is a future hardening story.
- **D-E6-S-UI-3** — Cancellation from the kanban card (mock 06's
  "Cancel" button on each card). The doctor's
  cancel-on-behalf-of-patient route is `POST /appointments/:id/cancel`
  (E5-S2 — reason required, BR-037 / FR-035). The cancel
  button on the kanban is wired but routes through E5-S2's
  surface; a future story integrates the cancel modal here.
- **D-E6-S-UI-4** — Audit drawer link (mock 37's "View all 4
  events in audit log →" link). The destination is the
  E7-S2 audit drawer (story #17). Today the link is a button
  without an onClick; the bottom note explains the
  integration timeline.
- **D-E6-S-UI-5** — Weekly schedule + audit drawer + today
  queue surfaces (mocks 09, 30, 12). DoctorApp has the
  view-state plumbing; the surface pages are separate stories.

## Cross-references

- `apps/api/src/routes/doctor-affected.ts` (E6-S3)
- `apps/api/src/routes/staff-doctor-move.ts` (E6-S2)
- `docs/design/mockups/v1/mockups/06-resolve-affected.html`
- `docs/design/mockups/v1/mockups/24-doctor-resolve-one.html`
- `docs/design/mockups/v1/mockups/37-doctor-resolution-saved.html`
- `docs/design/DESIGN-SYSTEM.md` (token-only CSS invariant, E7-S1)