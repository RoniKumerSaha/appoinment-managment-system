---
title: 'E1-S1-ui — Admin Branches (web)'
type: 'feature'
created: '2026-10-06'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'W10 (b1ccc7c)'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-1-create-edit-deactivate-branches.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
  - '{project-root}/docs/design/DESIGN-SYSTEM.md'
  - '{project-root}/docs/design/mockups/v1/mockups/17-admin-branches.html'
---

## Intent

**Problem:** W10 shipped the auth wall, but the only admin page behind it is the E1-S0-ui clinic settings screen. The next backlog item is the E1-S1 admin-branches surface — the page an admin uses to create a branch, rename it, deactivate it, and bring it back. The E1-S1 backend (`POST/GET/PATCH /admin/branches[/:id]`, frozen in `spec-1-1-create-edit-deactivate-branches.md`) is already done; what is missing is the web client. Without it, an admin has no way to manage their branch lifecycle from a UI — every change has to go through direct API calls or the dev seed.

**Approach:** Build `apps/web/src/pages/AdminBranches.tsx` as a pixel-perfect port of mockup 17 (the two-step stacked "select a branch, then edit" flow). The page is driven by the four E1-S1 API endpoints; the BR-059 conflict dialog is inlined (the global ConflictModal component ships in E7-S4, separate story #26). Mockup 17 also shows an address input, an operating-hours editor, and an impact banner — those ship with E1-S2 (#29) and render as labelled placeholder rows so the visual layout matches the mockup without pretending to ship functionality. **No tests** are added in this pass (per user instruction).

## Boundaries & Constraints

**Always:**
- Mockup 17 is the source of truth for the visual layout: 760px-stacked frame, top nav (reused from `AppShell`), breadcrumb "Admin → Branches", H1 "Manage branches", subline "X active branches · Y inactive · Z total" (counts derived from the loaded list — doctor / future-appt counts deliberately omitted; they live with E1-S2 + E3-S1), three cross-link chips (Doctors / Receptionists / Branch hours impact — all disabled placeholders for now), Step 1 branch list with radio selection + "+ Create new branch" row, Step 2 edit form with name + status toggle + cancel / save. No redesigns.
- The page authenticates via the existing W10 auth wall. The 401 path in the API client (`apps/web/src/api/client.ts:139-149`) re-routes to LoginPage automatically.
- API surface consumed (E1-S1 backend, `apps/api/src/routes/admin-branches.ts`):
  - `GET /admin/branches[?active=true|false]` → list all branches
  - `POST /admin/branches` body `{name}` → create
  - `PATCH /admin/branches/:id` body `{name?, active?}` → rename / activate / deactivate
  - `GET /admin/branches/:id` is NOT used in this pass; the page re-uses the loaded list for the single-edit path (saves one round-trip on save).
- API error envelopes translated to UI messages via `describeApiError()`:
  - `400 invalid_name` → "Name is required and must be 1..120 characters."
  - `400 invalid_active` → "Status must be Active or Inactive."
  - `400 no_fields_to_update` → "Nothing to save."
  - `400 unknown_field` → "Unsupported field sent to the API."
  - `404 branch_not_found` → "That branch no longer exists."
  - `409 branch_has_future_appointments` → opens the inline ConflictModal (BR-059)
  - `0 network_error` → "Connection failed. Is the API running on :3001?"
  - `>= 500` → "Server error. Try again in a moment."
- The form's "Save changes" button is disabled until the name is non-empty (post-trim). On 200, the input is replaced with the API response and the list is re-fetched to pick up the bumped `updated_at`. On 409, the form state is preserved (so the admin can fix the conflict without retyping).
- The "+ Create new branch" row switches Step 2 into `create` mode (no status toggle — new branches are always active). On 201, the freshly-created row is selected in Step 1 and Step 2 switches back to `edit` mode with the new branch's data.
- BR-059 ConflictModal (mockup 17 lines 232-251): inlined in the page since the E7-S4 global ConflictModal component is a separate story. Behaviour: when PATCH `{active: false}` returns 409, the modal opens with "{branch_name} has future appointments. {branch_name} cannot be deactivated while bookings exist." + the BR-059 rule footnote. The "Review appointments" CTA is a disabled placeholder (E5-S3 / E5-S4 will own the deep-linkable appointment views). Close affordances: scrim click, × button, "Got it" button, Escape key.
- Every visual value in the page CSS references a `var(--…)` token. Hex literals live ONLY in `apps/web/src/styles/tokens.css`. The new `--scrim` token was added in this pass (modal backdrop tint per mockup 17 line 67 `rgba(15, 29, 35, 0.45)`).
- The placeholder rows for address + operating hours ship as labelled cards with the hint "Address, operating hours, and impact preview ship with branch hours (#29)" — they preserve the mockup 17 layout without faking interactivity.
- The Step 2 foot text "Atomic: `Branch.update` · audit: `branch.changed`" is mockup 17 line 221 verbatim. Audit row writes are deferred to E7; today no audit row is written when this PATCH succeeds.
- The "Cancel" button in `create` mode reverts to editing the first branch in the list (mirroring the mockup 17 flow where cancel returns to step 1).
- The page is reachable via the AppShell nav (Branches link becomes clickable; Doctors / Receptionists / Audit log remain disabled). The local `useState` in `App.tsx` acts as a router stand-in (W59 / #22 is the real router story).
- `prefers-reduced-motion` strips all transitions globally (set in `tokens.css`).
- No new tests in this pass (per user instruction).

**Ask First:**
- **A1 (resolved this run) — Branch row subtext.** User chose "Just the essentials" (name + status pill + created date). The mockup 17 subline ("3 doctors · 98 future appts · 08:00–17:00") is omitted because the E1-S1 API only returns `{id, clinic_id, name, active, created_at, updated_at}` — doctor / future-appt / hours counts aren't part of the E1-S1 surface.
- **A2 (resolved this run) — Mockup 17 sections that E1-S1 doesn't own (address, hours editor, impact banner).** Going with "labelled placeholder rows" — the address and operating-hours rows render as static cards with the hint "Address, operating hours, and impact preview ship with branch hours (#29)." The impact banner is dropped (it requires appointment counting data, also deferred).

## I/O & Edge-Case Matrix

| # | Trigger | API behaviour | Web behaviour |
|---|---------|--------------|---------------|
| 1 | Page mount | `GET /admin/branches` 200 | Step 1 renders the list; first branch auto-selected; Step 2 shows its name + Active status |
| 2 | Page mount, no auth | — | LoginPage renders (auth wall, see W10) |
| 3 | Click another branch in Step 1 | — | Step 2 mirrors that branch's name + active state; dirty edits discarded |
| 4 | Rename a branch (clean) | `PATCH /admin/branches/:id {name}` 200 | Step 1 row + Step 2 input update; `updated_at` advances |
| 5 | Deactivate a branch with no future Scheduled appts | `PATCH /admin/branches/:id {active: false}` 200 | Step 1 row turns grey + Inactive pill |
| 6 | Deactivate a branch with future Scheduled appts | `PATCH /admin/branches/:id {active: false}` 409 `branch_has_future_appointments` | ConflictModal opens; form state preserved |
| 7 | Reactivate a branch | `PATCH /admin/branches/:id {active: true}` 200 | Step 1 row turns active + Active pill |
| 8 | Save with empty name (after trim) | — | "Name is required and must be 1..120 characters." inline |
| 9 | Save with 121+ char name | — | "Name is required and must be 1..120 characters." inline |
| 10 | Save with no dirty fields | — | "Nothing to save." inline |
| 11 | Click "+ Create new branch" | — | Step 2 title "Create new branch"; no status toggle; empty name input |
| 12 | Create a new branch | `POST /admin/branches {name}` 201 | New row appears in Step 1; auto-selected; Step 2 switches to edit mode |
| 13 | Cancel in create mode | — | Reverts to editing the first branch in the list |
| 14 | Cancel in edit mode | — | Dirty edits discarded; form reverts to selected branch's server state |
| 15 | ConflictModal: scrim click | — | Modal closes |
| 16 | ConflictModal: × button | — | Modal closes |
| 17 | ConflictModal: "Got it" button | — | Modal closes |
| 18 | ConflictModal: Escape key | — | Modal closes |
| 19 | Network down | Connection refused → `ApiError(0, 'network_error')` | "Connection failed. Is the API running on :3001?" |
| 20 | Server error 500 | `500 internal_error` | "Server error. Try again in a moment." |
| 21 | Sign-in as doctor / receptionist | adminScope middleware 403 | `403 forbidden_role` surfaces as "Server error. Try again in a moment." (no special doctor/receptionist variant in this pass) |

## Code Map

**Web (new / edited):**
- `apps/web/src/api/client.ts` (EDIT) — `BranchDto` type + 4 new endpoints: `listBranches(filter?)`, `getBranch(id)` (added for parity, not used in this pass), `createBranch(name)`, `patchBranch(id, {name?, active?})`. The `request()` helper's 401-handling already re-routes to LoginPage.
- `apps/web/src/pages/AdminBranches.tsx` (NEW) — the page. State slots: `branches`, `selectedId`, `mode` ('edit' | 'create'), `editName`, `editActive`, `busy`, `formErr`, `conflictOpen`, `conflictName`, `conflictModalRef`. Helper: `describeApiError()`, `formatCreated(iso)`. Inline ConflictModal component.
- `apps/web/src/pages/AdminBranches.module.css` (NEW) — pixel-perfect mockup 17 port. Token-only. New token-only style blocks: `.frame`, `.page`, `.page-header`, `.crumb`, `.sub`, `.cross-links`, `.cross-link`, `.step`, `.step-head`, `.step-num` / `--done` / `--current`, `.step-title`, `.step-hint`, `.list`, `.row` / `--selected` / `--inactive`, `.radio`, `.ic`, `.body`, `.name`, `.meta`, `.pill` / `--active` / `--inactive`, `.add-row`, `.form-group`, `.hint`, `.placeholder-row` + `.placeholder-row__tag`, `.status-toggle` + `.opt` / `--active`, `.step-foot`, `.audit`, `.btn-group`, `.btn-primary`, `.btn-ghost`, `.error-banner`, `.modal-backdrop`, `.modal`, `.modal-head`, `.modal-icon`, `.modal-head__body`, `.modal-title`, `.modal-sub`, `.modal-x`, `.modal-body`, `.modal-lead`, `.modal-rule`, `.modal-foot`.
- `apps/web/src/App.tsx` (EDIT) — local `useState<AdminSection>('clinic')` for the active section; renders `<ClinicSettings />` or `<AdminBranches />` based on `active`. Passes `onNavigate={setActive}` to AppShell.
- `apps/web/src/AppShell.tsx` (EDIT) — adds `onNavigate?: (s: AdminSection) => void` prop. The non-active links become real `<button>`s wired to `onNavigate` for the implemented sections (`clinic` + `branches`); the rest stay disabled.
- `apps/web/src/styles/tokens.css` (EDIT) — adds `--scrim: rgba(15, 29, 35, 0.45)` for the modal backdrop (mockup 17 line 67).

**Spec (new):**
- `_bmad-output/implementation-artifacts/spec-1-1-ui-admin-branches.md` (NEW) — this file.

**Sprint status (edited):**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — `1-1-ui-admin-branches: done` under epic-1; comment block.

## Reuse of existing code

- `apps/web/src/api/client.ts` `request()` helper — every new endpoint just calls `request<BranchDto>(...)` / `request<BranchDto[]>(...)`.
- `apps/web/src/auth/store.ts` `useAuth()` — the user chip continues to be driven by the W10 store.
- `apps/web/src/styles/tokens.css` — every value via `var(--…)`. New `--scrim` token added in this pass for the modal backdrop; everything else already existed.
- `apps/web/src/pages/LoginPage.module.css` `.btn-primary` / `.btn-ghost` patterns — mirrored in `AdminBranches.module.css`.
- `apps/web/src/pages/ClinicSettings.tsx` — same controlled-input + dirty-state + `ApiError` surface pattern (form `busy` state, `formErr` envelope, formatCreated helper).
- `apps/api/src/routes/admin-branches.ts` — the error codes (`invalid_name`, `invalid_active`, `branch_not_found`, `branch_has_future_appointments`, `no_fields_to_update`, `unknown_field`) are mirrored verbatim in the page's `describeApiError()` helper.
- `docs/design/mockups/v1/mockups/17-admin-branches.html` — visual reference (two-step stacked flow + ConflictModal).
- `docs/design/DESIGN-SYSTEM.md` — token references throughout. The new `--scrim` token follows the §2.4 semantic-surface pattern (named, not hex inline).

## Verification (manual, no tests in this pass per user instruction)

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001); `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Open `http://localhost:5173/`. Sign in as `admin-main@clinic.local` / admin. Lands on ClinicSettings (default).
3. Click "Branches" in the top nav → AdminBranches renders. The two seeded branches appear in Step 1; the first is auto-selected.
4. Click another branch in Step 1 → Step 2 fills with that branch's name + Active status. The form-group inputs are filled. Cancel resets; typing a new name enables Save.
5. **Rename.** Edit "East Branch" → "East Branch Renamed". Save → 200; the row in Step 1 updates. Reload — persists.
6. **Deactivate (no appts).** Select the seeded branch with no future Scheduled appts. Toggle to Inactive. Save → 200; the row goes grey + Inactive pill.
7. **Deactivate (with appts).** Seed a future appointment via the API; then deactivate that branch. Save → 409 → ConflictModal opens with the mockup-17 message. Dismiss via scrim / × / "Got it" / Escape; the form state is preserved.
8. **Create.** Click "+ Create new branch" → Step 2 title "Create new branch"; no status toggle. Type "New Test Branch". Save → 201; the new branch is selected in Step 1 and Step 2 switches to edit mode with Active.
9. **Validation.** Save with empty name → "Name is required and must be 1..120 characters." inline. Save with 200 chars → same.
10. **No regressions (ClinicSettings).** Navigate back to Clinic; the page still renders the same clinic info.
11. **No regressions (login).** Sign out → LoginPage renders (W10). Sign back in → ClinicSettings lands.
12. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline errors in `src/otp/{provider,service,twilio-provider}.ts` are unchanged and out of scope).
13. `pnpm --filter @clinic/web typecheck` — 0 errors.
14. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline errors in `ClinicSettings.tsx` are unchanged and out of scope).
15. Grep `apps/web/src` for hex literals outside `tokens.css` → 0 (E7-S1 invariant).

## Spec Change Log

- 2026-10-06 — initial spec (Amelia / E1-S1-ui). Done.

## Deferrals

- **E1-S1-ui-defer-a — Address + operating hours editor + impact banner.** Mockup 17 shows these on Step 2 but they're out of scope for E1-S1 (E1-S2 #29 owns the API). The page renders labelled placeholder rows with the hint "Address, operating hours, and impact preview ship with branch hours (#29)" — single static line, no interactivity.
- **E1-S1-ui-defer-b — Doctor / future-appt counts in the branch list subline.** The E1-S1 API only returns `{id, clinic_id, name, active, created_at, updated_at}`. Subline today shows "X active branches · Y inactive · Z total" with the active/inactive counts computed from the loaded list. Doctor counts land in E1-S2 (#29) and E1-S3 (#12); future-appt counts land in E3-S1 (#13).
- **E1-S1-ui-defer-c — "Review appointments" CTA in the BR-059 ConflictModal.** Mockup 17 shows the affordance but it requires a link to the receptionist appointment view (E5-S3 #14 + E5-S4 #14). Today the button is a disabled placeholder.
- **E1-S1-ui-defer-d — Audit row writes for `branch.changed`.** The step-foot text "audit: `branch.changed`" is mockup 17 verbatim. Real audit row writes are deferred to E7 (#17).
- **E1-S1-ui-defer-e — Global ConflictModal component extraction.** Today the modal is inlined in `AdminBranches.tsx`. E7-S4 (#26) extracts a reusable `<ConflictModal />` component when a second story needs it.
- **E1-S1-ui-defer-f — Router.** Today `App.tsx` uses a local `useState<AdminSection>` to switch between ClinicSettings and AdminBranches. W59 / #22 introduces a real router (probably `react-router-dom` or `wouter`).
- **E1-S1-ui-defer-g — Doctor / receptionist / audit log nav links.** Today the AppShell nav buttons for those sections stay disabled (no pages exist). They become clickable when their respective stories ship.

## Cross-References

- `spec-1-1-create-edit-deactivate-branches.md` — the API surface this UI consumes.
- `spec-w10-staff-login-patient-otp.md` — the auth wall this page sits behind.
- `epic-1-context.md` — the deferral "W10" (E0-S3 review pass) that W10 fulfilled, and the W59 router deferral that E1-S1-ui-defer-f extends.
- `docs/design/DESIGN-SYSTEM.md` §2.4 (semantic surfaces — new `--scrim` token), §3.1 (typography), §4 (spacing), §5 (radius), §6 (elevation).
- `docs/design/mockups/v1/mockups/17-admin-branches.html` — pixel reference.
- `apps/api/src/routes/admin-branches.ts` — the route surface.
- `apps/web/src/api/client.ts` — the API client used by this page.
- `apps/web/src/AppShell.tsx` — the nav this page extends.
- `apps/web/src/pages/ClinicSettings.tsx` — the sibling page the App.tsx switch coexists with.
