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
