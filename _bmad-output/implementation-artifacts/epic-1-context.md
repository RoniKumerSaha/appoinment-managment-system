# Epic 1 Context: Clinic structure & admin

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 1 installs the clinic-structure spine that every later epic depends on. It establishes the single-clinic anchor pattern (one clinic per deployment; every branch, doctor, receptionist, and patient is FK-bound to it), gives the admin a surface to inspect clinic-level counts, and lets the admin create, edit, and deactivate branches, branch hours, branch doctors, and branch receptionists — all under strict role × branch authorization. Branch-hours changes save-and-flag affected appointments rather than silently invalidating them, and admins never touch individual appointment data.

## Stories

- Story 1.0a: Clinic-singleton enforcement
- Story 1.0b: Admin clinic API (middleware + routes + tests)
- Story 1.0-ui: Clinic settings UI (deferred to Phase-5 web work)
- Story 1.1: Create / edit / deactivate branches
- Story 1.2: Change branch operating hours
- Story 1.3: Create / deactivate / assign branch doctors
- Story 1.4: Create / deactivate / assign branch receptionists

## Requirements & Constraints

- Single-clinic anchor pattern: every admin action is clinic-scoped; no cross-clinic access is possible by design.
- Branch deactivation is gated by zero future appointments — the system refuses, never warns. The deactivation UI must show a disabled primary CTA with a clear "N future appointments must be resolved first" message and a deep link to the resolve flow.
- Branch-hours changes always save first; affected appointments are flagged for resolution (status remains Scheduled). The admin's job is oversight, not resolution.
- All admin actions write one audit row (actor · action · target · time · reason); audit is append-only and source-of-truth.
- Branch-hours impact previews display counts only — never patient names, phone numbers, or any patient PII. Admins see the resolution-status side; the patient-detail side belongs to the doctor's kanban.
- The doctor-not-at-branch edge case is real: when an admin narrows branch hours and the assigned doctor no longer works at the branch, the admin must resolve that gap before the change can finalize; the save control stays disabled until cleared.
- Admin never reads or writes individual appointments; admin audit scope is clinic-structure configuration only.
- Page renders: admin surfaces follow the Stacked Vertical Flow pattern at 760px center column width.

## Technical Decisions

- pnpm monorepo with a dedicated API workspace.
- Hono on Node for the HTTP framework.
- PostgreSQL with the `pgcrypto` extension; range-overlap and partial-unique indexes enforce the appointment invariants that Epic 1's branch/doctor/receptionist edges must coexist with.
- JSON error envelope with a closed-enum code, a human message, and optional structured details — every error path uses it.
- Atomic operations: a branch-hours change writes the new hours row, the flag row, and an audit row in a single transaction.
- Bearer-JWT auth with role-based scope; an admin route requires `role=admin` AND `scope=clinic` in the token claim.
- Migrations are additive, forward-only; never destructive on production.
- Audit log is append-only, internal-only, and writes in the same transaction as the change it records.
- Pre-existing baseline failures are documented in `deferred-work.md` and are explicitly out of Epic 1 scope.

## UX & Interaction Patterns

- All admin surfaces use the Stacked Vertical Flow pattern at 760px center.
- Token palette is anchored on Clinical Calm teal as the brand color; semantic colors separate info, success, danger, and warning states.
- The branch-hours impact surface is the primary E1-S2 view: a 5-step confirmation that already includes the doctor-not-at-branch acknowledgment step; the acknowledgment checkbox is required.
- The deactivate branch flow has two visual states — success (proceed) and danger (disabled primary CTA with the resolve-first message); production picks the right one at render time based on whether future appointments exist.
- The branch-hours resolution status surface shows the admin a 4-number hero (Moved / Cancelled / Deferred / Remaining), per-doctor and per-branch breakdowns, and a configuration-only audit-log block; it carries a privacy callout enforcing counts-only and points to the doctor's resolution queue for patient detail.
- E1-S2 is wired to four mockups covering the editor, the impact preview, the resolution status, and the deactivate gate.
- No new design tokens are introduced by this epic; the design system is the single source of truth, and any drift is a bug.

## Cross-Story Dependencies

- E1-S2 depends on E1-S1: a branch must exist before its hours can be changed.
- E1-S2 reads doctor-branch assignments from E1-S3 to detect the doctor-not-at-branch edge case; if E1-S3 is built in parallel, E1-S2 validates via a "doctor works here" check rather than a hard foreign key.
- E1-S0b admin middleware is a hard prerequisite for every admin route in this epic.
- E1-S0a clinic singleton is a hard prerequisite for E1-S0b.
- Every admin route in this epic runs behind the E1-S0b admin-scope middleware.
