---
id: spec-5-1-2-ui-doctor-mark-cancel
title: E5-S1 + E5-S2 UI — Doctor mark-status + cancel-with-reason
epic: epic-5
status: done
review_loop_iteration: 0
created: 2026-10-06
last_updated: 2026-10-06
---

# E5-S1 + E5-S2 UI — Doctor mark-status + cancel-with-reason

## Intent

Ship the doctor-facing surfaces that consume the E5-S1 and
E5-S2 back-end routes:

- **E5-S1** — `POST /appointments/:id/mark-status`. Body is
  `{status: 'Completed' | 'No-Show'}`. Doctor or receptionist
  only. The slot is NOT released (BR-039): the row is in the
  past and the GIST exclusion (scoped on
  `status='Scheduled'`) already lets past rows coexist. No
  reason is required (BR-039, BR-040). Audit row carries
  `payload = {}`.
- **E5-S2** — `POST /appointments/:id/cancel`. Doctor-only.
  Reason is REQUIRED (FR-035 / BR-037). Server trims + caps
  at 500 chars. The slot IS released on success (BR-053 /
  FR-050). Audit row carries `payload = {reason,
  recurring_origin?}` (E6-S4 enrichment).

The UI half (mock 12 + mock 25): a 480px Mark Status modal
(two-button grid: Completed ✓ / No-Show ⚠) and a 560px
Cancel modal (reason-preset radio list + freeform note + red
CTA). Both reach the doctor through new affordances on the
affected-queue kanban cards (E6-S2's D-E6-S-UI-3 deferral).

Mock 12's "Today, Mark Status" left-list + right-detail
layout is a future story (D-E5-S1-UI-1). The right-detail
content is what ships here as the standalone modal.

## Approach

1. **API client** — add `markAppointmentStatus(id, input)`
   + `MarkStatus` / `MarkStatusInput` / `MarkStatusAppointment`
   / `MarkStatusResponse` types, and `doctorCancel(id, input)`
   + `DoctorCancelInput` / `DoctorCancelAppointment` /
   `DoctorCancelResponse` types.
2. **`DoctorMarkStatus`** — 480px modal (mock 12 right
   panel condensed). Two-button grid; on click → success →
   `onMarked(status)` callback.
3. **`DoctorCancel`** — 560px modal (mock 25 stacked flow
   condensed). Reason presets + freeform note + red CTA;
   on confirm → success → `onCancelled(reason)` callback.
4. **`DoctorAffected`** — adds a red "Cancel" button to every
   non-resolved kanban card, plus a "Mark status" button on
   past rows. The "Mark status" button only renders when the
   row's `start_datetime <= Date.now()` — future rows would
   trigger the server's 422 `appointment_in_future`, so the
   UI hides the affordance up front.
5. **Spec + sprint-status** — this doc + a `done` marker.

### 1. API client — mark-status + doctor cancel

**File:** `apps/web/src/api/client.ts` (EDIT).

```ts
export type MarkStatus = 'Completed' | 'No-Show';

export interface MarkStatusInput { status: MarkStatus; }
export interface MarkStatusAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;  // ISO UTC
  end_datetime: string;    // ISO UTC
  status: MarkStatus;
}
export interface MarkStatusResponse {
  appointment: MarkStatusAppointment;
}

export function markAppointmentStatus(
  appointmentId: string,
  input: MarkStatusInput,
): Promise<MarkStatusResponse>;

export interface DoctorCancelInput { reason: string; }
export interface DoctorCancelAppointment {
  id: string;
  branch_id: string;
  doctor_id: string;
  appointment_type_id: string;
  start_datetime: string;
  end_datetime: string;
  status: 'Cancelled';
}
export interface DoctorCancelResponse {
  appointment: DoctorCancelAppointment;
}

export function doctorCancel(
  appointmentId: string,
  input: DoctorCancelInput,
): Promise<DoctorCancelResponse>;
```

`POST /appointments/:id/mark-status` and
`POST /appointments/:id/cancel` (the staff path; E4-S2 owns
the `/patient/appointments/:id/cancel` patient path).

### 2. `DoctorMarkStatus` — modal (mock 12 condensed)

**File:** `apps/web/src/pages/DoctorMarkStatus.tsx` (NEW),
**File:** `apps/web/src/pages/DoctorMarkStatus.module.css` (NEW).

Token-only CSS (E7-S1 invariant). 480px modal centered on
`var(--scrim)` backdrop. Structure:
- **Head**: crumb "Mark status" + h2 "Update this appointment"
  + sub "The slot will not be released — this row is in the
  past."
- **Body**:
  - Appointment card: month / day / dow date-block + name +
    meta (date · time · branch · masked phone).
  - Two-button grid (Completed ✓ / No-Show ⚠). The Completed
    button uses `var(--success-text)` with
    `var(--success-badge-bg)` hover; the No-Show button uses
    `var(--on-warning)` with `var(--warning-soft)` hover.
  - Bottom note (warning-bg): "Audit row: marked_&lt;status&gt; ·
    actor=you · doctor · payload={} (no reason required,
    BR-039 / BR-040)."
- **Foot**: ghost "Close" button.

On success: `markAppointmentStatus(id, {status})` →
`onMarked(status)` → parent closes modal + refreshes + toasts.
On `appointment_in_future` (BR-040): surface inline; the UI
hides the affordance for future rows so this branch is
defense-in-depth.

### 3. `DoctorCancel` — modal (mock 25 condensed)

**File:** `apps/web/src/pages/DoctorCancel.tsx` (NEW),
**File:** `apps/web/src/pages/DoctorCancel.module.css` (NEW).

Token-only CSS. 560px modal. Structure:
- **Head**: danger icon (! in red ring) + crumb "Affected
  queue → …" + h2 "Cancel this appointment" + sub "A reason
  is required. The slot will be released."
- **Body**:
  - Appointment card (same shape as mark-status).
  - Reason presets (radio group, role="radio",
    aria-checked): Patient requested / Doctor unavailable /
    Scheduling conflict / Other (the last forces a freeform
    note).
  - Freeform textarea (max 500 chars, monospace char
    counter). Required when "Other" is selected; optional
    otherwise (the "Internal note (optional)" suffix in the
    label).
  - Impact banner (danger-bg): "Slot will be released and
    become bookable again immediately. The patient will see
    'Cancelled by clinic' and can rebook."
  - Audit row footer: "Audit row: action=cancelled,
    actor=doctor, payload={reason, recurring_origin?}".
- **Foot**: ghost "Keep appointment" + secondary "Back to
  queue" + red "Confirm cancel + release slot" (the active
  button — `var(--danger-strong)` background).

On confirm: composes `reason = "<preset>: <note>"` (or just
the preset label when no note), calls
`doctorCancel(id, {reason})`, on success
`onCancelled(reason)` → parent closes modal + refreshes +
toasts. On `reason_required` (400): inline error.

### 4. `DoctorAffected` — wire the affordances

**File:** `apps/web/src/pages/DoctorAffected.tsx` (EDIT).

New state: `cancelId`, `markId`. New handlers:
`onOpenCancel(id)`, `onCloseCancel()`, `onCancelled(reason)`
(closes + refreshes + toasts), `onOpenMark(id)`,
`onCloseMark()`, `onMarked(status)`. New helpers:
`rowById(id)` (looks up the appointment from the rows
cache), `isPastRow(r)` (Date check vs start_datetime).

New column render buttons on To do + In progress cards:
- Existing: Move/Continue (primary teal) + Audit log (ghost).
- **New: Cancel (red outline)** — always shown for non-resolved
  rows.
- **New: Mark status (ghost)** — only shown when the row is in
  the past (per E5-S1 BR-040).

New CSS variants in `DoctorAffected.module.css`:
- `.doc-aff__card-btn--danger` (red outline) — Cancel button.
- `flex-wrap: wrap` on `.doc-aff__card-actions` so 4 buttons
  wrap cleanly on narrow kanban columns.

### 5. Spec + sprint-status

**File:** `_bmad-output/implementation-artifacts/spec-5-1-2-ui-doctor-mark-cancel.md` (NEW, this doc).
**File:** `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT).

Story → `done`. 4 deferrals logged (D-E5-S1-UI-1..4).

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/api/client.ts` | EDIT | `MarkStatus*` types + `markAppointmentStatus` + `DoctorCancel*` types + `doctorCancel` |
| `apps/web/src/pages/DoctorMarkStatus.tsx` | NEW | 480px modal (mock 12 condensed) |
| `apps/web/src/pages/DoctorMarkStatus.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/DoctorCancel.tsx` | NEW | 560px modal (mock 25 condensed) |
| `apps/web/src/pages/DoctorCancel.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/DoctorAffected.tsx` | EDIT | Cancel + Mark status state + handlers + column buttons + modal renders |
| `apps/web/src/pages/DoctorAffected.module.css` | EDIT | `--danger` variant + flex-wrap on card-actions |
| `_bmad-output/implementation-artifacts/spec-5-1-2-ui-doctor-mark-cancel.md` | NEW | Spec |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | Story → done + deferrals |

## I/O & Edge-Case Matrix

### Mark Status (E5-S1)

| Surface | Input | API | UI |
|---------|-------|-----|----|
| Open modal (past row) | tap "Mark status" | — | Modal opens; both buttons enabled |
| Open modal (future row) | — | — | Modal not rendered (button hidden) |
| Confirm Completed | click "Completed" | 200 `{appointment}` | Modal closes; toast "Marked as Completed."; kanban refreshes (row removed since no longer Scheduled) |
| Confirm No-Show | click "No-Show" | 200 `{appointment}` | Modal closes; toast "Marked as No-Show."; kanban refreshes |
| Confirm Completed | — | 422 `already_in_terminal_state` | "This appointment is no longer Scheduled." |
| Confirm Completed | — | 422 `appointment_in_future` | "You can only mark past appointments." |
| Confirm Completed | — | 401 | "Session expired. Please sign in again." |
| Confirm Completed | — | 403 `outside_branch_scope` | "You do not have access to this appointment." |
| Confirm Completed | — | 404 | "That appointment no longer exists." |
| Confirm Completed | — | 400 `invalid_status` | "Pick Completed or No-Show." |
| Confirm Completed | — | 5xx / network | "Could not update the status." |
| Escape | keydown | — | Modal closes (only when not submitting) |
| Backdrop click | target === currentTarget | — | Modal closes (only when not submitting) |

### Cancel (E5-S2)

| Surface | Input | API | UI |
|---------|-------|-----|----|
| Open modal | tap "Cancel" | — | Modal opens; "Patient requested" preselected |
| Confirm "Patient requested" | empty note | 200 `{appointment}` | Modal closes; toast "Appointment cancelled · Patient requested"; kanban refreshes |
| Confirm "Other" | empty note | — | Inline "Please describe the reason." (client gate; server also enforces 400 reason_required) |
| Confirm "Other" | non-empty note | 200 | Modal closes; toast "Appointment cancelled · Other: <note>" |
| Confirm | — | 400 `reason_required` | "A reason is required." |
| Confirm | — | 400 `reason_too_long` | "Reason is too long (500 char max)." |
| Confirm | — | 422 `already_in_terminal_state` | "This appointment is no longer Scheduled." |
| Confirm | — | 401 / 403 / 404 | "Session expired…" / "You do not have access…" / "That appointment no longer exists." |
| Confirm | — | 5xx / network | "Could not cancel the appointment." |
| Escape | keydown | — | Modal closes (only when not submitting) |
| Backdrop click | target === currentTarget | — | Modal closes (only when not submitting) |
| "Keep appointment" | click | — | Modal closes (no API call) |

## Reason presets (Cancel modal)

| Key | Description | Note required? |
|-----|-------------|----------------|
| `patient_requested` | Patient or family called in | No (optional) |
| `doctor_unavailable` | Emergency, illness, schedule conflict | No (optional) |
| `scheduling_conflict` | Overbooked, branch issue | No (optional) |
| `other` | Please describe below | Yes |

The audit `payload.reason` is composed as
`<preset_label>: <note>` when the user types a note, otherwise
the preset label alone. The server trims + caps at 500 chars
(server-side cap mirrors the textarea's `maxLength`).

## Verification

Manual (no tests in this pass per user instruction):

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001);
   `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Sign in as `dr.-east-lead@clinic.local` (role=doctor).
   Land on DoctorApp → DoctorAffected kanban.
3. **Cancel path.** Seed a fresh affected row (narrow the
   doctor's branch hours so one of their future Scheduled
   rows is affected). Re-sign-in. The card now has
   "Cancel" (red outline). Click → Cancel modal opens.
   Default reason is "Patient requested". Click "Confirm
   cancel + release slot" → success. Kanban refreshes; the
   row is gone. Toast appears.
4. **Reason required.** Open the modal again on another
   affected row. Select "Other". The "Confirm cancel" button
   is disabled until the doctor types a note. Type "Patient
   clinic called at 9am, asked to reschedule." Confirm →
   success.
5. **Mark status (past row).** Seed an affected row in the
   past (insert directly via SQL: set start_datetime to
   yesterday). Refresh the kanban. The card now has
   "Mark status" (since the row is past). Click → DoctorMark
   modal opens. Click "Completed" → success. Kanban
   refreshes; the row is gone.
6. **Mark status (future row hidden).** Seed a future
   affected row. The card does NOT show "Mark status" (the
   helper filters on `isPastRow`). Defensive: if the doctor
   forces the call (via curl), the API returns 422
   `appointment_in_future` and the modal renders the
   friendly error.
7. **Already-cancelled.** Cancel an already-Cancelled row by
   manipulating the id. The modal surfaces "This appointment
   is no longer Scheduled." (server 422
   `already_in_terminal_state`).
8. **Patient privacy.** Open DevTools → Network, fire
   `POST /appointments/<id>/cancel`. The server returns the
   updated appointment row (no `patient_name`). The card's
   patient label is the synthetic "Patient ···{last4}"
   (E7-S3 invariant).
9. **Reason too long.** Type 501 characters in the textarea.
   The browser blocks beyond 500 (textarea `maxLength`); the
   server also enforces 500 (`reason_too_long`).
10. **Error envelope.** Trigger 401 by clearing the auth
    token in DevTools. The modals surface "Session expired.
    Please sign in again."
11. `pnpm --filter @clinic/web typecheck` — 0 new errors.
12. `pnpm --filter @clinic/web lint` — 0 new warnings.
13. Grep `apps/web/src` for hex literals outside `tokens.css`
    → 0 (E7-S1 invariant).

## Out of scope (deferred to later stories)

- **D-E5-S1-UI-1** — "Today" queue (mock 12 full layout).
  Today the mark-status modal is reachable only from the
  affected-queue card. The mock 12 left-list + right-detail
  layout (mockup: "Today, Aug 20 · 8 appointments · 3 done"
  with the right detail panel rendering the mark-status
  actions) is a separate story. The DoctorApp view machine
  has the plumbing for a `'today'` view; the surface page is
  the next story.
- **D-E5-S1-UI-2** — Bulk mark-status. The E5-S1 route is
  per-appointment `POST /appointments/:id/mark-status`. A
  "mark all past rows as Completed" affordance is a future
  hardening story.
- **D-E5-S1-UI-3** — "Mark future as scheduled" / "Auto-mark
  no-show after N minutes". Out of scope; the doctor/reception
  flow stays manual.
- **D-E5-S2-UI-1** — Patient-facing cancel modal (mock 22).
  E4-S2 owns the patient path; the surface already ships in
  PatientApp.tsx. Today there's no doctor-initiated cancel
  that's distinct from the kanban flow.

## Cross-references

- `apps/api/src/routes/staff-mark-status.ts` (E5-S1 back-end)
- `apps/api/src/routes/staff-doctor-cancel.ts` (E5-S2 back-end)
- `apps/api/src/routes/staff-receptionist-cancel.ts` (E5-S3
  receptionist cancel — shares the cancel-reason surface shape)
- `docs/design/mockups/v1/mockups/12-mark-status.html`
- `docs/design/mockups/v1/mockups/25-doctor-cancel-reason.html`
- `docs/design/DESIGN-SYSTEM.md` (token-only CSS invariant,
  E7-S1)