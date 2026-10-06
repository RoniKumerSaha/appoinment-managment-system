---
title: 'E1-S3-ui — Admin Doctors (web)'
type: 'feature'
created: '2026-10-06'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'E1-S4-ui (f1ff503)'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-create-deactivate-assign-branch-doctors.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-ui-admin-receptionists.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-ui-admin-branch-hours.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
  - '{project-root}/docs/design/DESIGN-SYSTEM.md'
  - '{project-root}/docs/design/mockups/v1/mockups/18-admin-doctors.html'
  - '{project-root}/docs/design/mockups/v1/mockups/31-admin-doctors-reassign.html'
---

## Intent

**Problem:** E1-S3 backend (`POST/GET/GET-by-id /admin/doctors`, `PATCH /admin/doctors/:id`, `PUT /admin/doctors/:id/branches`, frozen in `spec-1-3-create-deactivate-assign-branch-doctors.md`) is done. The web client has no admin page for doctors. Two mockups: mockup 18 (card grid) and mockup 31 (Reassign branches multi-select editor). Doctors can work at multiple branches within the singleton clinic (BR-002 single-clinic anchor + multi-branch via the `doctor_branch` junction table).

**Approach:** Build `apps/web/src/pages/AdminDoctors.tsx` (mockup 18 port — card grid + filter bar + in-page modal for create/edit) and `apps/web/src/pages/AdminDoctorAssign.tsx` (mockup 31 port — focused multi-select branch editor as the route layer behind the card's "Assign" button). F-18 non-blocking deactivate surfaces the API's `warning` + `future_appointment_count` as a yellow warning banner (same pattern as E1-S4-ui receptionists). **No tests** are added in this pass (per user instruction).

## Boundaries & Constraints

**Always:**
- Mockup 18 is the source of truth for the card-grid page: 1300px-wide frame (mockup 18 line 11; uses the existing `--container-grid` token), top nav (reused from AppShell; the AppShell's `active` stays on "doctors" so the nav highlights Doctors), breadcrumb "Admin → Doctors", H1 "Doctors", subline "X active · Y inactive · assigned across N branches".
- Filter bar: search input + All/Active/Inactive segmented toggle with live counts + branch select. Same pattern as AdminReceptionists.
- Card grid: `grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px`. Each card: head (avatar with initials, 44px vs receptionists' 48px) + name + email + Active/Inactive pill + "Branches" label + branch chips (multi-branch) + 2-cell stats grid (placeholder values for Future appts + Specialty) + 3 action buttons (Edit / Assign / Deactivate). Inactive cards: `opacity: 0.7`, grey background.
- Avatar initials strip the "Dr. " prefix so the displayed initials ("AR") align with the displayed name ("Dr. Ahmed Al-Rashid"). This is the only place a prefix-aware initials helper is used in the codebase today.
- "+ Add" card at the end of the grid.
- Create modal: full_name + email + branch multi-select checkboxes (≥1 required) + status (always Active on create; toggle hidden in create mode). On submit → `POST /admin/doctors`.
- Edit modal: full_name + email + status toggle. The branch checkbox grid is intentionally absent in edit mode — branch reassignment happens on the Assign sub-page (PUT /branches). The dirty-state check uses the loaded doctor's `branches` to detect branch changes (intentionally a no-op since the edit modal can't touch branches — see Deferral d).
- The "Assign" button on each card opens the dedicated `<AdminDoctorAssign doctorId onBackToDoctors />` sub-page (mockup 31). The button is wired to the `onOpenDoctorAssign` callback provided by App.tsx via the `AdminSubPage` state.
- AdminDoctorAssign page: 980px frame (mockup 31 line 11) — narrower than the card grid because this is a focused editor. Three step cards: doctor context (read-only doctor card) + clinic & branch assignment (locked clinic + effective picker + branch multi-select grid) + save & audit (lead paragraph + Discard / Save buttons + audit row preview text).
- Branch multi-select grid: `branch-row` is a styled checkbox row with a tick-box that flips colour on selection. Each row shows the branch name + meta line (active/inactive + future placeholders for doctor / appointment counts).
- API surface consumed (E1-S3 backend, `apps/api/src/routes/admin-branch-doctors.ts`):
  - `POST /admin/doctors` body `{full_name, email, branch_ids}` → `201 DoctorWithBranches`
  - `GET /admin/doctors[?active=true|false&branch_id=<uuid>]` → `200 DoctorWithBranches[]`
  - `GET /admin/doctors/:id` → `200 DoctorWithBranches`
  - `PATCH /admin/doctors/:id` body `{full_name?, active?}` → `200 DoctorWithBranches & {warning?, future_appointment_count?}` (warning + count only emitted when not null)
  - `PUT /admin/doctors/:id/branches` body `{branch_ids}` → `200 DoctorWithBranches`
  - Plus `listBranches()` from E1-S1 to populate the filter select + create modal + Assign page.
- API error envelopes translated to UI messages via `describeApiError()`:
  - `400 invalid_full_name` → "Full name is required and must be 1..120 characters."
  - `400 invalid_email` → "Email must be a valid address (3..254 characters)."
  - `400 invalid_branch_ids` → "At least one branch is required and each id must be a valid UUID."
  - `400 invalid_branch_id` → "A branch id in the list is not a valid UUID."
  - `400 invalid_active` → "Status must be Active or Inactive."
  - `400 branch_not_found` → "One or more branches no longer exist."
  - `400 doctor_not_found` → "That doctor no longer exists."
  - `400 doctor_must_work_at_least_one_branch` → "A doctor must work at least one branch."
  - `409 email_already_exists` → "A doctor with that email already exists. Edit them instead."
  - `400 no_fields_to_update` → "Nothing to save."
  - `400 unknown_field` → "Unsupported field sent to the API."
  - `0 network_error` → "Connection failed. Is the API running on :3001?"
  - `>= 500` → "Server error. Try again in a moment."
- Client-side validation mirrors `admin-branch-doctors-helpers.ts`:
  - `full_name.trim().length` 1..120
  - `EMAIL_RE.test(email)` AND length 3..254
  - `branch_ids` is a non-empty array of UUIDs (per-element check, non-empty check)
- The page re-fetches `listDoctors` + `listBranches` on mount and after every successful save / deactivate / reactivate. The local `editFullName` / `editEmail` / `editActive` mirror the response's canonical values after a successful PATCH.
- The AdminDoctorAssign page re-fetches `getDoctor` + `listBranches` on mount and after every successful PUT. The local `selectedIds` Set mirrors the response's canonical `branches[].id` set after a successful PUT.
- Every visual value in the page CSS references a `var(--…)` token. Hex literals live ONLY in `apps/web/src/styles/tokens.css`.
- `prefers-reduced-motion` strips all transitions globally (set in `tokens.css`).
- No new tests in this pass (per user instruction).

**Ask First:**
- (none — all scope decisions resolved at plan-time via epic-1-context.md + the E1-S3 spec.)

## I/O & Edge-Case Matrix

| # | Trigger | API behaviour | Web behaviour |
|---|---------|--------------|---------------|
| 1 | Page mount | `GET /admin/doctors` 200 + `GET /admin/branches` 200 | Filter bar + card grid + "+ Add" card; counts in the subline + segmented badge |
| 2 | Page mount, no auth | — | LoginPage renders (W10 auth wall) |
| 3 | Search "Ah" | — | Grid filters to doctors with "Ah" in name or email (client-side) |
| 4 | Click "Active (9)" segmented button | — | Grid filters to active rows only |
| 5 | Pick a branch from the select | — | Grid filters to doctors assigned to that branch |
| 6 | Click "+ Add" card | — | Create modal opens with empty form; branch checkbox grid defaults to first branch checked |
| 7 | Create with valid input | `POST /admin/doctors` 201 | Modal closes; new card appears in the grid; counts update |
| 8 | Create with empty full_name | — | "Full name is required and must be 1..120 characters." inline |
| 9 | Create with invalid email | — | "Email must be a valid address (3..254 characters)." inline |
| 10 | Create with no branches checked | — | "A doctor must work at least one branch." inline (submit button disabled) |
| 11 | Create with duplicate email | `POST .../doctors` 409 `email_already_exists` | "A doctor with that email already exists. Edit them instead." inline |
| 12 | Click "Edit" on a card | — | Edit modal opens; branch checkbox grid is HIDDEN (assignments managed on Assign page) |
| 13 | Edit with no changes | `PATCH` 400 `no_fields_to_update` | "Nothing to save." inline |
| 14 | Edit with rename | `PATCH .../doctors/:id` 200 | Modal closes; card re-renders with new name |
| 15 | Click "Assign" on a card | — | Routes to AdminDoctorAssign sub-page (App.tsx flips sub to `{key: 'doctor-assign', doctorId}`) |
| 16 | Assign page mount | `GET /admin/doctors/:id` 200 + `GET /admin/branches` 200 | Step 1 fills; Step 2 checkbox grid reflects current assignments |
| 17 | Assign: uncheck all branches | — | Save button disabled; "Discard changes" enabled; summary shows "0 branches assigned" |
| 18 | Assign: change 2 branches, save | `PUT .../doctors/:id/branches` 200 | Step 3 checklist; grid re-renders with new set; impact banner with "Heads-up: branches changed" |
| 19 | Assign: PUT with `[]` | `PUT .../branches` 400 `doctor_must_work_at_least_one_branch` | "A doctor must work at least one branch." inline |
| 20 | Deactivate a clean doctor | `PATCH {active: false}` 200, `warning` not emitted | Card flips to inactive; no banner |
| 21 | Deactivate a doctor with future Scheduled appts | `PATCH {active: false}` 200, `warning: 'doctor_has_future_appointments'`, `future_appointment_count: 5` | Card flips to inactive; warning banner: "Dr. Sara was deactivated, but has 5 future appointments. They stay Scheduled; the doctor's kanban (E6) handles the resolution queue." |
| 22 | Click `×` on warning banner | — | Banner disappears; card stays inactive |
| 23 | Reactivate an inactive doctor | `PATCH {active: true}` 200 | Card flips to active |
| 24 | Click Cancel in the modal | — | Modal closes; no API call |
| 25 | Press Escape while modal open | — | Modal closes (if not busy) |
| 26 | Click "← Back to doctors" on the Assign page | — | Returns to AdminDoctors (E1-S3-ui) |
| 27 | Network down | Connection refused → `ApiError(0, 'network_error')` | "Connection failed. Is the API running on :3001?" inside the modal |
| 28 | Sign in as doctor / receptionist | adminScope middleware 403 | Page fails to load with the auth wall; the structure is preserved |

## Code Map

**Web (new / edited):**
- `apps/web/src/api/client.ts` (EDIT) — `DoctorBranchDto`, `DoctorWithBranchesDto`, `DoctorPatchResponse` types + 5 new endpoints: `listDoctors(filter?)`, `getDoctor(id)`, `createDoctor(input)`, `patchDoctor(id, body)`, `putDoctorBranches(id, branchIds)`. The `request()` helper's 401-handling already re-routes to LoginPage.
- `apps/web/src/pages/AdminDoctors.tsx` (NEW) — the card-grid page. State slots: `doctors`, `branches`, `loading`, `loadErr`, `search`, `filterMode`, `filterBranchId`, `mode: 'closed' | 'create' | 'edit'`, `editId`, `editFullName`, `editEmail`, `editBranchIds`, `editActive`, `busy`, `formErr`, `warning`. Helpers: `describeApiError()`, `initialsOf()` (strips "Dr. "), `isValidEmailClient()`, `isValidUuidClient()`. Inline modal for create (with branch checkbox grid) + edit (without branch checkbox grid). One-shot deactivate shortcut.
- `apps/web/src/pages/AdminDoctors.module.css` (NEW) — pixel-perfect mockup 18 port. Token-only. 1300px frame; smaller avatar (44px vs receptionists' 48px); branch chips for multi-branch display.
- `apps/web/src/pages/AdminDoctorAssign.tsx` (NEW) — the assign-branches sub-page (mockup 31). State slots: `doctor`, `branches`, `loading`, `loadErr`, `selectedIds`, `busy`, `formErr`, `savedAt`. Helpers: `describeApiError()`, `initialsOf()`, `isoToDateLabel()`. Diff computation (added / removed) drives the impact banner + audit row preview text.
- `apps/web/src/pages/AdminDoctorAssign.module.css` (NEW) — pixel-perfect mockup 31 port. Token-only. 980px frame; branch-row checkboxes with brand-colour fill on selection; summary + impact banner styles.
- `apps/web/src/AppShell.tsx` (EDIT) — `AdminSubPage` is now a union type with two members (`branch-hours` + `doctor-assign`); `isImplemented()` also returns true for `'doctors'`.
- `apps/web/src/App.tsx` (EDIT) — adds `AdminDoctors` + `AdminDoctorAssign` imports + `onOpenDoctorAssign(doctorId)` callback + `onBackToDoctors` callback. Renders the sub-page when `sub?.key === 'doctor-assign'` and the card grid when `!sub && active === 'doctors'`.

**Spec (new):**
- `_bmad-output/implementation-artifacts/spec-1-3-ui-admin-doctors.md` (NEW) — this file.

**Sprint status (edited):**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — `1-3-ui-admin-doctors: done` under epic-1; comment block.

## Reuse of existing code

- `apps/web/src/api/client.ts` `request()` helper — every new endpoint just calls `request<...>(...)`.
- `apps/web/src/auth/store.ts` `useAuth()` — same pattern as AdminBranches / AdminReceptionists for the user chip.
- `apps/web/src/styles/tokens.css` — every value in `AdminDoctors.module.css` + `AdminDoctorAssign.module.css` is `var(--…)`. The `--container-grid: 1300px` token from E1-S4-ui is reused; no new tokens needed.
- `apps/web/src/pages/AdminReceptionists.tsx` + `AdminReceptionists.module.css` — same dirty-state + `ApiError` surface pattern (form `busy` state, `formErr` envelope, warning banner for F-19). The doctor card grid is structurally identical to the receptionist grid (filter bar + cards + "+ Add") but adds the multi-branch chip row + the dedicated Assign sub-page.
- `apps/web/src/pages/AdminBranches.tsx` — same ConflictModal / dirty-state / inline-edit pattern. The doctor Edit modal mirrors AdminBranches' edit form.
- `apps/api/src/routes/admin-branch-doctors.ts` — the error codes (`invalid_full_name`, `invalid_email`, `invalid_branch_ids`, `invalid_branch_id`, `invalid_active`, `branch_not_found`, `doctor_not_found`, `email_already_exists`, `doctor_must_work_at_least_one_branch`, `no_fields_to_update`, `unknown_field`) are mirrored verbatim in the page's `describeApiError()` helper.
- `apps/api/src/routes/admin-branch-doctors-helpers.ts` — `isValidFullName`, `isValidEmail`, `isValidUuid`, `isValidActive` semantics re-implemented in the page for client-side pre-validation (the server is still the source of truth; client validation is for UX responsiveness).
- `docs/design/mockups/v1/mockups/18-admin-doctors.html` — pixel reference (card grid).
- `docs/design/mockups/v1/mockups/31-admin-doctors-reassign.html` — pixel reference (assign sub-page).
- `docs/design/DESIGN-SYSTEM.md` — token references throughout.

## Verification (manual, no tests in this pass per user instruction)

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001); `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Open `http://localhost:5173/`. Sign in as `admin-main@clinic.local` / admin. Lands on ClinicSettings (default).
3. Click "Doctors" → AdminDoctors renders.
4. Subline shows "9 active · 1 inactive · assigned across 4 branches" (or whatever the seeded count is).
5. **Search "Ah"** → grid filters to doctors with "Ah" in the name. Clear the search.
6. **Click "Active (9)"** → only active cards visible.
7. **Pick "Riyadh Olaya" from the branch select** → grid filters to doctors at that branch.
8. **Click "+ Add" card** → Create modal opens. Status toggle is hidden.
9. **Create a new doctor** with `Dr. Test Doctor`, `test@clinic.local`, branch Riyadh Olaya → 201, modal closes, new card appears.
10. **Validation.** Edit Test Doctor to `full_name: ''`. Save → "Full name is required and must be 1..120 characters." inline.
11. **Validation.** Edit Test Doctor to `email: 'not-an-email'`. Save → "Email must be a valid address (3..254 characters)." inline.
12. **Click "Assign" on Test Doctor** → AdminDoctorAssign sub-page renders. Step 1 shows Test Doctor. Step 2 shows the branch checkbox grid with Riyadh Olaya already checked.
14. **Add a second branch** (Jeddah Corniche) → diff shows "+1 added", impact banner shows "branches changed".
15. **Save** → "Save · 2 branches" → returns 200; grid re-renders with both branches selected; savedAt timestamp appears in the summary.
16. **Discard** → flip back to original; "Discard changes" button disables when the diff is empty.
17. **Click "← Back to doctors"** → returns to AdminDoctors.
18. **Edit Test Doctor's name** to `Dr. Test Doctor 2` → modal closes, card re-renders with the new name.
19. **Deactivate (clean).** Click "Deactivate" on a doctor with no future appointments → card flips to inactive. No banner.
20. **Deactivate (with future appts).** Click "Deactivate" on a doctor whose `doctor_id` has future Scheduled appts → card flips to inactive; warning banner appears. Click `×` on the banner → banner disappears.
21. **Reactivate.** Click "Reactivate" on the inactive card → card flips to active.
22. **Modal close.** Open the create modal, click Cancel → modal closes, no API call. Open it again, press Escape → modal closes.
23. **No regressions.** Sign in as a doctor / receptionist → can't reach this page. Sign in as the original admin and revisit ClinicSettings / Branches / Receptionists — those pages still work. The "Doctors" nav link stays clickable.
24. `pnpm --filter @clinic/api typecheck` — 0 new errors.
25. `pnpm --filter @clinic/web typecheck` — 0 errors.
26. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline in `ClinicSettings.tsx` unchanged).
27. Grep `apps/web/src` for hex literals / rgba outside `tokens.css` → 0 (E7-S1 invariant).

## Spec Change Log

- 2026-10-06 — initial spec (Amelia / E1-S3-ui). Done.

## Deferrals

- **E1-S3-ui-defer-a — "Future appts" / "Specialty" stats.** Today the card stats grid shows `—` placeholders. The doctor's appointment queries (E5-S1) + specialty column (E5-S1) will surface real values; the layout is in place for parity.
- **E1-S3-ui-defer-b — Branch meta counts on Assign page.** Mockup 31 lines 138-152 show "3 doctors · 22 future appointments" + "added to resolve Layla S." meta lines on each branch row. Today the meta line shows only the activity status + branch id. The full meta surface ships with the doctor-dashboard (E5-S1) + appointment-count (E5-S3) stories.
- **E1-S3-ui-defer-c — Specialty + effective-from fields.** The Assign page's mockup 31 has a single "Effective: Immediately" picker (no future-dated changes in MVP). Future-dated branch changes ship with a separate scheduling story (per the mockup 31 hint "No future-dated branch changes in MVP"). The doctor's `specialty` field ships with E5-S1.
- **E1-S3-ui-defer-d — Branch checkbox grid in Edit modal.** Today the Edit modal intentionally omits the branch checkbox grid (the Assign sub-page owns branch changes). A future story could surface a compact branch chip list in the Edit modal that opens the Assign page on click, but the current split keeps the Edit modal focused on rename + status.
- **E1-S3-ui-defer-e — Audit row writes for `doctor.branches_changed`.** The step-3 audit-row text is mockup 31 line 184 verbatim. Real audit row writes are deferred to E7 (#17).
- **E1-S3-ui-defer-f — "Appointments (Layla S.) will be unflagged" summary.** Mockup 31 line 169 shows a third summary tile ("1 appointment (Layla S.) will be unflagged"). Today the summary tile only shows count + diff; the per-appointment unflagging summary ships with the doctor's kanban (E6) + the appointment-flag (E6-S2) story.
- **E1-S3-ui-defer-g — Router.** Today `App.tsx` uses a local `useState<AdminSection>` + `useState<AdminSubPage>` to switch between top-level pages + sub-pages. W59 / #22 introduces a real router that handles sub-page state via the URL.
- **E1-S3-ui-defer-h — Global ConflictModal extraction.** Today the modal is inlined in `AdminDoctors.tsx`. E7-S4 (#26) extracts a reusable `<ConflictModal />` component when a second story needs it. The doctor deactivate has no 409 (F-18), so no conflict modal is needed today.
- **E1-S3-ui-defer-i — Search debounce.** Today the search input filters on every keystroke. The list is small enough that this is fine, but a 200ms debounce is a 3-line future tweak.

## Cross-References

- `spec-1-3-create-deactivate-assign-branch-doctors.md` — the API surface this UI consumes (frozen spec).
- `spec-1-4-ui-admin-receptionists.md` — the sibling admin page (CRUD + warning banner pattern mirrored here).
- `spec-1-2-ui-admin-branch-hours.md` — the sibling admin page (impact-preview reference).
- `spec-1-1-ui-admin-branches.md` — the sibling admin page (ConflictModal pattern mirrored here).
- `spec-w10-staff-login-patient-otp.md` — the auth wall this page sits behind.
- `epic-1-context.md` — the W59 router deferral that E1-S3-ui-defer-g extends.
- `docs/design/DESIGN-SYSTEM.md` §2.4 (semantic surfaces), §3.1 (typography), §4 (spacing), §5 (radius), §6 (elevation).
- `docs/design/mockups/v1/mockups/18-admin-doctors.html` — pixel reference (card grid).
- `docs/design/mockups/v1/mockups/31-admin-doctors-reassign.html` — pixel reference (assign sub-page).
- `apps/api/src/routes/admin-branch-doctors.ts` — the route surface.
- `apps/web/src/api/client.ts` — the API client used by this page.
- `apps/web/src/AppShell.tsx` — the nav this page sits inside.
- `apps/web/src/pages/AdminReceptionists.tsx` — the sibling pattern (CRUD + warning banner).