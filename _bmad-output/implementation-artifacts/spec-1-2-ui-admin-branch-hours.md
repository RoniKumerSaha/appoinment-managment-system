---
title: 'E1-S2-ui — Admin Branch Hours (web)'
type: 'feature'
created: '2026-10-06'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'E1-S1-ui (3cc74c7)'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-change-branch-operating-hours.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-1-ui-admin-branches.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
  - '{project-root}/docs/design/DESIGN-SYSTEM.md'
  - '{project-root}/docs/design/mockups/v1/mockups/28-admin-branch-hours-editor.html'
  - '{project-root}/docs/design/mockups/v1/mockups/39-admin-branch-hours-resolution.html'
---

## Intent

**Problem:** E1-S1-ui shipped the admin branches CRUD page, but operating hours are still out of reach for an admin. The E1-S2 backend (`GET/POST/PATCH /admin/branches/:id/hours[-impact]`, frozen in `spec-1-2-change-branch-operating-hours.md`) is already done; what is missing is the web client. Mockup 28 shows the editor with three stacked steps + an inline impact preview after save; mockup 39 shows a separate resolution-tracking page (3 of 5 appointments resolved, doctor progress bars). The API has a one-shot impact preview (POST .../hours-impact) but no background-job / resolution-tracking endpoint — so mockup 39's hero card is mockup-only until E6-S2 ships.

**Approach:** Build `apps/web/src/pages/AdminBranchHours.tsx` as a pixel-perfect port of mockup 28 (three-step stacked flow + inline impact preview as a fourth step card). The page is reached from AdminBranches via an "Edit hours →" link on the step-2 foot. Mockup 39's resolution status page ships with E6-S2 (#16) when the backend has a resolution API. **No tests** are added in this pass (per user instruction).

## Boundaries & Constraints

**Always:**
- Mockup 28 is the source of truth for the visual layout: 980px-wide frame (mockup 28 line 11), top nav (reused from AppShell; the AppShell's `active` stays on "branches" so the nav still highlights Branches), breadcrumb "Admin → Branches → {branch_name} → Hours", H1 "Edit operating hours", subline "Changes flag future appointments that fall outside new hours. Status is preserved; doctors see a Resolve badge.", `← Back to branches` ghost button.
- Three step cards on the page:
  - **Step 1** — Branch context: two picker cards. Left = `{branch.name, "Active · hours-only edit"}`. Right = editable `address` input. Below: timezone input + "Effective from" read-only.
  - **Step 2** — Weekly hours: 7-row table (Sun..Sat) × {Open, Close, Status}. Each row has two `<input type="time">` controls + an `Open / Closed` toggle. The toggle is a label + hidden checkbox + CSS switch (mockup 28 lines 49-52). Dirty rows highlight with the warning tint + a leading `●` (mockup 28 lines 54-55). Summary bar at the bottom: total per-week hours + open-days count + "Effective" timestamp.
  - **Step 3** — Save & preview impact: lead paragraph + Cancel / Save & preview impact buttons. Foot: "Audit row preview: `branch.hours_changed`, actor=admin, metadata=`{sat: 09–13}`" (mockup 28 line 195 verbatim).
  - **Step 4** — Inline impact preview (only renders after Step 3 succeeds). Hero copy + a 2-tile summary (count_affected, doctor-ack flag) + affected-doctors breakdown (counts only per BR-065) + affected-list footer when `?include_affected=true`. When `requires_doctor_acknowledgement: true`, a "Cancel / Acknowledge & save" pair re-PATCHes with `?acknowledge_doctor_impact=true`. Privacy note surfaces the BR-065 rule (counts only, no patient PII, status preserved).
- The page is unreachable from the top nav. It's reached via the "Edit hours →" link on AdminBranches step-2 foot, and the "← Back to branches" button returns to the AdminBranches list. App.tsx carries an `AdminSubPage` state (`{key: 'branch-hours', branchId}`) layered on top of the existing `AdminSection` state; the AppShell's `active` stays on "branches" so the nav highlight is preserved.
- API surface consumed (E1-S2 backend, `apps/api/src/routes/admin-branch-hours.ts`):
  - `GET /admin/branches/:id/hours` → `{branch_id, tz, address, hours[7]}`
  - `POST /admin/branches/:id/hours-impact` body `{hours}` (per SC1 amendment; the spec's original GET-with-body was awkward) → `{count_affected, affected?, affected_doctors, requires_doctor_acknowledgement}`
  - `PATCH /admin/branches/:id/hours` body `{hours?, tz?}` query `?acknowledge_doctor_impact=true|false` → `{branch, hours[7], impact}`
  - The page does NOT use `getBranch` (the API has it but it's redundant with `getBranchHours`). Wait — it does, to populate the breadcrumb + step-1 picker card with `name` + `active`.
- API error envelopes translated to UI messages via `describeApiError()`:
  - `400 invalid_branch_id` → "Invalid branch id."
  - `400 invalid_hours_length` → "Hours must cover all 7 days."
  - `400 invalid_day_of_week` → "Day-of-week must be 0..6 with each day present exactly once."
  - `400 invalid_time_range` → "Open time must be earlier than close time on an open day."
  - `400 invalid_timezone` → "Timezone is not a valid IANA name."
  - `400 no_fields_to_update` → "Nothing to save."
  - `400 unknown_field` → "Unsupported field sent to the API."
  - `404 branch_not_found` → "That branch no longer exists."
  - `409 appointments_outside_hours` → surfaces the impact preview card (server flow included)
  - `0 network_error` → "Connection failed. Is the API running on :3001?"
  - `>= 500` → "Server error. Try again in a moment."
- Hours validation mirrors `admin-branch-hours-helpers.ts`:
  - `open_time < close_time` whenever `is_closed === false`
  - Closed days may carry NULL `open_time` / `close_time`
  - 7 rows exactly; Sun..Sat ordering preserved (the page normalises via `setEdit` ordering)
  - IANA timezone validated client-side via `Intl.DateTimeFormat` round-trip
- The `<input type="time">` controls emit `HH:MM` (24h). The API may return `HH:MM:SS` from Postgres `time` columns — the page normalises via `hhmm()` (strip the seconds).
- The PATCH `?acknowledge_doctor_impact=true` path uses the same `onSave(acknowledge)` callback as the regular save; the body is identical. The acknowledge flag is a query param, not a body field.
- The page re-fetches `getBranch` + `getBranchHours` on mount and after each successful save. The local `edit[]` mirrors the response's canonical ordering.
- Every visual value in the page CSS references a `var(--…)` token. Hex literals live ONLY in `apps/web/src/styles/tokens.css`.
- `prefers-reduced-motion` strips all transitions globally (set in `tokens.css`).
- No new tests in this pass (per user instruction).

**Ask First:**
- **A1 (resolved this run) — Resolution status page.** User chose "Editor only (Recommended)": ship the editor (mockup 28) wired end-to-end. "Save & preview impact" calls `POST .../hours-impact` and shows the impact preview inline as a fourth step card. Mockup 39's resolution-tracking page ships with E6-S2 (#16) when the backend has a resolution API.
- **A2 — Impact preview granularity.** Mockup 08's full impact-preview screen (mocks/08-branch-hours-impact.html) shows the affected appointment list (id, start/end, doctor, type, reason) when `?include_affected=true`. The current pass renders the preview as counts + doctor breakdown only (BR-065 privacy). When the count > 0, the affected-list is shown only if the API returned `affected` in the response (the `include_affected=true` flag). The flag is not flipped in this pass — the page always requests counts-only. (Future: a "Show affected appointments" toggle that re-issues the request with `include_affected=true`.)
- **A3 — Doctor-not-at-branch path.** The spec lists two sub-paths: (i) impact count > 0 with `requires_doctor_acknowledgement: false` → 409 rollback, no commit path; (ii) impact count > 0 with `requires_doctor_acknowledgement: true` → 409 rollback, admin re-PATCHes with `?acknowledge_doctor_impact=true` to commit. This UI story ships the second path only; the first path surfaces the count + affected-doctors list as a hard-stop. (Both paths use the same step-4 card; the acknowledge button only renders in the second case.)

## I/O & Edge-Case Matrix

| # | Trigger | API behaviour | Web behaviour |
|---|---------|--------------|---------------|
| 1 | Page mount | `GET /admin/branches/:id` 200 + `GET /admin/branches/:id/hours` 200 | Step 1 + Step 2 fill with branch metadata + 7 hours rows; "← Back to branches" |
| 2 | Page mount, no auth | — | LoginPage renders (W10 auth wall) |
| 3 | Toggle a day's Open/Closed | — | Row's time inputs disable/enable; row re-skin tint |
| 4 | Edit an open time / close time | — | Row turns amber (`tr.changed`); total-hours bar updates |
| 5 | Save with dirty hours, no impact | `PATCH .../hours` 200, `count_affected: 0` | Step 4 renders with "No appointments affected" |
| 6 | Save with dirty hours, 5 future Scheduled appts outside window, no doctors at branch | `PATCH .../hours` 409 `appointments_outside_hours`, `impact: {count_affected: 5, requires_doctor_acknowledgement: false}` | Step 4 renders the count + affected-doctors (likely empty list); NO acknowledge button; "Saved" not shown; editor stays dirty |
| 7 | Save with dirty hours, 5 future Scheduled appts, doctor assigned at branch | `PATCH .../hours` 409 `appointments_outside_hours`, `impact: {count_affected: 5, requires_doctor_acknowledgement: true, affected_doctors: [{doctor_id, doctor_name, count: 5}]}` | Step 4 renders with count + doctor breakdown + "Acknowledge & save" button |
| 8 | Click "Acknowledge & save" | `PATCH .../hours?acknowledge_doctor_impact=true` 200 | Same as #5 but with the doctor-ack acknowledged |
| 9 | Save with empty hours (post-validation) | — | "Hours must cover all 7 days." inline error |
| 10 | Save with `open_time >= close_time` | — | "Open time must be earlier than close time on an open day." inline |
| 11 | Save with invalid tz | — | "Timezone is not a valid IANA name." inline |
| 12 | Discard changes | — | Editor reverts to `original`; impact banner removed |
| 13 | Back to branches | — | Returns to AdminBranches (E1-S1-ui) |
| 14 | Network down | Connection refused → `ApiError(0, 'network_error')` | "Connection failed. Is the API running on :3001?" |
| 15 | Sign-in as doctor / receptionist | adminScope middleware 403 | `403 forbidden_role` surfaces as "Server error. Try again in a moment." |

## Code Map

**Web (new / edited):**
- `apps/web/src/api/client.ts` (EDIT) — `HoursRow`, `BranchHoursDto`, `AffectedAppointment`, `AffectedDoctor`, `HoursImpactSummary`, `BranchHoursCommitResponse` types + 3 new endpoints: `getBranchHours`, `previewBranchHoursImpact`, `patchBranchHours`. The `request()` helper's 401-handling already re-routes to LoginPage.
- `apps/web/src/pages/AdminBranchHours.tsx` (NEW) — the page. State slots: `branch`, `originalAddress`, `original[]`, `edit[]`, `address`, `tz`, `loading`, `loadErr`, `busy`, `formErr`, `impact`, `savedAt`, `impactExpanded`. Helpers: `describeApiError()`, `hhmm()`, `buildDefaultHours()`, `rowsEqual()`, `totalHoursThisWeek()`, `formatAppointmentLine()`. Inline impact preview card with conditional acknowledge affordance.
- `apps/web/src/pages/AdminBranchHours.module.css` (NEW) — pixel-perfect mockup 28 port. Token-only.
- `apps/web/src/AppShell.tsx` (EDIT) — exports `AdminSubPage` interface so App.tsx can carry sub-page state.
- `apps/web/src/App.tsx` (EDIT) — adds `sub: AdminSubPage | null` state + `onOpenBranchHours(branchId)` + `onBackToBranches()` callbacks. Renders `<AdminBranchHours branchId onBackToBranches />` when `sub?.key === 'branch-hours'`.
- `apps/web/src/pages/AdminBranches.tsx` (EDIT) — adds optional `onOpenBranchHours?: (branchId: string) => void` prop; renders an "Edit hours →" link in the step-2 audit row when in edit mode.
- `apps/web/src/pages/AdminBranches.module.css` (EDIT) — adds `.audit-link` rule (transparent button styled as the brand-primary link).

**Spec (new):**
- `_bmad-output/implementation-artifacts/spec-1-2-ui-admin-branch-hours.md` (NEW) — this file.

**Sprint status (edited):**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — `1-2-ui-admin-branch-hours: done` under epic-1; comment block.

## Reuse of existing code

- `apps/web/src/api/client.ts` `request()` helper — every new endpoint just calls `request<...>(...)`.
- `apps/web/src/auth/store.ts` `useAuth()` — same pattern ClinicSettings + AdminBranches use for the user chip.
- `apps/web/src/styles/tokens.css` — every value via `var(--…)`. No new tokens needed.
- `apps/web/src/pages/LoginPage.module.css` / `AdminBranches.module.css` `.btn-primary` / `.btn-ghost` patterns — mirrored in `AdminBranchHours.module.css`.
- `apps/web/src/pages/ClinicSettings.tsx` + `AdminBranches.tsx` — same controlled-input + dirty-state + `ApiError` surface pattern (form `busy` state, `formErr` envelope).
- `apps/api/src/routes/admin-branch-hours.ts` — the error codes (`invalid_branch_id`, `invalid_hours_length`, `invalid_day_of_week`, `invalid_time_range`, `invalid_timezone`, `branch_not_found`, `appointments_outside_hours`, `no_fields_to_update`, `unknown_field`) are mirrored verbatim in the page's `describeApiError()` helper.
- `apps/api/src/routes/admin-branch-hours-helpers.ts` — `isValidTime`, `isValidDayOfWeek`, `validateHoursArray`, `isValidTimezone` semantics re-implemented in the page for client-side pre-validation (the server is still the source of truth; client validation is for UX responsiveness).
- `docs/design/mockups/v1/mockups/28-admin-branch-hours-editor.html` — pixel reference.
- `docs/design/DESIGN-SYSTEM.md` — token references throughout.

## Verification (manual, no tests in this pass per user instruction)

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001); `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Open `http://localhost:5173/`. Sign in as `admin-main@clinic.local` / admin. Lands on ClinicSettings (default).
3. Click "Branches" → step 1 lists the seeded branches; click one → step 2 shows it.
4. Click "Edit hours →" in the step-2 audit row → AdminBranchHours renders.
5. Step 1 shows the branch metadata + address (NULL) + tz (e.g. `America/New_York` for east / `Asia/Riyadh` for west). Step 2 shows 7 rows with the seeded hours (Sun closed, Mon-Sat 09:00–17:00).
6. **Toggle Wed → closed.** Wed row turns off (grey); right column swaps the time inputs for "Closed".
7. **Narrow Sat close from 17:00 → 13:00.** Sat row turns amber; summary bar shows "Was: 17:00 / Now: 13:00 (computed via dirty compare)".
8. **Save & preview impact.** With no future Scheduled appts outside the new window (clean seed), Step 4 renders "No appointments affected". Step 3's step-num advances to "done".
9. **Reload** → the saved hours persist; Step 4 stays open with the prior save summary.
10. **Back to branches** → returns to AdminBranches.
11. **Validation.** Edit Mon to `open_time=17:00, close_time=09:00`. Save → "Open time must be earlier than close time on an open day." inline.
12. **Validation.** Edit tz to `Mars/Olympus_Mons`. Save → "Timezone is not a valid IANA name." inline.
13. **Impact path.** Seed a future appointment outside the new window via the API; re-edit hours so the appt falls outside. Save → 409 `appointments_outside_hours`; Step 4 shows the count. If the appointment belongs to a doctor at the branch, the doctor-ack flag is `true` and the "Acknowledge & save" button renders.
14. **Doctor-ack path.** Click "Acknowledge & save" → re-PATCH with `?acknowledge_doctor_impact=true` → 200; the count surfaces as the impact `count_affected` in the response.
15. **No regressions.** Sign in as a doctor / receptionist → can't reach this page (the adminScope middleware 403s). Sign in as the original admin and revisit AdminBranches — the "Edit hours →" link still works.
16. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline in `src/otp/{provider,service,twilio-provider}.ts` unchanged).
17. `pnpm --filter @clinic/web typecheck` — 0 errors.
18. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline in `ClinicSettings.tsx` unchanged).
19. Grep `apps/web/src` for hex literals / rgba outside `tokens.css` → 0 (E7-S1 invariant).

## Spec Change Log

- 2026-10-06 — initial spec (Amelia / E1-S2-ui). Done.

## Deferrals

- **E1-S2-ui-defer-a — Resolution-tracking page (mockup 39).** Today the impact preview renders as a step-4 card inline. The full mockup 39 resolution status page ("3 of 5 appointments resolved", doctor progress bars, audit log) ships with E6-S2 (#16) when the backend has a resolution API.
- **E1-S2-ui-defer-b — Affected-appointment list (mockup 08).** Today the impact preview returns counts + doctor breakdown only (BR-065). The `?include_affected=true` flag is plumbed in the API client but not flipped in this pass; a future story adds a "Show affected appointments" toggle on the step-4 card.
- **E1-S2-ui-defer-c — Audit row writes for `branch.hours_changed`.** The step-3 audit-row text is mockup 28 line 195 verbatim. Real audit row writes are deferred to E7 (#17).
- **E1-S2-ui-defer-d — Future-date / effective-from date input.** Mockup 28 step 1 shows a read-only "Effective from" picker; this UI story renders the "Effective from" picker as read-only with the current time. A future story adds a calendar input for scheduling future-dated hours changes (the spec doesn't define this for E1-S2).
- **E1-S2-ui-defer-e — Doctor + future-appt counts in the step-1 picker.** Today the picker reads "Active · hours-only edit" with no counts; the doctor / future-appt counts land with E1-S3 (#12) and E3-S1 (#13) respectively.
- **E1-S2-ui-defer-f — Router.** Today `App.tsx` uses a local `useState<AdminSubPage>` to switch between AdminBranches and AdminBranchHours. W59 / #22 introduces a real router (probably `react-router-dom` or `wouter`) that handles sub-page state via the URL.
- **E1-S2-ui-defer-g — Status-toggle rendering for closed days.** When a day is toggled to "Closed", the row's time inputs are disabled and the row re-skins to grey. Mockup 28's "Closed" state shows just a single "— Closed —" cell spanning both time columns; this pass renders the disabled inputs (simpler visual, same accessibility surface).
- **E1-S2-ui-defer-h — Global ConflictModal extraction.** Today the impact preview card is inlined in `AdminBranchHours.tsx`. E7-S4 (#26) extracts a reusable `<ConflictModal />` component when a second story needs it; the impact preview is its own pattern (preview + retry vs. modal-hide).

## Cross-References

- `spec-1-2-change-branch-operating-hours.md` — the API surface this UI consumes (frozen spec).
- `spec-1-1-ui-admin-branches.md` — the parent page this one nests under.
- `spec-w10-staff-login-patient-otp.md` — the auth wall this page sits behind.
- `epic-1-context.md` — the W59 router deferral that E1-S2-ui-defer-f extends.
- `docs/design/DESIGN-SYSTEM.md` §2.4 (semantic surfaces), §3.1 (typography), §4 (spacing), §5 (radius), §6 (elevation).
- `docs/design/mockups/v1/mockups/28-admin-branch-hours-editor.html` — pixel reference (editor).
- `docs/design/mockups/v1/mockups/39-admin-branch-hours-resolution.html` — pixel reference for the deferred resolution status page.
- `docs/design/mockups/v1/mockups/08-branch-hours-impact.html` — pixel reference for the deferred impact detail screen.
- `apps/api/src/routes/admin-branch-hours.ts` — the route surface.
- `apps/web/src/api/client.ts` — the API client used by this page.
- `apps/web/src/AppShell.tsx` — the nav this page sits inside.
- `apps/web/src/pages/AdminBranches.tsx` — the parent page that links to this one.