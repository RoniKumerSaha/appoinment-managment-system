---
title: 'E6-S2 — Doctor conflict move (affected queue)'
type: 'feature'
created: '2026-10-04'
status: 'in-progress'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-4-3-patient-rescheduling.md'
  - '_bmad-output/implementation-artifacts/spec-6-1-recurring-preview-create.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per PRD F-09 + BR-054…058 + FR-011, when an
admin-level change (branch hours, doctor schedule, doctor block)
invalidates an existing Scheduled appointment, the affected
appointment is queued for the doctor to resolve. The doctor
**moves** the appointment to a new slot — this is a
**doctor-initiated conflict move**, NOT a patient reschedule
(E4-S3). The move:
- Respects the per-occurrence FR-046 constraints (doctor available,
  branch open, 30-day window, no doctor overlap, no patient overlap).
- Locks the appointment type (BR-058) — the type picker is not
  shown because a type change would alter the audit-trail semantics.
- Allows the branch to change to any branch the doctor works at
  (BR-057 — branch picker shown).
- Releases the old slot atomically (FR-050).
- Writes a `moved_by_doctor` audit row with
  `metadata = {reason: "conflict_resolution"}`.

**Approach:** Add ONE new migration + ONE new route + ONE
supporting helper. No new migration is strictly required (the
audit table from 0009 already carries a `payload jsonb` column
and the `event` enum is open), but a migration may be needed if
the `event` column is restricted — verify against 0009.

1. **`POST /doctor/affected/:id/move` (NEW)** — atomic update.
   The handler:
   - Body shape: `{new_branch_id, new_start_datetime,
     new_end_datetime}`. The doctor is server-trusted
     (`claim.doctor_id`); the appointment_type_id is server-trusted
     from the existing row (BR-058); the new start/end must be a
     valid (start, end) pair with the same `duration_minutes` as
     the existing row.
   - Auth: claim.role === 'doctor' only. Patient / admin /
     receptionist → 403 forbidden_role. Anonymous → 401.
   - Doctor scope doubly-bound: `appt.doctor_id = claim.doctor_id`
     AND `appt.branch_id ∈ claim.branch_ids` (the original
     branch — the move may go to a different branch, but the
     doctor must have access to the source row).
   - The new branch must be in `claim.branch_ids` (the doctor's
     assigned branches). The new branch is the destination
     (BR-057 — branch picker shown).
   - The new branch must be a branch the doctor works at
     (`doctor_branch` row exists). 400 doctor_not_at_branch
     otherwise.
   - Status gate: only `Scheduled` rows are movable. Terminal
     states → 422 already_in_terminal_state.
   - Time gate: only future rows are movable. Past rows
     → 422 appointment_in_past.
   - The new slot must pass the FR-046 in-txn re-check (branch
     hours, doctor schedule, blocks, existing overlaps,
     FR-027, FR-029, FR-018 30-day window, FR-019 same-day
     exclusion). 4xx envelopes on failure mirror the per-occurrence
     reasons from E6-S1.
   - Atomic: BEGIN → SELECT FOR UPDATE on the existing row +
     SELECT FOR UPDATE on overlapping Scheduled rows at
     (new_doctor, new_branch) → UPDATE appointment SET
     branch_id, start_datetime, end_datetime → INSERT audit
     row → COMMIT. The GIST exclusion is the second line of
     defense (raises SQLSTATE 23P01 → 409 slot_raced).
   - Returns 200 with `{appointment: {id, branch_id, doctor_id,
     appointment_type_id, start_datetime, end_datetime, status}}`.

**Boundaries & Constraints**

**Always:**
- The doctor is server-trusted. The body's `new_branch_id` is
  allowed to differ from the source branch (BR-057), but must
  be in claim.branch_ids AND the doctor must be at that branch
  (doctor_branch row).
- The appointment type is LOCKED (BR-058). The body schema
  never accepts `new_appointment_type_id`; the type is read
  from the source row.
- The doctor_id is server-trusted. The body's schema does NOT
  accept `new_doctor_id`; the doctor is `claim.doctor_id`. The
  appointment row's `doctor_id` is updated to the same value
  (no-op semantically; the row is bound to the doctor). This
  keeps the API surface consistent with E4-S3.
- Audit: `actor_role='doctor'`, `actor_id='staff:<sub>'`,
  `event='moved_by_doctor'`,
  `payload={reason: 'conflict_resolution', from: {...}, to: {...},
  branch_change: <bool>, type_change: <bool>}` per F-09. The
  `branch_change` and `type_change` flags are always false
  (type is locked) and the `type_change` flag is always false
  (BR-058). The `branch_change` is true when the move crosses
  branches.
- The 30-day window (FR-018) caps the destination: the new
  start_datetime's branch-local date must be in
  `[today+1, today+30]`. Past / same-day rows → 422.
- Auth: claim.role === 'doctor' only. Patient / admin /
  receptionist → 403 forbidden_role. Anonymous → 401.
- The slot recheck runs the full FR-046 pipeline (E6-S1 helper).
  A 4xx on the new slot means the original row is untouched
  (FR-043 — atomicity).

**Ask First:**
- (none — scope resolved at plan-time via epics-and-stories.md
  E6-S2 + PRD F-09 + BR-054…058 + FR-011 + §4.7.)

**Never:**
- No receptionist / patient / admin use of this route. The
  doctor is the only actor that "moves" an affected
  appointment; the receptionist and patient flows have their
  own paths (E4-S2 patient cancel, E4-S3 patient reschedule,
  E5-S3 receptionist cancel).
- No type change. The body schema never accepts
  `new_appointment_type_id`. A type change requires a different
  workflow (cancel + rebook).
- No "no-op" moves (the new start_datetime equals the old
  start_datetime AND the new branch equals the old branch) —
  the route returns 422 no_op_move to surface a UX bug rather
  than silently write an audit row.
- No migration to add a new column to appointment_audit. The
  `event` text column is open (per 0009); the `payload jsonb`
  column carries the rich metadata. A future hardening story
  could enum-ify `event` (W50 — deferred).

## I/O & Edge-Case Matrix

| Scenario | Caller | Input | Expected | Notes |
|----------|--------|-------|----------|-------|
| Doctor moves own Scheduled | doctor | valid body | `200 {appointment: {..., status: 'Scheduled'}}` | happy path |
| Audit row written | — | — | `event='moved_by_doctor'`, `payload.reason='conflict_resolution'`, `payload.from`, `payload.to`, `payload.branch_change`, `payload.type_change` | F-09 |
| Patient JWT | patient | any | `403 forbidden_role` | not a doctor route |
| Receptionist JWT | receptionist | any | `403 forbidden_role` | not a doctor route |
| Admin JWT | admin | any | `403 forbidden_role` | not a doctor route |
| Anonymous | none | any | `401 unauthenticated` | auth gate |
| Doctor with no `claim.doctor_id` | doctor | body | `403 outside_branch_scope` | defense-in-depth |
| Body's `new_branch_id` not in claim.branch_ids | doctor | body | `403 outside_branch_scope` | BR-057 |
| Body's `new_branch_id` not at claim.doctor_id | doctor | body | `400 doctor_not_at_branch` | E3-S2 pattern |
| Body's `new_start_datetime` malformed | doctor | body | `400 invalid_start_datetime` | validation |
| Body's `new_end_datetime` doesn't match duration | doctor | body | `400 invalid_time_range` | E3-S2 pattern |
| Destination slot outside 30-day window | doctor | body | `409 outside_30d_window` | FR-018 |
| Destination slot same-day (branch tz) | doctor | body | `409 same_day_exclusion` | FR-019 |
| Destination slot conflicts with existing Scheduled | doctor | body | `409 slot_raced` | GIST |
| Destination slot crosses branch hours | doctor | body | `409 outside_branch_hours` | FR-046 |
| Destination slot outside doctor schedule | doctor | body | `409 doctor_unavailable` | FR-046 |
| Destination slot inside a doctor block | doctor | body | `409 doctor_blocked` | FR-046 |
| Destination slot has patient time conflict | doctor | body | `409 patient_time_conflict` | FR-029 |
| Destination slot is FR-027 same (patient, doctor) future | doctor | body | `409 patient_has_future_with_doctor` | FR-027 |
| Source row is terminal | doctor | body | `422 already_in_terminal_state` | E5-S2 pattern |
| Source row is in the past | doctor | body | `422 appointment_in_past` | new gate |
| Source row not at `claim.doctor_id` | doctor | body | `403 outside_branch_scope` | doubly-bound |
| Source row not in `claim.branch_ids` | doctor | body | `403 outside_branch_scope` | doubly-bound |
| Source row not found | doctor | body | `404 not_found` | privacy envelope |
| New branch = old branch AND new start = old start | doctor | body | `422 no_op_move` | UX bug surface |
| Type changed (server-trusted; should be unreachable) | — | — | route never accepts `new_appointment_type_id` | BR-058 |

## Code Map

- `apps/api/src/routes/staff-doctor-move.ts` (NEW) — POST
  /doctor/affected/:id/move handler.
- `apps/api/src/app.ts` (MODIFIED) — mount
  `staffDoctorMoveRouter` after authMiddleware.
- `apps/api/test/staff-doctor-move.test.ts` (NEW) — integration
  tests.

**No new migration.** The audit `event` column is open (0009).

**Atomic move SQL flow:**
```sql
-- BEGIN
-- SELECT FOR UPDATE on the existing appointment row by id.
-- (Optional) SELECT FOR UPDATE on overlapping Scheduled rows
-- at (claim.doctor_id, new_branch_id) that could conflict with
-- the new slot — analogous to the E6-S1 pre-lock.
-- For the destination slot:
--   - Re-run the FR-046 pipeline (in-txn recheck). Skip on any
--     failure (4xx envelope).
--   - UPDATE appointment SET branch_id = $new_branch,
--     start_datetime = $new_start, end_datetime = $new_end.
--     doctor_id and appointment_type_id are NOT changed.
--   - INSERT appointment_audit (event='moved_by_doctor',
--     payload={reason: 'conflict_resolution', from: {...},
--     to: {...}, branch_change: <bool>, type_change: <bool>}).
-- COMMIT (or ROLLBACK on any DB-level error).
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/staff-doctor-move.ts` — POST
  /doctor/affected/:id/move handler.
- [ ] `apps/api/src/app.ts` — mount staffDoctorMoveRouter after
  authMiddleware.
- [ ] `apps/api/test/staff-doctor-move.test.ts` — integration
  tests.

**Acceptance Criteria:**
- Given a doctor JWT for `claim.doctor_id=X` and an own Scheduled appointment at branch-east, when POST /doctor/affected/:id/move is invoked with a valid new (branch_id, start, end) tuple, then 200 with the updated `appointment` row.
- Given a successful move, the audit row carries `event='moved_by_doctor'`, `actor_role='doctor'`, `actor_id='staff:<sub>'`, and `payload={reason: 'conflict_resolution', from: {...}, to: {...}, branch_change, type_change}`. The `type_change` flag is always `false` (BR-058).
- Given a patient / receptionist / admin JWT, when POST /doctor/affected/:id/move is invoked, then 403 forbidden_role.
- Given an anonymous caller, when POST /doctor/affected/:id/move is invoked, then 401 unauthenticated.
- Given a doctor JWT and a `new_branch_id` not in `claim.branch_ids`, when POST /doctor/affected/:id/move is invoked, then 403 outside_branch_scope (BR-057).
- Given a doctor JWT and a `new_branch_id` not at `claim.doctor_id`, when POST /doctor/affected/:id/move is invoked, then 400 doctor_not_at_branch.
- Given a doctor JWT and a destination slot outside the 30-day window (FR-018), when POST /doctor/affected/:id/move is invoked, then 409 outside_30d_window.
- Given a doctor JWT and a destination slot on the same branch-local day as today (FR-019), when POST /doctor/affected/:id/move is invoked, then 409 same_day_exclusion.
- Given a doctor JWT and a destination slot that conflicts with an existing Scheduled row, when POST /doctor/affected/:id/move is invoked, then 409 slot_raced.
- Given a doctor JWT and a source row that is terminal, when POST /doctor/affected/:id/move is invoked, then 422 already_in_terminal_state.
- Given a doctor JWT and a source row that is in the past, when POST /doctor/affected/:id/move is invoked, then 422 appointment_in_past.
- Given a doctor JWT and a source row not at `claim.doctor_id` or not in `claim.branch_ids`, when POST /doctor/affected/:id/move is invoked, then 403 outside_branch_scope.
- Given a doctor JWT and a source row id that doesn't exist, when POST /doctor/affected/:id/move is invoked, then 404 not_found.
- Given a doctor JWT and a body where the new branch equals the old branch AND the new start equals the old start, when POST /doctor/affected/:id/move is invoked, then 422 no_op_move.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, code-review. Patches:

- N1: Re-uses `validateOccurrenceInTxn` from
  `recurring-helpers.ts` (E6-S1) for the FR-046 destination
  recheck. The route does NOT re-implement the pipeline —
  the helper is the single source of truth for the per-slot
  validation rules (branch hours, doctor schedule, blocks,
  FR-027, FR-029, FR-018, FR-019).
- N2: No-op detection (sameBranch && sameStart && sameEnd)
  happens AFTER the time gate (FR-018) but BEFORE the
  destination scope checks. A no-op move should never reach
  the destination recheck; the audit row is also avoided.
- N3: The duration check (`endMs - startMs ===
  sourceDurationMs`) is enforced in the route layer because the
  type is locked (BR-058) — the duration is read from the
  source row, NOT from the type's `duration_minutes`. The
  E3-S2 helper takes the type's duration; here we already
  have the source row.
- N4: The audit payload mirrors F-09 exactly:
  `{reason: 'conflict_resolution', from: {branch_id,
  start_datetime, end_datetime}, to: {branch_id,
  start_datetime, end_datetime}, branch_change: <bool>,
  type_change: <bool>}` — `type_change` is always `false`
  (BR-058), `branch_change` is true iff the branch crosses.
- N5: The handler rolls back the txn on any DB error (other
  than the explicit 23P01/23505 GIST race), so the source row
  is untouched on destination failure (FR-043 atomicity).

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/staff-doctor-move.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.