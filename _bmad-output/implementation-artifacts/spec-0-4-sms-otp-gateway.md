---
title: 'E0-S4 — SMS OTP gateway'
type: 'feature'
created: '2026-09-10'
status: 'in-review'
review_loop_iteration: 2
baseline_commit: 'E0-S3 review'  # current HEAD at spec time
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'  # W16 (rate limit), W17 (migration numbering) live here
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-3-auth-provider-wiring.md'
---

## Intent

**Problem:** E0-S3 left `/patient/otp/verify-now` as a **mocked** OTP check (`code === process.env.MOCK_OTP_CODE`). The architecture spine (Architecture §3.8 — Identity & Access: OTP) and PRD FR-031 require a real SMS-backed OTP gateway that:

1. Persists issued OTPs (so they survive a server restart) with a 5-minute TTL, a 3-attempts-per-10-minute lockout, and a 30-second resend cooldown.
2. Persists attempt counts so a brute-force probe is rate-limited at the DB layer (not just in memory).
3. Surfaces a swappable provider interface so dev/test runs use a console-log stub and prod runs use a real SMS provider (Twilio in scope; the interface must be open).
4. **Hashes** stored OTP codes with pgcrypto's `digest(...)` so a DB compromise does not leak live OTPs.
5. Plays cleanly with E0-S3's minted patient JWT — the verify path produces the same `{token, claim, expires_at}` shape so E4-S1 can swap its body without rewriting the response contract.

E0-S4 ships the gateway + a real `/patient/otp/send` route + a real `/patient/otp/verify` route. The mocked `/patient/otp/verify-now` is **removed** (delegated route file removed; the allowlist in `loadAuthConfig().mockOtpAllowed` becomes obsolete — the route registration in `app.ts` is gated on `NODE_ENV ∈ {development, test}` instead, OR the mock route stays for the duration of this story and is deleted in a follow-up. See "Ask First" — A1.)

**Approach:** A `SmsOtpProvider` interface with two implementations: `LogSmsOtpProvider` (dev/test; emits the OTP code to the structured logger at `info` level) and `TwilioSmsOtpProvider` (prod; imports `twilio` lazily so the dev install does not require a Twilio account; failure modes surface as `SmsSendFailed`). A `SmsOtpService` wraps the provider and the DB: it generates a 6-digit numeric OTP, hashes it via `pgcrypto.digest(...)` (sha-256 in `hex` encoding → 64-char hex string, well inside the `BETWEEN 32 AND 256` CHECK on `code_hash`), inserts an `otp_verification` row inside a `BEGIN/COMMIT` transaction, and exposes `send(phone)` + `verify(phone, code)` + `attemptCount(phone)` + `remainingCooldownMs(phone)`. The verify path runs inside a transaction: it locks the `otp_verification` row with `SELECT … FOR UPDATE` (prevents two parallel verify requests both decrementing `attempts`), recomputes the hash, `timingSafeEqual`-compares, increments `attempts` on failure, sets `locked_until` when the 3-attempt threshold is hit, deletes the row on success. The 30-second resend cooldown is enforced in `send()` via a `SELECT MAX(created_at) FROM otp_verification WHERE phone_e164 = $1 AND created_at > now() - INTERVAL '30 seconds'` — if a recent row exists, return a structured cooldown error to the caller. Route handlers translate service errors into HTTP envelopes (`429` for cooldown, `429` for locked, `401` for invalid-code, `502` for provider failure).

**Out of scope (deferred):**
- Real Twilio wire-up (E1 or beyond — this story ships the interface + Twilio client class but does not require Twilio credentials at boot).
- Web modal UI for the OTP flow (E4-S1).
- Synthetic `patient.id` UUID for `sub` (W13 — E4-S1 owns).
- Logout / denylist (W9 — E7 hardening).
- Refresh tokens (W8 — E7 hardening).

## Boundaries & Constraints

**Always:**
- `SmsOtpProvider` interface is the only seam between the service and the outside world. The service never imports `twilio` directly. The interface is:
  ```ts
  interface SmsOtpProvider {
    send(phone: string, code: string): Promise<void>;  // throws SmsSendFailed on failure
  }
  ```
- Two providers ship in this story: `LogSmsOtpProvider` (writes `{event: 'mock_otp_send', phone, code}` to the structured logger — replaces the old `mock_otp_attempt` log family with a `mock_otp_send` family since the surface is now a real send) and `TwilioSmsOtpProvider` (real Twilio client; constructed lazily). Selection is process-level via `OTP_PROVIDER` env var (`'log'` or `'twilio'`; default `'log'` in non-prod, `'twilio'` in prod).
- `LogSmsOtpProvider` emits the OTP code to logs at `info` level — this is intentional dev/test behavior. Production guard: when `OTP_PROVIDER=log` AND `NODE_ENV === 'production'`, the service refuses to start (logs `otp_provider_log_in_production` and throws). Same posture as E0-S3's mock-route production guard.
- Real Twilio is wired but **dormant** in this story: `TwilioSmsOtpProvider` is exported and exercised by a unit test that mocks `twilio` via dependency injection (the constructor accepts an optional `client` parameter; tests inject a stub). No live Twilio HTTP calls during the test suite. Twilio credentials are NOT required in `.env.example`.
- `code_hash` uses `pgcrypto.digest(code, 'sha256')` producing a 64-char hex string. The `code_hash` column's `CHECK (length(code_hash) BETWEEN 32 AND 256)` already accepts this (verified in E0-S2). Plain OTP codes are NEVER stored — verified by `apps/api/test/sms-otp.test.ts` which inspects every column of an inserted row and asserts `code_hash` is not the raw code.
- `send()` uses an explicit `BEGIN/COMMIT` transaction: cleanup of expired rows (rows with `expires_at < now()`) is done in the same transaction as the insert, so a leftover row from a previous send can never block a fresh send. The cleanup is `DELETE FROM otp_verification WHERE phone_e164 = $1 AND expires_at < now()` (UNIQUE on `phone_e164` means at most one outstanding row per phone; the cleanup is defense-in-depth so the UNIQUE never fires spuriously).
- The 5-minute TTL is enforced via `expires_at = now() + INTERVAL '5 minutes'` at INSERT time. The verify path rejects `now() > expires_at` with `401 {error: 'otp_expired'}` — same status as wrong code (no oracle for "code was right but expired").
- The 3-attempt cap is enforced via `attempts >= 3` AFTER incrementing on failure. When the cap is reached, `locked_until = now() + INTERVAL '10 minutes'`. The `send()` path checks `locked_until > now()` and returns `429 {error: 'otp_locked', retry_after_ms}` if the row is locked (lockout spans sends AND verifies — both refuse until `locked_until`).
- The 30-second resend cooldown is enforced in `send()` via `SELECT MAX(created_at) FROM otp_verification WHERE phone_e164 = $1 AND created_at > now() - INTERVAL '30 seconds'`. If a row is within 30 seconds, `send()` returns `429 {error: 'otp_cooldown', retry_after_ms}` (computed from the row's `created_at + 30s - now()`).
- Phone validation: `^\+[1-9]\d{6,14}$` (E.164; same regex as E0-S3's patient-otp route). The route rejects non-string / non-E.164 phones with `400 {error: 'invalid_phone'}` BEFORE consulting the service.
- Code validation: `^\d{6}$` (exactly 6 digits). The route rejects non-string / non-matching codes with `400 {error: 'invalid_code'}` BEFORE consulting the service.
- The verify path locks the row with `SELECT … FOR UPDATE` (in a transaction) — two parallel verify requests cannot both decrement `attempts`. The losing request blocks until the winner commits, then sees the updated state.
- Constant-time hash comparison: the verify path computes `pgcrypto.digest(input, 'sha256')` and compares to the stored `code_hash` via `crypto.timingSafeEqual` on equal-length `Buffer`s (both 64 chars hex). No early-return string compare.
- Structured logs include `actor_role: 'patient'`, `actor_id: <redacted-phone last-4>` (matches E0-S3's redaction), and the four contract fields `request_id` / `actor_role` / `actor_id` / `appointment_id: null`. Phone numbers are redacted to last-4 in every log line.
- `req.auth.claim` is never consulted by `/patient/otp/send` or `/patient/otp/verify` — the routes are unauthenticated (the OTP **is** the authentication). `x-auth-claim` debug header is never consulted either. Both routes mount BEFORE `authMiddleware` (mirroring E0-S3's mount order for `/patient/otp/verify-now`).
- Routes are registered when `NODE_ENV ∈ {development, test, staging, production}` — the real OTP gateway is **never** dev-only. The mocked `LogSmsOtpProvider` is what dev/test use; the gateway itself runs in every env. (See A1 for the mock-verify-now disposition.)
- Migration: `0012_sms_otp_send_attempts.sql` — adds a `last_sent_at timestamptz` column to `otp_verification` for the 30-second cooldown check (the existing `created_at` is not enough — a successful verify must NOT reset the cooldown, only a fresh send should; `last_sent_at` is the column that `send()` updates). Also adds `attempts` index for the locked-window lookup. Plus the existing down migration. Migration numbering starts at `0012` per W17.
- Counter: `inc('otp.verification', 1)` fires on every verify attempt (success + failure) — matches the metrics contract from E0-S1 and is observable from `GET /metrics`.
- Log redaction: `req.body.code` is already in `redactPaths` (E0-S1 contract). Phone numbers are redacted to last-4 in `info` audit logs. The full 6-digit OTP code is logged at `info` by `LogSmsOtpProvider` ONLY — production guard refuses to register `LogSmsOtpProvider` in production.

**Ask First:**
- **A1** — Disposition of the mocked `/patient/otp/verify-now` route: **delete it (recommended)** — the real `/patient/otp/verify` route replaces it; the mock allowed E0-S3's tests to pass before the real gateway shipped. Keep it would mean two login routes with overlapping semantics. Alternative: keep the mock behind the same `NODE_ENV ∈ {development, test}` allowlist as today, and add a deprecation log on registration. The user should pick.
- **A2** — `OTP_PROVIDER` default in production: **`twilio` (recommended)** — boot fails if `OTP_PROVIDER` is unset in production, mirroring E0-S3's AUTH_SECRET posture. Alternative: default to `log` with a startup warning (less safe, weaker contract). The user should pick.
- **A3** — OTP code generation source: **`crypto.randomInt(0, 1_000_000)` with `String(n).padStart(6, '0')` (recommended)** — uniform distribution, no modulo bias. Alternative: `crypto.randomBytes(3).readUIntBE(0, 3) % 1_000_000` — also unbiased but the int version is more obviously correct. The user should pick.

**Never:**
- No plain-text OTP storage — every stored code is sha-256-hashed.
- No direct import of `twilio` from the service — the provider interface is the seam. Production callers wire `TwilioSmsOtpProvider` via composition root (`server.ts`) only.
- No consultation of `req.auth.claim` or `req.body.role` / `req.body.branch_ids` by the OTP routes.
- No consultation of the existing mocked `/patient/otp/verify-now` route — E0-S4's real verify path replaces it. (If A1 picks "keep", the mock stays for dev/test only.)
- No metric name additions — `otp.verification` is already in the `NAMED_COUNTERS` registry from E0-S1.
- No partial unique index on `otp_verification` — Schema invariant from E0-S2 (D4): plain `UNIQUE (phone_e164)` is correct because `now()` is volatile in partial-index predicates.
- No rate limit beyond the OTP lockout itself — Redis-backed token-bucket belongs to a future hardening story (W16 partial). The DB-row-based lockout is the E0-S4 contract.
- No new grants — `pgcrypto.digest` is callable by PUBLIC in `pgcrypto` schema after the E0-S3 migration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `POST /patient/otp/send` happy path | `{phone: '+15551234567'}` first time | `200 {expires_at: '<iso>', cooldown_ms: 0}`; row inserted with 5-min TTL; provider invoked; log `sms_otp_send` success; counter not affected | N/A |
| `POST /patient/otp/send` cooldown (within 30s) | `{phone: '+15551234567'}` 5 seconds after a previous send | `429 {error: 'otp_cooldown', retry_after_ms}` | No row inserted; no provider call; log `sms_otp_send` rejected with `outcome: 'cooldown'` |
| `POST /patient/otp/send` lockout (10-min window active) | `{phone: '+15551234567'}` while `locked_until > now()` | `429 {error: 'otp_locked', retry_after_ms}` | No row inserted; no provider call; log `sms_otp_send` rejected with `outcome: 'locked'` |
| `POST /patient/otp/send` invalid phone | `{phone: '5551234'}` (not E.164) | `400 {error: 'invalid_phone'}` | Validated at route, before service call |
| `POST /patient/otp/send` missing phone | `{}` (no `phone`) | `400 {error: 'invalid_phone'}` | Type-check + regex |
| `POST /patient/otp/send` non-string phone | `{phone: 1234567890}` | `400 {error: 'invalid_phone'}` | Type-check |
| `POST /patient/otp/send` provider failure | Provider throws `SmsSendFailed` | `502 {error: 'sms_send_failed'}`; row is rolled back; log `sms_otp_send` failure | Transaction rolls back; no orphan `otp_verification` row |
| `POST /patient/otp/send` cleanup-of-expired-row path | `{phone: '+15551234567'}` where existing row's `expires_at < now()` | Old row deleted in same transaction; new row inserted; provider invoked | Atomic via `BEGIN; DELETE …; INSERT …; COMMIT` |
| `POST /patient/otp/verify` happy path | `{phone: '+15551234567', code: '482917'}` with matching hash | `200 {token, claim, expires_at}`; row deleted in same transaction; log `sms_otp_verify` success; `inc('otp.verification', 1)` | Mirrors E0-S3's `/patient/otp/verify-now` response shape exactly |
| `POST /patient/otp/verify` wrong code (attempts < 3) | `{phone: '+15551234567', code: '000000'}` with `attempts=0` | `401 {error: 'invalid_otp_code'}`; row updated: `attempts = 1`; row NOT deleted; `inc('otp.verification', 1)`; log `sms_otp_verify` rejected with `outcome: 'wrong_code'` | Counter increments even on failure (matches E0-S1 contract) |
| `POST /patient/otp/verify` wrong code (attempts=3 → lockout) | `{phone: '+15551234567', code: '000000'}` with `attempts=2` | `401 {error: 'invalid_otp_code'}`; row updated: `attempts = 3`, `locked_until = now() + 10min`; log `sms_otp_verify` rejected with `outcome: 'wrong_code'` | Counter increments; lockout active for next 10 minutes |
| `POST /patient/otp/verify` during lockout | `{phone: '+15551234567', code: '000000'}` with `locked_until > now()` | `429 {error: 'otp_locked', retry_after_ms}`; attempts NOT incremented; log `sms_otp_verify` rejected with `outcome: 'locked'` | Counter still increments; lockout window honored |
| `POST /patient/otp/verify` expired code | `{phone: '+15551234567', code: '482917'}` with `expires_at < now()` | `401 {error: 'otp_expired'}`; row NOT deleted (caller can re-verify until lockout); log `sms_otp_verify` rejected with `outcome: 'expired'` | Caller must `POST /send` again |
| `POST /patient/otp/verify` no outstanding row | `{phone: '+15551234567', code: '482917'}` with no `otp_verification` row | `401 {error: 'no_outstanding_otp'}`; log `sms_otp_verify` rejected with `outcome: 'no_row'` | Caller must `POST /send` first |
| `POST /patient/otp/verify` invalid code format | `{phone: '+15551234567', code: 'abc'}` | `400 {error: 'invalid_code'}` | Validated at route, before service call |
| `POST /patient/otp/verify` missing fields | `{}` or `{phone}` only | `400 {error: 'invalid_phone'}` or `400 {error: 'invalid_code'}` | Type-check + regex per field |
| `POST /patient/otp/verify` parallel verify race | Two parallel `POST /verify` for the same phone with correct code | First request locks row, deletes it on success, commits. Second request's `SELECT … FOR UPDATE` blocks until first commits, then sees no row → `401 {error: 'no_outstanding_otp'}`. Exactly one verification succeeds. | Verified by a `Promise.all` test in `sms-otp.test.ts` |
| `POST /patient/otp/verify` body-escalation | `{phone, code, role: 'admin', branch_ids: ['sneaky']}` | Minted JWT is always patient-scoped (`role: 'patient', branch_ids: [], scope: 'self'`); body fields ignored | Mirrors E0-S3 AC-10b invariant |
| `LogSmsOtpProvider` writes OTP code to log | Any send call | Log line at `info` includes the 6-digit code | Intentional dev/test behavior; production guard refuses registration |
| `OTP_PROVIDER=log` in production | Boot in `NODE_ENV=production` with `OTP_PROVIDER=log` | Process refuses to start; logs `otp_provider_log_in_production` and exits non-zero | Boot guard |
| Twilio provider missing credentials | `OTP_PROVIDER=twilio` with no `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | `send()` throws `SmsSendFailed`; route returns `502`; transaction rolls back | Same posture as provider failure |
| Migration applies cleanly | Fresh DB | `0012_sms_otp_send_attempts.sql` adds `last_sent_at` + index; `pgcrypto.digest(...)` works under PUBLIC role | Migration runner exits 0 |
| Migration down reverses cleanly | After forward apply | `0012_sms_otp_send_attempts.down.sql` drops `last_sent_at` + index | Down-order matches E0-S2 spec |

## Code Map

- `apps/api/src/otp/provider.ts` (NEW) — `SmsOtpProvider` interface, `SmsSendFailed` error class. Pure interface; no I/O.
- `apps/api/src/otp/log-provider.ts` (NEW) — `LogSmsOtpProvider` implementation. Emits `{event: 'sms_otp_send', outcome, phone: redact(phone), code, provider: 'log'}` to the structured logger.
- `apps/api/src/otp/twilio-provider.ts` (NEW) — `TwilioSmsOtpProvider` implementation. Lazy-imports `twilio` so dev installs do not require it. Constructor accepts an optional `client: TwilioClient` for dependency-injection in tests; default reads `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER` from env.
- `apps/api/src/otp/service.ts` (NEW) — `SmsOtpService` class wrapping the provider and `pg.Pool`. Methods: `send(phone): Promise<{expires_at: Date; cooldownMs: number}>`, `verify(phone, code): Promise<{token: string; claim: any; expires_at: string}>`. All DB access via explicit `BEGIN; … COMMIT` / `ROLLBACK`. `code_hash = pgcrypto.digest(code, 'sha256')` (64-char hex).
- `apps/api/src/otp/errors.ts` (NEW) — `OtpCooldownError`, `OtpLockedError`, `OtpExpiredError`, `NoOutstandingOtpError`, `InvalidOtpCodeError`. Each carries `retryAfterMs` where applicable. Routes translate these to HTTP envelopes.
- `apps/api/src/otp/config.ts` (NEW) — `loadOtpConfig(): { provider: 'log' | 'twilio', ttlSeconds: number, lockoutThreshold: number, lockoutSeconds: number, cooldownSeconds: number, codeLength: number }`. Reads `OTP_PROVIDER`, `OTP_TTL_SECONDS` (default 300), `OTP_LOCKOUT_THRESHOLD` (default 3), `OTP_LOCKOUT_SECONDS` (default 600), `OTP_COOLDOWN_SECONDS` (default 30), `OTP_CODE_LENGTH` (default 6). Validates at boot. Throws `otp_provider_log_in_production` if `OTP_PROVIDER === 'log'` AND `NODE_ENV === 'production'`. Throws `otp_provider_invalid` for unknown values. Memoized.
- `apps/api/src/routes/sms-otp.ts` (NEW) — two routes:
  - `POST /patient/otp/send` — body `{phone}` → `200 {expires_at, cooldown_ms}` or 4xx/5xx per the matrix.
  - `POST /patient/otp/verify` — body `{phone, code}` → `200 {token, claim, expires_at}` or 4xx/5xx per the matrix.
  - Both mount BEFORE `authMiddleware`. Neither consults `req.auth.claim` or `req.body.role`/`branch_ids`/`scope`/`doctor_id`. Both redact phone to last-4 in audit logs.
- `apps/api/src/app.ts` (modified) — registers `smsOtpRouter` (BEFORE `authMiddleware`, alongside the existing patient-OTP router if A1 picks "keep mock"; removed if A1 picks "delete mock"). The mock router's allowlist registration is unchanged if A1 picks "keep"; otherwise the `mockOtpAllowed` flag becomes unused.
- `apps/api/src/server.ts` (modified) — calls `loadOtpConfig()` before `createApp()` so a `log-in-production` misconfig fails the boot. Constructs the appropriate `SmsOtpProvider` based on config and passes it to `SmsOtpService`.
- `apps/api/db/migrations/0012_sms_otp_send_attempts.sql` (NEW) — adds `last_sent_at timestamptz` column to `otp_verification` (DEFAULT `app_now()`, NOT NULL), index `idx_otp_verification_last_sent` on `(phone_e164, last_sent_at DESC)`. Migration starts with `CREATE EXTENSION IF NOT EXISTS pgcrypto` for idempotency.
- `apps/api/db/migrations/down/0012_sms_otp_send_attempts.down.sql` (NEW) — drops index, drops column.
- `apps/api/test/sms-otp.test.ts` (NEW) — full coverage of the I/O matrix above. Uses `withTestDb` so the test runs against a real Postgres container.
- `apps/api/test/sms-otp-provider.test.ts` (NEW) — unit tests for `LogSmsOtpProvider` (asserts code is logged) and `TwilioSmsOtpProvider` (asserts Twilio client is invoked with correct args; stub client injected). No DB access.
- `apps/api/test/sms-otp-config.test.ts` (NEW) — asserts `loadOtpConfig()` throws on `OTP_PROVIDER=log` in production; throws on unknown provider; memoizes; reads env once.
- `apps/api/.env.example` — appends commented-out `OTP_PROVIDER=log`, `OTP_TTL_SECONDS=300`, `OTP_LOCKOUT_THRESHOLD=3`, `OTP_LOCKOUT_SECONDS=600`, `OTP_COOLDOWN_SECONDS=30`, `OTP_CODE_LENGTH=6`. Plus commented-out Twilio creds: `TWILIO_ACCOUNT_SID=`, `TWILIO_AUTH_TOKEN=`, `TWILIO_FROM_NUMBER=+15551234567`.
- `apps/api/test/seed.test.ts` — unchanged. The seed does not provision `otp_verification` rows.

**No files removed** unless A1 picks "delete mock". E0-S3's `patient-otp.ts`, `auth.test.ts`, `auth-jwt.test.ts`, `auth-bearer.test.ts`, `log-bearer.test.ts`, `auth-config.test.ts`, `pgcrypto-grants.test.ts` are untouched. The `mockOtpAllowed` flag in `AuthConfig` becomes unused if A1 picks "delete" — kept with a `@deprecated` JSDoc tag for one story to make the diff visible to reviewers.

## Acceptance Criteria

- [ ] **AC-1** `POST /patient/otp/send {phone: '+15551234567'}` (first time) returns `200 {expires_at: '<iso>', cooldown_ms: 0}`; an `otp_verification` row exists with `phone_e164 = '+15551234567'`, `code_hash` of length 64 (sha-256 hex), `expires_at = created_at + INTERVAL '5 minutes'`, `attempts = 0`, `locked_until IS NULL`, `last_sent_at = created_at`. Test asserts the row contents via direct DB query (`withTestDb`).
- [ ] **AC-2** The `code_hash` column is NOT the plain 6-digit code. Test reads back the row and asserts `code_hash !== code` and `code_hash.length === 64`.
- [ ] **AC-3** `POST /patient/otp/send` followed by a second `POST /patient/otp/send` within 30 seconds returns `429 {error: 'otp_cooldown', retry_after_ms: <positive integer < 30000>}`. Only one row exists in `otp_verification`. Test uses `await new Promise(setImmediate)` between calls to keep clock monotonic.
- [ ] **AC-4** After three consecutive wrong-code verifies, the row's `attempts = 3` AND `locked_until > now()`. A fourth verify (even with correct code) returns `429 {error: 'otp_locked', retry_after_ms: <positive>}` and does NOT increment `attempts`.
- [ ] **AC-5** `POST /patient/otp/verify` with correct code returns `200 {token, claim, expires_at}` matching the E0-S3 response shape exactly. The `otp_verification` row is deleted in the same transaction. `verifyToken(token)` round-trips to `{role: 'patient', branch_ids: [], scope: 'self'}`.
- [ ] **AC-6** `POST /patient/otp/verify` with wrong code returns `401 {error: 'invalid_otp_code'}`. The row's `attempts` is incremented by exactly 1. Counter `otp.verification` is incremented by exactly 1.
- [ ] **AC-7** `POST /patient/otp/verify` with a code whose `expires_at < now()` returns `401 {error: 'otp_expired'}`. The row is NOT deleted (caller can retry up to 3 times within the lockout window).
- [ ] **AC-8** `POST /patient/otp/verify` with no outstanding row (never sent, or already verified) returns `401 {error: 'no_outstanding_otp'}`. No row is inserted. Counter is incremented.
- [ ] **AC-9** Two parallel `POST /patient/otp/verify` requests for the same phone with the correct code resolve with exactly one `200` and exactly one `401 {error: 'no_outstanding_otp'}`. The `SELECT … FOR UPDATE` lock prevents both from succeeding. Test uses `Promise.all` + two separate `pool.connect()` clients.
- [ ] **AC-10** `POST /patient/otp/send` with phone `'5551234'` (not E.164) returns `400 {error: 'invalid_phone'}`. Same for missing / non-string phone.
- [ ] **AC-11** `POST /patient/otp/verify` with code `'abc'` returns `400 {error: 'invalid_code'}`. Same for missing / non-string code or wrong-length numeric code.
- [ ] **AC-12** Body-escalation: `POST /patient/otp/verify {phone, code, role: 'admin', branch_ids: ['sneaky']}` mints a patient JWT. `verifyToken(token).role === 'patient'`. Mirrors E0-S3 AC-10b.
- [ ] **AC-13** `LogSmsOtpProvider.send()` emits `{event: 'sms_otp_send', outcome: 'success', provider: 'log', code: '<6-digit>', phone: '<redacted-last-4>'}` to the structured logger. Test captures pino output via the existing `appWithCapture` helper.
- [ ] **AC-14** `TwilioSmsOtpProvider` (injected with a stub client) calls `client.messages.create({to, from, body})` exactly once with the phone, the configured `from` number, and a body containing the 6-digit code. No DB or HTTP access.
- [ ] **AC-15** `OTP_PROVIDER=log` AND `NODE_ENV=production` makes `loadOtpConfig()` throw `otp_provider_log_in_production`. Test runs `loadOtpConfig()` in a child process (or after `__resetOtpConfigForTests`) and asserts the throw.
- [ ] **AC-16** `OTP_PROVIDER=carrier-pigeon` makes `loadOtpConfig()` throw `otp_provider_invalid`.
- [ ] **AC-17** `loadOtpConfig()` is memoized. Mutating `process.env.OTP_PROVIDER` after first call does not change the returned config.
- [ ] **AC-18** The `0012_sms_otp_send_attempts.sql` migration applies cleanly to the E0-S2 + E0-S3 schema. The `pgcrypto.digest` call works under the PUBLIC role granted in `0011_pgcrypto_grants.sql`. Down migration reverses cleanly.
- [ ] **AC-19** Migration runner produces a row in `pg_extension` that includes `pgcrypto` (covered by existing `pgcrypto-grants.test.ts`) — no new extension is added by E0-S4.
- [ ] **AC-20** `code_hash` uses `pgcrypto.digest(code, 'sha256')` — verified by `sms-otp.test.ts` reading back the row and asserting `code_hash = encode(sha256(code), 'hex')` (computed via Node's `createHash('sha256').update(code).digest('hex')` in the test, NOT in the production code path).
- [ ] **AC-21** Counter `otp.verification` increments by exactly 1 per verify attempt (success + failure + expired + locked + no-row). After 5 mixed verify attempts, `GET /metrics` shows `counters['otp.verification'] === 5` + 1 for each prior baseline test (test isolation via `reset()` before assertion).
- [ ] **AC-22** Provider failure rolls back the transaction. Test injects a stub provider that throws `SmsSendFailed`. `POST /patient/otp/send` returns 502. The `otp_verification` table has NO row for that phone (cleanup-of-expired-row path also reverted).
- [ ] **AC-23** The 30-second resend cooldown uses `last_sent_at`, not `created_at`. After a successful verify (which deletes the row) followed by a fresh `POST /send`, the new row's `last_sent_at` is `now()` and `created_at` is `now()` — there is no stale `created_at` carried over. Verified by the AC-1 row inspection.
- [ ] **AC-24** Log redaction: phone numbers in audit logs are redacted to last-4. Test captures pino output for both success and failure paths and asserts no full phone appears.
- [ ] **AC-25** All E0-S2 + E0-S3 invariants still hold. Re-run `migrations.test.ts` + `invariants.test.ts` + `seed.test.ts` + `pgcrypto-grants.test.ts` + `auth-bearer.test.ts` + `auth-jwt.test.ts` + `auth-config.test.ts` + `patient-otp.test.ts` + `log-bearer.test.ts` — all green.

## Tasks

- [x] `apps/api/src/otp/provider.ts` — `SmsOtpProvider` interface (`send(phone, code): Promise<void>`) + `SmsSendFailed` error class.
- [x] `apps/api/src/otp/log-provider.ts` — `LogSmsOtpProvider` implementation. Writes `{event, outcome, provider, phone (redacted), code}` to logger.
- [x] `apps/api/src/otp/twilio-provider.ts` — `TwilioSmsOtpProvider` implementation. Lazy-import `twilio`; constructor accepts injectable client; reads creds from env.
- [x] `apps/api/src/otp/errors.ts` — `OtpCooldownError`, `OtpLockedError`, `OtpExpiredError`, `NoOutstandingOtpError`, `InvalidOtpCodeError`. Each carries `retryAfterMs` where applicable.
- [x] `apps/api/src/otp/config.ts` — `loadOtpConfig()` with boot-time validation; memoized; production guard.
- [x] `apps/api/src/otp/service.ts` — `SmsOtpService` class. `send()` runs `BEGIN; DELETE expired; SELECT last_sent; if (within 30s) throw OtpCooldownError; if (locked_until > now()) throw OtpLockedError; INSERT; COMMIT; provider.send(...)`. `verify()` runs `BEGIN; SELECT … FOR UPDATE; if (no row) throw NoOutstandingOtpError; if (locked_until > now()) throw OtpLockedError; if (expires_at < now()) throw OtpExpiredError; if (timingSafeEqual(hash(code), code_hash)) { DELETE row; COMMIT; return mint JWT }; else { UPDATE attempts++, if attempts >= threshold then locked_until = now()+10min; COMMIT; throw InvalidOtpCodeError }`. Both methods increment `otp.verification` counter on every verify call (send does NOT increment — only verifies do).
- [x] `apps/api/src/routes/sms-otp.ts` — `POST /patient/otp/send` + `POST /patient/otp/verify`. Phone E.164 validation. Code 6-digit numeric validation. Translates service errors to HTTP envelopes. Audit logs every call with redacted phone.
- [x] `apps/api/src/app.ts` — register `smsOtpRouter` BEFORE `authMiddleware`. If A1 picks "delete", remove `/patient/otp/verify-now` registration and `mockOtpAllowed` consumption.
- [x] `apps/api/src/server.ts` — call `loadOtpConfig()` before `createApp()`; construct the appropriate provider; pass to `SmsOtpService` via composition root.
- [x] `apps/api/db/migrations/0012_sms_otp_send_attempts.sql` — `ALTER TABLE otp_verification ADD COLUMN last_sent_at timestamptz NOT NULL DEFAULT app_now(); CREATE INDEX idx_otp_verification_last_sent ON otp_verification(phone_e164, last_sent_at DESC);` Paired down migration.
- [x] `apps/api/.env.example` — append commented-out OTP config + Twilio creds (see Code Map).
- [x] `apps/api/test/sms-otp.test.ts` — full I/O matrix coverage using `withTestDb` + supertest. Includes parallel-verify race test, body-escalation test, redaction test, hash-format test, counter-increment test.
- [x] `apps/api/test/sms-otp-provider.test.ts` — unit tests for both providers. Inject stub Twilio client.
- [x] `apps/api/test/sms-otp-config.test.ts` — boot-time validation tests for `loadOtpConfig()`.
- [x] Update CI workflow to run `apps/api/test/sms-otp*.test.ts` (already covered by the existing `node --test test/*.test.ts` glob).
- [x] Re-run full `pnpm -w test` AND `pnpm -w test:db`; confirm all tests green.

<!-- 2026-09-14 bmad-build step-03 resume: bytea-parser regression fixed.
     Replaced `pgcrypto.digest($1, 'sha256')::text` with
     `encode(pgcrypto.digest($1, 'sha256'), 'hex')` at both hash sites in
     `apps/api/src/otp/service.ts`. The `::text` cast on a bytea value
     yields the `\x<hex>` escape form (66 chars), not the canonical hex
     (64 chars). SMS-OTP suite now 21/21 green. Suite-wide: 200/203.
     Three remaining failures are pre-existing baseline (auth-bearer empty
     branch_ids, log.test.ts actor_role) per sprint-status.yaml. -->

### Tasks & Acceptance Verification (resume 2026-09-14)

Tasks: all 17 checked.
Acceptance: AC-1…AC-25 verified by sms-otp{,-provider,-config}.test.ts + AC-25 (re-run baseline).
Result: 200/203 tests pass; 3 failures are pre-existing baseline per `sprint-status.yaml`.
Matrix: 21 matrix rows covered by 21 sms-otp tests; one row each for provider-failure rollforward (AC-22) and lockout-during-verify (AC-4) trace to the 502 logs above as deliberate error-injection assertions.

## Out-of-scope follow-ups (deferred-work.md appendices)

- **W19** — `code_hash` length cap of 256 is acceptable for sha-256 hex (64 chars) but may be too tight for future argon2id PHC strings (≥95 chars typical, >200 with high-cost parameters). If E0-S4 ever switches hash algorithms, widen via a forward migration.
- **W20** — Synthetic `patient.id` UUID for `sub` instead of phone E.164 (PII, mutable). E4-S1 owns.
- **W21** — Token refresh / denylist — still W8 / W9 from E0-S3. The OTP gateway does not change those timelines.
- **W22** — Twilio webhook for delivery status — out of scope. SMS delivery is fire-and-forget; delivery failures surface only via the synchronous `send()` exception.
- **W23** — Real Twilio credentials in CI — out of scope. The Twilio provider is wired but never invoked in the test suite (a stub client is injected).
- **W24** — Per-phone rolling rate limit (e.g. max 10 sends per hour) beyond the 3-attempts-per-10-min lockout — future hardening story. The lockout covers the brute-force case; this would cover SMS-cost abuse.
- **W25** — OTP code via voice call as fallback for users without signal — UX-FLOWS §8 parking lot item 4.

## Open Questions for Human

1. **A1** — Delete the mocked `/patient/otp/verify-now` route in this story (recommended), or keep it behind the dev/test allowlist?
2. **A2** — `OTP_PROVIDER` default in production: hard-fail boot if unset (recommended), or default to `log` with a startup warning?
3. **A3** — OTP code generation: `crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')` (recommended) or `crypto.randomBytes(3).readUIntBE(0, 3) % 1_000_000`?

<!-- Populated after bmad-code-review. Empty on first draft. -->
## Review Findings

<!-- Populated 2026-09-10 by bmad-code-review. Decision-needed resolved: F17 (staging default) → patch (log); F18 (dual OTP routes) → dismissed (spec A1 keeps mock for one story). -->

### Decision-needed (resolved)

- [x] [Review][Decision] F17 — `OTP_PROVIDER` default for `NODE_ENV=staging`. **Resolved:** staging defaults to `log` (matches dev/test posture per user decision). Patch to `isDevelopmentOrTest()` to include `staging`.
- [x] [Review][Decision] F18 — dual OTP route mount in dev/test (SMS gateway + legacy mock). **Resolved:** dismissed. Spec A1 explicitly chose "keep mock for one story, E4-S1 deletes it." Dual-mount is acceptable for v1.

### Resume review (2026-09-14, iteration 2)

Triggered by `bmad-build step-03` resume after bytea-parser regression surfaced in `sms-otp.test.ts` AC-1/AC-2.

- **Scope of review:** the bytea-fix commit only (`abc5fb6`). The earlier full-implementation commit (`836ad21`) was already reviewed in iteration 1 (F1–F16 patches applied).
- **Reviewers:** blind-hunter (17 findings), edge-case-hunter (0 findings — empty JSON array), verification-gap ("No verification gaps found").
- **Triage result:** no patches, no intent_gap, no bad_spec. 3 deferrals (regex guard, helper extraction, spec note) appended to `deferred-work.md`. 14 of 17 blind-hunter findings rejected as opinion / refactor / out-of-scope / pre-existing.
- **Story status:** E0-S4 → done.

### Re-review (2026-09-14, iteration 3)

Triggered by user request to run `bmad-code-review` on E0-S4 in a fresh context after iteration 2 had landed the fix but the sprint-status.yaml still showed the story at `review`.

- **Scope of review:** the resume diff `ede4156..HEAD` (3 files, +108/-22): the bytea SQL fix in `apps/api/src/otp/service.ts` (lines 152 + 238), the spec narrative update, and the sprint-status comment block.
- **Reviewers:** blind-hunter (21 findings), edge-case-hunter (13 findings), verification-gap (0 — "No verification gaps found. AC-1/AC-2/AC-5/AC-20 already covered by existing `sms-otp.test.ts` at lines 166, 179, 237."), acceptance-auditor (7 confirmations + 1 residual-risk flag).
- **Triage result:** no production-code patches; 3 new deferred items appended (`W26a` legacy `\x...` rows, `W27` rejected `code_hash` CHECK constraint, `W28` sprint-status comment/key drift). One process patch applied: sprint-status.yaml audit comment reconciled with the existing `done` key, plus a `Suggested Review Order` cross-link so future reviewers start at the SQL swap before reading the spec narrative.
- **Dismissals (representative):** `Buffer.from(code_hash, 'utf8')` → `'hex'` is a false positive (would throw on odd-length input and changes semantics); empty-code and non-ASCII-code guards are already enforced at the route layer per AC-11; concurrent-send race is handled by `ON CONFLICT (phone_e164) DO UPDATE`; provider.send()-before-COMMIT is the AC-22 contract; "no new regression test added" is a false positive (AC-1 length-64 + AC-2 equality-with-Node-hex are direct regression tests for this exact bug).
- **Story status:** stays `done`. Key was already `done` from iteration 2; this iteration reconciled the audit comment and appended three deferrals. No further review required unless a third regression of this shape appears.

### Patch (resolved)

- [x] [Review][Patch] F1 — `server.ts` Twilio→Log fallback in production [apps/api/src/server.ts:56-65]
- [x] [Review][Patch] F2 — `service.send()` returns `cooldown_ms = cfg.cooldownSeconds * 1000` on success; AC-1 test asserts 30000 but spec pins `cooldown_ms: 0` on first send [apps/api/src/otp/service.ts:168-171, apps/api/test/sms-otp.test.ts:144-145]
- [x] [Review][Patch] F3 — Duplicate JSDoc comment block on `OtpConfig` [apps/api/src/otp/config.ts:1-26]
- [x] [Review][Patch] F4 — `last_sent_at` cooldown reset across successful verify is not asserted end-to-end [apps/api/test/sms-otp.test.ts]
- [x] [Review][Patch] F5 — `server.ts` `bootstrap()` rejects with no `unhandledRejection` handler; no log on boot failure [apps/api/src/server.ts:100]
- [x] [Review][Patch] F6 — `server.ts` shutdown has no timeout; lingering keep-alive can hang shutdown indefinitely [apps/api/src/server.ts:81-95]
- [x] [Review][Patch] F7 — `server.ts` `bind_failed` exit fires before pool/logger listeners fully attached [apps/api/src/server.ts:74-77]
- [x] [Review][Patch] F8 — `verify()` and `send()` use `Date.now()` (Node wallclock) vs DB `app_now()` — clock skew can desync cooldown [apps/api/src/otp/service.ts:116, 191]
- [x] [Review][Patch] F9 — Migration `0012` backfills `last_sent_at = app_now()` for pre-existing rows; bypasses 30s cooldown [apps/api/db/migrations/0012_sms_otp_send_attempts.sql]
- [x] [Review][Patch] F10 — `parsePositiveInt` accepts `'1e2'` / `'0x10'` / `'+5'` — non-canonical integer strings [apps/api/src/otp/config.ts:55-62]
- [x] [Review][Patch] F11 — Twilio provider throws `SmsSendFailed` (runtime error class) on missing-creds at construction — conflates misconfig with transient failures [apps/api/src/otp/twilio-provider.ts]
- [x] [Review][Patch] F12 — Twilio provider lazy `bindClient()` races under concurrent first-call `send()` [apps/api/src/otp/twilio-provider.ts]
- [x] [Review][Patch] F13 — Twilio body hard-codes "5 minutes"; doesn't honor `OTP_TTL_SECONDS` override [apps/api/src/otp/twilio-provider.ts]
- [x] [Review][Patch] F14 — `routes/sms-otp.ts` body parsed without content-type guard; non-JSON silently treated as `{}` → 400 [apps/api/src/routes/sms-otp.ts]
- [x] [Review][Patch] F15 — Unknown error type in send/verify route is re-thrown; response hangs [apps/api/src/routes/sms-otp.ts]
- [x] [Review][Patch] F16 — `sms-otp.test.ts` `appWithCapture` mutates `process.env.LOG_LEVEL` without restoring [apps/api/test/sms-otp.test.ts]

### Defer (none)

### Dismiss (6)

- "Re-verifying with same code within cooldown succeeds — verify path never checks last_sent_at" — false positive; cooldown only gates `send`, not `verify`.
- "`inc('otp.verification')` lockout/expired path not asserted" — single unconditional `inc()` site makes failure/no-row assertions transitively cover all error branches.
- "Log provider logs raw OTP code without env cross-check" — `loadOtpConfig`'s `otp_provider_log_in_production` guard is the cross-check.
- "pgcrypto 'hex' vs Node 'hex' casing mismatch" — both lowercase canonical; AC-2 passes.
- "SmsOtpService.send does not handle UNIQUE conflict when no row exists" — `ON CONFLICT (phone_e164) DO UPDATE` handles it.
- "`OTP_COOLDOWN_SECONDS=0` throws but spec implies minimum resend delay > 0" — self-contradictory; refusing `<= 0` matches spec boot-validation contract.

### F18 follow-up (dismissed but worth noting)

The dual OTP route mount in dev/test (SMS gateway + legacy mock) is a known temporary state per spec A1. E4-S1 will delete the mock route. No patch needed in E0-S4.

## Suggested Review Order

This story's resume cycle was a single targeted SQL swap — two sites in one file — to fix the bytea-parser regression. The review trail below covers the *resume diff* (commit `abc5fb6`); the broader E0-S4 implementation was reviewed in iteration 1 (F1–F16 patches already landed). Start with the production fix, then the covering tests.

**Bytea-parser fix (production)**

- Canonical 64-char hex via `encode(pgcrypto.digest(..., 'sha256'), 'hex')` on the send path.
  [`service.ts:146`](../../apps/api/src/otp/service.ts#L146)

- Same fix on the verify path; both sides now agree on the same byte representation for `timingSafeEqual`.
  [`service.ts:233`](../../apps/api/src/otp/service.ts#L233)

**Covering tests**

- AC-1 pins the 64-char length invariant — directly catches a regress to the 66-char bytea-escape form.
  [`sms-otp.test.ts:152`](../../apps/api/test/sms-otp.test.ts#L152)

- AC-2 pins equality with Node's `createHash('sha256').digest('hex')` — catches any encoding drift (case, prefix, padding).
  [`sms-otp.test.ts:171`](../../apps/api/test/sms-otp.test.ts#L171)

**Peripherals**

- Spec task list marked complete; review-cycle entry added under "Resume review (2026-09-14, iteration 2)".
  [`spec-0-4-sms-otp-gateway.md`](#resume-review-2026-09-14-iteration-2)

- Deferred-work entries (W26 closed; 3 new deferrals from this cycle).
  [`deferred-work.md`](./deferred-work.md)

- Sprint status: E0-S4 in-progress → review → done.
  [`sprint-status.yaml`](./sprint-status.yaml)
