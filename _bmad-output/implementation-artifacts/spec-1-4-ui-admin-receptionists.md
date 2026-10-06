---
title: 'E1-S4-ui — Admin Receptionists (web)'
type: 'feature'
created: '2026-10-06'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'E1-S2-ui (1cff5ba)'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-create-deactivate-assign-branch-receptionists.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-1-ui-admin-branches.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-ui-admin-branch-hours.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
  - '{project-root}/docs/design/DESIGN-SYSTEM.md'
  - '{project-root}/docs/design/mockups/v1/mockups/19-admin-receptionists.html'
---

## Intent

**Problem:** E1-S4 backend (`POST/GET/GET-by-id/PATCH /admin/receptionists`, frozen in `spec-1-4-create-deactivate-assign-branch-receptionists.md`) is done. The web client has no admin page for receptionists. Mockup 19-B is a card-grid layout (1300px frame) with a filter bar (search + All/Active/Inactive segmented + branch select) and a single-branch-locked card per receptionist (BR-004 — receptionists have exactly one branch, so no multi-branch list like the doctor page will need). Deactivate does NOT 409 (F-19: warn but commit), so the warning shows as a banner, not a blocking modal.

**Approach:** Build `apps/web/src/pages/AdminReceptionists.tsx` as a pixel-perfect port of mockup 19 (card grid + filter bar + in-page modal for create/edit + a non-blocking warning banner for F-19). The page is reached from the top nav ("Receptionists" link), which AppShell flips to enabled. The create + edit flow lives in a single in-page modal (mirrors the AdminBranches pattern). **No tests** are added in this pass (per user instruction).

## Boundaries & Constraints

**Always:**
- Mockup 19 is the source of truth for the visual layout: 1300px-wide frame (mockup 19 line 11; new `--container-grid` token), top nav (reused from AppShell; the AppShell's `active` stays on "receptionists" so the nav highlights Receptionists), breadcrumb "Admin → Receptionists", H1 "Receptionists", subline "X active · Y inactive · single branch per receptionist (BR-004)".
- Filter bar: search input (client-side filter, debounce-free — list is small) + All/Active/Inactive segmented toggle with live counts (mockup 19 lines 94-96) + branch select.
- Card grid: `grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px`. Each card: head (avatar with initials + name-block + Active/Inactive pill) + branch-locked tile (📍 ic + "Assigned branch" label + branch name + 🔒) + 2-cell stats grid (Appts today, Last login — both "—" placeholders for E1-S4) + 3 action buttons (Edit / Deactivate or Reactivate). Inactive cards: `opacity: 0.7`, grey background.
- "+ Add" card at the end of the grid (dashed border, "New receptionist" label).
- Avatar initials: first letter of first name + first letter of last name, uppercased. Fallback to `??` if the name is empty.
- Inactive stats: faded (`--text-faint`) — both numbers + the values themselves go grey.
- Create + edit live in a single in-page modal:
  - **Create** — opens when "+ Add" card is clicked. Form fields: full_name (required, 1..120), email (required, valid email format), branch_id (select, populated from `listBranches()`, defaults to first active branch), status (Active/Inactive toggle, defaults to Active). The status toggle is hidden in create mode (every new receptionist is active by default per the API).
  - **Edit** — opens when an active or inactive card's "Edit" button is clicked. Form fields are the same plus the status toggle (mirrors AdminBranches' "Edit · {name}" pattern). The dirty-state check uses `original` from the loaded receptionist list.
- Deactivate from the card foot sends a one-shot `PATCH {active: false}`. It does NOT open the edit modal. If the API returns `warning: 'receptionist_has_future_appointments'` with `future_appointment_count > 0`, a yellow warning banner surfaces below the page header (and the deactivate still succeeded — F-19). The banner has a `×` dismiss button.
- Reactivate from the card foot of an inactive card sends a one-shot `PATCH {active: true}`. No warning.
- API surface consumed (E1-S4 backend, `apps/api/src/routes/admin-branch-receptionists.ts`):
  - `POST /admin/receptionists` body `{full_name, email, branch_id}` → `201 ReceptionistWithBranch`
  - `GET /admin/receptionists[?active=true|false&branch_id=<uuid>]` → `200 ReceptionistWithBranch[]`
  - `GET /admin/receptionists/:id` → `200 ReceptionistWithBranch`
  - `PATCH /admin/receptionists/:id` body `{full_name?, active?, branch_id?}` → `200 ReceptionistWithBranch & {warning, future_appointment_count}`
  - Plus `listBranches()` from E1-S1 to populate the filter select + the create/edit branch picker.
- API error envelopes translated to UI messages via `describeApiError()`:
  - `400 invalid_full_name` → "Full name is required and must be 1..120 characters."
  - `400 invalid_email` → "Email must be a valid address (3..254 characters)."
  - `400 invalid_branch_id` → "Branch id is invalid (must be a UUID)."
  - `400 invalid_active` → "Status must be Active or Inactive."
  - `400 branch_not_found` → "That branch no longer exists."
  - `400 receptionist_not_found` → "That receptionist no longer exists."
  - `409 email_already_exists` → "A receptionist with that email already exists. Edit them instead."
  - `400 no_fields_to_update` → "Nothing to save."
  - `400 unknown_field` → "Unsupported field sent to the API."
  - `0 network_error` → "Connection failed. Is the API running on :3001?"
  - `>= 500` → "Server error. Try again in a moment."
- Client-side validation mirrors `admin-branch-receptionists-helpers.ts`:
  - `full_name.trim().length` 1..120
  - `EMAIL_RE.test(email)` AND length 3..254
  - `UUID_RE.test(branch_id)` (defensive; the `<select>` always provides a valid UUID)
- The page re-fetches `listReceptionists` + `listBranches` on mount and after every successful save / deactivate / reactivate. The local `editFullName` / `editEmail` / `editBranchId` / `editActive` mirror the response's canonical values after a successful PATCH (no extra fetch needed for the modal, but a refetch keeps the page state clean).
- The modal closes on:
  - `×` button click
  - Cancel button click
  - Escape key
  - Successful create / save
  - Scrim click (backdrop area, not the modal itself)
- Every visual value in the page CSS references a `var(--…)` token. Hex literals live ONLY in `apps/web/src/styles/tokens.css`. The new token `--container-grid: 1300px` is added for the 1300px frame.
- `prefers-reduced-motion` strips all transitions globally (set in `tokens.css`).
- No new tests in this pass (per user instruction).

**Ask First:**
- (none — all scope decisions resolved at plan-time via epic-1-context.md + the E1-S4 spec.)

## I/O & Edge-Case Matrix

| # | Trigger | API behaviour | Web behaviour |
|---|---------|--------------|---------------|
| 1 | Page mount | `GET /admin/receptionists` 200 + `GET /admin/branches` 200 | Filter bar + card grid + "+ Add" card; counts in the subline + segmented badge |
| 2 | Page mount, no auth | — | LoginPage renders (W10 auth wall) |
| 3 | Search "Al" | — | Grid filters to receptionists with "Al" in name or email (client-side) |
| 4 | Click "Active (5)" segmented button | — | Grid filters to active rows only; "All branches" select still honoured |
| 5 | Pick a branch from the select | — | Grid filters to that branch only; combined with the segmented toggle |
| 6 | Clear search + reset filters | — | Grid shows everything |
| 7 | Click "+ Add" card | — | Modal opens in create mode; full_name / email empty; branch_id defaulted to first branch |
| 8 | Create with valid input | `POST /admin/receptionists` 201 | Modal closes; new card appears in the grid; list refreshes |
| 9 | Create with empty full_name | — | "Full name is required and must be 1..120 characters." inline |
| 10 | Create with invalid email | — | "Email must be a valid address (3..254 characters)." inline |
| 11 | Create with duplicate email | `POST .../receptionists` 409 `email_already_exists` | "A receptionist with that email already exists. Edit them instead." inline |
| 12 | Create with missing branch | — | "Pick a branch." inline (should be impossible via the UI — the select always has a value) |
| 13 | Click "Edit" on a card | — | Modal opens in edit mode with the receptionist's current values |
| 14 | Edit with no changes | `PATCH` 400 `no_fields_to_update` | "Nothing to save." inline |
| 15 | Edit with rename + branch reassign | `PATCH .../receptionists/:id` 200 | Modal closes; card re-renders with new name + new branch |
| 16 | Deactivate a clean receptionist | `PATCH {active: false}` 200, `warning: null`, `future_appointment_count: 0` | Card flips to inactive (grey); no banner |
| 17 | Deactivate a receptionist with 3 future Scheduled appts | `PATCH {active: false}` 200, `warning: 'receptionist_has_future_appointments'`, `future_appointment_count: 3` | Card flips to inactive; warning banner appears: "Sara was deactivated, but has 3 future appointments. They stay Scheduled; the receptionist can no longer manage them." |
| 18 | Click `×` on the warning banner | — | Banner disappears |
| 19 | Reactivate an inactive receptionist | `PATCH {active: true}` 200 | Card flips to active (full colour) |
| 20 | Click Cancel in the modal | — | Modal closes; no API call |
| 21 | Click `×` in the modal | — | Modal closes; no API call |
| 22 | Press Escape while modal open | — | Modal closes (if not busy) |
| 23 | Click backdrop (scrim) | — | Modal closes (if not busy) |
| 24 | Network down | Connection refused → `ApiError(0, 'network_error')` | "Connection failed. Is the API running on :3001?" inside the modal (form error) |
| 25 | Sign in as doctor / receptionist | adminScope middleware 403 | `403 forbidden_role` surfaces as "Server error. Try again in a moment." (the page request fails, the auth wall re-routes after the next me-call) |

## Code Map

**Web (new / edited):**
- `apps/web/src/api/client.ts` (EDIT) — `ReceptionistBranchDto`, `ReceptionistWithBranchDto`, `ReceptionistPatchResponse` types + 4 new endpoints: `listReceptionists(filter?)`, `getReceptionist(id)`, `createReceptionist(input)`, `patchReceptionist(id, body)`. The `request()` helper's 401-handling already re-routes to LoginPage.
- `apps/web/src/pages/AdminReceptionists.tsx` (NEW) — the page. State slots: `receptionists`, `branches`, `loading`, `loadErr`, `search`, `filterMode`, `filterBranchId`, `mode: 'closed' | 'create' | 'edit'`, `editId`, `editFullName`, `editEmail`, `editBranchId`, `editActive`, `busy`, `formErr`, `warning`. Helpers: `describeApiError()`, `initialsOf()`, `isValidEmailClient()`, `isValidUuidClient()`. Inline modal for create + edit; warning banner for F-19. `useEffect` re-fetches on mount and after every successful save.
- `apps/web/src/pages/AdminReceptionists.module.css` (NEW) — pixel-perfect mockup 19 port. Token-only. Adds new `.frame`, `.page`, `.crumb`, `.page-header`, `.sub`, `.cross-links`, `.warning-banner`, `.filter-bar`, `.search`, `.seg`, `.seg-btn`, `.branch-select`, `.grid`, `.rec-card`, `.head`, `.av`, `.name-block`, `.name`, `.email`, `.pill`, `.branch-locked`, `.stats`, `.actions`, `.rec-card--add`, `.add-icon`, `.add-label`, `.modal-*` rules.
- `apps/web/src/styles/tokens.css` (EDIT) — adds `--container-grid: 1300px` for the card-grid frame width.
- `apps/web/src/App.tsx` (EDIT) — adds `AdminReceptionists` import + `!sub && active === 'receptionists' && <AdminReceptionists />` branch.
- `apps/web/src/AppShell.tsx` (EDIT) — `isImplemented()` now also returns true for `'receptionists'` so the "Receptionists" nav link becomes clickable.

**Spec (new):**
- `_bmad-output/implementation-artifacts/spec-1-4-ui-admin-receptionists.md` (NEW) — this file.

**Sprint status (edited):**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — `1-4-ui-admin-receptionists: done` under epic-1; comment block.

## Reuse of existing code

- `apps/web/src/api/client.ts` `request()` helper — every new endpoint just calls `request<...>(...)`.
- `apps/web/src/auth/store.ts` `useAuth()` — same pattern ClinicSettings + AdminBranches + AdminBranchHours use for the user chip.
- `apps/web/src/styles/tokens.css` — every value in `AdminReceptionists.module.css` is `var(--…)`. The new `--container-grid` token is the only addition.
- `apps/web/src/pages/AdminBranches.tsx` + `AdminBranches.module.css` — same dirty-state + `ApiError` surface pattern (form `busy` state, `formErr` envelope). The inline ConflictModal pattern is mirrored, except the receptionist deactivate doesn't have a 409 conflict — it has a 200-with-warning path. So the warning surfaces as a banner, not a modal.
- `apps/api/src/routes/admin-branch-receptionists.ts` — the error codes (`invalid_full_name`, `invalid_email`, `invalid_branch_id`, `invalid_active`, `receptionist_not_found`, `branch_not_found`, `email_already_exists`, `no_fields_to_update`, `unknown_field`) are mirrored verbatim in the page's `describeApiError()` helper.
- `apps/api/src/routes/admin-branch-receptionists-helpers.ts` — `isValidFullName`, `isValidEmail`, `isValidUuid`, `isValidActive` semantics re-implemented in the page for client-side pre-validation (the server is still the source of truth; client validation is for UX responsiveness).
- `docs/design/mockups/v1/mockups/19-admin-receptionists.html` — pixel reference.
- `docs/design/DESIGN-SYSTEM.md` — token references throughout.

## Verification (manual, no tests in this pass per user instruction)

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001); `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Open `http://localhost:5173/`. Sign in as `admin-main@clinic.local` / admin. Lands on ClinicSettings (default).
3. Click "Receptionists" in the top nav → AdminReceptionists renders.
4. Subline shows "5 active · 1 inactive · single branch per receptionist (BR-004)". Card grid shows the seeded receptionists with their assigned branches. Inactive cards are greyed.
5. **Search "Al"** → grid filters to receptionists with "Al" in the name. Clear the search.
6. **Click "Active (5)"** → only active cards visible. Click "All (6)" → all cards visible.
7. **Pick "Riyadh Olaya" from the branch select** → grid filters to receptionists at that branch.
8. **Click "+ Add" card** → modal opens. Status toggle is hidden (new receptionists are always active).
9. **Create a new receptionist** with `Hana Test`, `hana@clinic.local`, `Riyadh Olaya` → 201, modal closes, new card appears. The card is in the grid; counts in the subline + segmented badge update.
10. **Edit Hana's name** to `Hana Test 2` → modal closes, card re-renders with the new name.
11. **Validation.** Edit Hana to `full_name: ''`. Save → "Full name is required and must be 1..120 characters." inline.
12. **Validation.** Edit Hana to `email: 'not-an-email'`. Save → "Email must be a valid address (3..254 characters)." inline.
13. **Duplicate email.** Try to create a new receptionist with `n.alharbi@clinic.local` (already taken) → 409 `email_already_exists`, "A receptionist with that email already exists. Edit them instead." inline.
14. **Deactivate (clean).** Click "Deactivate" on a receptionist with no future appointments → card flips to inactive. No banner.
15. **Deactivate (with future appts).** Click "Deactivate" on a receptionist whose branch has future Scheduled appts → card flips to inactive; warning banner appears: "{Name} was deactivated, but has N future appointments. They stay Scheduled; the receptionist can no longer manage them." Click `×` on the banner → banner disappears; card stays inactive.
16. **Reactivate.** Click "Reactivate" on the inactive card → card flips to active.
17. **Modal close.** Open the create modal, click Cancel → modal closes, no API call. Open it again, press Escape → modal closes. Open it again, click the backdrop (not the modal) → modal closes.
18. **No regressions.** Sign in as a doctor / receptionist → can't reach this page (the adminScope middleware 403s). Sign in as the original admin and revisit ClinicSettings / Branches — those pages still work. The "Receptionists" nav link stays clickable.
19. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline in `src/otp/{provider,service,twilio-provider}.ts` unchanged).
20. `pnpm --filter @clinic/web typecheck` — 0 errors.
21. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline in `ClinicSettings.tsx` unchanged).
22. Grep `apps/web/src` for hex literals / rgba outside `tokens.css` → 0 (E7-S1 invariant).

## Spec Change Log

- 2026-10-06 — initial spec (Amelia / E1-S4-ui). Done.

## Deferrals

- **E1-S4-ui-defer-a — "Appts today" / "Last login" stats.** Today the card stats grid shows `—` placeholders. The receptionist-dashboard (E5-S3) and login-activity (E7) stories will surface real values; the layout is in place for parity.
- **E1-S4-ui-defer-b — Reactivate card with "Assign" + "Activate" actions.** Mockup 19 line 264-267 shows the inactive "Ziad Ibrahim" card with two primary buttons (Assign + Activate). This pass ships a single "Reactivate" button on every inactive card; the "Assign" action is implied by the Edit modal (which lets the admin reassign the branch). The mockup's two-button split is design-only and the single-button flow covers both intents.
- **E1-S4-ui-defer-c — Reassign-branch affordance on the card foot.** Mockup 19 line 153 shows an "Reassign" button on every card. The Edit modal already covers this (the branch_id select is editable in edit mode), so the card foot stays Edit / (Deactivate|Reactivate). The "Reassign" button is design-only parity.
- **E1-S4-ui-defer-d — Cross-link affordances.** The "Branches / Doctors / Today's view" cross-link chips at the top of the page are static placeholders (mockup 19 lines 85-89). They become real routes when the Branches (E1-S1-ui, done), Doctors (E1-S3-ui, #12), and Today's view (E5-S3, #14) pages ship.
- **E1-S4-ui-defer-e — Audit row preview.** The card foot in the mockup shows no audit row; the spec's E1-S4 backend doesn't write audit rows (E7-S2 is the audit owner). The "Audit row preview" line is deferred to E7.
- **E1-S4-ui-defer-f — Router.** Today `App.tsx` uses a local `useState<AdminSection>` to switch between top-level pages. W59 / #22 introduces a real router that handles sub-page state via the URL.
- **E1-S4-ui-defer-g — Global ConflictModal extraction.** Today the modal is inlined in `AdminReceptionists.tsx`. E7-S4 (#26) extracts a reusable `<ConflictModal />` component when a second story needs it. The receptionist modal is its own pattern (edit-form, not just confirm).
- **E1-S4-ui-defer-h — Search debounce.** Today the search input filters on every keystroke. The list is small enough that this is fine, but a 200ms debounce is a 3-line future tweak.

## Cross-References

- `spec-1-4-create-deactivate-assign-branch-receptionists.md` — the API surface this UI consumes (frozen spec).
- `spec-1-1-ui-admin-branches.md` — the sibling admin page (CRUD pattern + ConflictModal pattern mirrored here).
- `spec-1-2-ui-admin-branch-hours.md` — the sibling admin page (impact-preview + helper pattern reference).
- `spec-w10-staff-login-patient-otp.md` — the auth wall this page sits behind.
- `epic-1-context.md` — the W59 router deferral that E1-S4-ui-defer-f extends.
- `docs/design/DESIGN-SYSTEM.md` §2.4 (semantic surfaces), §3.1 (typography), §4 (spacing), §5 (radius), §6 (elevation).
- `docs/design/mockups/v1/mockups/19-admin-receptionists.html` — pixel reference.
- `apps/api/src/routes/admin-branch-receptionists.ts` — the route surface.
- `apps/web/src/api/client.ts` — the API client used by this page.
- `apps/web/src/AppShell.tsx` — the nav this page sits inside.
- `apps/web/src/pages/AdminBranches.tsx` — the sibling pattern (CRUD + conflict modal).