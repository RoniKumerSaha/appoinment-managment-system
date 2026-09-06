# UX Consistency Report — Personas × Mockups × System Flows

**Author:** Sally (UX Designer)
**Date:** 2026-09-06 (updated)
**Scope:** 4 persona flows × **31 mockups** × 19 system flows (F-01 through F-19) + shared primitives
**Method:** Each persona journey traced through every screen it touches. Each gap scored by severity.

---

## Why this audit

`docs/specs/UX-FLOWS.md` is the **system's** view — what rules fire, what atomic transactions commit, what audit rows write. `docs/design/user-flows/` is the **person's** view — what they see, decide, feel. The 31 mockups in `docs/design/mockups/v1/winners/` are the **visual design**.

These three views must agree. When they don't, the system either:
- **Surprises the user** (a copy mismatch, a missing screen, a wrong route)
- **Fabricates behavior** (an SMS that's not in BRD/PRD)
- **Breaks continuity** (the patient cancels but there's no confirmation feedback)

This report catalogues every divergence and ranks the fixes.

---

## Severity scale

- **Blocker** — actively breaks the persona journey; user can't complete the act.
- **High** — surfaces wrong information or routes to the wrong place.
- **Medium** — visual or copy inconsistency; user can complete the act but is confused.
- **Low** — polish; tone, micro-copy, alignment.

---

## 1. Persona-name + phone mismatch (Blocker) — **FIXED**

**Where:** `04-patient-confirm.html`, `05-patient-self-service.html`, `07-recurring-preview.html`

The persona **Fatima A. Al-Sayed** (`+966 5XX XXX 5555`) is the patient throughout `docs/design/user-flows/patient.md`. The mockups instead showed **Ahmed M. Al-Falasi** (`+971 50 123 4567`) — a UAE number for a Riyadh persona.

| File | Before | After |
|---|---|---|
| `04-patient-confirm.html` | "Ahmed M. Al-Falasi" / `+971 50 123 4567` | "Fatima A. Al-Sayed" / `+966 5XX XXX 5555` |
| `05-patient-self-service.html` | "AM" avatar / `+971 50 123 4567` | "FA" avatar / `+966 5XX XXX 5555` |
| `07-recurring-preview.html` | "Sara M. · +971 50 222 3344" | "Sara M. · +966 5XX XXX 7777" |

**Rule going forward:** One canonical phone per persona. Lock it down in a single demo-data fragment that every mockup imports.

---

## 2. No ConflictModal primitive anywhere (Blocker) — **FIXED**

**Where:** UX-FLOWS §6.1 declares `ConflictModal` a shared primitive used by F-01, F-02, F-05, F-06, F-07, F-13, F-16. The mockups render conflict paths as inline warning cards instead.

**Fix:** Built `winners/29-conflict-modal.html` — a 4-variant showcase (patient slot-just-booked, patient already-booked, patient overlap, admin branch-deactivation). Three-part shape: `what happened` · `why (rule citation)` · `what you can do`. Wired into `app/shell.js` at `/conflict` and mirrored in `standalone-router.js`. Source-of-truth component template lives at `app/components.html`.

---

## 3. No Toast component anywhere (Blocker) — **PARTIALLY FIXED**

**Where:** UX-FLOWS prescribes success toasts for F-04, F-05, F-06, F-07, F-10, F-13, F-14. Zero mockups originally rendered a toast.

**Fix:** Toast template added in `app/components.html`. Single shape: top-right, teal, 3s auto-dismiss. Wire-in across action-screens remains pending.

---

## 4. No Audit log surface (Blocker) — **FIXED**

**Where:** Persona files for all four roles reference audit logs (Salem's Act 6, Dr. Ahmed's Act 4, Reem's edge cases). UX-FLOWS §6.3 specifies audit visibility. No mockup showed an audit log.

**Fix:** Built three audit surfaces, each scoped by role:
- `winners/27-admin-audit-log.html` — admin-only: clinic-structure events (branch hours / doctor assignments / branch state).
- `winners/30-doctor-audit-drawer.html` — doctor's own appointments only, slid in from the right (AuditLogDrawer primitive).
- (Receptionist audit surface still pending — same drawer component, scoped to branch.)

Privacy footer present on all surfaces: "Patients — never see audit logs." Wired at `/admin/audit` and `/doctor/audit-drawer`.

---

## 5. Patient cancel is a plain button, not a modal (Blocker) — **FIXED**

**Where:** `05-patient-self-service.html` originally had the `Cancel` button routing to `/patient/manage` — no confirmation modal.

**Fix:** Built `winners/22-patient-cancel-confirm.html` — standalone modal page reachable from cancel buttons. Three-part shape (what / why / do) using the ConflictModal pattern. `[Keep appointment]` `[Cancel appointment]` actions. Privacy note: "No reason needed. The slot will be released."

---

## 6. Patient reschedule has no success state (Blocker) — **FIXED**

**Where:** `05-patient-self-service.html`. After the patient taps `Confirm move`, they should see:
> "Your appointment has been moved to Sat, Aug 23, 11:15."

**Fix:** Built `winners/20-patient-reschedule.html` — full SlotFinder with branch + type locked per BR-058, calendar grid, slot grid. Inline `Confirm move` button. Wired at `/patient/reschedule`.

---

## 7. Admin persona name mismatch on `08` (Blocker) — **FIXED**

**Where:** `08-branch-hours-impact.html` showed `Admin · Nadia K.`. The persona is Salem.

**Fix applied:** now `Admin · Salem Al-Mutairi`.

---

## 8. Receptionist cancel fabricates SMS/email behaviour (Blocker) — **FIXED**

**Where:** `15-recep-cancel.html` had bullet: "Send SMS + email cancellation to patient". Not in BRD/PRD/UX-FLOWS.

**Fix applied:** removed.

---

## 9. Branch deactivation modal (BR-059) missing in `17` (Blocker) — **FIXED (variant in `29`)**

**Where:** `17-admin-branches.html`. Toggling a branch with future appointments to Inactive should trigger a modal: "Branch A has 14 future appointments. Deactivation not allowed (BR-059)."

**Fix:** The variant "Branch has 14 future appointments" is rendered in `winners/29-conflict-modal.html` (variant 4) with rule citation BR-059. Wiring into the Status toggle in `17` remains pending.

---

## 10. Cross-screen identity drift (High) — **PARTIALLY FIXED**

**Phone numbers** for the same patient differed across mockups:

| Patient | `12` (doctor view) | `13` (recep view) | `14` (recep create) | `15` (recep cancel) |
|---|---|---|---|---|
| Fatima Al-Sayed | `+966 5XX XXX 1234` | `+966 5XX XXX 5555` | `+966 5XX XXX 1234` | `+966 5XX XXX 1234` |

**Rule:** one canonical phone per persona. New mockups (20-31) consistently use `+966 5XX XXX 5555` for Fatima. Old screens (`12`, `13`, `14`, `15`) still drift.

---

## 11. Status-pill style inconsistent (High)

`12-mark-status.html`: pills without icons (`Scheduled`, `Completed`, `Cancelled`, `No-show`).
`13-recep-today.html`: pills with icons (`✓ Done`, `○ Cancelled`, `● Scheduled`, `✕ No-show`).

**Decision:** adopt the icon-prefixed variant. Richer semantic cue; the icons survive translation.

---

## 12. Wrong interaction model for patient cancel/reschedule (High) — **FIXED**

`05-patient-self-service.html` had a contradiction: the `Reschedule` button routed to `/patient/slot` (the doctor-picker/branch-picker flow) **and** an inline form appeared for the same appointment.

**Fix:** The reschedule form is now a dedicated screen at `winners/20-patient-reschedule.html` reachable via `/patient/reschedule`. Inline form was removed from `05`. Cancel goes to the modal at `22-patient-cancel-confirm.html`.

---

## 13. All "New doctor / receptionist / branch" cards route to wrong screens (High) — **PARTIALLY FIXED**

- `17`: `Create new branch` → empty route
- `18`: `New doctor` → `/doctor/schedule` (wrong)
- `19`: `New receptionist` → `/recep/today` (wrong)

**Progress:** routes registered (`/admin/branch-new`, `/admin/doctor-new`, `/admin/recep-new`) but pointing to the same parent screen. Dedicated New-X screens pending.

---

## 14. Doctor `Edit` and receptionist `Reassign` route to wrong screens (High) — **PARTIALLY FIXED**

- `18`: `Edit` and `Assign` buttons route to `/doctor/schedule` (wrong — admin is editing the admin record, not impersonating the doctor)
- `19`: `Edit` and `Reassign` route to `/recep/today` (same problem)

**Progress:** `winners/31-admin-doctors-reassign.html` (Salem's reassign-branches flow) is built. Edit-recep screen pending.

---

## 15. Doctor's `Save changes` in `09` jumps to Kanban (Medium)

`09-doctor-schedule.html` Save button routes to `/doctor/resolve`. Save should stay in place with a toast.

**Next step:** change route to self-route + toast "Schedule saved."

---

## 16. Cancel-reason dropdowns differ between doctor and receptionist (Medium)

`12-mark-status.html`: `{Patient requested, Doctor unavailable, Scheduling conflict}` ✓ matches persona.
`15-recep-cancel.html`: had 6 options including `Doctor unavailable` (doctor-only by BR-037) and `Patient ill` (receptionist preference).

**Decision:** keep them split per role. The new `winners/25-doctor-cancel-reason.html` honors the 3-option doctor set. Recep cancel keeps its separate list.

---

## 17. Outside-branch-hours warning lacks buttons in `09` (Medium)

UX-FLOWS F-06 calls for `[Adjust]` `[Continue anyway]`. `09` shows the warning text only.

**Next step:** add the two action buttons.

---

## 18. Recurring preview `Edit pattern` routes to wrong screen (Medium) — **PARTIALLY FIXED**

`07-recurring-preview.html` → `/doctor/schedule` (wrong).

**Progress:** `winners/23-recurring-confirm.html` is the post-preview "9 created, 3 skipped" confirmation page (F-11 second step). Edit-pattern editor still pending.

---

## 19. Branch-hours "Notify doctors by SMS" leaks patient PII (Medium)

`08-branch-hours-impact.html` checkbox: opt-in to SMS notify. UX-FLOWS §6.3 says "Patients — never see audit logs." SMS with affected appointment list = PII leak.

**Decision:** replace SMS with in-app notification only. No PII leaves the system.

---

## 20. Appointment-types impact card uses wrong example (Medium)

`11-appointment-types.html` impact card talks about changing duration to 60 min. Persona/UX-FLOWS F-08 talks about **deactivating** with future appointments.

**Next step:** add a separate impact preview for deactivation with future appointments.

---

## Top fixes — current status

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | Blocker | No `ConflictModal` primitive | **FIXED** — `winners/29-conflict-modal.html` + `app/components.html` |
| 2 | Blocker | No `Toast` component | **Component created** — wire-in pending |
| 3 | Blocker | No audit log mockup | **FIXED** — `27-admin-audit-log` + `30-doctor-audit-drawer` |
| 4 | Blocker | Patient persona drift | **FIXED** in `04`, `05`, `07` |
| 5 | Blocker | Patient cancel is a plain button | **FIXED** — `22-patient-cancel-confirm.html` |
| 6 | Blocker | Patient reschedule has no success state | **FIXED** — `20-patient-reschedule.html` |
| 7 | Blocker | Admin `08` shows "Nadia K." | **FIXED** |
| 8 | Blocker | Recep `15` fabricates SMS/email | **FIXED** |
| 9 | Blocker | Branch deactivation modal (BR-059) | **FIXED in `29`** — wire-in to `17` pending |
| 10 | High | Cross-screen identity drift | **Partially fixed** — new screens consistent, old still drift |
| 11 | High | Status-pill style inconsistent | **Pending** |
| 12 | High | Patient cancel/reschedule interaction model | **FIXED** |
| 13 | High | Recurring route collision (07 served both patient + doctor) | **FIXED** — `/doctor/recurring-preview` now → `23-recurring-confirm.html` (the doctor screen); `07` stays as patient-only. `23`'s `Edit pattern` → `/doctor/schedule` (upstream). Standalone-router + shell.js + ROUTE_META updated. |
| 14 | High | Branch-hours editor vs preview routing | **FIXED** — `08`'s `Back to editor` now → `/admin/branch-hours-editor` (28, the editor); `28`'s `Save & preview impact` → `/admin/branch-hours` (08, the preview); `08`'s `Cancel` + `Save anyway` still → `/admin/branches` (17, list) |
| 15 | Medium | Doctor `Save changes` jumps to Kanban | **FIXED** — `09` Save stays on page, toast reveals on click, auto-dismiss 3s |
| 16 | Medium | Cancel-reason dropdowns differ | **Doctor side FIXED** (`25`) |
| 17 | Medium | Outside-branch-hours warning lacks buttons | **FIXED** — `09` warning now has `[Adjust periods]` (scrolls + highlights first period) and `[Continue anyway]` (dismisses, focuses Save) |
| 18 | Medium | Recurring preview `Edit pattern` | **Confirm page FIXED** (`23`) — editor pending |
| 19 | Medium | Branch-hours "Notify doctors by SMS" leaks PII | **FIXED** — `08` SMS toggle replaced with in-app notification info row (no PII leaves the system) |
| 20 | Medium | Appointment-types impact card wrong example | **Pending** |
| 21 | High | Card-with-`cursor:pointer` was a div, no click handler | **FIXED** — `02` (branch-card × 3 + type-card × 3), `14` (type-opt × 4) now `<button>` with JS toggle for `.selected` |

---

## What's been done

### v1 (2026-08-30)

1. Created `docs/design/mockups/v1/app/components.html` — shared component library (ConflictModal, Toast, AppointmentCard, StatusPill, EmptyState, AuditLogDrawer templates).
2. Fixed patient persona drift in `04`, `05`, `07`.
3. Added a reschedule success banner to `05`.
4. Fixed admin name on `08`.
5. Removed fabricated SMS/email bullet from `15`.
6. Fixed doctor name drift on `18`.

### v2 (2026-09-06) — gap-fill pass: 12 new wireframes

Built 12 missing screens to close the persona-flow gaps surfaced by user-flows + UX-FLOWS:

| # | File | Flow | Purpose |
|---|------|------|---------|
| 20 | `winners/20-patient-reschedule.html` | F-05 | Patient slot finder; branch+type locked |
| 21 | `winners/21-patient-otp-modal.html` | F-03 | OTP 6-digit input + resend timer |
| 22 | `winners/22-patient-cancel-confirm.html` | F-04 | Patient cancel modal |
| 23 | `winners/23-recurring-confirm.html` | F-11 | "9 created, 3 skipped" confirm page |
| 24 | `winners/24-doctor-resolve-one.html` | F-09 | Single-affected resolution |
| 25 | `winners/25-doctor-cancel-reason.html` | F-10 | Doctor cancel + reason (3-option set) |
| 26 | `winners/26-recep-checkin.html` | F-13 | Walk-in check-in; branch locked |
| 27 | `winners/27-admin-audit-log.html` | F-20 | Admin config audit |
| 28 | `winners/28-admin-branch-hours-editor.html` | F-17 | Hours editor (pre-impact step) |
| 29 | `winners/29-conflict-modal.html` | UX | ConflictModal showcase · 4 variants |
| 30 | `winners/30-doctor-audit-drawer.html` | UX | AuditLogDrawer (doctor scope) |
| 31 | `winners/31-admin-doctors-reassign.html` | F-18 | Salem reassign-branches flow |

All 12 wired into `app/shell.js` ROUTES + `app/standalone-router.js` mirror. `app/mocks.html` updated with thumbnails per actor section + new "Design system" section for shared primitives. `README.md` + `CHOICES.md` updated to reflect 31-mockup total + 22-pattern E dominance.

### v3 (2026-09-06) — tokenization + a11y + card-clickability pass

1. **Extracted shared stylesheet** at `app/design-system.css` (467 lines: tokens, chrome, 13 components, focus rings, two media queries). Linked from all 31 mockups. The .md is still the source of truth — the .css is its implementation. Per-mockup local rules still win on cascade for visual drift, so behaviour is unchanged.
2. **Rebuilt `app/design-system.html`** against the shared sheet (735 lines, was 1079). Every component renders from the .css — change a token, the swatch updates. Demonstrates `#44` (demo badge gating) by setting `body[data-demo="true"]`.
3. **Fixed card-clickability affordance** (#21) — `.branch-card` × 3 and `.type-card` × 3 in `02-doctor-picker.html`, `.type-opt` × 4 in `14-recep-create.html`. Converted `<div>` → `<button>`, added `:focus-visible` ring, added per-group JS toggle for `.selected`. Bottom advance button remains the navigation trigger (no eager-advance on card click). The locked branch card in `14` (BR-004 single-branch) was already correct — left as-is.

## What remains

- Toast wire-in (component exists; needs per-screen placement)
- Status-pill icon consistency (pending design-system decision)
- New-X dedicated screens (routes registered, parent screens reused for now)
- Edit-recep screen (mirror of `31`)
- Appointment-types deactivation impact card on `11`
- Recep audit drawer (mirror of `30`, branch-scoped)
- Phone-number canonicalization across `12`, `13`, `14`, `15`

### v3 (2026-09-06) — bug-fix sweep: routing + card a11y + copy fixes

1. **Card-with-`cursor:pointer` was a `<div>` (#21).** `02-doctor-picker.html` (branch-card × 3, type-card × 3) and `14-recep-create.html` (type-opt × 4) converted to `<button>`, added `:focus-visible` ring + `appearance:none` button-reset, added per-group JS toggle for `.selected`. Bottom advance button remains the navigation trigger (no eager-advance on card click). Locked branch card in `14` (BR-004) was already correct — left as-is.
2. **Doctor `Save changes` jumped to Kanban (#15).** `09-doctor-schedule.html`: toast was visible on page load (a phantom "saved" message). Fixed by hiding `.toast-stack` by default, showing it via JS on Save click. Capture-phase listener on `window` runs before the standalone-router's document-capture handler, so `preventDefault` + `stopImmediatePropagation` blocks the self-route navigation. Auto-dismiss after 3 s; manual dismiss button works.
3. **Outside-branch-hours warning had no buttons (#17).** `09-doctor-schedule.html` warning now has `[Adjust periods]` (smooth-scrolls to first period, brief amber halo) and `[Continue anyway]` (fades the warning, focuses Save).
4. **Recurring route collision (#13).** `/doctor/recurring-preview` was → `07-recurring-preview.html` (the **patient** screen — wrong perspective). Re-routed to `23-recurring-confirm.html` (the doctor recurring preview/confirmation). Updated in standalone-router.js + shell.js ROUTES + ROUTE_META. Also fixed `23`'s `Edit pattern` button which had `data-route="/doctor/recurring-preview"` (self-loop) → now `/doctor/schedule` (upstream).
5. **Branch-hours editor/preview routing (#14).** `08`'s `Back to editor` was → `/admin/branches` (the branches list — wrong). Re-routed to `/admin/branch-hours-editor` (28, the editor). Cancel + Save-anyway still → `/admin/branches` (correct).
6. **Branch-hours SMS PII leak (#19).** `08` had a "Notify doctors by SMS" opt-in checkbox — sending appointment details by SMS violates UX-FLOWS §6.3 ("PII never leaves the system"). Replaced with a read-only info row: "In-app notification only. Affected doctors are notified in-app on next login. **No SMS** — appointment details (patient names, times) stay inside the system."

The pattern: build the shared component once, wire it everywhere it should appear.