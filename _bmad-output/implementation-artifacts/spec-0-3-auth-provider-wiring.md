---
title: 'E0-S3 — Auth provider wiring'
type: 'feature'
created: '2026-09-10'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'E0-S2 review'  # current HEAD at spec time
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'  # W7 (pgcrypto grant) lives here
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates. Re-approved after 2026-09-10 code review (5 decisions resolved, 43 patches applied).">

## Known Architecture Divergence

**E0-S3 does not implement the refresh contract from Architecture §3.1.** The architecture binds session tokens to "…plus a refresh contract" but E0-S3 ships short-lived access tokens only (60-minute default). Refresh tokens are explicitly deferred to W8 (E7 hardening). Patient and staff flows during E1–E6 will operate against access tokens only; the refresh path lands when W8 ships.

## Intent

**Problem:** E0-S1 stubbed auth via a `x-auth-claim` debug header so test code could exercise claim-aware guards. E0-S2 widened the data model with the entities those guards will filter on (`receptionist`, `admin_user`, `doctor`, `branch`, `appointment`). The architecture spine (§3.1) requires the chosen auth library to issue session tokens whose signed claims include `{role, branch_ids: string[], scope, doctor_id?: string}` plus a refresh contract, and the server MUST read `branch_ids` from the claim — never the request body. E0-S3 closes that gap: pick a provider, wire it through middleware, prove it satisfies every E0 acceptance bullet (role-route separation, empty-branch rejection, doctor-only enforcement), and stand up the patient login path via a **mocked OTP** so E4-S1 inherits a working `/patient/otp/verify-now` instead of plumbing from scratch.

**Approach:** Self-issued JWT (HS256, shared secret from `AUTH_SECRET` env var) — no external dependency, no session table, fits the greenfield spirit. Middleware tries `Authorization: Bearer <jwt>` first; falls back to the existing `x-auth-claim` debug header when `NODE_ENV !== 'production'` so the 12 E0-S1 `auth.test.ts` cases continue to pass unchanged. A single mocked `/patient/otp/verify-now` route accepts `{phone, code}` and mints a patient JWT when `code === process.env.MOCK_OTP_CODE` (default `'123456'`) — E4-S1 replaces this stub with the real SMS-OTP-backed verifier, but the contract it exposes (`POST → token + patient session payload`) is stable. Staff login is deferred to a future story (E1-S0 admin or a dedicated E1-S3 staff-login story) and is explicitly **out of scope** here.

Why JWT over Lucia/sessions: the architecture's claim shape is already structured (role + branch_ids + scope + doctor_id) — JWT fits one-to-one without an extra session-table migration. Why JWT over Clerk/Auth0: greenfield, no third-party secrets, and the spec's auth contract is fully local. Why HS256 over RS256: no key distribution problem in a single-service deploy; asymmetric keys belong to a future multi-service story.

**Out of scope (deferred):**
- Real SMS OTP integration (E0-S4 wires the gateway; E4-S1 ships the modal).
- Staff login routes (a future E1 story — `0-3-auth-provider-wiring.md` is intentionally patient-only on the login surface).
- Token refresh / rotation (E7's hardening pass — current story ships short-lived access tokens only, no refresh claim yet).
- Logout / denylist (no revocation story exists yet; tokens are valid until `exp`).
- CSRF protection (the bearer header pattern is naturally CSRF-immune; cookie-based sessions arrive with the web app's authenticated routes in E1).

## Boundaries & Constraints

**Always:**
- Tokens are signed with HS256 using `process.env.AUTH_SECRET`. Server refuses to boot if `AUTH_SECRET` is missing in **any** env (no dev/test fallback). Devs copy the placeholder from `.env.example`. The boot guard logs `auth_secret_missing` and exits non-zero.
- `AUTH_SECRET` MUST be at least **32 bytes** (measured with `Buffer.byteLength`, not `.length` — UTF-16 code units miscount multibyte chars). Shorter values are rejected at boot with `auth_secret_too_short`.
- Claim shape is exactly `{sub, role, branch_ids: string[], scope, doctor_id?: string, aud, iss, jti, iat, exp}` — never more, never less. `aud: 'clinic-api'`, `iss: 'clinic-api'`, `jti: <uuid v4>` are mint-time-mandatory and verifier-time-mandatory (verifier rejects missing `aud`/`iss` mismatch / missing `jti`). Enforced by the minter (rejects extras) and the verifier (rejects unknown fields AND missing required fields). Rationale: `jti` enables the future W9 denylist without re-issuing tokens; `aud`/`iss` prevent confused-deputy attacks if the secret ever leaks to another service.
- `branch_ids` is read from the claim only. Body fields named `role`, `branch_ids`, `scope`, `doctor_id` are NEVER consulted by `authMiddleware` AND by the `/patient/otp/verify-now` route handler. The existing 12-test `auth.test.ts` body-escalation assertion continues to pass against the Bearer path; a new test in `patient-otp.test.ts` asserts the OTP route does not consult body for claim fields.
- Tokens carry `iat` and `exp`. `iat` MUST be ≤ `now + 30s` (clock skew tolerance); `exp` MUST be > `iat`; `exp - iat` MUST equal `AUTH_TOKEN_TTL_SECONDS` exactly. Default lifetime: 60 minutes. Configurable via `AUTH_TOKEN_TTL_SECONDS` (default `3600`). Boot guard rejects `AUTH_TOKEN_TTL_SECONDS <= 0`, non-integer, or non-numeric.
- `iat` and `exp` are JSON numbers (RFC 7519 NumericDate), not strings. Verifier rejects string-encoded values.
- Mocked OTP code is `process.env.MOCK_OTP_CODE ?? '123456'`. Any other value yields 401 `{error: 'invalid_otp_code'}`. The mock is the only path that mints a patient JWT in this story; E4-S1 replaces the body but keeps the route + response shape. **Rate limiting is intentionally not in scope** for the mock (deferred to E0-S4 / E4-S1, which wire the real SMS gateway and the OTP lockout contract); a comment in the route file marks the boundary.
- Phone format for the mock: must look like E.164 (`^\+[1-9]\d{6,14}$` — 8 to 15 total digits including the leading `+`). Validation runs after `typeof body.phone === 'string'`; missing or non-string yields 400 `{error: 'invalid_phone'}`. The mock does NOT write to `otp_verification` (that's E0-S4's job); it short-circuits verification entirely.
- The mocked path is gated behind `process.env.NODE_ENV ∈ {development, test}` — an **allowlist**, not a denylist. Production, staging, or any other NODE_ENV refuses to register the route. Boot logs `mock_otp_disabled_<env>` when registration is skipped. Production must use E0-S4's SMS gateway.
- The mock OTP code comparison uses `crypto.timingSafeEqual` against equal-length buffers — no early-return string comparison (timing side-channel).
- The mock OTP response `{token, claim, expires_at}` derives `expires_at` from `decode(token).exp` (single source of truth; no drift between `iat + ttl` and `now + ttl`).
- `req.auth.claim` shape at runtime: matches the JWT payload minus `aud`/`iss`/`jti`/`iat`/`exp` (those are transport-level, not domain claims). The frozen `types/auth.ts` interface gains `expires_at: number` derived from `exp` so downstream consumers don't have to decode twice. `actor_role` and `actor_id` log context is attached by both the Bearer path and the debug path identically — a new test in `log-bearer.test.ts` pins this.
- All E0-S2 invariants still hold: `EXCLUDE USING gist`, partial unique indexes, `updated_at` triggers, append-only audit, polymorphic `created_by`. E0-S3 adds NO migrations.
- E0-S3 closes deferred-work item W7 by adding `GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC` in a follow-up migration (`0011_pgcrypto_grants.sql`) so a future non-superuser role can call `gen_random_uuid()`. Migration is forward-only; down step revokes the grant. Migration starts with `CREATE EXTENSION IF NOT EXISTS pgcrypto` for idempotency. AC-20 includes a `pgcrypto-grants.test.ts` that creates a low-privilege role fixture (`app_user`) in `withTestDb`'s `beforeEach`, grants it `CONNECT` on the DB and `USAGE` on the schema, then `SET ROLE app_user; INSERT INTO clinic (name) VALUES (...)` to prove `gen_random_uuid()` works.
- Migration numbering: `0011_pgcrypto_grants.sql` is reserved by E0-S3. E0-S4 (SMS OTP gateway) and E0-S5 (seed fixtures) MUST NOT use `0011`; if a parallel branch reserves it, the conflict is resolved at merge time by re-numbering the later migration (E0-S4 starts at `0012`).
- Log redaction: `req.auth.claim` is **never** logged at info+ levels (only `actor_role` and `actor_id`, both already in scope). JWT strings are **never** logged. Phone numbers are redacted in mock-OTP audit logs (only last 4 digits or a hash).
- Constant-time HMAC compare: `verifyToken` uses `crypto.timingSafeEqual` on signature buffers; `signClaim`/`verifyToken` always go through HMAC SHA256 with the configured secret — never trust the token's `alg` header (verifier hardcodes `'HS256'` and rejects `alg=none` or any other value).

**Ask First:**
- Token storage — Authorization: Bearer header only (recommended; matches the architecture's "server reads from claim, never body" posture and is naturally CSRF-immune). Switching to cookies would require a CSRF story.
- Token TTL — 60 minutes default (recommended for a greenfield with no refresh story). Shorter (15 min) requires refresh tokens; longer (24 h) increases blast radius if leaked.
- Mock OTP code — `'123456'` default (recommended). Production deployments MUST override via `MOCK_OTP_CODE` (and the production guard refuses to register the route anyway).

**Never:**
- No external auth provider (Clerk, Auth0, Firebase Auth) — the architecture binds us to local claim shape.
- No session table — JWT is the session.
- No OAuth/OIDC flows — staff login is a future story, patient login is mocked.
- No password storage — patients are OTP-only; staff will use a password/SSO mechanism decided in a later story.
- No cookies set by `/patient/otp/verify-now` — the response body holds the JWT; the web client stores it (decisions deferred to E1 when the web shell consumes it).
- No `req.body` consultation in `authMiddleware` (architectural invariant from §3.1; body-escalation test must keep passing).
- No production deploy with `MOCK_OTP_CODE` set or with the mock route enabled — the production guard refuses both.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid Bearer JWT | `Authorization: Bearer <valid-jwt>` with `{sub, role, branch_ids, scope}` | `req.auth.claim` populated; request continues to next middleware/route | N/A |
| Valid Bearer JWT, doctor missing `doctor_id` | Bearer claim has `role: 'doctor'`, no `doctor_id` | `req.auth.claim` populated; doctor-only route rejects with `403 {error: 'doctor_token_requires_doctor_id'}` | Doctor enforcement happens at the route guard, not middleware (consistent with E0-S1 stub behavior and Architecture §3.1) |
| Valid Bearer JWT, staff with `branch_ids: []` | Bearer claim has `role: 'receptionist'` (or `'doctor'`/`'admin'`), `branch_ids: []` | `403 {error: 'staff_token_requires_branch_ids'}` at middleware | Same rejection code as the E0-S1 stub path so the existing test keeps passing |
| Invalid Bearer JWT (bad signature / expired / malformed) | `Authorization: Bearer <bad>` | Treated as anonymous; Bearer path yields no claim | If `x-auth-claim` debug header is also present and valid (dev/test only), that wins; otherwise anonymous |
| Missing `Authorization` in prod | No header in `NODE_ENV === 'production'` | Treated as anonymous | x-auth-claim fallback is disabled in prod |
| Missing `Authorization` in dev | No header in `NODE_ENV !== 'production'` | Treated as anonymous; x-auth-claim fallback may rescue | x-auth-claim fallback is dev-only |
| Body role-escalation attempt | Bearer claim `role: 'patient'`; body `{role: 'admin', branch_ids: ['sneaky']}` | Body ignored; claim wins (test invariant from `auth.test.ts:84`) | Request proceeds as patient; if route requires admin, downstream guard rejects |
| `/patient/otp/verify-now` happy path | `POST {phone: '+15551234567', code: '123456'}` in dev | `200 {token: '<jwt>', claim: {sub: '+15551234567', role: 'patient', branch_ids: [], scope: 'self'}, expires_at: '<iso>'}` | N/A |
| `/patient/otp/verify-now` bad code | `POST {phone: '+15551234567', code: '000000'}` | `401 {error: 'invalid_otp_code'}` | No token issued; no DB write |
| `/patient/otp/verify-now` bad phone format | `POST {phone: '5551234', code: '123456'}` | `400 {error: 'invalid_phone'}` | Validation error before code check |
| `/patient/otp/verify-now` in production | `NODE_ENV === 'production'` | `404 {error: 'not_found'}` — route not registered | Production guard logs a startup warning if `MOCK_OTP_CODE` is set |
| `/patient/otp/verify-now` in staging | `NODE_ENV === 'staging'` | `404 {error: 'not_found'}` — route not registered (allowlist: only `development` and `test` register the route) | Boot logs `mock_otp_disabled_staging` |
| Server boot missing `AUTH_SECRET` | any `NODE_ENV`, no `AUTH_SECRET` env | Process refuses to start; logs `auth_secret_missing` and exits non-zero | Boot guard, not a per-request error |
| Server boot with short `AUTH_SECRET` | `Buffer.byteLength(AUTH_SECRET) < 32` | Process refuses to start; logs `auth_secret_too_short` and exits non-zero | Boot guard (byte length, not UTF-16 code units) |
| Server boot with `AUTH_TOKEN_TTL_SECONDS <= 0` or non-numeric | env set to `0`, `-1`, `NaN`, or string | Process refuses to start; logs `auth_ttl_invalid` and exits non-zero | Boot guard |
| `x-auth-claim` debug header present in dev | `x-auth-claim` valid in `NODE_ENV !== 'production'`, no `Authorization` header | `x-auth-claim` parsed as claim; debug path stays for the 12 existing tests | In prod, debug header is ignored |
| `x-auth-claim` debug header present in production | `NODE_ENV === 'production'`, valid `x-auth-claim`, no `Authorization` | Treated as anonymous; debug header disabled | Silent reject; no `actor_role`/`actor_id` attached |
| Both `Authorization` and `x-auth-claim` present in dev | Both headers set and parseable | Bearer wins (more specific path); debug header ignored | Conflict resolution logged at `debug` level |
| `MOCK_OTP_CODE` set in production | `NODE_ENV === 'production'`, `MOCK_OTP_CODE` present | Startup warning; mock route not registered | Boot guard, not a per-request error |
| Bearer with `branch_ids.length === 257` | Signed JWT with 257 branch_ids | Treated as anonymous (over-cap → same as `x-auth-claim` path) | 256-element cap is enforced on the Bearer path too |
| Bearer with `branch_ids` containing non-string, empty, or duplicate elements | Signed JWT with `branch_ids: ['', 'a', 'a']` or `['a', 1, null]` | Treated as anonymous (per-element validation) | Prevents downstream SQL filter crashes |
| Bearer with role outside closed enum | Signed JWT with `role: 'superuser'` | Treated as anonymous | Verifier rejects unknown role values |
| Bearer with scope outside closed enum | Signed JWT with `scope: 'universal'` | Treated as anonymous | Verifier rejects unknown scope values |
| Bearer with `alg=none` header | Token header `{"alg":"none"}` with empty signature | Treated as anonymous; verifier hardcodes `HS256` | Classic JWT alg-none attack mitigation |
| Bearer with `iat` in the future | Signed JWT with `iat = now + 60s` | Treated as anonymous (30s clock skew tolerance) | Verifier rejects future-iat |
| Bearer with `exp <= iat` | Signed JWT with `exp == iat` or `exp < iat` | Treated as anonymous | Verifier rejects impossible window |
| Bearer with `aud` mismatch | Signed JWT with `aud: 'other-service'` | Treated as anonymous | Verifier requires `aud === 'clinic-api'` |
| Bearer with `iss` mismatch | Signed JWT with `iss: 'evil'` | Treated as anonymous | Verifier requires `iss === 'clinic-api'` |
| Bearer with missing `jti` | Signed JWT without `jti` | Treated as anonymous | Verifier requires `jti` is a string |
| OTP route body-escalation | `POST /patient/otp/verify-now` with `{phone, code, role: 'admin', branch_ids: ['sneaky']}` | Mints a patient JWT regardless of body fields; `verifyToken(token).role === 'patient'` | Route handler does not consult body for claim-shape fields |
| OTP route missing phone | `POST` with `{code: '123456'}` (no `phone`) | `400 {error: 'invalid_phone'}` | Type-check before regex |
| OTP route missing code | `POST` with `{phone: '+15551234567'}` (no `code`) | `400 {error: 'invalid_phone'}` (phone validates) or `401 {error: 'invalid_otp_code'}` (phone validates but code is undefined) | Both fields type-checked before any check |
| OTP route timing-safe code compare | `POST` with any `code` value | `crypto.timingSafeEqual` against equal-length buffer | No early-return; pads/truncates as needed |
| Bearer-vs-debug `req.auth.claim` shape parity | `Authorization: Bearer` valid claim + `/healthz` request | `actor_role` and `actor_id` attached in pino log line identically to debug path | `log-bearer.test.ts` asserts parity |

## Code Map

- `apps/api/src/auth/jwt.ts` — `signClaim(claim): string` and `verifyToken(token): AuthClaim | null`. Pure functions; no I/O. HS256 via `node:crypto`'s `createHmac` (no library — keeps the dependency tree small). Verifier hardcodes `HS256` (ignores token header `alg`). Constant-time signature compare via `crypto.timingSafeEqual`. Token includes `aud: 'clinic-api'`, `iss: 'clinic-api'`, `jti: <uuid v4>`, `iat`, `exp`.
- `apps/api/src/auth/config.ts` — `loadAuthConfig(): { secret: Buffer, ttlSeconds: number, mockOtpCode: string, allowDebugHeader: boolean, mockOtpAllowed: boolean }`. Reads env once at boot (module-level singleton — re-loaded only on process restart). Throws `auth_secret_missing` if `AUTH_SECRET` unset in **any** env; throws `auth_secret_too_short` if `Buffer.byteLength(AUTH_SECRET) < 32`; throws `auth_ttl_invalid` if `AUTH_TOKEN_TTL_SECONDS <= 0` or non-numeric. `mockOtpAllowed` is true only when `NODE_ENV ∈ {development, test}`; `allowDebugHeader` is true when `NODE_ENV !== 'production'`.
- `apps/api/src/middleware/auth.ts` — extended to (1) parse `Authorization: Bearer` first (case-insensitive on the scheme, exact on the JWT), (2) fall back to `x-auth-claim` only when `config.allowDebugHeader === true`, (3) keep the existing 256-element cap on `branch_ids.length` AND the empty-branch_ids rejection, (4) attach `req.auth.claim` and log context identically. Verifies signature FIRST, then validates claim shape — prevents unsigned-token timing oracle on shape probes.
- `apps/api/src/routes/patient-otp.ts` — `POST /patient/otp/verify-now` route. Reads `{phone, code}` body, type-checks both fields (`typeof === 'string'`), validates phone via E.164 regex, compares code via `crypto.timingSafeEqual`, mints a patient JWT, returns `{token, claim, expires_at}`. **Does NOT consult `req.body.role` / `req.body.branch_ids` / `req.body.scope` / `req.body.doctor_id`** (body-escalation invariant for the login surface itself, not just `authMiddleware`). Registered only when `config.mockOtpAllowed === true`. Audit log on every attempt (success + failure) with redacted phone (last-4 only).
- `apps/api/src/app.ts` — mounts the patient-otp router **BEFORE** `authMiddleware` so an unauthenticated caller can hit the login route. Body-parser (`express.json()`) is also mounted before `authMiddleware` so the OTP handler can read the body. The OTP route's own handler is the auth gate for the login surface.
- `apps/api/db/migrations/0011_pgcrypto_grants.sql` (NEW) — starts with `CREATE EXTENSION IF NOT EXISTS pgcrypto` for idempotency, then `GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC`. Paired `down/0011_pgcrypto_grants.down.sql` revokes the grant. Closes deferred-work W7.
- `apps/api/.env.example` — appends `# AUTH_SECRET=` (commented out — devs must generate their own), `# AUTH_TOKEN_TTL_SECONDS=3600`, `# MOCK_OTP_CODE=123456` (commented out — production must NOT set this; dev/test uncomment to enable the mock). Inline comments document the security posture of each var.
- `apps/api/test/auth-jwt.test.ts` (NEW) — exercises `signClaim`/`verifyToken` round-trip, signature tampering rejection, expiry, malformed token rejection, claim-shape enforcement (rejects unknown fields AND missing required fields: `aud`, `iss`, `jti`, `iat`, `exp`), `alg=none` rejection, `aud`/`iss` mismatch rejection, future-`iat` rejection, `exp <= iat` rejection, `iat`/`exp` NumericDate type check.
- `apps/api/test/auth-bearer.test.ts` (NEW) — drives `createApp()` with `Authorization: Bearer <jwt>` through supertest. Covers: valid Bearer → 200/404 fallthrough; doctor without `doctor_id` → request passes auth (verifier accepts, route guard would reject — separate future test); staff with empty `branch_ids` → 403; 257 branch_ids → anonymous; non-string/duplicate branch_ids → anonymous; unknown role/scope → anonymous; bad signature → anonymous; missing header in prod → anonymous; body escalation still ignored; Bearer wins over x-auth-claim when both present; x-auth-claim disabled in prod.
- `apps/api/test/patient-otp.test.ts` (NEW) — drives `/patient/otp/verify-now`: happy path returns a usable JWT (round-trip through `verifyToken`); bad code → 401; bad phone → 400; missing phone or code → 400; production guard removes the route; body-escalation invariant (body `{role: 'admin'}` does not affect minted claim); timing-safe code compare (asserted indirectly via the no-401-during-regex-validity test).
- `apps/api/test/log-bearer.test.ts` (NEW) — drives `createApp()` with a Bearer JWT, captures pino output through the test-injected `requestLogger` (the `opts.requestLogger` escape hatch in `createApp`), asserts `actor_role` and `actor_id` are attached identically to the debug path. Pairs with the existing `log.test.ts`.
- `apps/api/test/pgcrypto-grants.test.ts` (NEW) — `withTestDb` `beforeEach` creates a low-privilege role (`app_user`) with `CONNECT` on the test DB and `USAGE` on `public`/`pgcrypto`, then runs `SET ROLE app_user; INSERT INTO clinic (name) VALUES ('grants test') RETURNING id`. The test fails without the migration's grant and passes with it.
- `apps/api/src/types/auth.ts` — extended (not frozen): `AuthClaim` gains `expires_at: number` (derived from `exp` for downstream convenience) and `jti: string` (for future W9 denylist). The frozen core `{sub, role, branch_ids, scope, doctor_id?}` is preserved verbatim. `AuthContext` is unchanged.

**No files removed.** E0-S1's stub middleware and `auth.test.ts` remain — they exercise the `x-auth-claim` debug path which E0-S3 keeps for dev/test compatibility.

## Acceptance Criteria

- [ ] **AC-1** `signClaim` produces a JWT that `verifyToken` round-trips to the same `AuthClaim` (excluding `iat`/`exp`/`jti` which are token-unique). `aud === 'clinic-api'` and `iss === 'clinic-api'` on round-trip.
- [ ] **AC-2** `verifyToken` rejects a token whose signature was tampered with (constant-time compare detects mismatch; treated as anonymous).
- [ ] **AC-3** `verifyToken` rejects an expired token (`now > exp`) and a token with `iat` in the future (`iat > now + 30s`).
- [ ] **AC-4** `verifyToken` rejects a token whose payload contains an unknown field (e.g. `{role: 'admin', branch_ids: [], scope: 'clinic', is_superuser: true}`), a token missing any required field (`sub`/`role`/`branch_ids`/`scope`/`aud`/`iss`/`jti`/`iat`/`exp`), a token with `role` outside `{patient, receptionist, doctor, admin}`, a token with `scope` outside `{self, branch, clinic, global}`, a token with `aud !== 'clinic-api'`, a token with `iss !== 'clinic-api'`, a token with `alg=none` in the header (verifier hardcodes `HS256`), a token with `exp <= iat`, and a token whose `iat`/`exp` is a string instead of a JSON number.
- [ ] **AC-5** `loadAuthConfig()` throws `auth_secret_missing` when `AUTH_SECRET` is unset in **any** `NODE_ENV`. Process exits non-zero.
- [ ] **AC-6** `loadAuthConfig()` throws `auth_secret_too_short` when `Buffer.byteLength(AUTH_SECRET) < 32` (NOT `.length`). Process exits non-zero.
- [ ] **AC-6b** `loadAuthConfig()` throws `auth_ttl_invalid` when `AUTH_TOKEN_TTL_SECONDS <= 0`, non-numeric, or non-finite. Process exits non-zero.
- [ ] **AC-7** Middleware accepts a valid Bearer JWT, populates `req.auth.claim`, request reaches the 404 fallthrough (`auth-bearer.test.ts`).
- [ ] **AC-8** Middleware rejects `Authorization: Bearer <jwt>` whose claim is staff with empty `branch_ids` — same 403 code as the `x-auth-claim` path.
- [ ] **AC-8b** Middleware treats Bearer JWTs with `branch_ids.length > 256` as anonymous (same cap as `x-auth-claim` path).
- [ ] **AC-8c** Middleware treats Bearer JWTs with `branch_ids` containing non-string / empty / duplicate elements as anonymous (per-element validation).
- [ ] **AC-9** Middleware falls back to `x-auth-claim` in dev when no `Authorization` is present — the existing E0-S1 `auth.test.ts` cases continue to pass without modification. (The case count is derived from the file at review time, not pinned here — see AC-17b.)
- [ ] **AC-9b** Middleware does NOT consult `x-auth-claim` in `NODE_ENV === 'production'` — anonymous fallthrough.
- [ ] **AC-10** Middleware does NOT consult `req.body` for claims — `auth-bearer.test.ts` mirrors the E0-S1 body-escalation test on the Bearer path.
- [ ] **AC-10b** `/patient/otp/verify-now` does NOT consult body claim-shape fields (`role`/`branch_ids`/`scope`/`doctor_id`) when minting the patient JWT — `patient-otp.test.ts` asserts a body carrying `{role: 'admin', branch_ids: ['sneaky']}` still mints a patient JWT.
- [ ] **AC-11a** (provable in this story) Claim-shape verification rejects cross-role field combinations: a JWT with `role: 'doctor'` and `branch_ids: []` fails the staff-empty-array rejection; a JWT with `role: 'patient'` and `doctor_id: 'x'` is rejected at verification.
- [ ] **AC-11b** (deferred — provable only when staff login ships) "A patient cannot authenticate through a staff login route and vice versa." Logged in `deferred-work.md` as W14 for the future staff-login story.
- [ ] **AC-12** (invariant documentation) A doctor JWT missing `doctor_id` is accepted at middleware (claim populates `req.auth.claim.doctor_id === undefined`); doctor-only route guards (future E1 story) reject. **No test in this story** exercises the doctor-only route guard — the invariant is documented but not asserted by E0-S3's test files. Logged in `deferred-work.md` as W15.
- [ ] **AC-13** `/patient/otp/verify-now` accepts `{phone, code: <MOCK_OTP_CODE>}` and returns `{token, claim, expires_at}`. `verifyToken(token)` returns the same claim. `expires_at` is `decode(token).exp * 1000` (ISO string), single source of truth with `exp`.
- [ ] **AC-14** `/patient/otp/verify-now` rejects `{code: <wrong>}` with 401 `{error: 'invalid_otp_code'}`. The comparison uses `crypto.timingSafeEqual` against equal-length buffers.
- [ ] **AC-15** `/patient/otp/verify-now` rejects `{phone: '5551234'}` (not E.164) with 400 `{error: 'invalid_phone'}` AND rejects missing `phone` / missing `code` / non-string `phone` / non-string `code` with the same 400.
- [ ] **AC-16** `/patient/otp/verify-now` is NOT registered when `NODE_ENV === 'production'` OR `NODE_ENV === 'staging'` (allowlist: `{development, test}` only) — 404 on the path.
- [ ] **AC-17** Existing `auth.test.ts` cases pass unchanged. **The count is derived from the file at review time** (12 in the E0-S1 spec; any future additions are inherited without breaking this AC).
- [ ] **AC-17b** `loadAuthConfig()` is memoized at module load — runtime env changes after boot do not alter auth behavior. Asserted by a unit test that mutates `process.env.AUTH_SECRET` after `loadAuthConfig()` is called and confirms the returned config does not change.
- [ ] **AC-18** All E0-S2 invariants still hold — `EXCLUDE USING gist`, partial unique, append-only audit, `created_by` polymorphic. Re-run `invariants.test.ts` + `migrations.test.ts` + `seed.test.ts` green. **CI step**: `pnpm -w test` AND `pnpm -w test:db` (the latter runs the DB-touching suite via Testcontainers); both must be green.
- [ ] **AC-19** `pnpm -w test` + `pnpm -w test:db` are green. Per-file case count is asserted by the test runner's own output (the count is not pinned here — see AC-17 for the derivation rationale). 0 failing.
- [ ] **AC-19b** Bearer-path structured-log parity: `log-bearer.test.ts` asserts `actor_role` and `actor_id` are attached identically to the `x-auth-claim` debug path when a Bearer JWT is present.
- [ ] **AC-20** `0011_pgcrypto_grants.sql` migration applies cleanly to the E0-S2 schema and `gen_random_uuid()` works under a non-superuser role. The grant is exercised by `pgcrypto-grants.test.ts` which creates an `app_user` role fixture in `withTestDb`'s `beforeEach`, grants it `CONNECT` on the test DB and `USAGE` on `public`/`pgcrypto`, then runs `SET ROLE app_user; INSERT INTO clinic (name) VALUES ('grants test') RETURNING id`. **This test is the only thing that fails without the grant** — verified by temporarily reverting the migration and re-running.
- [ ] **AC-21** Log redaction: `req.auth.claim`, the raw JWT, and the full phone number are never logged at info+ levels. `log-bearer.test.ts` and `patient-otp.test.ts` capture pino output and assert no JWT or claim-body leakage.

## Tasks

- [ ] `apps/api/src/auth/jwt.ts` — implement `signClaim(claim): string` and `verifyToken(token): AuthClaim | null` using `node:crypto`'s `createHmac('sha256', secret)`. Payload: `{sub, role, branch_ids, scope, doctor_id?, aud, iss, jti, iat, exp}`. Verifier: hardcode `HS256` (ignore header `alg`); verify signature FIRST via `crypto.timingSafeEqual`; THEN validate claim shape (reject unknown fields, reject missing required fields, reject enum-mismatched role/scope, reject aud/iss mismatch, reject future-iat with 30s tolerance, reject `exp <= iat`, reject string-encoded `iat`/`exp`, reject `branch_ids.length > 256` and per-element validation). Return `null` on any failure (caller treats as anonymous).
- [ ] `apps/api/src/auth/config.ts` — implement `loadAuthConfig()` with boot-time validation; throw `auth_secret_missing` if `AUTH_SECRET` unset in any env; throw `auth_secret_too_short` if `Buffer.byteLength(AUTH_SECRET) < 32`; throw `auth_ttl_invalid` if `AUTH_TOKEN_TTL_SECONDS <= 0` or non-numeric. Memoize in a module-level singleton. `mockOtpAllowed` derived from `NODE_ENV ∈ {development, test}`; `allowDebugHeader` derived from `NODE_ENV !== 'production'`.
- [ ] `apps/api/src/middleware/auth.ts` — add Bearer-first parse path (case-insensitive scheme); preserve `x-auth-claim` debug fallback only when `config.allowDebugHeader`; same `staff_token_requires_branch_ids` rejection; same 256-element cap AND per-element validation on `branch_ids`; same body-escalation safety; attach `actor_role`/`actor_id` log context identically to the debug path.
- [ ] `apps/api/src/routes/patient-otp.ts` — implement `POST /patient/otp/verify-now`; type-check `phone` and `code` are strings; E.164 regex check on phone; `crypto.timingSafeEqual` code compare; mint JWT with `role: 'patient', branch_ids: [], scope: 'self'`; return `{token, claim, expires_at}` where `expires_at = new Date(exp * 1000).toISOString()`. Audit-log every attempt with redacted phone (last 4 digits). **No consultation of body for claim-shape fields.**
- [ ] `apps/api/src/app.ts` — mount the patient-otp router BEFORE `authMiddleware` (login route is the auth gate for itself); body-parser (`express.json()`) also before `authMiddleware`; conditional registration of patient-otp router based on `config.mockOtpAllowed`.
- [ ] `apps/api/src/types/auth.ts` — extend `AuthClaim` with `expires_at: number` (derived from `exp`) and `jti: string`. Preserve frozen core.
- [ ] `apps/api/db/migrations/0011_pgcrypto_grants.sql` — `CREATE EXTENSION IF NOT EXISTS pgcrypto; GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC;` paired down migration.
- [ ] `apps/api/.env.example` — append commented-out `# AUTH_SECRET=` (with placeholder comment), `# AUTH_TOKEN_TTL_SECONDS=3600`, `# MOCK_OTP_CODE=123456`. No active defaults — devs must generate or uncomment.
- [ ] `apps/api/test/auth-jwt.test.ts` — round-trip + tampering + expiry + future-iat + unknown-field + missing-required-field + alg=none + aud-mismatch + iss-mismatch + role-enum + scope-enum + branch_ids cap + per-element validation + iat/exp NumericDate type + exp <= iat.
- [ ] `apps/api/test/auth-bearer.test.ts` — Bearer-path middleware: happy path, doctor without `doctor_id`, staff empty branch_ids, 257 branch_ids, non-string branch_ids, duplicate branch_ids, unknown role, unknown scope, bad signature, missing header in prod, body escalation, Bearer-wins-over-x-auth-claim, x-auth-claim disabled in prod.
- [ ] `apps/api/test/patient-otp.test.ts` — happy path, bad code, bad phone, missing phone/code, non-string phone/code, production guard, staging guard, body-escalation invariant, audit log redaction.
- [ ] `apps/api/test/log-bearer.test.ts` — Bearer-path log context parity (asserts `actor_role` and `actor_id` attached identically to debug path).
- [ ] `apps/api/test/pgcrypto-grants.test.ts` — low-privilege role fixture, `SET ROLE app_user`, INSERT using `gen_random_uuid()` PK default. Failure without migration; success with it.
- [ ] `apps/api/test/auth-config.test.ts` — `loadAuthConfig()` throws on missing secret (any env), short secret, invalid TTL; memoization invariant.
- [ ] Update CI workflow to add `pnpm -w test:db` step (E0-S2 added the test files; E0-S3 adds the CI invocation).
- [ ] Re-run full `pnpm -w test` AND `pnpm -w test:db`; confirm all tests green.

## Out-of-scope follow-ups (deferred-work.md appendices)

- **W8** — Refresh tokens: E0-S3 ships access-only JWTs. Future hardening story adds `refresh_token` claim + rotation. Defer until a route actually needs it. **Known architecture divergence** — Architecture §3.1 requires "plus a refresh contract"; E0-S3 does not satisfy this clause.
- **W9** — Logout / denylist: E0-S3 includes `jti` in every token to enable future denylist. The denylist table + revocation check lands in a future hardening story.
- **W10** — Staff login route (password / SSO choice deferred to E1): E0-S3 leaves this to whoever owns the staff login surface.
- **W11** — Key rotation: AUTH_SECRET is single-valued. A future story adds key id (`kid`) header support. Defer until a second service consumes our tokens.
- **W12** — Token storage on the web client: `localStorage` vs `httpOnly cookie` is a web-story decision; E0-S3 stays bearer-only.
- **W13** — Patient `sub` should be a synthetic UUID minted at first OTP verify (not the phone E.164) — phone is mutable, PII, and breaks session continuity on phone change. Defer to E4-S1 (real OTP verification) which can persist a `patient.id` and use it as `sub`.
- **W14** — Cross-role login rejection at the staff login route (AC-11b). E0-S3 verifies claim shape; the staff route is E1's surface.
- **W15** — Doctor-only route guard enforcement (AC-12). E0-S3 documents the invariant; E1 ships the guard.
- **W16** — Rate limiting / brute-force protection on `/patient/otp/verify-now`. E0-S3 ships the mock with no rate limit; E0-S4 (SMS gateway) and E4-S1 (real OTP) own the lockout contract.
- **W17** — Migration numbering collision with E0-S4: E0-S3 reserves `0011`. E0-S4 begins at `0012`.

## Review Findings

<!-- Populated after bmad-code-review. Empty on first draft. -->
- [x] [Review][Decision] D1 — AUTH_SECRET length check. **Resolved:** `Buffer.byteLength(AUTH_SECRET) >= 32`. Spec patched.
- [x] [Review][Decision] D2 — Refresh contract divergence. **Resolved:** added "Known Architecture Divergence" callout. Spec patched.
- [x] [Review][Decision] D3 — MOCK staging boundary. **Resolved:** allowlist `{development, test}` only. Spec patched.
- [x] [Review][Decision] D4 — aud/iss/jti inclusion. **Resolved:** include all three now. Spec patched.
- [x] [Review][Decision] D5 — Dev fallback AUTH_SECRET. **Resolved:** refuse in any env. Spec patched.
- [x] [Review][Patch] P1-P43 — 43 patch findings applied: branch_ids cap on Bearer path, body-escalation on Bearer AND OTP, x-auth-claim disabled in prod, pgcrypto role fixture, AC-11 split (11a provable / 11b deferred), AC-12 downgraded to invariant doc, Architecture §3.1 refresh divergence flagged, AC-19 counts de-pinned, req.auth.claim runtime shape pinned, loadAuthConfig memoization pinned, log-bearer parity test added, mount-order contradiction fixed, MOCK staging guard, JWT verify-signature-first, alg=none/HS256 enforcement, constant-time code compare, closed enum at verify, branch_ids per-element validation, phone validation edge cases, iat/exp validation, .env.example commented defaults, migration IF NOT EXISTS + CREATE EXTENSION, migration numbering collision note, log redaction, jti for future W9 denylist, log code centralization, patient sub PII flagged (W13), expires_at drift eliminated, empty-bucket vs doctor-no-id asymmetry rationale, Bearer scheme case-insensitive, clock skew tolerance, AUTH_TOKEN_TTL boundary, AUTH_SECRET low entropy deferred (W11), body-parser order, hot-reload dismissed.

## Tasks

- [ ] `apps/api/src/auth/jwt.ts` — implement `signClaim`/`verifyToken` using `node:crypto`'s `createHmac('sha256', …)`; HS256 only; payload is `{sub, role, branch_ids, scope, doctor_id?, iat, exp}`; unknown fields rejected at verify; constant-time signature comparison.
- [ ] `apps/api/src/auth/config.ts` — implement `loadAuthConfig()` with boot-time validation; memoize in a module-level singleton.
- [ ] `apps/api/src/middleware/auth.ts` — add Bearer-first parse path; preserve `x-auth-claim` debug fallback only when `config.allowDebugHeader`; same `staff_token_requires_branch_ids` rejection; same body-escalation safety.
- [ ] `apps/api/src/routes/patient-otp.ts` — implement `POST /patient/otp/verify-now`; phone E.164 regex check; code equality check; JWT mint; conditional registration.
- [ ] `apps/api/src/app.ts` — mount the patient-otp router BEFORE `authMiddleware` so unauthenticated callers can hit it; register router conditionally based on `NODE_ENV`.
- [ ] `apps/api/db/migrations/0011_pgcrypto_grants.sql` — `GRANT USAGE ON SCHEMA pgcrypto TO PUBLIC`; paired down migration.
- [ ] `apps/api/.env.example` — append `AUTH_SECRET=`, `AUTH_TOKEN_TTL_SECONDS=3600`, `MOCK_OTP_CODE=123456` with inline comments.
- [ ] `apps/api/test/auth-jwt.test.ts` — round-trip + tampering + expiry + unknown-field cases.
- [ ] `apps/api/test/auth-bearer.test.ts` — Bearer-path middleware cases.
- [ ] `apps/api/test/patient-otp.test.ts` — mock OTP happy path + bad code + bad phone + production guard.
- [ ] `apps/api/test/pgcrypto-grants.test.ts` — `SET ROLE` to a non-superuser role and insert a row that exercises `gen_random_uuid()`.
- [ ] Re-run full `pnpm test`; confirm all tests green.

## Out-of-scope follow-ups (deferred-work.md appendices)

- **W8** — Refresh tokens: E0-S3 ships access-only JWTs. Future hardening story adds `refresh_token` claim + rotation. Defer until a route actually needs it.
- **W9** — Logout / denylist: E0-S3 has no revocation story. A future hardening story adds a denylist table keyed on `jti`. Defer until a logout UI exists (E4).
- **W10** — Staff login route (password / SSO choice deferred to E1): E0-S3 leaves this to whoever owns the staff login surface.
- **W11** — Key rotation: AUTH_SECRET is single-valued. A future story adds key id (`kid`) header support. Defer until a second service consumes our tokens.
- **W12** — Token storage on the web client: `localStorage` vs `httpOnly cookie` is a web-story decision; E0-S3 stays bearer-only.

## Review Findings

<!-- Populated after bmad-code-review. Empty on first draft. -->
