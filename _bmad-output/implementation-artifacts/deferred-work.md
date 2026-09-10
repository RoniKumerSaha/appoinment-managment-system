- source_spec: `_bmad-output/implementation-artifacts/spec-0-1-repo-skeleton-starter-template.md`
  summary: Add `trace_id` to the structured-log field contract (architecture §6 mentions it; E0-S1 ships only the four spec-promised fields).
  evidence: Architecture §6 lists `trace_id` alongside `request_id`, `actor_role`, `actor_id`, `appointment_id`; the spec narrowed to four fields for E0-S1 scope.
- source_spec: `_bmad-output/implementation-artifacts/spec-0-1-repo-skeleton-starter-template.md`
  summary: Adopt canonical `ErrorEnvelope` shape `{code, what, why, can_do, details}` (architecture AD-4) across all error responses.
  evidence: Architecture AD-4 mandates the envelope; E0-S1's error handler returns bespoke `{error: 'internal_error'}` — fine for E0-S1 but AD-4 conformance will land with the first real route in E1+.
- source_spec: `_bmad-output/implementation-artifacts/spec-0-1-repo-skeleton-starter-template.md`
  summary: Add CORS, rate-limit, and `trust proxy` configuration at the API gateway layer (architecture §2 component map).
  evidence: Architecture §2 mentions Edge / API gateway as a distinct layer; E0-S1 doesn't ship it. CORS specifically will be needed when the patient web (`:5173`) calls the API cross-origin in E1+.
- source_spec: `_bmad-output/implementation-artifacts/spec-0-1-repo-skeleton-starter-template.md`
  summary: Adopt a real DB-touching test layer (Testcontainers or Docker Compose Postgres in CI) so `seed.test.ts` becomes a true snapshot-then-replay test.
  evidence: E0-S1's `seed.test.ts` is a source-level contract check; the spec promises live row-count equality but forbids live DB in CI. E0-S2 introduces DB-touching tests and resolves this.
- source_spec: `_bmad-output/implementation-artifacts/spec-0-1-repo-skeleton-starter-template.md`
  summary: Add the double-booking counter to `NAMED_COUNTERS` (architecture §6 "double-booking counter that MUST remain 0").
  evidence: Architecture §6 explicitly names this counter; E0-S1 seeded seven counters but not this one. E0-S6 (observability) or the first booking story (E3-S1) is the natural home.

## Deferred from: code review of spec-0-2-data-model-migrations.md (2026-09-10)

- **W1 — `AppointmentAudit` tamper-evidence (prev_hash / hash chain):** PRD §8 may require tamper-evidence. E0-S2 ships append-only (REVOKE + trigger); tamper-evidence belongs to a later audit-hardening story.
- **W2 — `DoctorPatientLink` entity:** Architecture §4 says "DoctorPatientLink is populated on first booking." Belongs in E3 (booking core) — that's where the link is populated.
- **W3 — `AppointmentAudit.changed_by` mutator column:** Spec has `actor_role`/`actor_id`; no additional column needed.
- **W4 — `DoctorSchedule` overlap not DB-enforced:** Two weekly Saturday rows for same doctor/branch can coexist silently. KISS — overlap enforcement is app-layer (E2-S2).
- **W5 — `DoctorBlock` vs `Appointment` overlap not DB-enforced:** GIST exclusion only spans `Appointment` rows. Belongs in E2-S2 (block creation) where the constraint should be checked.
- **W6 — `Branch.tz` IANA-validity CHECK:** Cannot be expressed in pure SQL. App-level validation lands in E1 (branch management); DB stores the string, no constraint.
- **W7 — `pgcrypto` USAGE grant scope:** If E0-S3 introduces non-superuser role, `gen_random_uuid()` fails without `GRANT USAGE ON SCHEMA pgcrypto`. E0-S3's grant model owns this.

## Deferred from: code review of spec-0-3-auth-provider-wiring.md (2026-09-10)

- **W8 — Refresh tokens (Architecture §3.1 divergence):** Architecture requires session tokens to carry "…plus a refresh contract." E0-S3 ships short-lived access tokens only. Refresh claim + rotation lands in a future hardening story. Known architectural divergence — see the "Known Architecture Divergence" callout at the top of the E0-S3 spec.
- **W9 — Logout / denylist:** E0-S3 includes `jti` in every token to enable future revocation. The denylist table + revocation check at middleware lands in a future hardening story.
- **W10 — Staff login route:** Password / SSO choice deferred to the staff login story (E1). E0-S3 wires the patient-OTP mock only.
- **W11 — Key rotation:** AUTH_SECRET is single-valued. A future story adds `kid` header support and multi-secret verification.
- **W12 — Token storage on the web client:** `localStorage` vs `httpOnly cookie` is a web-story decision; E0-S3 stays bearer-only.
- **W13 — Patient `sub` is phone E.164 (PII, mutable):** A future story (E4-S1 real OTP verification) should mint a synthetic `patient.id` UUID at first verify and use it as `sub`. Phone remains a lookup field.
- **W14 — Cross-role login rejection at the staff login route (AC-11b):** E0-S3 verifies claim shape; the staff route is E1's surface.
- **W15 — Doctor-only route guard enforcement (AC-12):** E0-S3 documents the invariant; E1 ships the guard.
- **W16 — Rate limiting / brute-force on `/patient/otp/verify-now`:** E0-S3 ships the mock with no rate limit; E0-S4 (SMS gateway) and E4-S1 (real OTP) own the lockout contract per Architecture §3.8.
- **W17 — Migration numbering collision with E0-S4:** E0-S3 reserves `0011_pgcrypto_grants.sql`. E0-S4 begins at `0012` to avoid collision.
- **W18 — AUTH_SECRET entropy / all-same-byte check:** Boot guard only checks byte length. Low-entropy secrets (e.g. all-zero 32 bytes) would pass; a future story adds entropy heuristics.
