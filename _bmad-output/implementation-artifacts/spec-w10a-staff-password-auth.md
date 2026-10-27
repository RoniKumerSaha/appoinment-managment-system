---
title: 'W10a — Staff password credentials'
type: 'feature'
created: '2026-10-27'
status: 'done'
review_loop_iteration: 0
baseline_commit: '5d62be0'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-w10-staff-login-patient-otp.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-3-auth-provider-wiring.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-4-sms-otp-gateway.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
---

## Intent

**Problem:** `POST /auth/login/staff` was an **email-only stub**. The caller supplied `{role, email}` and, if a staff row matched, the route minted a JWT. The staff tables (`admin_user` / `doctor` / `receptionist`) had no credential column at all, so the endpoint proved only that the caller knew a seeded address.

The route was therefore confined to dev/test by `staffStubLoginAllowed` — correct as a stopgap, but it left the app with **no way to authenticate a staff user in production at all**. There was no path from "the app needs to be deployed" to "a real member of staff can sign in".

**Approach:** Give the staff tables a real credential, and teach the login route to verify it. Keep the email-only path as a dev-only convenience so the seeded accounts stay usable in the dev web app without provisioning a password first.

This closes the "stub auth" P2 gap that the 2026-10-26 gap-closure pass left open.

## Boundaries & Constraints

**Always:**
- The API JWT shape is unchanged — `AuthClaim` (`{sub, role, branch_ids, scope, doctor_id?, jti, expires_at}`). No new claim fields. A password login mints exactly the same token the email-only path mints.
- `password_hash` is added to all three staff tables as a **nullable** column (migration 0022). A NULL hash means "no credential configured".
- Hashing uses **Postgres `pgcrypto.crypt(..., 'bf')`** — bcrypt — not a native npm bcrypt dependency. `pgcrypto` is already installed (migration 0002) and granted (0011).
- A **CHECK constraint** on each table pins `password_hash` to the bcrypt shape (`^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$`) so a malformed or plaintext value can never be stored.
- A password login works in **every** environment. The email-only path works in **dev/test only**.
- The email-only refusal in production happens **before** any database lookup and answers **404 `not_found`**, not 401 — it hides the endpoint's existence rather than confirming that authentication is possible here.
- The password policy is a **floor, not a policy**: at least 12 characters (NIST SP 800-63B's recommendation for user-chosen secrets), under 72 UTF-8 bytes.
- There is **no read route that returns a hash**. The only observable state is "is a credential configured", reported by the set/clear responses.
- Every attempt (success or failure) on both the login route and the admin route is audit-logged with the email redacted (`${email[0]}***${email.slice(at)}`), matching the existing convention.
- The plaintext is a **bind parameter** in every SQL statement. It is never interpolated into SQL text.
- The web `LoginPage` gains an **optional** password field. A blank field means "use the dev-only email sign-in"; a non-blank one is sent as a credential. An empty string is never sent — that would be a password attempt and would fail.

**Ask First:**
- **A1 — bcrypt via pgcrypto vs. a native dependency.** (i) `pgcrypto.crypt(..., 'bf')` (chosen) — no new dependency to install, audit or pin, and `bf` is bcrypt with the same `$2a$` shape. The cost is that hashing requires a database round-trip, which is a non-issue here because hashes are created by an admin action against the live DB and verified on every login against the same DB. (ii) A native `bcrypt` npm package — the conventional choice, but adds a native build dependency and a second hashing implementation to keep consistent. (iii) `argon2` — stronger against GPU attacks, but a different algorithm from the one bcrypt-shaped tooling expects, and it would need a new extension as well as a new dependency.
- **A2 — NOT NULL with a backfilled default password vs. a nullable column.** (i) Nullable (chosen) — existing seeded rows keep working with no forced password reset on deploy, and each account opts in. (ii) NOT NULL with a backfilled default — rejected: it ships a well-known credential on every account, which is worse than no credential at all.

## I/O & Edge-Case Matrix

| # | Trigger | API behaviour | Web behaviour |
|---|---------|--------------|---------------|
| 1 | Admin sets a password on a doctor | `200 {credential_configured: true, role, id}` | — |
| 2 | Admin sets a password on an unknown id | `404 staff_not_found` | — |
| 3 | Non-admin sets a password | `403 forbidden_role` | — |
| 4 | Admin sets a password on an unknown role | `400 invalid_role` | — |
| 5 | Password under 12 chars | `400 password_too_short` | — |
| 6 | Password of 72+ UTF-8 bytes | `400 password_too_long` | — |
| 7 | Password is not a string | `400 password_required` | — |
| 8 | Staff logs in with the correct password | `200 {token, claim, expires_at, profile}` | Store the token, render the shell |
| 9 | Staff logs in with the wrong password | `401 invalid_credentials` | "That email and password combination is not valid." |
| 10 | Staff supplies a password but the account has no credential | `401 invalid_credentials` | Same as #9 — the two cases are deliberately indistinguishable |
| 11 | Staff logs in with no password, dev/test | `200` | Signed in via the dev-only path |
| 12 | Staff logs in with no password, production | `404 not_found` | "No staff account matches that role + email." |
| 13 | Staff logs in with a password, production | `200` | Signed in |
| 14 | Admin clears a credential | `200 {credential_configured: false, role, id}` | — |
| 15 | After clearing, a password login | `401 invalid_credentials` | Same as #9 |

## Code Map

**API (new / edited):**
- `apps/api/db/migrations/0022_staff_password_auth.sql` (NEW) — the nullable `password_hash` columns + the bcrypt-shape CHECK constraints.
- `apps/api/src/auth/password.ts` (NEW) — `hashPassword`, `verifyPassword`, `assertPasswordAcceptable`, the policy constants, `PasswordError`.
- `apps/api/src/routes/admin-staff-password.ts` (NEW) — `POST`/`DELETE /admin/staff/:role/:id/password`.
- `apps/api/src/routes/auth-staff.ts` (EDIT) — the login route accepts an optional `password`; `lookupStaff` selects the hash.
- `apps/api/src/app.ts` (EDIT) — mounts `adminStaffPasswordRouter` under `/admin` (behind `adminScope`).
- `apps/api/src/auth/config.ts` (EDIT) — the `staffStubLoginAllowed` doc comment now reflects that it governs only the email-only fallback.

**Web (edited):**
- `apps/web/src/api/client.ts` (EDIT) — `loginStaff` takes an optional `password`.
- `apps/web/src/auth/store.ts` (EDIT) — `loginAsStaff` takes an optional `password`.
- `apps/web/src/pages/LoginPage.tsx` (EDIT) — the staff card gains a password field; `invalid_credentials` gets a user-facing message.

## Reuse of existing code

- `apps/api/src/auth/config.ts` `loadAuthConfig()` — the `staffStubLoginAllowed` flag is reused as-is; only its meaning narrowed (it now governs the email-only fallback, not the whole endpoint).
- `apps/api/src/middleware/admin-scope.ts` — gates the new admin route unchanged.
- `apps/api/src/routes/auth-staff.ts` `lookupStaff` — extended in place to select the hash; the three role-specific SELECTs keep their existing joins.
- `apps/api/src/db/pool.ts` `getPool()` — reused for the hash/verify queries.
- `apps/web/src/api/client.ts` `request()` — unchanged; the password rides in the existing JSON body.

## Verification

1. `pnpm --filter @clinic/api typecheck` — 0 errors.
2. `pnpm --filter @clinic/web typecheck` — 0 errors.
3. `pnpm --filter @clinic/api lint` — 0 errors (14 pre-existing warnings, none in the new files).
4. `pnpm --filter @clinic/web lint` — 0 errors.
5. API suite — green (367 pre-existing + 19 new).
6. Web suites — green across all 11 runners.
7. `apps/api/test/19-staff-password-auth.test.ts` (NEW, 19 tests) — the hash is bcrypt and not the plaintext; the hash is never echoed back; role gating; the policy bounds; correct/wrong password; the email-only fallback in dev/test; the production refusal; clearing a credential.

## Spec Change Log

- 2026-10-27 — initial spec. Done.

## Deferrals

- **W10a-2 (defer) — SSO / OIDC for the clinic's IdP.** The password credential is the local half of W10a; the SSO half needs a provider decision and a separate story.
- **W10b (defer) — Token refresh / denylist.** Tokens are valid until `exp` (60 min). "Sign out" clears `localStorage` but does not revoke server-side.
- **W10c (defer) — Rate limiting on `/auth/login/staff` and `/patient/otp/verify-now`.** A password endpoint without rate limiting invites brute force.
- **W10d (defer) — Remove the dev-mode `x-auth-claim` header from the web client.** The API's `allowDebugHeader` guard can then be flipped to `false` in all environments.
- **W10e (defer) — Lockout after N failed attempts.** The LoginPage shows an attempts banner for the patient OTP card, but the server enforces nothing.
- **Password rotation / expiry / per-user reset — not specified.** The admin route sets and clears a credential; there is no rotation policy and no self-service reset flow.

## Cross-References

- `spec-w10-staff-login-patient-otp.md` — the staff login surface this completes (and whose W10a deferral this closes).
- `spec-0-3-auth-provider-wiring.md` — the JWT shape and `loadAuthConfig` contract.
- `spec-0-4-sms-otp-gateway.md` — the patient-side credential, which already had a real transport.
- `apps/api/db/migrations/0011_pgcrypto_grants.sql` — the `pgcrypto` grant this story depends on.
- `apps/api/src/metrics/counters.ts` — the counter registry (the P2-b gap closed in the same pass).
- `apps/api/src/routes/admin-stats.ts` — the real-query stats route (the P2-a gap closed in the same pass).
