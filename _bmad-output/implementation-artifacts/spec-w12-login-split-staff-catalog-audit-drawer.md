---
id: spec-w12-login-split-staff-catalog-audit-drawer
title: 'W12 — Split the login screen, give staff a real catalog, and give the receptionist an audit drawer'
type: 'feature'
created: '2026-10-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'c3da809'
context:
  - '{project-root}/docs/specs/PRD.md'
  - '{project-root}/docs/specs/UX-FLOWS.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
---

# W12 — Split the login screen, give staff a real catalog, and give the receptionist an audit drawer

## Intent

Four defects shipped together, because they share one root cause: **the
staff-facing surfaces were built against admin-facing surfaces and were
never exercised by an admin.**

1. **The login showed both audiences' forms at once.** One page rendered
   the staff sign-in form and the patient OTP form as two cards side by
   side. A patient was shown a role dropdown and a staff password field;
   a staff member was shown an OTP widget. On a narrow screen each had to
   scroll past the other's form first.

2. **The staff password was optional, and the API had a dev-only
   email-only path.** A blank password fell through to a development-only
   branch that minted a valid session for anyone who knew a seeded staff
   address. The password field was optional in the UI too, so nothing
   pushed a user to type one.

3. **The doctor and appointment-type pickers were empty for exactly the
   two roles that use them.** They read `GET /admin/doctors`,
   `GET /admin/appointment-types` and `GET /admin/branches`, all gated by
   `adminScope`, which requires `role === 'admin'`. A doctor or
   receptionist got `403 forbidden_role`, the pickers silently stayed
   empty, and the walk-in booking flow, the availability browser and the
   recurring-series form were unusable.

4. **The receptionist had no audit drawer.** The receptionist-scoped
   endpoint (`GET /reception/appointments/:id/audit`) and its client
   wrapper (`getReceptionistAppointmentAudit`) both existed, but no UI
   called them — even though PRD FR-051 grants that scope explicitly.

Two latent enum-casing bugs were found and fixed in the same pass; see
[Spec Change Log](#spec-change-log) SC3 and SC4.

## Boundaries & Constraints

- **No route may weaken an existing admin gate.** The fix for defect 3 is
  a *new* route family, not a relaxation of `adminScope`.
- **The catalog DTO shape must not change.** The doctor and receptionist
  screens already read `email` and `branches` off a doctor row and filter
  on `active`. A shape change would silently empty a picker — the same
  failure the new route exists to fix.
- **The API remains the sole enforcement point.** The UI refusing a blank
  password is a convenience; the API must independently refuse it.
- **The dev-only `x-auth-claim` fallback and the email-only login path
  stay DEV/TEST-only.** Neither becomes reachable in production.
- **Audit scope stays bounded.** The receptionist drawer reads events for
  appointments *at their branch* — never another branch's.
- **Existing session and sign-out behaviour must not regress.** Signing
  out of the patient screen must not bounce the user back to the patient
  form.

## I/O & Edge-Case Matrix

### Staff sign-in — `POST /auth/login/staff`

| Input | Output | Notes |
|---|---|---|
| role + email + **valid** password | `200` + session token | The only success path. |
| role + email + **empty** password | `400 password_required` | Refused in the UI *and* the API. |
| role + email + **wrong** password | `401 invalid_credentials` | Same envelope as an unknown email. |
| role + **unknown** email | `401 invalid_credentials` | Must not distinguish "no such user" from "wrong password". |
| role + email, password omitted entirely | `400 password_required` | The field is required, not merely validated when present. |
| email only, in `NODE_ENV=development` | `200` + token | **DEV/TEST ONLY.** Preserved deliberately for the existing test suite; unreachable in production. |

### Login screen routing — hash-based

| Hash | Screen | Notes |
|---|---|---|
| `#/login` | `LoginChooser` | The app root's landing screen. |
| `#/login/staff` | `StaffLoginPage` | Role + email + required password. |
| `#/login/patient` | `PatientLoginPage` | Phone + 6-digit OTP. |
| *(empty)* | `LoginChooser` | A bare `page.goto('/')` lands on a usable screen. |
| anything unrecognised | `LoginChooser` | Safe fallback — the chooser is always reachable. |

### `GET /staff-catalog/{doctors,branches,appointment-types}`

| Caller | Result |
|---|---|
| anonymous | `401` |
| doctor | `200` — the picker shape |
| receptionist | `200` — the picker shape |
| admin | `200` — the picker shape |
| patient | `200` — no credentials in the payload (the route is "any authenticated caller"; the catalog carries no patient rows and no secrets) |

| Query | Result |
|---|---|
| `?active=true` | Only active rows. |
| `?active=false` | Only inactive rows. |
| `?active=maybe` | `400 invalid_active_filter` |
| `?branch_id=<uuid>` (doctors) | Only doctors assigned to that branch. |
| `?branch_id=not-a-uuid` | `400 invalid_branch_id` |

**DTO shape (load-bearing — the screens read every field):**

```
doctor:            { id, full_name, email, active, specialty, branches[] }
branch:            { id, name, tz, active }
appointment_type:  { id, name, duration_minutes, description, is_active }
```

### Receptionist audit drawer

| Case | Result |
|---|---|
| Receptionist opens an appointment at their branch | `200` + the event list. |
| Receptionist opens an appointment at another branch | `403 outside_branch_scope` |
| Non-receptionist role | `403 forbidden_role` |
| Unknown / non-UUID appointment id | `404 not_found` |

## Code Map

### New API route — `apps/api/src/routes/staff-catalog.ts`

Three `GET` handlers returning the **same DTO shapes as the `/admin`
routes**, over the same data, mounted at `/staff-catalog` (no
`adminScope`). Filter parsing and the `invalid_active_filter` /
`invalid_branch_id` error envelopes are shared with the admin handlers
rather than re-implemented, so the two families cannot drift.

### New API test — `apps/api/test/20-staff-catalog.test.ts`

17 tests. The DTO-shape assertions are the load-bearing part: the
screens read `email` and `branches` off a doctor row, so a shape change
here silently empties a picker.

### New web pages

| File | Role |
|---|---|
| `apps/web/src/pages/LoginChooser.tsx` | The entry screen. |
| `apps/web/src/pages/LoginFrame.tsx` | Shared chrome for both form screens. |
| `apps/web/src/pages/StaffLoginPage.tsx` | Role + email + required password. |
| `apps/web/src/pages/PatientLoginPage.tsx` | Phone + OTP. |
| `apps/web/src/pages/login-routes.ts` | Hash → screen parser. |
| `apps/web/src/auth/login-hashes.ts` | The three hash constants. |
| `apps/web/src/pages/ReceptionistAuditDrawer.tsx` | The receptionist audit drawer. |

### Modified — API

- `apps/api/src/routes/receptionist-today.ts` — `VALID_STATUSES` casing
  (SC3).
- `apps/api/src/routes/doctor-recurring-series.ts` — completed-count
  casing (SC4).
- `apps/api/src/routes/auth-staff.ts` — `invalid_credentials` envelope.

### Modified — web

- `apps/web/src/pages/LoginPage.tsx` — reduced from the two-card page to
  a compatibility shell.
- `apps/web/src/pages/ReceptionistToday.tsx` — opens the drawer.
- `apps/web/src/pages/staff-nav-items.ts`, `StaffNav.tsx`,
  `styles/staff-nav.css` — staff navigation.
- `apps/web/vite.config.ts` — **the dev proxy map.** A missing prefix is
  not proxied, so Vite answers from the SPA fallback and returns a 404
  with an HTML body, which the client surfaces as
  `api_404:unknown_error`.

### Modified — data

- `apps/api/db/seeds/03_rich_operations.ts` — the rich operational seed:
  staff `password_hash` credentials, doctor blocks, full-status
  appointment history, a recurring series, and an audit trail.

## Reuse of existing code

- **`DoctorAuditDrawer` is the template.** `ReceptionistAuditDrawer`
  mirrors it — same slide-in shape, same filter-chip vocabulary — so the
  two role surfaces read as one feature. The difference is scope: the
  doctor sees events for their own appointments; the receptionist sees
  events for appointments at their branch.
- **`login-hashes.ts` lives in `auth/`, not `pages/`.** Both the auth
  store and the login screens need the constants. Keeping them in
  `auth/` avoids a layering inversion (`auth/` importing from `pages/`)
  and stops the two sides drifting apart on the literal.
- **`parseLoginRoute` is its own reader, not an extension of
  `usePathRoute`.** `usePathRoute` is the *admin* router; its
  `ParsedRoute` union only knows `admin-top` / `admin-sub`, and
  `App.tsx` consults it *after* the authenticated shell is chosen. The
  login renders *before* any shell, for an unauthenticated visitor, so
  folding it into the admin router would mean teaching the admin parser
  about auth.
- **Hash routing, not `history.pushState`.** The whole app is
  hash-routed; a `pushState` route would 404 on refresh because the Vite
  dev proxy forwards unknown paths to the API.

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | **Pass** — both packages, no errors. |
| `pnpm lint` | **Pass** — 0 errors (14 pre-existing `no-unused-vars` warnings in files this story does not touch). |
| `pnpm --filter @clinic/api run test` | **Pass** — 425/425 across 21 files. |
| `pnpm --filter @clinic/web run test:e7-s1` | **Pass** — token-only CSS invariant holds; the new drawer CSS uses tokens only. |
| `pnpm --filter @clinic/web run test:e7-s4` | **Pass** — `ConflictModal` is still the only conflict modal. |
| `pnpm --filter @clinic/web run build` | **Pass** — production build succeeds. |
| New e2e specs | **Written but NOT run** — `login-split`, `staff-login`, `staff-nav`, `receptionist-audit` need a live seeded API. See [Deferrals](#deferrals). |

## Spec Change Log

### SC1 — New requirement IDs, no renumbering

`FR-052` (Staff Authentication) and `FR-053` (Login Screen Separation)
are **new**. `FR-051` was **extended** with an explicit read-scope list
rather than replaced. No existing `FR-` / `BR-` / `F-` ID was renumbered
or reused; the change log in `docs/specs/PRD.md` records the additions
and why.

### SC2 — UX-FLOWS section renumbering

The sign-in flow was previously described only implicitly, inside the
primitive table. It is now a first-class flow, `F-00`, with its own
section. That required inserting **section 2**, so the downstream
sections shifted: Patient Flows §2→§3, Doctor §3→§4, Receptionist
§4→§5, Administrator §5→§6, Cross-Cutting §6→§7, Open Questions §7→§8,
Traceability §8→§9.

**Section numbers are structural and may shift; flow IDs
(`F-NN`) are stable and do not.** Every inbound cross-reference across
the repository was updated in the same commit. Two references were found
to have been **stale before this change** and were corrected at the same
time — they pointed at a section that never existed:

| Reference | Before | After | Why |
|---|---|---|---|
| `spec-7-4-conflict-modal-global-component.md` | `§8 (Conflict Patterns)` | `§7.1` | §8 was Traceability Summary; "Conflict Patterns" was always §6.1. |
| `apps/web/test/conflict-modal-singleton.test.ts` | `§8` | `§7.1` | Same. |
| `spec-6-4-recurring-occurrence-cancel-reschedule.md` | `§4.7` | `F-11 (per-occurrence independence)` | There was never a §4.7; the rule lives in F-11. |
| `spec-3-4-receptionist-booking-on-behalf-of-patient.md` | `§508` | `F-13` | A stale line-number reference. |

### SC3 — `No-show`, not `No-Show` (API bug)

**The code was wrong; the code was changed.** The `appointment_status`
DB enum is `{Scheduled, Completed, Cancelled, No-show}` — lowercase
`s` — and the API mirrors the enum verbatim on the wire. Two places
spelled it `'No-Show'`:

- `receptionist-today.ts` — `VALID_STATUSES` accepted `'No-Show'`, but
  the web UI sends `'No-show'`. Filtering the receptionist day by
  no-show returned `400 invalid_status`.
- `doctor-recurring-series.ts` — the completed-count filter matched
  `'Completed' || 'No-Show'`, so a no-show occurrence was **never
  counted as completed**.

Both were fixed to `'No-show'`. The corresponding test literals and the
`apps/web/e2e/helpers/api.ts` signature were updated to match. The doc
comments across eight route files were normalised at the same time.

### SC4 — Audit visibility was documented but not built

`docs/specs/UX-FLOWS.md` §7.3 already specified "Doctors and
receptionists — audit history for appointments they own", and PRD
FR-051 granted the receptionist scope. **The code was the gap**, not the
doc. The receptionist drawer was built to match the existing spec rather
than the spec being weakened.

### SC5 — The email-only login path is retained in dev

The API still honours an email-only staff login in `NODE_ENV=development`
/ `test`. It is **not** reachable in production, and it exists because
the pre-W12 test suite creates staff tokens that way. The UI refuses a
blank password unconditionally, so the path is not reachable from the
product surface. Closing it in the API too would require regenerating
every staff token in the test suite — see [Deferrals](#deferrals).

## Deferrals

| Item | Why | Follow-up |
|---|---|---|
| The four new e2e specs have not been run | They need a live seeded API and a browser. | Run `pnpm --filter @clinic/web run test:e2e` once the dev stack is up. |
| The dev-only email-only API path still exists | The pre-W12 test suite mints staff tokens through it. | Close it alongside a token-registry rework; `FR-052` is satisfied for the product surface today. |
| No token refresh or denylist | Out of scope for W12. | — |
| No rate limiting or lockout on the login routes | Out of scope. | — |
| Per-page WCAG audit | The global a11y rules are locked by static tests. | Per-page `axe` validation deferred. |

## Cross-References

- **PRD:** `FR-051` (read scopes), `FR-052` (staff authentication),
  `FR-053` (login screen separation), `FR-031` (patient authentication —
  unchanged), `§2.1` / `§2.2` / `§2.3` (role capabilities).
- **UX-FLOWS:** `F-00` (sign-in), `F-10` / `F-12` / `F-14` (audit
  surfaces), `§7.1` (ConflictModal), `§7.2` (atomicity), `§7.3` (audit
  visibility), `§7.4` (time zone), `§7.5` (no buffer / fixed window),
  `§8` (open questions), `§9` (traceability).
- **Architecture:** principle 2 (atomicity over clever UX), §3.4,
  §5, AD-9.
- **BRD:** `BR-004`, `BR-012`, `BR-013`, `BR-036`, `BR-040`, `BR-063`.
- **Stories:** `w10-staff-login-patient-otp` (the login this replaces),
  `E3-S4`, `E5-S4`, `E6-S4`.
- **Prior art:** `spec-7-4-conflict-modal-global-component.md` (the
  shared-modal pattern), `spec-5-3-5-4-ui-receptionist-today-cancel.md`
  (the receptionist today screen this drawer attaches to).
