---
id: spec-1-0-ui-router
title: E1-S0-ui W59 — Client-side router for the admin surface
epic: epic-1
review_loop_iteration: 0
created: 2026-10-06
last_updated: 2026-10-06
status: done
---

# E1-S0-ui W59 — Client-side router for the admin surface

## Intent

Replace the local `useState<AdminSection>` stand-in in `App.tsx`
(deferral W59 from the E1-S0-ui pass) with a real client-side
router. The URL hash becomes the source of truth, so:

- The back / forward buttons work (`window.history` is shared).
- Bookmarks to admin pages survive a refresh.
- `<a href="#/admin/branches">` navigations don't trigger a full
  page reload — they're intercepted by `<Link>` and routed through
  the same React state.

Two new surfaces ship with the router:

- **`AdminAuditPage`** — `/admin/audit` is now a working nav item
  (was a disabled placeholder per E1-S0-ui). It renders the
  `AdminAuditEnvelope` returned by `GET /admin/audit` (the
  privacy-policy envelope that the back-end already serves).
  This is the natural home for the "what admins don't see"
  card that the inline audit-policy card on ClinicSettings
  was a stopgap for.
- **`/admin/audit`** link on the inline policy card foot —
  the ClinicSettings inline card now deep-links to the audit
  page for the full envelope.

## Approach

### 1. Hash-based router (no external dep)

**File:** `apps/web/src/router/usePathRoute.tsx` (NEW).

Why hash and not History API:

- The Vite dev proxy forwards `/admin/*` to the API on :3001.
  Deep-link refresh on a sub-page like
  `/admin/branches/<id>/hours` would 404 because the proxy
  intercepts before the SPA fallback runs.
- Hash routes are never sent to the server. They survive any
  reverse-proxy / fallback config. A future hardening pass can
  swap to the History API + an SPA fallback when we control the
  production reverse proxy.

The router is ~60 lines:

- `parsePath(hash)` — converts a hash path (`/admin/branches/<id>/hours`)
  into a discriminated union:
  ```ts
  type ParsedRoute =
    | { kind: 'admin-top'; section: AdminSection }
    | { kind: 'admin-sub'; section: AdminSection; sub: AdminSubPage }
    | { kind: 'unknown'; hash: string };
  ```
  Sub-pages: branch-hours, doctor-assign, doctor-schedule,
  doctor-blocks. Prefix matches (`/admin/branches/foo` with
  unknown sub) fall back to the parent section.
- `buildPath(section, sub?)` — inverse; produces `#/admin/...`.
- `usePathRoute()` — React hook that reads
  `window.location.hash`, listens to `hashchange`, returns
  `{ route, navigate }`. `navigate('#/admin/...')` updates the
  hash.
- `<Link to="#/admin/...">` — same shape as `<a>` but
  intercepts left-clicks (modifier keys + middle clicks pass
  through). Updates `window.location.hash` instead of doing a
  full reload.

`DEFAULT_PATH = '#/admin/clinic'`. When the hash is empty or
unknown, App.tsx redirects to the default on first mount.

### 2. App.tsx — derive active + sub from the route

**File:** `apps/web/src/App.tsx` (EDIT).

Removed: the local `useState<AdminSection>` + `useState<AdminSubPage>`
pair. Added: `usePathRoute()` + a `useMemo` that derives
`{ active, sub }` from `route`. The `onNavigate` /
`onOpenBranchHours` / `onOpenDoctorAssign` / `onOpenDoctorSchedule`
/ `onOpenDoctorBlocks` / `onBackToBranches` / `onBackToDoctors`
callbacks all wrap `navigate(buildPath(...))` instead of
`setState`. Render dispatch is unchanged.

The "unknown route" effect redirects to the default when the admin
URL hash doesn't match any known admin route (defensive — the
router returns `{ kind: 'unknown', hash }` and the effect
redirects on first admin mount).

### 3. AppShell — enable the audit nav

**File:** `apps/web/src/AppShell.tsx` (EDIT).

`isImplemented()` now returns `true` for `'audit'` (it was
false because no page rendered it; now `AdminAuditPage` does).

### 4. AdminAuditPage — the new `/admin/audit` page

**File:** `apps/web/src/pages/AdminAuditPage.tsx` (NEW),
**File:** `apps/web/src/pages/AdminAuditPage.module.css` (NEW).

Pixel-faithful to the ClinicSettings card-row layout so the
two surfaces look consistent. Loads
`getAdminAudit()` on mount; renders the envelope
(`appointments_audit_reads: 'rejected_per_role_policy'` pill,
reason, reference, doctor endpoint, receptionist endpoint,
future-work note) plus a list of the resource-level audit
endpoints the admin role *can* hit.

Loading + error + retry states follow the ClinicSettings pattern.

### 5. ClinicSettings — `<Link>` for nav, deep-link to /admin/audit

**File:** `apps/web/src/pages/ClinicSettings.tsx` (EDIT).

- The breadcrumb's `<a href="/admin/clinic">Admin</a>` is now
  `<Link to="#/admin/clinic">Admin</Link>`.
- The four `<a href="/admin/branches|doctors|receptionists">`
  stat tiles + quick links are now `<Link>` (with `#/` prefixes).
- The inline audit policy card's foot now includes a "full policy
  envelope is on the Audit log page" link to `#/admin/audit`.
- `StatTile` `href` prop renamed to `to`; signature uses `<Link>`
  not `<a>`.

### 6. Spec + sprint-status

- This doc.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  `1-0-ui-router: done`.

## Files to change

| Path | Kind | What |
|------|------|------|
| `apps/web/src/router/usePathRoute.tsx` | NEW | Hash router + `<Link>` (no external dep) |
| `apps/web/src/App.tsx` | EDIT | Use `usePathRoute`; remove `useState<AdminSection>` |
| `apps/web/src/AppShell.tsx` | EDIT | Enable audit nav |
| `apps/web/src/pages/AdminAuditPage.tsx` | NEW | `/admin/audit` page (renders `getAdminAudit`) |
| `apps/web/src/pages/AdminAuditPage.module.css` | NEW | Token-only CSS |
| `apps/web/src/pages/ClinicSettings.tsx` | EDIT | `<Link>` for nav; deep-link to `/admin/audit` |
| `apps/web/src/pages/ClinicSettings.module.css` | EDIT | `.audit-card__foot-link` style |
| `_bmad-output/implementation-artifacts/spec-1-0-ui-router.md` | NEW | Spec |

## I/O & Edge-Case Matrix

| Surface | Input | Behaviour |
|---------|-------|-----------|
| Hash empty | first mount | redirect → `#/admin/clinic` |
| Hash `#/admin/clinic` | first mount | render `<ClinicSettings>` |
| Hash `#/admin/branches` | first mount | render `<AdminBranches>` |
| Hash `#/admin/branches/<id>/hours` | first mount | render `<AdminBranchHours branchId={id}>` |
| Hash `#/admin/doctors/<id>/schedule` | first mount | render `<AdminDoctorSchedule doctorId={id}>` |
| Hash `#/admin/doctors/<id>/assign` | first mount | render `<AdminDoctorAssign doctorId={id}>` |
| Hash `#/admin/doctors/<id>/blocks` | first mount | render `<AdminDoctorBlocks doctorId={id}>` |
| Hash `#/admin/types` | first mount | render `<AdminAppointmentTypes>` |
| Hash `#/admin/audit` | first mount | render `<AdminAuditPage>` |
| Hash `#/foo` | first mount | redirect → `#/admin/clinic` (unknown route) |
| Hash `#/admin/branches/<id>` (no sub) | first mount | render `<AdminBranches>` (parent fallback) |
| Link click | left-click | `window.location.hash = to` (no full reload) |
| Link click | middle-click / cmd / ctrl / shift | browser default (new tab / window) |
| `<Link to="#/X">` already on `#/X` | click | no-op (guard in `navigate`) |
| Back / forward | browser button | re-render via `hashchange` listener |
| `AdminAuditPage` load | 200 | render envelope + Retry |
| `AdminAuditPage` load | 401 | (client auto-clears auth → LoginPage) |
| `AdminAuditPage` load | 5xx / network | "Could not load audit policy: <code>" + Retry button |
| AppShell nav click | ClinicSettings active | stays on ClinicSettings (re-loads) |
| AppShell nav click | other section active | navigates to that section |

## Verification (manual, no tests in this pass per user instruction)

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001);
   `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Sign in as `admin-main@clinic.local` / role `admin`. Land
   on `/` → hash defaults to `#/admin/clinic` → ClinicSettings
   renders.
3. **Click "Branches" in the AppShell.** URL hash becomes
   `#/admin/branches` (no full reload). AdminBranches renders.
4. **Click "Audit log" in the AppShell.** URL hash becomes
   `#/admin/audit` (no full reload). AdminAuditPage renders
   the policy pill (`✕ rejected_per_role_policy`) + reason +
   reference + doctor / receptionist endpoints + future-work
   note + the "What you can see" list of resource-level audit
   endpoints.
5. **Click a StatTile on ClinicSettings.** URL hash flips
   (e.g. `#/admin/branches`), AppShell highlights Branches, the
   new section renders. **No full page reload.** View the
   browser console — no errors.
6. **Refresh on a deep sub-page.** From Branches, click "Edit
   hours" on a branch → URL is `#/admin/branches/<id>/hours` →
   AdminBranchHours renders. Press F5 → the page reloads
   (intended — the router can rehydrate from the hash). The
   AdminBranchHours renders again.
7. **Back / forward.** Click Branches → Audit → ClinicSettings,
   then press Back. Each press re-renders the previous section
   (the hash listener fires).
8. **Audit deep-link from ClinicSettings.** Open
   ClinicSettings, click "View audit log" — the inline policy
   card opens. Click "Audit log" in the card's foot — URL hash
   becomes `#/admin/audit` and AdminAuditPage renders.
9. **A11y.** Tab to a `<Link>`. Press Enter — the click handler
   runs (the keydown synthesises a click) and the hash updates.
   `aria-current="page"` is set on the active AppShell link.
10. **No regressions.** Doctor / patient / receptionist sessions
    are unaffected (their apps render their own state machines,
    not the admin router). Reload on any non-admin URL still
    works.
11. `pnpm --filter @clinic/web typecheck` — 0 new errors.
12. `pnpm --filter @clinic/web lint` — 0 **new** errors (the
    2 pre-existing `react/no-unescaped-entities` errors on
    ClinicSettings.tsx are baseline; the 2 pre-existing
    `Parsing error: Declaration or statement expected` errors
    on `.module.css` files are a pre-existing eslint config
    issue).
13. Grep new files for hex literals → 0 (E7-S1 invariant).

## Out of scope (deferred to later stories)

- **D-W59-1** — History API + SPA fallback. The hash approach is
  defensive against the Vite proxy; a future hardening story
  swaps to pushState when we add an SPA-fallback rule to the
  production reverse proxy.
- **D-W59-2** — react-router (or equivalent) for nested routes,
  route guards, params. The 60-line router is enough for the
  flat admin surface. When patient/doctor/receptionist flows
  grow their own sub-pages, each gets its own `usePathRoute`
  (or we promote this one to a shared router with role-based
  namespaces).
- **D-W59-3** — pre-existing lint baseline. The eslint config
  doesn't recognise `.module.css` files; the 2 pre-existing
  ClinicSettings.tsx apostrophes are baseline. A future
  linter-cleanup pass fixes both.
- **D-W59-4** — Search-string routing (e.g. `?branch=abc`). Today
  the router is path-only. Search-string support is a future
  add.
- **D-W59-5** — Browser back/forward on sub-pages across role
  transitions. The router resets to default when the role flips
  from admin to non-admin (via the LoginPage re-mount). UX is
  correct but not perfect; a future pass adds a "Back to previous
  URL" affordance on the LoginPage.

## Cross-references

- `apps/web/src/router/usePathRoute.tsx` — router
- `apps/web/src/App.tsx` — admin route dispatch
- `apps/web/src/AppShell.tsx` — `AdminSection` type + nav links
- `apps/web/src/pages/AdminAuditPage.tsx` — the new audit surface
- `apps/web/src/pages/AdminBranches.tsx` — branch-hours sub-page
  pattern
- `apps/web/src/pages/AdminDoctors.tsx` — doctor sub-pages
  pattern
- `apps/api/src/routes/admin-audit.ts` — `GET /admin/audit`
  (the policy envelope)
- `_bmad-output/implementation-artifacts/spec-1-0-ui-clinic-settings.md`
  — original W59 deferral