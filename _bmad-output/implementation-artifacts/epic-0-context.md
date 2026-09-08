# Epic 0 Context: Bootstrap & platform

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn the greenfield repo into a runnable platform that every later epic depends on: a backend with health probes, a placeholder web shell, a persisted data model with the invariants future stories must honor, an auth provider whose session claims carry the role/branch/scope shape every API guard will read, an SMS OTP gateway behind a swappable interface, idempotent seed data + role fixtures that tests load by path, and an observability baseline whose structured-log fields and counters downstream stories (booking, recurring, metrics) emit into. Nothing here delivers user-facing flows — the only UI is the placeholder web shell — but every later story assumes these seams exist and behave correctly.

## Stories

- Story E0-S1: Repo skeleton + starter template
- Story E0-S2: Data model & migrations
- Story E0-S3: Auth provider wiring
- Story E0-S4: SMS OTP gateway
- Story E0-S5: Seed data + role fixtures
- Story E0-S6: Observability baseline

## Requirements & Constraints

- Repo must run locally with one command and CI must run lint + unit tests on every push.
- The seed script must provision one clinic, one branch (S1) — expanded to 2 branches with distinct time zones in S5 — one doctor, one receptionist, one admin, zero patients in S1; S5 widens to 3 doctors with appointment types, 2 receptionists (one per branch), 1 admin, 5 patients (some with existing future appointments). The seed is the only sanctioned way tests load fixtures; tests reference fixtures by path, never inline JSON.
- `Patient` is identified by `phone_number` (unique). Two `Patient` rows for the same phone must be rejected at the DB layer.
- All appointment timestamps are stored as UTC; conversion to the branch tz happens at display time. Branch hours and slot times are branch-local at render, UTC at rest.
- The SMS OTP gateway must expose `send(phone, code)` and `verify(phone, code)` plus attempt counting, TTL, and lockout — surfaced behind an interface so the dev environment can stub the actual send (console log) without weakening the contract.
- OTP enforces 5-minute TTL, a 3-attempt cap per phone per 10-minute window with lockout, and a 30-second resend cooldown. Provider timeout must not corrupt OTP state.
- Patient self-service screens reuse OTP via the E4-S1 modal; E0-S4 ships the gateway, not the UI.
- Structured logs must include `request_id`, `actor_role`, `actor_id`, and `appointment_id` when in scope — fields every later epic's log emission must populate.
- One metrics endpoint exposes counters that downstream stories will increment: `booking.attempt`, `booking.success`, `booking.conflict`, `booking.failure`, `otp.verification`, `recurring.created`, `recurring.skipped`. Health and readiness probes return 200.
- The web app's design tokens load from the seed environment (S1 acceptance); the full token discipline (no literal hex outside `tokens.css`, token names consumed by reference) is finalized in E7-S1 but S1 must not bake drift into the placeholder shell.
- Web placeholder honors `prefers-reduced-motion` and uses system fonts only — no web fonts.

## Technical Decisions

- **Auth claim shape is binding.** Session tokens must carry `{role, branch_ids: string[], scope, doctor_id?: string}` plus a refresh contract. Server reads `branch_ids` from the claim, never the request body. A patient cannot authenticate through the staff login route and vice versa; a staff token with `branch_ids = []` is rejected at middleware; a doctor token missing `doctor_id` is rejected at doctor-only routes.
- **Design tokens are CSS variables, not literal hex.** A single token source (CSS variables or framework equivalent) is consumed by name. Literal hex outside that token source is a bug — enforced by CI lint in E7-S1 but the placeholder web shell must already follow the discipline.
- **Structured logs with fixed fields.** Every log line carries `request_id`, `actor_role`, `actor_id`, `appointment_id` (when in scope). The fields are a contract; later stories add new fields but cannot drop these.
- **Server-side filters, never client-side.** Receptionists are branch-scoped at the data layer; cross-branch URLs return 403. Patient sessions filter by phone server-side only. The pattern is established in E0 (auth wiring + data model) so E1–E7 don't reintroduce client-side trust.
- **No client-side slot holds.** The placeholder web shell must not assume any slot is bookable; it shows static placeholder UI only. The full "no tentative holds" rule is owned by E7-S7 but E0 establishes the no-implicit-state baseline.
- **Atomicity discipline.** Booking-related writes in later stories are transactional; E0's data model must express that the database supports the required primitives (`EXCLUDE USING gist` on `tstzrange`, partial unique indexes, `SERIALIZABLE`, `timestamptz`) so the E2-S1, E3, E6 stories don't re-litigate the DB-engine question.
- **Audit append-only with retention.** `AppointmentAudit` is append-only; never deleted. Retention is at least 7 years. The table exists in E0-S2 with the shape future stories write into.
- **Booking concurrency primitives are decided here.** Future booking writes will rely on a `EXCLUDE USING gist` constraint on `(doctor_id, branch_id, tstzrange(start, end) WITH &&)` for `Scheduled` rows plus `SERIALIZABLE` retry. E0-S2 must produce a schema that supports both, even though the application-level writers land in E3.
- **Branch tz discipline.** `Branch.tz` is required. All timestamps stored UTC, rendered at `appointment.branch.tz`. Session tz never relabels an event at another branch.
- **No deletion of appointments.** The terminal state is `Cancelled`; `Appointment` rows are never deleted. E0-S2's status enum must be exactly `{Scheduled, Completed, Cancelled, No-show}` and the model must have no `DELETE /appointments` route surface.
- **Role field policy for PII.** `patient.phone` visibility is declared per role: receptionist same branch, doctor own appointment, admin never. The policy table exists from E0; E7-S3 enforces it.
- **Stack choice is deferred to E0-S1.** The Epic context is stack-agnostic. The chosen stack (Node + Express + React/Vite + TypeScript on PostgreSQL 16) belongs in the E0-S1 spec, not here.

## UX & Interaction Patterns

- The web shell is a placeholder page only; no real flows ship from E0. Its only UX obligation is to consume design tokens by name (no literal hex), honor `prefers-reduced-motion`, and load system fonts — all token-discipline ground that E7-S1 builds on.
- No conflict modals, no OTP modal, no status pills ship from E0.

## Cross-Story Dependencies

- E0 unblocks every other epic (E1–E7). E3 (booking core), E4 (patient self-service), E5 (staff appointment management), E6 (recurring & conflict resolution), and E7 (cross-cutting) all assume the E0 surfaces exist.
- Within E0: S1 ships the runnable skeleton. S2 (data model & migrations) and S3 (auth provider wiring) depend on S1 — migrations and auth both need the skeleton in place. S4 (SMS OTP gateway) and S5 (seed data + role fixtures) depend on S2 (the OTP table and the entities being seeded) and S3 (the auth claim shape that role fixtures exercise). S6 (observability baseline) is last, so its structured-log fields and counters are defined after the request paths and write sites they instrument are known.
- E7 stories run in parallel with E0's later stories; E7-S1 (design system token wiring) inherits the token discipline E0-S1 already established, and E7-S3 (patient privacy filter) inherits the role field policy and server-side filter pattern E0-S3 + S2 put in place.