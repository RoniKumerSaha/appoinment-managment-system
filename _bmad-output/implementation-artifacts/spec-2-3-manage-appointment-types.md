---
title: 'E2-S3 — Manage appointment types (create, edit, deactivate)'
type: 'feature'
created: '2026-10-04'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
  - '_bmad-output/implementation-artifacts/spec-2-1-configure-doctor-weekly-schedule.md'
  - '_bmad-output/implementation-artifacts/spec-2-2-block-time.md'
  - '_bmad-output/implementation-artifacts/spec-1-3-create-deactivate-assign-branch-doctors.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `appointment_type` table exists from `0005_appointment_type.sql` (E0-S2) with `(id, clinic_id, name, duration_minutes, is_active, created_by, created_at, updated_at)`. There is no admin/doctor surface to create, list, edit, or deactivate types. FR-006/FR-007 require that a type is bookable at every branch where the doctor works, and that booking against an inactive type is rejected server-side regardless of branch. Deactivating a type with future appointments must WARN but not cancel (F-08). The schema already enforces `duration_minutes BETWEEN 5 AND 480` via CHECK constraint, but the API surface is missing.

**Approach:** Add a new route family `routes/admin-appointment-types.ts` exposing `GET /admin/appointment-types` (list all types with optional `?active=` filter), `POST /admin/appointment-types` (create a type — always active=true), `GET /admin/appointment-types/:id` (single type), and `PATCH /admin/appointment-types/:id` (rename / activate / deactivate — deactivating emits a warning if ≥1 future Scheduled appointment references this type). All routes gated by `adminScope`.

**Boundaries & Constraints**

**Always:**
- `GET /admin/appointment-types` returns `200 [{id, name, duration_minutes, is_active, created_by, created_at, updated_at}, ...]` (an array, NOT wrapped) — matches the E1-S3 `GET /admin/doctors` precedent. Optional `?active=true|false` filter.
- `POST /admin/appointment-types` accepts `{name, duration_minutes}`. Returns `201 {id, name, duration_minutes, is_active: true, ...}` on success. `is_active` is NOT settable at create (always starts true; activate/deactivate is a separate PATCH).
- `PATCH /admin/appointment-types/:id` accepts `{name?, is_active?}` (at least one required). On `is_active: false` transition, returns `200 {...}` with `warning: 'appointment_type_has_future_appointments'` + `future_appointment_count: N` when N ≥ 1. Future appointments STAY Scheduled; the deactivation does NOT block. The doctor's kanban (E6) handles the resolution queue.
- Validation order: UUID parse on `:id` (PATCH) → body shape (POST/PATCH: `unknown_field` + per-field validators) → DB lookup (PATCH) → effect (warn-on-deactivate).
- `name`: 1..120 chars after trim.
- `duration_minutes`: integer, 5..480 (matches 0005 CHECK constraint). Sub-5 minute durations rejected at API; the DB CHECK is the backstop.
- `is_active` on PATCH: boolean (not string / not 1/0).
- Patient privacy: N/A — no patient_phone in any of these routes.
- Per-clinic scope: every type is anchored to the singleton clinic (`SELECT id FROM clinic LIMIT 1`). A multi-clinic world is out of scope.

**Ask First:**
- (none — scope resolved at plan-time via epic-1-context.md + epics-and-stories.md E2-S3.)

**Never:**
- No audit row written on create / edit / deactivate. E7-S2 (FR-051) owns the audit story; E2-S3 follows the E1-S2/E1-S3/E1-S4/E2-S1/E2-S2 no-audit precedent (D1).
- No DELETE endpoint. Deactivate is the only soft-delete path; appointments retain FK references to appointment_type via `appointment_type_id` (0008). Hard-delete is reserved for migrations.
- No `appointment_type_id` change endpoint — types are immutable once created (same precedent as E2-S2's blocks).
- No branch/type assignment table — the spec says "bookable at every branch where the doctor works" which is enforced via the booking flow's check that `is_active = true` at the clinic level; the type is NOT bound to specific branches or doctors.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `GET .../appointment-types` happy | admin JWT | `200 [{id, name, duration_minutes, is_active, ...}, ...]` (array; 3 seeded types: consultation, follow-up, physical) | N/A |
| `GET .../appointment-types ?active=true` | admin JWT | `200 [...]` filtered to active=true | N/A |
| `GET .../appointment-types ?active=false` | admin JWT | `200 []` (seeded types all active) | N/A |
| `GET .../appointment-types ?active=banana` | invalid value | `400 {error: 'invalid_active_filter'}` | Route |
| `GET .../appointment-types` no auth | unauthenticated | `401` | auth middleware |
| `GET .../appointment-types` patient JWT | patient role | `403 {error: 'forbidden_role'}` | adminScope |
| `POST .../appointment-types` happy | admin JWT + `{name: 'specialist', duration_minutes: 60}` | `201 {id, name, duration_minutes: 60, is_active: true, created_by: 'staff:admin-main', ...}` | N/A |
| `POST .../appointment-types` duration < 5 | `{duration_minutes: 1}` | `400 {error: 'invalid_duration_minutes'}` | Route |
| `POST .../appointment-types` duration > 480 | `{duration_minutes: 481}` | `400 {error: 'invalid_duration_minutes'}` | Route |
| `POST .../appointment-types` duration non-integer | `{duration_minutes: '30'}` | `400 {error: 'invalid_duration_minutes'}` | Route |
| `POST .../appointment-types` name empty | `{name: ''}` | `400 {error: 'invalid_name'}` | Route |
| `POST .../appointment-types` name > 120 | `{name: 'x'.repeat(121)}` | `400 {error: 'invalid_name'}` | Route |
| `POST .../appointment-types` missing fields | `{}` | `400 {error: 'invalid_name'}` | Route |
| `POST .../appointment-types` unknown field | `{name, duration_minutes, foo: 1}` | `400 {error: 'unknown_field', fields: ['foo']}` | Route |
| `POST .../appointment-types` no auth | unauthenticated | `401` | auth middleware |
| `POST .../appointment-types` patient JWT | patient role | `403 {error: 'forbidden_role'}` | adminScope |
| `GET .../appointment-types/:id` happy | admin JWT + valid id | `200 {id, name, duration_minutes, is_active, ...}` | N/A |
| `GET .../appointment-types/:id` unknown id | random UUID | `404 {error: 'appointment_type_not_found'}` | Route |
| `GET .../appointment-types/:id` non-UUID | `not-a-uuid` | `400 {error: 'invalid_appointment_type_id'}` | Route |
| `PATCH .../appointment-types/:id` rename | `{name: 'new name'}` | `200 {...}` (no warning; count: 0) | N/A |
| `PATCH .../appointment-types/:id` activate | `{is_active: true}` | `200 {...}` (no warning; count: 0) | N/A |
| `PATCH .../appointment-types/:id` deactivate clean | `{is_active: false}` on a type with 0 future Scheduled appointments | `200 {...}` (`warning: null`, `future_appointment_count: 0`) | N/A |
| `PATCH .../appointment-types/:id` deactivate with future | `{is_active: false}` on a type with ≥1 future Scheduled appointment | `200 {...}` (`warning: 'appointment_type_has_future_appointments'`, `future_appointment_count: N ≥ 1`); DB updated; appointments STAY Scheduled | N/A |
| `PATCH .../appointment-types/:id` duration < 5 | `{duration_minutes: 1}` | `400 {error: 'unknown_field', fields: ['duration_minutes']}` | Route (length validation only — duration_minutes is NOT mutable per spec §Never; reject as unknown_field rather than silently dropping) |
| `PATCH .../appointment-types/:id` empty body | `{}` | `400 {error: 'no_fields_to_update'}` | Route |
| `PATCH .../appointment-types/:id` unknown field | `{name, foo: 1}` | `400 {error: 'unknown_field', fields: ['foo']}` | Route |
| `PATCH .../appointment-types/:id` unknown id | random UUID | `404 {error: 'appointment_type_not_found'}` | Route |
| `PATCH .../appointment-types/:id` non-UUID id | `not-a-uuid` | `400 {error: 'invalid_appointment_type_id'}` | Route |
| `PATCH .../appointment-types/:id` no auth | unauthenticated | `401` | auth middleware |

## Code Map

- `apps/api/src/routes/admin-appointment-types-helpers.ts` (NEW) — pure validators: `isValidUuid`, `isValidName`, `isValidDurationMinutes`, `validateCreateTypeBody`, `validatePatchTypeBody`, `parseActiveFilter`.
- `apps/api/src/routes/admin-appointment-types.ts` (NEW) — 4 routes:
  - `GET /admin/appointment-types` — UUID n/a → SELECT types (with optional `?active=` filter applied to `is_active`) → 200.
  - `POST /admin/appointment-types` — body validation → SELECT clinic_id → INSERT type (is_active defaults to true; `created_by = 'staff:${admin_sub}'`) → 201.
  - `GET /admin/appointment-types/:id` — UUID validate → SELECT type → 200 or 404.
  - `PATCH /admin/appointment-types/:id` — UUID validate → body validation → SELECT FOR UPDATE on the type row → if `is_active: false` transition, COUNT future Scheduled appointments referencing this type → build dynamic UPDATE → COMMIT → 200 with `warning` + `future_appointment_count` always emitted (P-A1 from E1-S3 review-loop-1 pattern).
- `apps/api/src/app.ts` (MODIFIED) — chain `adminAppointmentTypesRouter` into the existing `app.use('/admin', adminScope, ...)` mount.
- `apps/api/test/admin-appointment-types.test.ts` (NEW) — full I/O matrix (~25 tests).

**No new migration.** `0005` already has every column. The DB CHECK constraint on `duration_minutes BETWEEN 5 AND 480` is the backstop; the API rejects out-of-range with the same code 400 envelope.

**Future-Appointment-Impact query (deactivate-warn):**

```sql
SELECT COUNT(*)::text AS count FROM appointment
 WHERE appointment_type_id = $1
   AND start_datetime > now()
   AND status = 'Scheduled';
```

## Tasks & Acceptance

**Execution:**
- [ ] `apps/api/src/routes/admin-appointment-types-helpers.ts` — pure validators.
- [ ] `apps/api/src/routes/admin-appointment-types.ts` — 4 routes.
- [ ] `apps/api/src/app.ts` — chain adminAppointmentTypesRouter.
- [ ] `apps/api/test/admin-appointment-types.test.ts` — full I/O matrix.

**Acceptance Criteria:**
- Given a valid admin JWT, when `GET /admin/appointment-types` is called, then `200` array of seeded types is returned.
- Given `?active=false`, when `GET ...` is called, then `200 []` (seeded types are all active).
- Given `?active=banana`, when `GET ...` is called, then `400 invalid_active_filter`.
- Given `POST` with `{name: 'specialist', duration_minutes: 60}`, when called, then `201 {id, is_active: true, ...}` is returned; the DB has 1 new row.
- Given `POST` with `duration_minutes < 5` or `> 480`, when called, then `400 invalid_duration_minutes`.
- Given `POST` with empty name or name > 120 chars, when called, then `400 invalid_name`.
- Given a valid type id, when `GET .../:id` is called, then `200` with full type record.
- Given an unknown / non-UUID id, when `GET .../:id` is called, then `404` / `400`.
- Given `PATCH` with `{name: 'new name'}`, when called, then `200` with updated record; `warning: null`, `future_appointment_count: 0` always emitted.
- Given `PATCH` with `{is_active: false}` on a clean type, when called, then `200` with `warning: null`, `future_appointment_count: 0`; type is now inactive.
- Given `PATCH` with `{is_active: false}` on a type referenced by ≥1 future Scheduled appointment, when called, then `200` with `warning: 'appointment_type_has_future_appointments'`, `future_appointment_count: N ≥ 1`; type is now inactive; appointments STAY Scheduled.
- Given `PATCH` with empty body or unknown field, when called, then `400`.
- Given `PATCH` with unknown / non-UUID id, when called, then `404` / `400`.
- Given the new code, when the existing test suites run, then no regression.

## Spec Change Log

**SC1 — 2026-10-04, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

**SC2 — 2026-10-04, post-implementation review (code-review-loop-1).

- **PATCH `duration_minutes` matrix row clarified** (matrix row 24): the original row said `duration_minutes < 5` → `400 invalid_duration_minutes`. After review identified that `duration_minutes` is gated by the route's ALLOWED_KEYS set (it is excluded from PATCH entirely per spec §Never), the only reachable behavior is `400 unknown_field` with `fields: ['duration_minutes']`. Spec amended to reflect the actual envelope. Helper `validatePatchTypeBody` no longer carries the unreachable `invalid_duration_minutes` branch — dead code removed. The DB CHECK constraint on `duration_minutes BETWEEN 5 AND 480` remains the backstop for POST.
- **Test cleanup hardened**: deactivate tests now self-restore `is_active = true` via inline PATCH on completion. Previously relied on after-hook for restoration; a mid-suite CI crash would have left Follow-up / General Consultation in a deactivated state. Rename test already self-restored. Tests now mirror that pattern.

## Verification

**Commands:**
- `pnpm --filter @clinic/api exec node --import tsx --test --test-global-setup=test/setup/globalSetup.cjs --test-concurrency=1 test/admin-appointment-types.test.ts` — expected: all green.
- `pnpm --filter @clinic/api run typecheck` — expected: 0 new errors.
- `pnpm --filter @clinic/api run lint` — expected: 0 new warnings.

**Manual checks (if no CLI):**
- After `POST /admin/appointment-types {name: 'specialist', duration_minutes: 60}`, the response is 201; the DB has 1 new row in `appointment_type` with `is_active = true`.
- After `PATCH /admin/appointment-types/<type_id> {is_active: false}` on a type referenced by a future appointment, the response is 200 with `warning: 'appointment_type_has_future_appointments'` and `future_appointment_count: 1`; the type's `is_active` is false; the appointment stays Scheduled.