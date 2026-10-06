---
title: 'E1-S0-ui — Admin clinic settings (web)'
type: 'feature'
created: '2026-10-06'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'dev HEAD (pre-E1-S0-ui)'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-0-admin-clinic-api.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-0-clinic-management-single-clinic-anchor.md'
  - '{project-root}/docs/design/DESIGN-SYSTEM.md'
  - '{project-root}/docs/design/mockups/v1/mockups/32-admin-clinic-settings.html'
---

## Intent

**Problem:** Epic 1 is functionally complete on the API side (E1-S0a singleton, E1-S0b admin/clinic read+update, E1-S1 branches, E1-S2 hours, E1-S3 doctors, E1-S4 receptionists), but the only backlog story is `1-0-ui-clinic-settings` — the web UI for an admin to view and edit their clinic. Without it, the API surface that E1-S0b shipped is unreachable by any human; the admin's audit and configuration flows have no frontend. The web app is the E0-S1 placeholder (`apps/web/src/App.tsx` was a 17-line "Repo skeleton" page). The token file (`apps/web/src/styles/tokens.css`) carried only a 17-line subset of the design system.

**Approach:** Build the Clinic Settings page as a pixel-perfect port of mockup 32. Replace the placeholder `App.tsx` with a hard-coded `AppShell + ClinicSettings` composition (no router — the next admin page will be the natural place to add one). Wire the page to `GET /admin/clinic` and `PATCH /admin/clinic` via the existing dev-mode `x-auth-claim` header so the page works end-to-end in dev. Reach the API through a Vite dev proxy (`localhost:5173 → localhost:3001`) so no CORS surface is added to the API. Expand `tokens.css` to the full design-system set per `docs/design/DESIGN-SYSTEM.md` §2-6, then move every hex literal out of the page CSS into named tokens. **No tests** are added in this pass (per user instruction; E7-S1's cross-cutting token-discipline audit will pin the no-hex-literal rule in a future story).

## Boundaries & Constraints

**Always:**
- Mockup 32 is the source of truth for the visual layout: top nav (brand "MediSlot · Admin" + 5 nav links + user chip), breadcrumb, page header (H1 + subtitle + 3 action buttons), single-clinic info banner, identity card (2 form rows + 3 read-only rows + footer), operational snapshot (4 stat tiles + 3 quick-links), booking policy (5 read-only rows), and danger zone. No redesigns.
- The page is driven entirely by the `ClinicDto` returned from `GET /admin/clinic`. Static read-only identity rows (Deployment region, Display tagline) are mockup content and live as constants in the page; they are NOT stored in the database.
- The clinic name input round-trips through `PATCH /admin/clinic`. The `Save clinic name` button is disabled until the input is dirty AND valid (1..120 chars, post-trim). On 200, the input is replaced with the API response and the displayed `updated_at` advances.
- `GET /admin/clinic` MUST return the `*_active` / `*_inactive` count subqueries (added in this story's API extension) so the stat tiles can render mockup 32's "X active · Y inactive" split. The `branch.active`, `doctor.active`, `receptionist.active` columns already exist (added in E1-S1 / E1-S3 / E1-S4 respectively).
- The page authenticates as the seeded admin via the dev-mode `x-auth-claim: <json>` debug header. The header is silently dropped by the API when `NODE_ENV === 'production'`, so the dev affordance cannot leak.
- `apps/web/vite.config.ts` proxies `/admin`, `/patient`, `/availability`, `/bookings`, `/health`, `/metrics` to `http://localhost:3001`. No CORS middleware is added to the API.
- Every visual value in the page CSS (`ClinicSettings.module.css`, `styles/shell.css`) references a `var(--…)` token. Hex literals live ONLY in `apps/web/src/styles/tokens.css`.
- `prefers-reduced-motion` strips all transitions globally (set in `tokens.css`).
- No router dependency is added. The other admin nav links are visible as disabled `<button>`s with `cursor: not-allowed` so the user can see what's coming.
- `Discard changes` / `View audit log` in the page header are present for mockup layout parity but are no-ops (the former resets the input; the latter is a TODO). `Deactivate clinic…` is wired to a `window.alert` placeholder — the real deactivate flow is a future story.
- The "+47 this week" sub-line on the Patients tile (mockup demo content) is omitted; the Patients tile shows just the total.

**Ask First:**
- **A1 — Auth model.** Three options were considered: (i) dev-mode `x-auth-claim` header (chosen — no extra API surface, reuses E0-S3's debug path, blocked in production by `loadAuthConfig().allowDebugHeader === false`); (ii) a new `/dev/login` API route that returns a real signed JWT (more realistic but adds API surface); (iii) skip auth (not viable — `/admin/*` requires admin scope). (i) is recommended and chosen.
- **A2 — Routing.** Three options: (i) hard-code `ClinicSettings` in `App.tsx` with no router (chosen — smallest change, no dependency, the next admin page is the natural place to add a router); (ii) add `react-router-dom@6` (future-proof but a chunk of plumbing for one route); (iii) hand-roll a tiny path matcher (~30 lines, no dep). (i) is recommended and chosen.

**Never:**
- No new npm dependency (no router, no icon library, no date library).
- No hex literal in `apps/web/src/**` outside `tokens.css`.
- No `Authorization: Bearer` path — the dev-mode header is the only auth flow.
- No DELETE on the API. No `tagline` field on the API. No new metric name. No new `trg_*` trigger.
- No tests are added in this pass.
- No CORS middleware on the API.
- No `react-router-dom`, no Redux, no zustand, no SWR, no React Query. Pure `useState` + `useEffect`.
- No real staff login. W10 (deferred) replaces the dev-mode header.
- No production deploy path for the dev proxy. Production serves the web app behind a reverse proxy on the same origin as the API.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Initial load (happy) | dev server up, DB seeded, `x-auth-claim` header valid | `200 {id, name, created_at, updated_at, counts: {…}}`; page renders all 4 cards | Loading state while in flight |
| Initial load (API down) | Vite proxy refused connection | `network_error`; page shows red error state with a Retry button | `ApiError(status=0, code='network_error')` |
| Initial load (401) | API up but header missing | `401 {error: 'unauthenticated'}`; error state shown | `ApiError(401, 'unauthenticated')` |
| Initial load (403 role) | `x-auth-claim: {role:'patient'}` | `403 {error: 'forbidden_role'}`; error state shown | `ApiError(403, 'forbidden_role')` |
| Initial load (500) | `clinic_row_missing` (invariant broken) | `500 {error: 'clinic_row_missing'}`; error state shown | `ApiError(500, 'clinic_row_missing')` |
| Edit name, click Save | dirty input, valid | `PATCH /admin/clinic` 200; input updates to server-returned `name`; page header actions reset to disabled | Loading state on the button |
| Edit name, click Save (400) | input trimmed to '' | `400 {error: 'invalid_name'}`; input retains dirty value; `Save failed: 400 invalid_name` shown in card footer | `ApiError(400, 'invalid_name')` |
| Edit name, click Cancel | dirty input | input reverts to last saved name; `updated_at` unchanged | n/a |
| Edit name, click Discard changes | dirty input | same as Cancel | n/a |
| Click "Deactivate clinic…" | any state | `window.alert('Deactivate clinic — not implemented yet. This is a future story.')` | n/a |
| Stat tile click | any state | navigates to `/admin/branches` / `/admin/doctors` / `/admin/receptionists` (404 today; the routes exist on the API but the web app has no pages for them) | Browser navigation |
| Mockup fidelity | every section in mockup 32 | DOM has the same class names (`.frame`, `.nav`, `.page`, `.crumb`, `.page-header`, `.card`, `.form-row`, `.readonly-row`, `.stats`, `.stat`, `.quicklinks`, `.qlink`, `.info-banner`, etc.) | n/a |

## Code Map

- `apps/web/src/styles/tokens.css` (REWRITE) — full design-system set per `docs/design/DESIGN-SYSTEM.md` §2-6: brand (5), surface (6), text (6), semantic (15+), typography (12-step scale), spacing (12-step), container (2), radius (6), elevation (5), font stack, plus `--on-brand` / `--on-danger` / `--on-warning` (implied foreground tokens from §7.1). Every other CSS file references these by name.
- `apps/web/vite.config.ts` (EDIT) — adds `server.proxy` mapping `/admin`, `/patient`, `/availability`, `/bookings`, `/health`, `/metrics` to `http://localhost:3001`. `strictPort: 5173` and the React plugin are unchanged.
- `apps/web/src/api/client.ts` (NEW) — `getClinic()`, `patchClinic(name)`, `ClinicDto`, `ClinicCounts`, `ApiError`. The dev-mode `x-auth-claim` header is constructed from the `ADMIN_CLAIM` constant (`{sub:'admin-main', role:'admin', branch_ids:['__clinic_anchor__'], scope:'clinic'}` — matches the sentinel used by `apps/api/test/__helpers__/admin-token.ts`).
- `apps/web/src/styles/shell.css` (NEW) — the top nav. `MediSlot · Admin` brand with a CSS-only logo glyph (no SVG asset), 5 nav links, user chip with `SA` avatar circle. All classes BEM (`shell__*`, `nav__*`). Every value is a `var(--…)`.
- `apps/web/src/AppShell.tsx` (NEW) — `<AppShell active="clinic">{children}</AppShell>`. The active section is passed in; non-active links are rendered as disabled buttons.
- `apps/web/src/pages/ClinicSettings.module.css` (NEW) — the full page. Class names match the mockup one-for-one (`.page`, `.crumb`, `.page-header`, `.card`, `.form-row`, `.readonly-row`, `.stats`, `.stat`, `.quicklinks`, `.qlink`, `.info-banner`, etc.). Every value is a `var(--…)`.
- `apps/web/src/pages/ClinicSettings.tsx` (NEW) — the React component. Pure `useState` + `useEffect` + `useCallback`. Handles loading / error / data states, name-edit lifecycle (dirty tracking, save, cancel, discard, error), stat-tile render with the `active · inactive` split, and the deactivated-clinic alert. No third-party state library.
- `apps/web/src/App.tsx` (REWRITE) — replaces the E0-S1 placeholder with `<AppShell active="clinic"><ClinicSettings /></AppShell>`.
- `apps/web/src/vite-env.d.ts` (NEW) — ambient `declare module '*.module.css'` so `tsc` accepts the CSS Modules import (Vite's runtime resolves it; `tsc` needs the shim).
- `apps/web/src/main.tsx` (UNCHANGED) — the `App` named export still drives the ReactDOM.createRoot call.
- `apps/api/src/routes/admin-clinic.ts` (EDIT) — adds `branches_active` / `branches_inactive` / `doctors_active` / `doctors_inactive` / `receptionists_active` / `receptionists_inactive` to the SELECT and the response builder. The `*_inactive` subquery covers both `active = FALSE` and `active IS NULL` so the UI's count is correct on legacy rows that pre-date the `active` column. The file-header docblock is updated to reflect that the `*_active`/`*_inactive` field set now exists (the prior "spec deliberately drops" note from SC1 of E1-S0b is stale and removed).

**API contract ground truth (re-read of `apps/api/src/routes/admin-clinic.ts:38-110`):**

`GET /admin/clinic` now returns:
```json
{
  "id": "clinic_<uuid>",
  "name": "MediSlot Clinic Group",
  "created_at": "2026-08-25T…Z",
  "updated_at": "2026-10-04T…Z",
  "counts": {
    "branches_total": 2, "branches_active": 2, "branches_inactive": 0,
    "doctors_total": 3, "doctors_active": 3, "doctors_inactive": 0,
    "receptionists_total": 2, "receptionists_active": 2, "receptionists_inactive": 0,
    "patients_total": 5
  }
}
```

The seeded counts (2 / 3 / 2 / 5) come from `apps/api/db/seeds/01_minimum.ts` (E0-S5). The `*_active` values will match `*_total` until a future story flips a row's `active` to `FALSE`.

## Verification (manual, no tests in this pass)

1. `cd apps/api && pnpm db:migrate && pnpm db:seed` — DB provisioned.
2. `pnpm --filter @clinic/api dev` — API on :3001. `curl -H "x-auth-claim: {\"sub\":\"admin-main\",\"role\":\"admin\",\"branch_ids\":[\"__clinic_anchor__\"],\"scope\":\"clinic\"}" http://localhost:3001/admin/clinic` returns the new payload with all 10 count fields.
3. `pnpm --filter @clinic/web dev` — Vite on :5173. Open `http://localhost:5173/` → Clinic Settings page renders.
4. Mockup 32 vs the rendered DOM, side-by-side:
   - Frame: 1080px max-width, white card on `--surface-page` background, sticky top nav.
   - Brand "MediSlot · Admin" with teal logo glyph.
   - 5 nav links; "Clinic" is teal + underlined; the other 4 are muted and visually disabled.
   - User chip "SA · Sara Al-Otaibi · Administrator" on the right.
   - Breadcrumb `Admin › Clinic settings`.
   - Page header H1 + subtitle + 3 action buttons (View audit log / Discard changes / Save clinic) — all 3 are disabled until the name input is dirty.
   - Single-clinic info banner (teal-tinted with `i` icon).
   - Identity card: Clinic name input pre-filled with the API's `name`; tagline input disabled (mockup content); 3 read-only rows (Clinic ID, Deployment region, Created `<YYYY-MM-DD>` · by Sara Al-Otaibi); footer with Cancel + Save clinic name.
   - Operational snapshot: 4 stat tiles in a 4-col grid (Branches, Doctors, Receptionists, Patients) with `N active · M inactive` sub-text (or just `N active` when M is 0); 3 quick-link cards.
   - Booking policy: 5 read-only rows.
   - Danger zone: red-tinted card head, red secondary button "Deactivate clinic…".
5. Edit the clinic name in the input → "Save clinic name" enables → click → API PATCH fires → 200 → input updates to the server-returned name → header buttons reset to disabled.
6. Browser DevTools → Network → confirm `GET /admin/clinic` 200 and the request includes `x-auth-claim`.
7. Browser DevTools → Console → no errors, no warnings.
8. `pnpm --filter @clinic/web typecheck` — 0 new errors.
9. `pnpm --filter @clinic/web lint` — 0 new warnings.

## Spec Change Log

- **SC1 (2026-10-06) — counts field set re-introduced.** E1-S0b's spec-1-0-admin-clinic-api.md SC1 (2026-09-14) deliberately dropped the `*_active` / `*_inactive` fields because the `branch.active` column didn't yet exist. E1-S1 (migration `0014_branch_active.sql`), E1-S3 (migration `0016_doctor_lifecycle.sql`), and E1-S4 (migration `0017_receptionist_lifecycle.sql`) added those columns. Mockup 32's "X active · Y inactive" rendering now drives the API surface back to including the splits. No data shape change for the existing 4 fields; the 6 new fields are additive and non-breaking. The `*_inactive` subquery covers `active = FALSE OR active IS NULL` for legacy-row safety.
- **SC2 (2026-10-06) — auth path for the dev web UI.** Until a real staff login lands (W10), the web app authenticates as the seeded admin via the dev-mode `x-auth-claim` header. The header is silently dropped when `NODE_ENV === 'production'`, so the dev affordance cannot leak. Documented as a hard-coded `ADMIN_CLAIM` constant in `apps/web/src/api/client.ts`.

## Deferrals

- **W54** (open): the `Discard changes` button in the page header and the `View audit log` button are present for mockup layout parity but are no-ops. The real "view audit log" lands with E7-S2's admin audit route; "Discard changes" duplicates the Cancel button in the card footer. Reopen if future pages diverge.
- **W55** (open): the `Deactivate clinic…` button shows a `window.alert` placeholder. The real deactivate flow (typed confirmation, audit row, etc.) is a future story — likely E1-S5 or a hardening pass on E7-S2.
- **W56** (defer): the "+47 this week" sub-line on the Patients tile (mockup demo content) is omitted. Future work could expose a "patients added in the last 7 days" count if/when the analytics use-case lands.
- **W57** (defer): the API's `*_inactive` predicate covers `active = FALSE OR active IS NULL`. Once a future migration enforces `NOT NULL` on every `active` column, the `IS NULL` arm becomes dead code. Cosmetic.
- **W58** (open): the `Save clinic` button in the page header is wired to `saveName()`, but the mockup is ambiguous about whether that button saves the identity card specifically (it does today — only the name is editable). A future "edit more fields" iteration would re-scope.
- **W59** (defer): the Admin nav has no router; the disabled button affordance for non-active links is a placeholder. The next admin page (E1-S1 UI for branches) is the natural place to introduce a router.

## Cross-References

- Mockup: `docs/design/mockups/v1/mockups/32-admin-clinic-settings.html`
- Design system: `docs/design/DESIGN-SYSTEM.md` §2-6 (tokens), §7.1 (buttons), §7.3 (cards), §7.4 (sections)
- Spec: `spec-1-0-admin-clinic-api.md` (E1-S0b — the API surface this story consumes)
- Spec: `spec-1-0-clinic-management-single-clinic-anchor.md` (E1-S0a — the singleton invariant)
- Spec: `spec-1-1-create-edit-deactivate-branches.md` (E1-S1 — added `branch.active` in migration `0014_branch_active.sql`)
- Spec: `spec-1-3-create-deactivate-assign-branch-doctors.md` (E1-S3 — added `doctor.active` in migration `0016_doctor_lifecycle.sql`)
- Spec: `spec-1-4-create-deactivate-assign-branch-receptionists.md` (E1-S4 — added `receptionist.active` in migration `0017_receptionist_lifecycle.sql`)
- Code: `apps/api/src/middleware/auth.ts:37-70` (the `parseClaimHeader` path the dev-mode header exercises)
- Code: `apps/api/src/routes/admin-clinic.ts:38-110` (the API surface this story consumes)
- Code: `apps/web/src/main.tsx` (unchanged entry point)
- Deferred work: `_bmad-output/implementation-artifacts/deferred-work.md`
- Epic context: `_bmad-output/implementation-artifacts/epic-1-context.md`
