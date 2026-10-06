---
title: 'E5-S3/S4 UI — Receptionist today dashboard + cancel appointment'
type: 'feature'
created: '2026-10-06'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-5-3-receptionist-cancellation-with-reason.md'
  - '_bmad-output/implementation-artifacts/spec-5-4-todays-branch-view-receptionist-dashboard.md'
  - '_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
---

## Intent

**Problem:** The receptionist's two back-end routes shipped earlier — `GET /reception/branch/today` (E5-S4) and `POST /reception/appointments/:id/cancel` (E5-S3) — but the web client has no surface to drive them. A receptionist who signs in via W10 lands on the admin AppShell's ClinicSettings page; their only path to the today dashboard is a thin link they don't have.

**Approach:** Add a pixel-perfect port of mockup 13 (recep-today, 1100px frame) and mockup 15 (recep-cancel, 760px stacked-vertical frame). The flow lives in a new receptionist frame (`ReceptionistFrame`) — a third frame alongside `AppShell` and `PatientFrame`, distinct from both: thinner nav (logo + actor chip + Sign out), no section sidebar, no progress bar. Mockup 26 (recep-checkin) is OUT OF SCOPE here because the back-end has no `receptionist books on behalf` POST — that surface is deferred until E5-S1/S2's mark-status / cancel-with-reason back-end surfaces ship.

The receptionist role bypasses the admin AppShell in `App.tsx` (mirrors the patient bypass from E3-ui) and renders a new `ReceptionistApp` component that internally routes between two views: `ReceptionistToday` (mock 13) and `ReceptionistCancel` (mock 15).

## Boundaries & Constraints

**Always:**
- New top-level `ReceptionistFrame` with a 1100px-wide layout, sticky position, logo + actor chip + Sign out (no section nav, no progress bar).
- `App.tsx` bypasses the admin `AppShell` when `stored.claim.role === 'receptionist'` and renders `<ReceptionistApp />`.
- `ReceptionistApp` is a thin internal router (no real router, W59 deferral) that flips between the today and cancel screens via `onOpenCancel(id)` / `onBackToToday()` callbacks.
- Today view (`ReceptionistToday`) renders:
    - Branch pill (📍 + branch.name) + "Today, Aug 20" title + "N doctors · M appointments" sub.
    - "+ Book walk-in" button (mock 13) — surfaces an `alert()` because the receptionist book-on-behalf back-end is not yet shipped (deferred — D-E5-S-UI-1).
    - Quick links: "Cancel appointment" (routes to `ReceptionistCancel` with no preselect) + "Doctor availability" (deferred — D-E5-S-UI-2).
    - Toolbar: search (phone), date, doctor select, status select. Each non-default filter wires to a backend query param on the next refetch.
    - Hour-grouped appointment rows: time (start→end), patient phone (full + masked), doctor (avatar + surname), appointment type, status pill, View + (Scheduled-only) Check in buttons.
    - "Now" highlight on the row whose [start, end] contains the current time-in-branch.tz; ticks every 60s.
- Cancel view (`ReceptionistCancel`) renders:
    - Two steps (mock 15 stacked-vertical):
        1. Pick the appointment — radio list of today's Scheduled rows at the receptionist's branch. Backend-filtered (`status=Scheduled`).
        2. Reason + confirm — reason select (curated options + "Other (write in notes)") + optional notes textarea + impact callout ("⚠ This will…") + Back / Keep / Confirm buttons.
    - On success: toast "Cancelled. Slot released." (UX-FLOWS F-14) auto-dismisses after 4s; the appointment list refetches with `status=Scheduled` so the just-cancelled row disappears.
- Privacy (E7-S3): the today endpoint never returns `patient_name`. The receptionist identifies the patient on arrival by phone. The cell shows the full phone + masked variant.
- New API surface (all in `apps/web/src/api/client.ts`):
    - `getReceptionistToday({status?, doctor_id?, date?})` → `ReceptionistTodayResponse`.
    - `receptionistCancel({appointment_id, reason})` → `ReceptionistCancelResponse`.
- All API errors are mapped through `describeCancelError()` for the E5-S3 envelope codes (`unauthenticated`, `forbidden_role`, `outside_branch_scope`, `not_found`, `reason_required`, `reason_too_long`, `already_in_terminal_state`, `internal_error`).
- Token-only CSS via `var(--…)` (E7-S1 invariant). One new token added to `tokens.css`: `--danger-badge-bg: #fecaca` (used by the Cancelled and No-Show status pills — no existing token covered the saturated-red pill background).
- The cancel reason is a free-form string per E5-S3's `staff-receptionist-cancel.ts:124-134`. The UI presents a curated enum but appends `notes` to the chosen reason so the audit log can reconstruct the receptionist's intent. The `__other__` option requires notes.
- The receptionist's branch is server-locked (E5-S4 + BR-004); the `branch_id` query param is IGNORED (Scenario 11). The branch pill on the today header always shows the receptionist's actual assigned branch.
- Reason validation: `reason` is trimmed and must be 1..500 chars (server-side mirror of `staff-receptionist-cancel.ts:127-134`). The UI prevents submission when the reason is empty.

**Ask First:**
- (none — all scope decisions resolved at plan-time.)

**Never:**
- No real router. `ReceptionistApp` uses internal `view` state (W59 deferral).
- No walk-in book surface today (mock 26) — the "+ Book walk-in" button is a no-op with an alert. Deferred to a future story when the back-end ships `receptionist books on behalf`.
- No "Check in" / mark-status flow — the per-row Check in button is a no-op with an alert. Deferred to E5-S1's mark-status + the doctor-or-receptionist cancel-with-reason (E5-S2) back-end surfaces.
- No doctor availability for the receptionist today. The mock 13 quick-link is a muted placeholder.
- No patient-name surface anywhere (E7-S3 privacy invariant). The today list and the cancel picker only show phone.
- No new design tokens except `--danger-badge-bg`.

## I/O & Edge-Case Matrix

| Scenario | UI Behavior |
|----------|-------------|
| Receptionist signs in (W10) | App.tsx routes to `<ReceptionistApp />` → today view. |
| Today, load | GET `/reception/branch/today` renders the hour-grouped list. |
| Today, filter changes (status / doctor / date) | 250ms debounced refetch with the matching query params. |
| Today, search typed | Client-side filter on `patient_phone` (the only field the API exposes). |
| Today, branch pill | "📍 {branch.name}" — server-locked, ignores any `?branch_id=`. |
| Today, "now" row | Yellow ring on the row containing the current branch-local time. |
| Today, "+ Book walk-in" click | Alert: "Walk-in booking surface is not yet implemented." |
| Today, "Check in" click | Alert: "Patient check-in flow is not yet wired." |
| Today, "Cancel appointment" link | Routes to cancel view (no preselect). |
| Today, "Doctor availability" link | No-op (muted style, click is a no-op with alert). |
| Today, empty list | "No appointments today at Riyadh Olaya." |
| Today, no match for search | "No appointments match `{query}` on Aug 20." |
| Today, 401 / 403 | "Session expired" / "You do not have access to this branch." inline banner. |
| Today, network down | "Connection failed. Is the API running on :3001?" |
| Cancel, no preselect | The first row is auto-selected on load. |
| Cancel, branch with 0 Scheduled rows | "No scheduled appointments today at {branch.name}." |
| Cancel, reason select | Curated list; "Other" requires notes. |
| Cancel, Confirm click | POST `/reception/appointments/:id/cancel` with the reason as a textarea. |
| Cancel, 201 | Auto-dismiss toast (4s) + refetch picker (just-cancelled row is gone). |
| Cancel, 403 outside_branch_scope | "That appointment is not at your branch." |
| Cancel, 422 already_in_terminal_state | "This appointment is no longer Scheduled — refresh the list." |
| Cancel, 400 reason_required | "A reason is required." |
| Cancel, 400 reason_too_long | "Reason is too long (max 500 characters)." |
| Cancel, 404 not_found | "That appointment no longer exists." |
| Cancel, network down | "Connection failed. Is the API running on :3001?" |
| Cancel, "Back" or "Keep appointment" click | Returns to today view, clears preselect. |
| Sign out (any view) | `logout()` + re-render LoginPage. |

## Code Map

- `apps/web/src/api/client.ts` (EDIT) — added `ReceptionistAppointmentStatus`, `ReceptionistTodayAppointment`, `ReceptionistTodayBranch`, `ReceptionistTodayFilters`, `ReceptionistTodayResponse`, `ReceptionistTodayInput`, `getReceptionistToday(input)`; added `ReceptionistCancelInput`, `ReceptionistCancelAppointment`, `ReceptionistCancelResponse`, `receptionistCancel(input)`.
- `apps/web/src/styles/tokens.css` (EDIT) — added `--danger-badge-bg: #fecaca` for the Cancelled / No-Show status pill (mock 13's `pill.cancelled` / `pill.no-show` backgrounds).
- `apps/web/src/pages/recep-utils.ts` (NEW) — `todayIsoLocalIn(tz)`, `formatTimeLocal(iso, tz)`, `formatMonthDay(isoDate)`, `formatDateHeader(isoDate)`, `initialsOf(fullName, fallback)`, `maskPhone(e164)`, `lastNameOf(fullName)`.
- `apps/web/src/pages/ReceptionistFrame.tsx` (NEW) — frame with sticky nav (logo + actor chip + Sign out).
- `apps/web/src/pages/styles/receptionist-frame.css` (NEW) — token-only CSS for the frame.
- `apps/web/src/pages/ReceptionistToday.tsx` (NEW) — today list (hour grouping, toolbar filters, now highlight, status pills).
- `apps/web/src/pages/ReceptionistToday.module.css` (NEW) — token-only CSS for the today view.
- `apps/web/src/pages/ReceptionistCancel.tsx` (NEW) — two-step cancel flow (pick → reason+confirm + toast).
- `apps/web/src/pages/ReceptionistCancel.module.css` (NEW) — token-only CSS for the cancel view.
- `apps/web/src/pages/ReceptionistApp.tsx` (NEW) — internal router between today and cancel.
- `apps/web/src/App.tsx` (EDIT) — receptionist-role bypass to `<ReceptionistApp />`.
- `_bmad-output/implementation-artifacts/spec-5-3-5-4-ui-receptionist-today-cancel.md` (NEW) — this spec.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — story → done.

## Reuse of existing code

- `apps/api/src/routes/receptionist-today.ts` (E5-S4) — `GET /reception/branch/today` is the single source for both the today view and the cancel picker.
- `apps/api/src/routes/staff-receptionist-cancel.ts` (E5-S3) — `POST /reception/appointments/:id/cancel` is the cancel commit; the UI's reason payload matches the server's `{reason: string}` schema (no `recurring_origin` etc).
- `apps/web/src/api/client.ts` `ApiError` + the existing `describeXxxError()` pattern from E3-ui — `describeCancelError` mirrors the same shape.
- `apps/web/src/auth/store.ts` `useAuth()` / `logout()` — the frame's Sign out button is the same affordance every other frame uses.
- `apps/web/src/styles/tokens.css` — every CSS value uses `var(--…)`.
- `docs/design/mockups/v1/mockups/13-recep-today.html` (today + status pills), `15-recep-cancel.html` (cancel stacked-vertical), `26-recep-checkin.html` (walk-in — surface NOT yet shipped, button is a placeholder).

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/api/client.ts` — types + endpoints.
- [x] `apps/web/src/styles/tokens.css` — `--danger-badge-bg` token.
- [x] `apps/web/src/pages/recep-utils.ts` — date / time / masking helpers.
- [x] `apps/web/src/pages/ReceptionistFrame.tsx` — frame.
- [x] `apps/web/src/pages/styles/receptionist-frame.css` — frame styles.
- [x] `apps/web/src/pages/ReceptionistToday.tsx` — today view.
- [x] `apps/web/src/pages/ReceptionistToday.module.css` — today styles.
- [x] `apps/web/src/pages/ReceptionistCancel.tsx` — cancel view.
- [x] `apps/web/src/pages/ReceptionistCancel.module.css` — cancel styles.
- [x] `apps/web/src/pages/ReceptionistApp.tsx` — internal router.
- [x] `apps/web/src/App.tsx` — receptionist-role bypass.
- [x] This spec.
- [x] Sprint status updated.

**Acceptance Criteria:**
- Given a receptionist signs in via W10, then the app routes to the receptionist frame and the today dashboard is shown with the "now" highlight.
- Given the receptionist changes the status / doctor / date filter, the toolbar refetches `/reception/branch/today` with the matching query params after a 250ms debounce.
- Given the receptionist searches a partial phone number, the list filters client-side without re-hitting the API.
- Given the receptionist clicks "View" on a row, then the cancel view opens with that appointment preselected.
- Given the receptionist clicks "Confirm cancellation" with a reason, then `POST /reception/appointments/:id/cancel` fires and a 200 returns the success toast + auto-refetches the picker (just-cancelled row is gone).
- Given a 422 `already_in_terminal_state`, then the cancel view shows "This appointment is no longer Scheduled — refresh the list." inline.
- Given a 400 `reason_required`, then the cancel view shows "A reason is required." inline.
- Given a network-down error, then either view shows "Connection failed. Is the API running on :3001?".
- The "Sign out" button in the receptionist frame clears the auth and returns to the login page.
- Token-only CSS: 0 hex literals outside `tokens.css` in any new file (E7-S1 invariant verified).
- `pnpm --filter @clinic/web typecheck` — 0 new errors.
- `pnpm --filter @clinic/web lint` — 0 new warnings.
- `pnpm --filter @clinic/api typecheck` — 0 new errors (no API changes this pass).

## Spec Change Log

**SC1 — 2026-10-06, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Deferrals

- **D-E5-S-UI-1 — Walk-in booking surface (mock 26).** The "+ Book walk-in" button on the today view is a no-op with an alert. The receptionist book-on-behalf back-end surface is not yet shipped; future story adds `POST /reception/book` (or equivalent) plus the three-step walk-in wizard (patient details → pick doctor + branch + type → slot grid) per mockup 26.
- **D-E5-S-UI-2 — Doctor availability for the receptionist.** The mock 13 "Doctor availability" link is a muted placeholder. Future: the existing `GET /reception/branch/today` plus the doctor schedule surfaces (E2-S1's `GET /admin/doctors/:id/schedule`) combine to render a branch calendar grid.
- **D-E5-S-UI-3 — Patient check-in flow.** The per-row "Check in" button is a no-op with an alert. Future: E5-S1's mark-status back-end (status transition Scheduled → Checked-in) plus a receptionist-only check-in surface — or a unified state machine that bundles check-in with the cancel / no-show / complete flows.
- **D-E5-S-UI-4 — Edit affordances on completed sections.** The cancel view's step 1 stays editable after step 2 opens. A real router (W59) would let the user click "Step 1" to revise the appointment; the internal sub-state preserves that affordance trivially, but the visual edit-link isn't part of mockup 15 (the mockup uses step-state-driven borders only).
- **D-E5-S-UI-5 — Reason select as a free-form enum.** The backend accepts any trimmed string (E5-S3 FR-034). The UI's curated list is a UX nudge toward consistent audit text; a future hardening story could surface a server-driven enum.

## Cross-References

- E5-S3 backend: `spec-5-3-receptionist-cancellation-with-reason.md` (cancel POST)
- E5-S4 backend: `spec-5-4-todays-branch-view-receptionist-dashboard.md` (today GET)
- W10: `spec-w10-staff-login-patient-otp.md` (auth gate)
- E3-ui: `spec-3-ui-patient-booking.md` (PatientFrame pattern — same no-router, internal-state model)
- E7-S3: privacy filter (no patient_name on the receptionist today response)
- W59: router wiring (deferred)