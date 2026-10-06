---
title: 'W10 — Real staff login + patient OTP web'
type: 'feature'
created: '2026-10-06'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'E1-S0-ui (841dc15)'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics-and-stories.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-3-auth-provider-wiring.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-4-sms-otp-gateway.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-0-ui-clinic-settings.md'
  - '{project-root}/docs/design/DESIGN-SYSTEM.md'
  - '{project-root}/docs/design/mockups/v1/mockups/21-patient-otp-modal.html'
---

## Intent

**Problem:** Epic 1's API surface is complete and the E1-S0-ui web page (admin clinic settings, hash `841dc15`) is pixel-perfect against mockup 32. Every other admin / doctor / receptionist / patient page is missing, but the most fundamental blocker is **auth**: the web client uses a hard-coded dev-mode `x-auth-claim` header in `apps/web/src/api/client.ts` that the API silently drops in production (`loadAuthConfig().allowDebugHeader === false`). There is no way to log in as a doctor, a receptionist, a patient, or even a different admin. The E0-S3 review pass deferred staff login to "whoever owns the staff login surface" — that owner is this story.

**Approach:** Ship the smallest end-to-end change that unblocks every other UI story — one new API route, one new web page, and a token store in the existing API client. Keep the dev-mode `x-auth-claim` admin header working as a fallback for offline development (deferred to W10d). Once W10 lands, every other UI story (admin pages, patient booking, doctor dashboard, etc.) can be built behind a real auth wall.

## Boundaries & Constraints

**Always:**
- The API JWT shape is the existing `AuthClaim` (`{sub, role, branch_ids, scope, doctor_id?, jti, expires_at}`) — no new claim fields. The staff login route mints the same claim the patient route already mints (`apps/api/src/routes/patient-otp.ts` is the model).
- `POST /auth/login/staff` is **email-only** for now. No password column exists in the seed (`admin_user` / `doctor` / `receptionist` don't have one) and adding one is explicitly deferred to W10a (a future hardening pass). The route is annotated `staff_login_dev_only` so a future story can swap the verification step.
- The staff route looks up the user by `(role, email)`, joins to the right branch table (`admin_user` → `branch` on `clinic_id`; `doctor` → `doctor_branch` → `branch` (first row by `created_at`); `receptionist` → `branch`), and mints a JWT. Admin's `branch_ids` is `[<seeded east branch UUID>]` with `scope: 'clinic'` so the E0-S3 empty-branch_ids guard is satisfied without the `__clinic_anchor__` sentinel.
- `GET /auth/me` is mounted AFTER `authMiddleware` and rehydrates the claim + profile from `req.auth.claim`. Used by the web client on app boot to confirm a stored token is still valid.
- All email columns are `citext` (migrations 0004 / 0016 / 0017); the SQL casts use `$1::citext` so the case-insensitive comparison happens at the column type, not in a WHERE-clause `lower()` wrapper.
- The web client reads the token from `localStorage` under `medislot.auth`. Token is dropped 60s before `expires_at` (early-expiry cushion so requests in flight don't get 401'd mid-call). On any 401 from the API, the client fires `setOnUnauthorized(clearAuth)` so the auth store clears and the parent re-renders `<LoginPage />`.
- LoginPage is two cards on a single 760px frame (mockup 21's frame). Left = staff sign-in (admin / doctor / receptionist) which calls `POST /auth/login/staff`. Right = patient OTP (mockup 21) which calls `POST /patient/otp/verify-now`. Both cards use the design tokens (`var(--…)`) — no hex literals.
- The patient OTP card has 6 separate `<input>`s with auto-advance, paste-spread (`handleDigit`), and backspace-navigates-previous (`handleKeyDown`). Dev mock code is `123456` per `MOCK_OTP_CODE` default. Resend is a non-functional link (no SMS gateway in dev).
- The staff card surfaces a dev seed hint block (`admin-main@clinic.local` / `dr.-east-lead@clinic.local` / `receptionist-east@clinic.local`) so a developer can copy/paste from the dev seed.
- `App.tsx` gates the existing `<AppShell active="clinic"><ClinicSettings /></AppShell>` behind a real auth check: on mount, if a token is in `localStorage`, POST `/auth/me` to confirm; on 401, clear and render `<LoginPage />`. While the me-call is in flight, render a centered "Loading…" status. The user chip in AppShell is now dynamic: name + role from the stored profile + `claim.role` (capitalized), plus a small "Sign out" button that calls `logout()` from the auth store.
- The dev-mode `x-auth-claim` header is still wired as a fallback in `apps/web/src/api/client.ts:request()` for the no-backend dev path. When a token is present in `localStorage`, the Bearer header takes precedence.
- Every login attempt (success AND failure) is audit-logged via `getLogger()` with the email redacted (`${email[0]}***${email.slice(at)}`).
- Error responses use the existing `ApiError` shape: `400 invalid_email` / `invalid_role`, `401 staff_not_found`, `500 internal_error`. The web side surfaces these via a small `describeApiError()` helper inside `LoginPage.tsx`.
- No tests are added in this pass (per user instruction).

**Ask First:**
- **A1 — Admin's `branch_ids` for staff login.** The seeded admin has no branch (admin_user has no branch column). Three options: (i) use the seeded `branch-east` UUID as the admin's branch placeholder (chosen — the admin's `scope: 'clinic'` JWT works today, and the admin can read every branch via the `clinic` scope; the placeholder is invisible to the client because the `profile.branch_id` field is metadata only); (ii) introduce a `__clinic_anchor__` sentinel (deferred — already used in E1-S0-ui's dev claim, not in scope here); (iii) modify the admin's claim to have empty `branch_ids` and trust the scope check (not viable — the E0-S3 guard rejects empty `branch_ids` for staff). (i) is recommended and chosen.
- **A2 — `GET /auth/me` location.** Three options: (i) own router mounted at `/auth` AFTER `authMiddleware` (chosen — symmetric with the login route, fits the existing app.ts mount pattern); (ii) attach to the existing `authStaffRouter` (mixed public+authenticated on the same router — works but reads confusingly); (iii) a third router `auth-me.ts` (over-decomposed for one route). (i) is recommended and chosen.

## I/O & Edge-Case Matrix

| # | Trigger | API behaviour | Web behaviour |
|---|---------|--------------|---------------|
| 1 | Staff sign-in: valid `(role, email)` | `200 {token, claim, expires_at, profile}` | Store in `localStorage`, render AppShell |
| 2 | Staff sign-in: unknown email | `401 staff_not_found` | "No staff account matches that role + email." |
| 3 | Staff sign-in: malformed email | `400 invalid_email` | "Enter a valid email address." |
| 4 | Staff sign-in: missing role | `400 invalid_role` | "Pick a role." |
| 5 | Staff sign-in: network down | Connection refused → `ApiError(0, 'network_error')` | "Connection failed. Is the API running on :3001?" |
| 6 | Patient OTP: valid `(phone, code)` | `200 {token, claim, expires_at, profile}` | Store in `localStorage`, render AppShell |
| 7 | Patient OTP: wrong code | `401 invalid_otp_code` | "Invalid code. Try again." |
| 8 | Patient OTP: malformed phone | `400 invalid_phone` | "Phone must include country code, e.g. +966 5… 5555." |
| 9 | App boot: token in storage, `/auth/me` 200 | OK | Render AppShell |
| 10 | App boot: token in storage, `/auth/me` 401 | — | Clear storage, render LoginPage |
| 11 | App boot: token in storage, `/auth/me` 500 | — | Keep session; surface error inside ClinicSettings (existing pattern) |
| 12 | App boot: no token in storage | — | Render LoginPage |
| 13 | Token past `expires_at` (in storage) | — | `useAuth().expired === true`; clear, render LoginPage |
| 14 | Any in-flight request returns 401 | — | Fire `onUnauthorized` → `clearAuth()` → parent re-renders LoginPage |
| 15 | Sign-out | — | `logout()` clears `localStorage`; parent re-renders LoginPage |
| 16 | Patient OTP cell: paste 6 digits | — | Spread across all 6 cells; focus last cell |
| 17 | Patient OTP cell: paste 1 digit | — | Set that cell's value; focus next cell if not last |
| 18 | Patient OTP cell: backspace on empty | — | Focus previous cell |
| 19 | Patient OTP cell: invalid `verify` | — | Mark all 6 cells `.error` (red border via `--danger-strong`) |

## Code Map

**API (new / edited):**
- `apps/api/src/routes/auth-staff.ts` (NEW) — `POST /auth/login/staff` + `GET /auth/me`. `lookupStaff(role, email)` does three SELECTs depending on role. Audit-logs every attempt.
- `apps/api/src/app.ts` (EDIT) — Mount `authStaffRouter` BEFORE `authMiddleware` (login is its own auth gate). Mount `authMeRouter` AFTER `authMiddleware` (me-route needs claim).

**Web (new / edited):**
- `apps/web/src/api/client.ts` (REWRITE) — Token store (`readTokenFromStorage`), `setOnUnauthorized(cb)`, `request()` resolves Bearer from store with 60s early-expiry cushion, falls back to `x-auth-claim` debug header when no token. New endpoints: `loginStaff`, `verifyPatientOtp`, `getMe`. Existing `getClinic` / `patchClinic` unchanged in signature.
- `apps/web/src/auth/store.ts` (NEW) — `useAuth()` (React `useSyncExternalStore`), `loginAsStaff(input)`, `verifyPatientOtp(input)`, `logout()`, `clearAuth()`. Key: `medislot.auth` in `localStorage`.
- `apps/web/src/pages/LoginPage.tsx` (NEW) — `LoginPage` renders the 760px-wide frame with nav + 2 cards + privacy footer. `StaffCard` (role + email). `PatientCard` (phone E.164 + 6 OTP cells with auto-advance + paste).
- `apps/web/src/pages/LoginPage.module.css` (NEW) — Two-card grid (`grid-template-columns: 1fr 1fr`, single-column fallback at 920px). OTP cell styles (filled teal, error red, focus ring). Hint block with dev seed credentials.
- `apps/web/src/App.tsx` (REWRITE) — `useEffect` wires `setOnUnauthorized(() => clearAuth())` at boot. `useEffect` calls `getMe()` on mount if stored token exists; on 401, clears. Renders Loading… while checking. Renders LoginPage when not authenticated. Renders AppShell when authenticated.
- `apps/web/src/AppShell.tsx` (REWRITE) — User chip is dynamic: reads `useAuth()`, shows `profile.full_name` + `ROLE_LABELS[role]` + initials + Sign-out button. Falls back to "Sara Al-Otaibi" when no session (defensive — should not happen since App.tsx gates the shell).
- `apps/web/src/styles/shell.css` (EDIT) — Adds `.nav__signout` rules (transparent background, border-default border, radius-sm, focus ring via `--ring-focus`).

## Reuse of existing code

- `apps/api/src/auth/jwt.ts` `signClaim` / `verifyToken` — the staff route mints the same JWT shape the patient route already mints. No changes.
- `apps/api/src/auth/config.ts` — `loadAuthConfig()` is reused as-is. `mockOtpCode` and `mockOtpAllowed` are unchanged.
- `apps/api/src/routes/patient-otp.ts` — copy the `verifyToken(token)`-after-mint pattern (`patient-otp.ts:88-95`) for the staff route so `expires_at` and `jti` are read from the single source of truth.
- `apps/api/src/middleware/auth.ts` `parseBearerHeader` — the staff route doesn't read claims; the me-route uses the existing `req.auth.claim` population.
- `apps/api/src/middleware/log.ts` `getLogger` — same audit-log pattern as `patient-otp.ts:62-79`.
- `apps/web/src/styles/tokens.css` — every value in `LoginPage.module.css` is `var(--…)`. No new tokens needed.
- `apps/web/src/styles/shell.css` — `AppShell.tsx` is extended in place; the new `.nav__signout` style reuses the same `--text-default` / `--text-muted` palette.
- `docs/design/mockups/v1/mockups/21-patient-otp-modal.html` — visual reference for the patient OTP card.
- `docs/design/DESIGN-SYSTEM.md` — token references throughout. §3.4 phone format, §8 stacked-vertical frame.

## Verification (manual, no tests in this pass per user instruction)

1. DB up; `pnpm --filter @clinic/api dev` (API on :3001); `pnpm --filter @clinic/web dev` (Vite on :5173).
2. Open `http://localhost:5173/` → LoginPage renders. No redirect; no token in `localStorage`.
3. **Patient path.** Enter phone `+15550000001` (seeded patient 0001) and code `123456`. Click "Verify & continue" → 200, token stored, ClinicSettings renders. Reload — the session persists from `localStorage`; ClinicSettings renders.
4. **Staff path.** Sign out. Sign in with `admin-main@clinic.local` / role `admin`. Token stored, ClinicSettings renders. The user chip now shows "Admin Main" (from the `profile.full_name` lookup on the me-route).
5. **Wrong email.** Sign out. Sign in with `nobody@clinic.local` / role `doctor` → 401 `staff_not_found`, LoginPage shows "No staff account matches that role + email."
6. **Wrong code.** Sign in as patient with code `000000` → 401 `invalid_otp_code`, LoginPage shows "Invalid code. Try again."
7. **Doctor session.** Sign in as `dr.-east-lead@clinic.local` / role `doctor` → claim has `doctor_id: <uuid>`, `branch_ids: [<east>]`, `scope: 'branch'`. (Verified in DevTools → Application → Local Storage → `medislot.auth`.)
8. **Token expiry.** Manually edit the stored `expires_at` to a past ISO, reload. The boot-time me-call returns 401; the app clears storage and shows LoginPage.
9. **No regressions.** The dev-mode `x-auth-claim` admin header is still wired. Clearing `localStorage` and reloading still shows ClinicSettings (the request() falls back to the admin claim). Documented in W10d below.
10. `pnpm --filter @clinic/api typecheck` — 0 new errors (3 pre-existing baseline errors in `src/otp/{provider,service,twilio-provider}.ts` are unchanged and out of scope).
11. `pnpm --filter @clinic/web typecheck` — 0 errors.
12. `pnpm --filter @clinic/web lint` — 0 new errors (2 pre-existing baseline errors in `ClinicSettings.tsx` are unchanged and out of scope).
13. Grep `apps/web/src` for hex literals outside `tokens.css` → 0 (E7-S1 invariant).

## Spec Change Log

- 2026-10-06 — initial spec (Amelia / W10). Done.

## Deferrals

- **W10a (defer) — Password / SSO for staff.** Today the staff route is `email-only`. The route is annotated `staff_login_dev_only` so a future hardening story can swap the verification step. Spec: a future `epic-10` hardening pass adds the password column (bcrypt hash), a `POST /auth/login/staff/password` route, and the SSO integration (OIDC for the clinic's IdP).
- **W10b (defer) — Token refresh / denylist (W8 / W9 from E0-S3 review pass).** Tokens are valid until `exp` (60 min). "Sign out" clears `localStorage` but doesn't revoke server-side. Spec: a future `epic-11` adds refresh tokens, a denylist (Redis or `revoked_jti` table), and a "Sign out everywhere" affordance.
- **W10c (defer) — Rate limiting on `/auth/login/staff` and `/patient/otp/verify-now` (replay protection).** Mock OTP at `/patient/otp/verify-now` is also unrate-limited. Spec: a future `epic-11` adds per-IP and per-phone rate limits (token bucket, e.g. 5/min/IP, 10/hour/phone).
- **W10d (defer) — Remove the dev-mode `x-auth-claim` header from the web client.** The web app's `request()` only sends the header when no token is in `localStorage`. Spec: a future hardening pass rips the dev affordance out of the web client so the API's `allowDebugHeader` guard can be flipped to `false` in all environments.
- **W10e (defer) — Real lockout after N failed OTP attempts.** Mockup 21 shows the affordance ("2 attempts remaining before lockout"); we don't ship lockout — that's E0-S4 / E4-S1's contract on the back-end. The row is present in the UI for mockup layout parity but is a static text.
- **W10f (defer) — A router.** The LoginPage + ClinicSettings composition is the entire app for now. The next admin page (E1-S1 UI for branches) is the natural place to introduce a router (W59 from the E1-S0-ui deferrals, already on the task list). The router is also the natural place to put the redirect-after-login logic; today the redirect is a hard `/` (ClinicSettings).

## Cross-References

- `spec-0-3-auth-provider-wiring.md` — JWT shape, `loadAuthConfig`, `mockOtpCode`, `allowDebugHeader`.
- `spec-1-0-ui-clinic-settings.md` — the page that's now gated behind the auth wall.
- `epic-1-context.md` §"deferral W10" — the deferral that this story fulfills.
- `docs/design/DESIGN-SYSTEM.md` §3.4 (phone format), §8 (stacked-vertical frame), §2-7 (token catalogue).
- `docs/design/mockups/v1/mockups/21-patient-otp-modal.html` — patient OTP card visual reference.
- `apps/api/src/routes/patient-otp.ts` — the route this story mirrors.
- `apps/api/src/auth/jwt.ts` — JWT minter/verifier (no changes).
