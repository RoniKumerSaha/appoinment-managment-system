---
title: 'E2-S3 UI — Admin Manage Appointment Types (create, edit, deactivate)'
type: 'feature'
created: '2026-10-06'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-2-3-manage-appointment-types.md'
  - '_bmad-output/implementation-artifacts/spec-2-2-ui-doctor-block-time.md'
  - '_bmad-output/implementation-artifacts/spec-1-3-ui-admin-doctors.md'
---

## Intent

**Problem:** The E2-S3 backend route family (`GET/POST /admin/appointment-types` + `GET/PATCH /admin/appointment-types/:id`) shipped in spec-2-3 but the web client has no surface to drive it. Appointment types can only be created / edited from raw SQL today.

**Approach:** Add a pixel-perfect port of mockup 11 (`docs/design/mockups/v1/mockups/11-appointment-types.html`) — a 760px stacked-vertical flow with 2 step cards (Select a type to edit + Edit · {name}). The page lives at the new top-level admin section `/admin/types` (matches the "Appointment types" nav label in the mockup). A new nav item is added to `AppShell` between "Receptionists" and "Audit log".

The mockup nav labels it the "Doctor view" (line 84: "Dr. Ahmed Al-Rashid") but the API is gated by `adminScope` (E0-S3 staff JWT with role=admin). Today every editor in the app is admin-driven; the doctor-scoped equivalent is deferred to E1-S0a. Same pattern as E2-S1 / E2-S2.

## Boundaries & Constraints

**Always:**
- Page lives at the new top-level `types` admin section. `AppShell`'s `isImplemented()` returns true for `types`; nav label is "Appointment types" (matches the mockup).
- Loads `listAppointmentTypes()` on mount (no filter — the page shows all types so the admin can reactivate an inactive one).
- **Step 1** — Type list:
    - One row per type: radio + name + meta line (`Duration N min · created YYYY-MM-DD`) + duration badge (e.g. "30 min") + Active / Inactive pill.
    - Click selects; radio + row get the selected state.
    - "+ Create new appointment type" dashed row at the bottom.
    - Step-hint: "N types · M active".
- **Step 2** — Edit / Create form (rendered only when mode ≠ 'closed'):
    - **Name** — `<input type="text">`, max 120 chars. Required.
    - **Duration (minutes)** — `<input type="number">`, **read-only** (per spec-2-3 §Never — `duration_minutes` is NOT mutable; the PATCH route rejects `duration_minutes` as `unknown_field`).
    - **Status** — two-button toggle (Active / Inactive). The active state is the source of truth.
    - **Impact banner** — rendered when the server returns a non-null `warning` after a deactivate commit. Yellow warn-card with the future-appointment count.
    - **Step foot** — audit row preview + Cancel / Save changes.
- Save flow:
    - Create: `POST /admin/appointment-types` with `{name, duration_minutes}`. The route always sets `is_active: true` server-side.
    - Edit: `PATCH /admin/appointment-types/:id` with `{name?, is_active?}` (at least one required). Empty body 400s with `no_fields_to_update`.
    - The page computes the diff and only sends changed fields (so a click without changes 400s gracefully).
    - The PATCH response always carries `warning` + `future_appointment_count` (per spec-2-3 line 86). When `warning !== null`, the impact banner is rendered.
- F-08 (deactivation with future appointments): non-blocking — the deactivate commits, the banner surfaces the count, and the doctor's kanban (E6) handles the resolution queue. Same pattern as F-18 / F-19.
- All API errors are mapped through `describeApiError()` with friendly text for `invalid_name`, `invalid_duration_minutes`, `invalid_appointment_type_id`, `appointment_type_not_found`, `no_fields_to_update`, `unknown_field`, `invalid_active_filter`, `network_error`, 5xx.
- Token-only CSS via `var(--…)` (E7-S1 invariant).
- No audit row writes (E7-S2 deferred).

**Ask First:**
- (none — all scope decisions resolved at plan-time.)

**Never:**
- No doctor-side nav. The API is admin-scoped; today every editor is admin-driven.
- No duration edit. The PATCH route rejects `duration_minutes` as `unknown_field` per spec-2-3 §Never; the UI mirrors this with a disabled `<input>` and a "Locked after creation" hint.
- No description field. The mockup shows a Description textarea but the API doesn't accept it (D-S3-1). The field is not rendered.
- No DELETE. Deactivate is the only soft-delete path per spec-2-3 §Never.
- No new design tokens — every CSS value uses `var(--…)` from `styles/tokens.css`.

## I/O & Edge-Case Matrix

| Scenario | UI Behavior |
|----------|-------------|
| Page mount | — |
| Page mount, 0 types | Step 1 list shows "No appointment types yet. Create one below." |
| Click a type row | Step 2 form opens with that type's name + duration + status. |
| Click "+ Create new appointment type" | Step 2 form opens in create-mode (empty name, duration=30, status=active). |
| Save (create, valid) | `POST` returns 201 → form switches to edit-mode with the new type selected → success banner. |
| Save (edit, name change only) | `PATCH` returns 200 → list re-sorts alphabetically (server-side ORDER BY name) → success banner. |
| Save (edit, activate / deactivate clean) | `PATCH` returns 200 with `warning: null` → success banner. |
| Save (edit, deactivate with future appts) | `PATCH` returns 200 with `warning: 'appointment_type_has_future_appointments'` + `future_appointment_count: N` → yellow impact banner with the count. |
| Save (edit, no changes) | Client detects no diff → "Nothing to save." inline error (no API roundtrip). |
| Save (network down) | "Connection failed. Is the API running on :3001?" |
| Save (400 invalid_name) | Inline error banner: "Name is required and must be 1..120 characters." |
| Cancel | Mode resets to 'closed', Step 2 form unmounts. |
| Loading | "Loading appointment types…" placeholder. |
| Load error | Error banner in the page-header area. |

## Code Map

- `apps/web/src/api/client.ts` (EDIT) — added `AppointmentTypeDto`, `AppointmentTypePatchResponse`; added `listAppointmentTypes`, `getAppointmentType`, `createAppointmentType`, `patchAppointmentType`.
- `apps/web/src/AppShell.tsx` (EDIT) — extended `AdminSection` union with `'types'`; added a new entry to `SECTIONS` (label "Appointment types", href `/admin/types`); `isImplemented()` now returns true for `types`.
- `apps/web/src/App.tsx` (EDIT) — imported `AdminAppointmentTypes`; renders the page when `!sub && active === 'types'`.
- `apps/web/src/pages/AdminAppointmentTypes.tsx` (NEW) — pixel-perfect mockup 11 port.
- `apps/web/src/pages/AdminAppointmentTypes.module.css` (NEW) — token-only CSS.
- `_bmad-output/implementation-artifacts/spec-2-3-ui-admin-appointment-types.md` (NEW) — this spec.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — story → done.

## Reuse of existing code

- `apps/web/src/api/client.ts` `ApiError` + `describeApiError()` pattern — same shape as E1-S2/E1-S3/E1-S4/E2-S1/E2-S2.
- `apps/web/src/pages/AdminDoctors.tsx` + `AdminBranches.tsx` — the list-then-form pattern (step 1 = list, step 2 = edit modal or step card) is the same as the inline modal pattern in E1-S3. The mockup here uses a step-card instead of a modal because the form has more fields.
- `apps/web/src/styles/tokens.css` — every CSS value is `var(--…)`.
- `docs/design/mockups/v1/mockups/11-appointment-types.html` — pixel-perfect port (frame 760px, 2 stacked step cards, step-num circles, type-item radio + duration badge + status pill, status-toggle).

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/api/client.ts` — endpoints + types.
- [x] `apps/web/src/AppShell.tsx` — extended `AdminSection` + nav entry + `isImplemented`.
- [x] `apps/web/src/App.tsx` — wire new section.
- [x] `apps/web/src/pages/AdminAppointmentTypes.tsx` — new page.
- [x] `apps/web/src/pages/AdminAppointmentTypes.module.css` — new styles.
- [x] This spec.
- [x] Sprint status updated.

**Acceptance Criteria:**
- Given 3 seeded types, when the page mounts, then Step 1 lists all 3 (one row each) with their duration badges + Active pills, and the step-hint reads "3 types · 3 active".
- Given a click on a type row, then Step 2 form opens with the type's name, duration (read-only), and status.
- Given a click on "+ Create new appointment type", then Step 2 form opens in create-mode (empty name, duration=30, status=active).
- Given a Save in create-mode with valid fields, then `POST` returns 201, the form switches to edit-mode with the new type selected, and a "✓ Saved." banner appears.
- Given a Save in edit-mode with only the name changed, then `PATCH` returns 200 and the list re-sorts alphabetically.
- Given a Save in edit-mode deactivating a type with ≥1 future Scheduled appointment, then `PATCH` returns 200 with `warning: 'appointment_type_has_future_appointments'` and the page renders a yellow impact banner with the future-appointment count.
- Given any 4xx from the API (invalid_name / invalid_duration_minutes / invalid_appointment_type_id / appointment_type_not_found / no_fields_to_update / unknown_field / invalid_active_filter), then `describeApiError` maps it to a friendly inline error banner.
- Given a network-down error, then "Connection failed. Is the API running on :3001?" appears.
- Given a Cancel click, then the form unmounts and Step 2 returns to closed state.
- The duration `<input type="number">` is rendered as disabled with the title "Duration is locked once a type is created (spec-2-3)" and the hint "Locked after creation.".
- The "Appointment types" nav entry is visible in the AppShell and lights up when the section is active.
- Token-only CSS: no hex literals outside `tokens.css`.
- `pnpm --filter @clinic/web typecheck` — 0 new errors.
- `pnpm --filter @clinic/web lint` — 0 new warnings.

## Spec Change Log

**SC1 — 2026-10-06, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Deferrals

- **D-S3-1 — Description field.** The mockup shows a Description textarea ("Initial assessment for new patients. Includes history + physical exam.") but the API doesn't accept a `description` field on create or patch. The field is not rendered; a future story can add a `description` column + PATCH support.
- **D-S3-2 — Doctor-scoped types editor.** Today the page is reached from the admin "Appointment types" section because the API is gated by `adminScope`. The natural doctor-self view (mockup 11 nav shows "Dr. Ahmed Al-Rashid") lives behind a role-based nav once E1-S0a lands. Same routes can be repurposed behind a doctor-scoped equivalent. Spec-only; no code change.
- **D-S3-3 — New top-level admin section.** The mockup implies the page is a sub-page of "Settings"; the existing app has no Settings section. The simplest mapping is a new top-level `types` admin section (label "Appointment types"). Future role-based nav (D-S3-2) might fold this into a doctor-self "Settings" page.

## Cross-References

- E2-S3 backend: `spec-2-3-manage-appointment-types.md`
- F-08: deactivate with future appointments is non-blocking
- FR-007: duration_minutes 5..480 (CHECK constraint is the backstop)
- BR-014..017: appointment type invariants
- E2-S1 UI: `spec-2-1-ui-doctor-weekly-schedule.md` (sibling sub-page; same code pattern)
- E2-S2 UI: `spec-2-2-ui-doctor-block-time.md` (sibling sub-page; same code pattern)