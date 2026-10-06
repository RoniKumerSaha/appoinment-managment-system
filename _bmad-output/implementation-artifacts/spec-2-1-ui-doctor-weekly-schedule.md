---
title: 'E2-S1 UI — Admin Doctor Weekly Schedule (multi-period days)'
type: 'feature'
created: '2026-10-06'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-2-1-configure-doctor-weekly-schedule.md'
  - '_bmad-output/implementation-artifacts/spec-1-3-create-deactivate-assign-branch-doctors.md'
  - '_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
---

## Intent

**Problem:** The E2-S1 backend route family (`GET/POST /admin/doctors/:id/schedule` + `POST /admin/doctors/:id/schedule-impact`) shipped in spec-2-1 but the web client has no surface to drive it. The admin clinic settings page exists, but a doctor's weekly schedule is only editable from raw SQL today.

**Approach:** Add a pixel-perfect port of mockup 09 (`docs/design/mockups/v1/mockups/09-doctor-schedule.html`) — a 1200px-wide 2-column layout with a 320px form-col on the left (branch + effective-from + summary card + Save button) and the schedule editor on the right (day-tabs + per-day period cards + outside-branch-hours warning). The page is reached from a new "Schedule" button on each doctor card in `AdminDoctors.tsx` and lives at `admin/doctors/<id>/schedule` as a sub-page under the existing `Doctors` section (mirrors how `AdminDoctorAssign` is reached from the "Assign" button).

The mockup title labels it the "Doctor view" but the API is gated by `adminScope` (E0-S3 staff JWT with role=admin). Today every editor in the app is admin-scoped; the doctor-scoped equivalent is deferred to when role-based nav ships (E1-S0a follow-up). The same routes work either way — `req.auth.claim.role` is what `adminScope` checks.

## Boundaries & Constraints

**Always:**
- Page is reached from `<AdminDoctors />` via `onOpenDoctorSchedule(doctorId)`.
- AppShell's `active` stays on `'doctors'` so the nav still highlights Doctors.
- Loads `getDoctor()`, `getDoctorSchedule()`, and per-branch `getBranchHours()` in parallel on mount. Branch hours are needed for the outside-branch-hours warning (UX-FLOWS F-06).
- Effective-from is **read-only** and shows tomorrow's date in `Aug 18, 2026 (tomorrow)` form. FR-010 requires tomorrow minimum; "apply immediately" is not a path. The `effective_from` field on every row is set to the same tomorrow value client-side; the API re-validates and 400s if not.
- Branch select is shown only when the doctor works at >1 branch. With 1 branch, the branch is rendered as a static label (matches mockup 09's "Branch A — Downtown" rendering).
- Day-tabs span Sun..Sat matching Postgres EXTRACT DOW convention (0=Sun, 6=Sat). Each tab shows the period count for that day; days with 0 periods read "0 · off". Active day has `--brand-light-50` background.
- Each period card is numbered (1..N for the active day), shows `HH:MM – HH:MM` + a derived "Morning block / Afternoon block / Evening block" label + duration in hours.
- Inline edit per period: clicking Edit replaces the time row with two `<input type="time">` fields + Save/Cancel. Split inserts a new row at the mid-time of the existing one (or falls through to Edit if the period is too short to split). Delete drops the row.
- Outside-branch-hours warning card (UX-FLOWS F-06) appears when any working period falls outside the branch's operating window (open_time/close_time for that day_of_week, ignoring closed days). The card offers [Adjust periods] (focuses the first outside period in edit mode) and [Continue anyway] (cosmetic dismiss; save still routes through form submit).
- Impact preview (E2-S1's "schedule_invalidates_future_appointments" 409) is surfaced inline before commit: the page POSTs `/schedule-impact` first; if `future_appointment_count > 0`, the page renders a warning banner listing the masked affected appointments + a "Continue anyway" checkbox that must be ticked before re-saving.
- Toast: "Schedule saved." appears for 3s after a successful save (mockup 09 lines 73-75 / UX-FLOWS F-06).
- Save button is disabled when there are no periods to save (matches the "Saving replaces the schedule in full" semantics).
- Discard button is **always enabled** (it's a re-fetch from the server, not a diff-discard) — labels match the E1-S1/E1-S2/E1-S3/E1-S4 pages.
- All API errors are mapped through `describeApiError()` with friendly text for `invalid_schedule_row`, `schedule_rows_overlap`, `branch_not_in_doctor_branches`, `schedule_invalidates_future_appointments`, `invalid_rows`, `unknown_field`, `network_error`, 5xx.
- Token-only CSS via `var(--…)` (E7-S1 invariant).

**Ask First:**
- (none — all scope decisions resolved at plan-time. Role-based nav section for "Doctors (their schedule)" is deferred to E1-S0a follow-up.)

**Never:**
- No doctor-side nav. The API is admin-scoped; today every editor is admin-driven.
- No actual delete for periods that have future appointments — the impact preview already gates the commit at the API layer (409 schedule_invalidates_future_appointments). The UI mirrors that with the "Continue anyway" checkbox.
- No "apply immediately" / effective_from=today path. FR-010 requires tomorrow minimum.
- No PATCH route use (the spec-2-1 PATCH route is out of scope; full-set replace only).
- No block-time sub-page (E2-S2 owns that).
- No audit row writes (E7-S2 deferred).
- No new design tokens — every value uses `var(--…)` from `styles/tokens.css`.

## I/O & Edge-Case Matrix

| Scenario | UI Behavior |
|----------|-------------|
| Page mount | — |
| Page mount, no schedule rows yet | Branch select (or label), day-tabs all "0 · off", day-empty hint "No periods on Monday. Add one below.", "+ Add" dashed card visible. Save disabled. |
| Add period (active day=Mon) | New card with 09:00–13:00 + inline edit mode open. Day-tab count updates. Save re-enabled. |
| Edit period | Replace time row with two `<input type="time">` + Save/Cancel buttons. Save persists the change to working state. Cancel reverts. |
| Split period | Insert a new row at mid-time; the existing row is shortened to [start, mid). If the period is too short, fall through to Edit mode. |
| Delete period | Drop the row. Day-tab count decrements. If the active day hits 0 periods, the day-empty hint re-appears. |
| Switch day | `activeDay` updates; day-rows recompute. |
| Switch branch (multi-branch doctor) | `selectedBranchId` updates; `branchRows` filters to the new branch. Day-tabs recount. The summary card updates. |
| Outside-branch-hours warning | Rendered when any working period's start/end falls outside the branch's `hours[dow].open_time/close_time`. Adjust focuses the first offending period in edit mode. |
| Save, clean | `preview` returns 0 → `commit` 201 → reload → toast "Schedule saved." → affectedPreview clears. |
| Save, with impact | `preview` returns ≥1 → render warning banner + "Continue anyway" checkbox (must be ticked to re-submit). User clicks Save again → `commit` 201. |
| Save, 409 from commit (shouldn't happen if preview is the gate, but defense-in-depth) | Render the error envelope inline. |
| Save, 400 invalid_schedule_row | Render the API code → friendly message. |
| Save, 400 schedule_rows_overlap | "Two periods overlap on the same day — please adjust." |
| Save, 400 branch_not_in_doctor_branches | "A period uses a branch the doctor is not assigned to." |
| Save, network down | "Connection failed. Is the API running on :3001?" |
| Discard | Reload from the server. Working state is restored. Form errors clear. |
| Back to doctors | AppShell active stays 'doctors'; sub clears; `AdminDoctors` re-renders. |
| Loading | "Loading schedule…" placeholder (same pattern as E1-S3 ui). |
| Load error | Error banner + "← Back to doctors" ghost button (matches AdminDoctorAssign). |

## Code Map

- `apps/web/src/api/client.ts` (EDIT) — added `ScheduleRowDto`, `DoctorScheduleDto`, `AffectedScheduleAppointment`, `DoctorScheduleImpactResponse`, `DoctorScheduleCommitResponse`; added `getDoctorSchedule`, `previewDoctorScheduleImpact`, `postDoctorSchedule`.
- `apps/web/src/AppShell.tsx` (EDIT) — extended `AdminSubPage` union with `{key: 'doctor-schedule', doctorId: string}`.
- `apps/web/src/App.tsx` (EDIT) — imported `AdminDoctorSchedule`; added `onOpenDoctorSchedule` callback; renders the new sub-page when `sub?.key === 'doctor-schedule'`; passes the new callback into `AdminDoctors`.
- `apps/web/src/pages/AdminDoctors.tsx` (EDIT) — accepted `onOpenDoctorSchedule` prop; added a "Schedule" action button on each card (after "Assign", before "Deactivate"); the button is disabled when no callback is provided.
- `apps/web/src/pages/AdminDoctorSchedule.tsx` (NEW) — pixel-perfect mockup 09 port.
- `apps/web/src/pages/AdminDoctorSchedule.module.css` (NEW) — token-only CSS.
- `_bmad-output/implementation-artifacts/spec-2-1-ui-doctor-weekly-schedule.md` (NEW) — this spec.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — story → done.

## Reuse of existing code

- `apps/web/src/api/client.ts` `getDoctor` / `getBranchHours` — unchanged from E1-S2 / E1-S3.
- `apps/web/src/api/client.ts` `ApiError` + `describeApiError()` pattern — same shape as E1-S2/E1-S3/E1-S4.
- `apps/web/src/pages/AdminDoctorAssign.tsx` — the file chrome (back button, crumb, page-header__row, sub-page wiring) is structurally identical. The Schedule page reuses the same shape.
- `apps/web/src/styles/tokens.css` — every CSS value is `var(--…)` (--container-wide: 1200px-ish, --text-3xs/2xs/xs/sm/md/lg/xl/3xl, --space-*, --radius-*, --brand-*, --surface-*, --warning-*, --danger-*, --success-*, --text-*, --font-mono, --ring-focus, --elev-2).
- `docs/design/mockups/v1/mockups/09-doctor-schedule.html` — pixel-perfect port (frame 1200px, grid 320px/1fr, day-tab active style, period-card layout, outside-hours warning card, toast top-right auto-dismiss).

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/api/client.ts` — endpoints + types.
- [x] `apps/web/src/AppShell.tsx` — extended `AdminSubPage`.
- [x] `apps/web/src/App.tsx` — wire sub-page + callback.
- [x] `apps/web/src/pages/AdminDoctors.tsx` — Schedule button + callback.
- [x] `apps/web/src/pages/AdminDoctorSchedule.tsx` — new page.
- [x] `apps/web/src/pages/AdminDoctorSchedule.module.css` — new styles.
- [x] This spec.
- [x] Sprint status updated.

**Acceptance Criteria:**
- Given a doctor with no schedule rows, when the Schedule button is clicked, then the page renders with day-tabs all "0 · off" and Save disabled.
- Given a doctor with 2 schedule rows (Mon 09:00–13:00 + 14:00–17:00), when the page loads, then Mon tab shows "2 periods", Mon day shows both period cards with derived "Morning block · 4h" + "Afternoon block · 3h" meta lines, Tue..Sun show "0 · off".
- Given a multi-branch doctor, when the page loads, then a Branch select dropdown is rendered with one option per branch; switching branches refilters the day-tabs + period cards.
- Given an "Edit" click on a period, then the card flips into inline-edit mode with two `<input type="time">` fields + Save/Cancel; Save persists the change in working state.
- Given a "Split" click on a 09:00–17:00 period, then the existing row shrinks to 09:00–13:00 and a new row 13:00–17:00 is appended.
- Given a "Delete" click, then the row is removed and the day-tab count decrements.
- Given a "+ Add another period" click, then a new 09:00–13:00 row is appended on the active day in inline-edit mode.
- Given any working period that falls outside the branch's operating window, then the outside-hours warning card is rendered with [Adjust periods] (focuses the first offending period) and [Continue anyway] (cosmetic dismiss).
- Given a Save with a clean preview, then `POST /schedule-impact` returns 0, `POST /schedule` returns 201, and a toast "Schedule saved." appears for 3s.
- Given a Save with an impact preview > 0 and the user has not ticked the "Continue anyway" checkbox, then the impact warning banner is rendered (with masked phone + branch + start_datetime + status rows) and the commit is **not** issued.
- Given a Save with impact > 0 and the checkbox ticked, then the commit goes through and the toast appears.
- Given any 4xx from the API (invalid_schedule_row / schedule_rows_overlap / branch_not_in_doctor_branches / schedule_invalidates_future_appointments / invalid_rows / unknown_field / doctor_not_found / invalid_doctor_id), then `describeApiError` maps it to a friendly inline error banner.
- Given a network-down error, then "Connection failed. Is the API running on :3001?" appears.
- Given a successful load + Discard click, then the page reloads from the server (working state restored, form errors cleared).
- Given a "← Back to doctors" click, then the AppShell's `active` stays 'doctors' and `AdminDoctors` re-renders.
- Token-only CSS: no hex literals outside `tokens.css`.
- `pnpm --filter @clinic/web typecheck` — 0 new errors.
- `pnpm --filter @clinic/web lint` — 0 new warnings.

## Spec Change Log

**SC1 — 2026-10-06, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Deferrals

- **D-S1-1 — Doctor-scoped schedule editor.** Today the page is reached from the admin Doctors section because the API is gated by `adminScope`. The natural doctor-self view (mockup 09 is titled "Schedule: List by Day with Tabs" and shows the doctor's initials in the nav chip) lives behind a role-based nav once E1-S0a lands. The same `/admin/doctors/:id/schedule` routes can be repurposed behind a doctor-scoped equivalent (e.g. `/doctor/schedule`) when the doctor JWT carries `doctor_id: <self>`. Spec-only; no code change.
- **D-S1-2 — TZ-aware outside-hours warning.** The outside-hours check uses `branch.tz` only when branch hours are populated; the day-of-week comparison is wall-clock (matches the spec-2-1 SC log D2 deferral to E3-S1). When E3-S1 lands the availability engine, the warning should re-compute against branch-local TZ. Spec-only; the current behaviour is correct for the API's UTC-as-working-plane.

## Cross-References

- E2-S1 backend: `spec-2-1-configure-doctor-weekly-schedule.md`
- E1-S3 admin doctors: `spec-1-3-ui-admin-doctors.md` (the parent page where the "Schedule" button lives)
- E1-S3 admin doctor assign: `spec-1-3-ui-admin-doctors.md` (sibling sub-page; same code pattern)
- UX-FLOWS F-06: outside-branch-hours warning
- UX-FLOWS FR-010: effective_from >= tomorrow minimum
- BR-007: multiple periods per day allowed (the day-tab + period card layout encodes this)