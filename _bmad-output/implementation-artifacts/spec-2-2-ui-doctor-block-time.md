---
title: 'E2-S2 UI — Admin Doctor Block Time (single range + delete)'
type: 'feature'
created: '2026-10-06'
status: 'done'
context:
  - '_bmad-output/planning-artifacts/epics-and-stories.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/implementation-artifacts/spec-2-2-block-time.md'
  - '_bmad-output/implementation-artifacts/spec-2-1-ui-doctor-weekly-schedule.md'
  - '_bmad-output/implementation-artifacts/spec-1-3-ui-admin-doctors.md'
---

## Intent

**Problem:** The E2-S2 backend route family (`GET/POST /admin/doctors/:id/blocks` + `POST /admin/doctors/:id/blocks-impact` + `DELETE /admin/doctors/:id/blocks/:block_id`) shipped in spec-2-2 but the web client has no surface to drive it. Admin blocks can only be managed from raw SQL today.

**Approach:** Add a pixel-perfect port of mockup 10 (`docs/design/mockups/v1/mockups/10-doctor-block-time.html`) — a 760px stacked-vertical flow with 5 section cards (Type / When / Where / Impact preview / Block & resolve). The page is reached from a new "Block time" button on each doctor card in `AdminDoctors.tsx` and lives at `admin/doctors/<id>/blocks` as a sub-page under the existing `Doctors` section (mirrors how `AdminDoctorSchedule` is reached from the "Schedule" button).

The mockup nav labels it the "Doctor view" (line 65: "Dr. Ahmed Al-Rashid"), but the API is gated by `adminScope` (E0-S3 staff JWT with role=admin). Today every editor in the app is admin-scoped; the doctor-scoped equivalent is deferred to when role-based nav ships (E1-S0a follow-up). Same pattern as E2-S1.

## Boundaries & Constraints

**Always:**
- Page is reached from `<AdminDoctors />` via `onOpenDoctorBlocks(doctorId)`.
- AppShell's `active` stays on `'doctors'` so the nav still highlights Doctors.
- Loads `getDoctor()` + `listDoctorBlocks(doctorId)` in parallel on mount.
- Form fields:
    - **Type** — radio row with three options (Single date / Time range / Multi-day). Only "Time range" is wired; Single date and Multi-day are rendered as disabled buttons with a "Not in MVP" tooltip (D-S2-1).
    - **Start** + **End** — `<input type="datetime-local">` each. End defaults to start + 3 hours on mount.
    - **Branch** — `<select>` (multi-branch doctor) or static label (single-branch doctor). Defaults to the doctor's first branch.
    - **Reason** — `<textarea>`, optional, max 500 chars.
- Preview flow:
    - "Preview impact" button issues POST `/blocks-impact`. Result populates the summary strip's "Affected" tile + the warn-card (only when count > 0) + the impact-list (rows of masked phone + branch + start_datetime + status).
- Save flow:
    - Primary "Block & resolve N →" button (or "Block →" when count = 0) issues POST `/blocks`. On 201: success banner + reset + reload blocks list.
    - 409 `block_overlaps_future_appointments` is surfaced inline as a friendly error (the preview is advisory; the server is the source of truth).
- Delete flow:
    - Existing blocks panel below the form. Each row shows when (start → end) + branch + reason + created_at + a Delete button.
    - Delete issues `DELETE /admin/doctors/:id/blocks/:block_id` and refreshes the panel.
- Branch field defaults to the first branch the doctor works at; with >1 branch a `<select>` is shown, with 1 branch the field is static.
- All API errors are mapped through `describeApiError()` with friendly text for `invalid_doctor_id`, `doctor_not_found`, `invalid_branch_id`, `invalid_block_id`, `branch_not_in_doctor_branches`, `invalid_time_range`, `invalid_reason`, `start_in_past`, `block_overlaps_future_appointments`, `block_not_found`, `unknown_field`, `network_error`, 5xx.
- Token-only CSS via `var(--…)` (E7-S1 invariant).
- No audit row writes (E7-S2 deferred).

**Ask First:**
- (none — all scope decisions resolved at plan-time. Role-based nav section for "Doctors (their blocks)" is deferred to E1-S0a follow-up.)

**Never:**
- No doctor-side nav. The API is admin-scoped; today every editor is admin-driven.
- No block-vs-block conflict at the UI layer (D-S2-3 — block overlap is allowed per spec-2-2 D1).
- No block edit / PATCH — blocks are immutable per spec-2-2 line 40-41; to edit, delete + re-create.
- No audit log row write.
- No new design tokens — every CSS value uses `var(--…)` from `styles/tokens.css`.

## I/O & Edge-Case Matrix

| Scenario | UI Behavior |
|----------|-------------|
| Page mount | — |
| Page mount, no blocks yet | Form ready (defaults populated), Existing blocks panel shows "No blocks yet." |
| Click "Preview impact" (clean) | `POST /blocks-impact` returns 0 → "Affected: 0 appointments" tile populated, no warn-card, no impact-list. |
| Click "Preview impact" (with overlap) | `POST /blocks-impact` returns ≥1 → warn-card "N appointments fall in this period." + impact-list rows. |
| Click "Block & resolve N →" (clean) | `POST /blocks` returns 201 → success banner + form reset + list refreshes. |
| Click "Block & resolve N →" (with overlap) | Server 409 → error banner with friendly text. Form stays populated. |
| Click "Block & resolve N →" with no preview yet | Allowed (server is the source of truth); same flow as above. |
| Click Delete on existing block | `DELETE /blocks/:block_id` returns 204 → list refreshes. |
| Click Delete, 404 mid-flight | Error banner with friendly text; list refreshes. |
| Type = Single date / Multi-day | Disabled buttons with tooltip "Not in MVP". |
| Branch select (multi-branch) | One option per branch; switching refills nothing (the impact is per-branch, the preview re-runs on click). |
| Branch static (single-branch) | Renders the branch name as a static label. |
| Reason field | Up to 500 chars; char count "0/500" / "123/500" updates live. |
| Loading | "Loading doctor…" placeholder. |
| Load error | Error banner + "← Back to doctors" ghost button. |
| Network down | "Connection failed. Is the API running on :3001?" |
| Back to doctors | AppShell active stays 'doctors'; sub clears; `AdminDoctors` re-renders. |

## Code Map

- `apps/web/src/api/client.ts` (EDIT) — added `DoctorBlockDto`, `DoctorBlockImpactResponse`, `CreateDoctorBlockInput`; added `listDoctorBlocks`, `previewDoctorBlockImpact`, `createDoctorBlock`, `deleteDoctorBlock`.
- `apps/web/src/AppShell.tsx` (EDIT) — extended `AdminSubPage` union with `{key: 'doctor-blocks', doctorId: string}`.
- `apps/web/src/App.tsx` (EDIT) — imported `AdminDoctorBlocks`; added `onOpenDoctorBlocks` callback; renders the new sub-page when `sub?.key === 'doctor-blocks'`; passes the new callback into `AdminDoctors`.
- `apps/web/src/pages/AdminDoctors.tsx` (EDIT) — accepted `onOpenDoctorBlocks` prop; added a "Block time" action button on each card (after "Schedule", before "Deactivate").
- `apps/web/src/pages/AdminDoctorBlocks.tsx` (NEW) — pixel-perfect mockup 10 port.
- `apps/web/src/pages/AdminDoctorBlocks.module.css` (NEW) — token-only CSS.
- `_bmad-output/implementation-artifacts/spec-2-2-ui-doctor-block-time.md` (NEW) — this spec.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (EDIT) — story → done.

## Reuse of existing code

- `apps/web/src/api/client.ts` `getDoctor` — unchanged from E1-S3.
- `apps/web/src/api/client.ts` `ApiError` + `describeApiError()` pattern — same shape as E1-S2/E1-S3/E1-S4/E2-S1.
- `apps/web/src/pages/AdminDoctorSchedule.tsx` — the file chrome (back button, crumb, page-header__row, sub-page wiring, sub-page load lifecycle) is structurally identical. The Blocks page reuses the same shape.
- `apps/web/src/styles/tokens.css` — every CSS value is `var(--…)`.
- `docs/design/mockups/v1/mockups/10-doctor-block-time.html` — pixel-perfect port (frame 760px, 5 stacked section cards, section-num circle, summary strip, warn-card, impact-list).

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/api/client.ts` — endpoints + types.
- [x] `apps/web/src/AppShell.tsx` — extended `AdminSubPage`.
- [x] `apps/web/src/App.tsx` — wire sub-page + callback.
- [x] `apps/web/src/pages/AdminDoctors.tsx` — Block time button + callback.
- [x] `apps/web/src/pages/AdminDoctorBlocks.tsx` — new page.
- [x] `apps/web/src/pages/AdminDoctorBlocks.module.css` — new styles.
- [x] This spec.
- [x] Sprint status updated.

**Acceptance Criteria:**
- Given a doctor with no blocks, when the page mounts, then the form is populated (start = now+1h, end = now+4h, branch = first branch, reason = empty) and the Existing blocks panel shows "No blocks yet."
- Given a click on "Preview impact" with a clean range, then `POST /blocks-impact` returns 0 and the summary strip's "Affected" tile shows "0 appointments".
- Given a click on "Preview impact" with a range that overlaps a future Scheduled appointment, then the summary strip shows the count, the warn-card "N appointments fall in this period." is rendered, and the impact-list shows one row per affected appointment with masked phone + branch + start_datetime + status.
- Given a click on "Block →" (clean preview or no preview), then `POST /blocks` returns 201, success banner appears, the form resets to defaults, and the Existing blocks panel refreshes with the new row.
- Given a click on "Block & resolve N →" with the server returning 409 `block_overlaps_future_appointments`, then the error banner surfaces the API's code + friendly message; the form stays populated.
- Given any 4xx from the API (invalid_doctor_id / doctor_not_found / invalid_branch_id / invalid_block_id / branch_not_in_doctor_branches / invalid_time_range / invalid_reason / start_in_past / block_overlaps_future_appointments / block_not_found / unknown_field), then `describeApiError` maps it to a friendly inline error banner.
- Given a click on Delete in the Existing blocks panel, then `DELETE /blocks/:block_id` returns 204 and the panel refreshes.
- Given a network-down error, then "Connection failed. Is the API running on :3001?" appears.
- Given the Single date / Multi-day options in the type picker, then both are rendered as disabled buttons with "Not in MVP" tooltips.
- Given the Branch field on a multi-branch doctor, then a `<select>` is shown with one option per branch; on a single-branch doctor, the branch is rendered as a static label.
- Token-only CSS: no hex literals outside `tokens.css`.
- `pnpm --filter @clinic/web typecheck` — 0 new errors.
- `pnpm --filter @clinic/web lint` — 0 new warnings.

## Spec Change Log

**SC1 — 2026-10-06, plan-step. (No pre-issue.)

This is the initial spec; no amendments yet.

## Deferrals

- **D-S2-1 — Single date / Multi-day block UI.** The mockup's three radio options map to backend routes that don't exist (E2-S2 ships only the `start_datetime`/`end_datetime` range form per spec-2-2 line 36-43). The two disabled buttons today; a future story adds single-date + multi-day support in the backend + UI.
- **D-S2-2 — Existing blocks panel.** The mockup doesn't include a list panel; the doctor-self view of mockup 10 only shows the create flow. Admin needs a way to remove blocks so the panel is added below the form (matches the natural "list + delete" CRUD pattern of E1-S1/E1-S2/E1-S3/E1-S4 sub-pages). Spec-only addition; no mockup change.
- **D-S2-3 — Block-vs-block overlap.** The UI doesn't gate block creation on block-vs-block overlap (the API also doesn't, per spec-2-2 D1).
- **D-S2-4 — Doctor-scoped block editor.** Today the page is reached from the admin Doctors section because the API is gated by `adminScope`. The natural doctor-self view (mockup 10 nav shows "Dr. Ahmed Al-Rashid") lives behind a role-based nav once E1-S0a lands. Same routes can be repurposed behind a doctor-scoped equivalent. Spec-only; no code change.

## Cross-References

- E2-S2 backend: `spec-2-2-block-time.md`
- E1-S3 admin doctors: `spec-1-3-ui-admin-doctors.md` (the parent page where the "Block time" button lives)
- E2-S1 UI: `spec-2-1-ui-doctor-weekly-schedule.md` (sibling sub-page; same code pattern)
- FR-013 + BR-011: block-vs-Scheduled-appointment conflict semantics
- UX-FLOWS F-06: outside-of-hours warning (not applicable to blocks; blocks are time-off by definition)