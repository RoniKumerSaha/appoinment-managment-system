# UX Design — Engineer Hand-off

**Project:** Clinic Scheduling — appointment management system
**Phase:** WDS Phase 5 — Development (UX→Eng bridge)
**Date:** 2026-09-15
**Author:** Sally (UX Designer)
**Audience:** Phase 5 engineers picking up stories from `_bmad-output/implementation-artifacts/sprint-status.yaml`

---

## What this document is

A story-by-story map from the 36 mockups in `docs/design/mockups/v1/` to the sprint backlog in `_bmad-output/planning-artifacts/epics-and-stories.md`. For each upcoming story (E1-S2 onwards), this document points engineers at:

1. **Which mockup(s) to implement against** (open in browser, don't re-invent).
2. **Which design-system tokens** to wire (file path + token name).
3. **Which component primitive** to copy (status pills, branch cards, agenda timeline, ConflictModal, audit-log row).
4. **Which UX principle** is being defended, so the engineer knows *why* a particular edge case must be surfaced.

This document does **not** introduce new tokens, new components, or new patterns. Where the sprint story needs something the design system doesn't yet have, the resolution is documented under "Open questions."

---

## 1 · The 8 reusable component primitives

Every mockup is built from these eight primitives. They live as named patterns in the design-system CSS, in `imports/app/components.html`, and as inline patterns in the mockups themselves. **Copy, don't recreate.**

| # | Primitive | Where it lives | Stories that depend on it |
|---|---|---|---|
| 1 | **Status pill** | `imports/app/design-system.css` §`.pill` family | E1-S0-ui, E5-S1, E5-S2, E5-S3, E5-S4, E6-S3 |
| 2 | **Section card** (numbered steps) | `08-branch-hours-impact.html` `.section` | E1-S2, E1-S3, E1-S4, E2-S1, E6-S3, E7-S2 |
| 3 | **ConflictModal** (3-part) | `29-conflict-modal.html` showcase | E3-S1, E3-S2, E3-S3, E6-S1, E7-4 |
| 4 | **Audit log row** | `27-admin-audit-log.html` + `30-doctor-audit-drawer.html` | E7-S2 |
| 5 | **Appointment card** (time · patient · doctor · type · status · qa) | `13-recep-today.html` `.appt-row` | E5-S4, E5-S1, E3-S4, E4-S2, E4-S3 |
| 6 | **Branch card** / **Doctor card** | `02-doctor-picker.html` `.branch-card`, `18-admin-doctors.html` `.doctor-card` | E1-S1, E1-S3, E1-S4, E3-S2, E3-S3 |
| 7 | **Agenda timeline** (slot picker) | `03-availability-calendar.html` `.agenda-day` | E3-S1, E3-S2, E3-S3, E3-S4, E3-S5 |
| 8 | **Step-number primitive** | `08-branch-hours-impact.html` `.section-num` | E1-S2, E6-S3, E7-S4 |

Each primitive is documented in [`DESIGN.md`](./DESIGN.md) §6.

---

## 2 · Story → Mockup matrix (E1-S2 onwards)

### Epic 1 — Clinic structure & admin

#### E1-S0-ui — Clinic settings UI (web) · DEFERRED
- **Mockup:** `32-admin-clinic-settings.html`
- **Tokens to wire:** `--brand-primary`, `--surface-card`, `--text-heading`, `--space-7`, `--radius-lg`
- **Component:** Section card + status pills (active vs inactive counts)
- **API surface:** `GET /admin/clinic` (E1-S0b) returns `{id, name, branches_total, doctors_total, receptionists_total, patients_total, updated_at}`
- **UX principle (P-01 Visibility):** Admin sees aggregate counts only — no patient names, no appointment detail. Defends BR-065.

#### E1-S1 — Create / edit / deactivate branches · DONE (UX handoff for review fixes)
- **Mockups:** `17-admin-branches.html`, `38-admin-branch-deactivate.html`
- **Tokens:** `--success-bg`, `--danger-bg`, `--danger-strong`, `--text-3xs` (pill text), `--radius-lg` (cards), `--radius-pill` (status pills)
- **Component:** Section card (numbered steps) for the deactivate confirmation
- **UX principle (P-02 Accuracy):** `38` is the disabled-button-with-clear-message gate. If `future_appointment_count > 0`, the "Confirm deactivation" button is **disabled** with a clear message: "N future appointments must be resolved first. [Resolve them →]" linking to the resolve flow.
- **API contract:**
  - `POST /admin/branches` → `201 {id, name, active: true, ...}` (mirrors E1-S0b trim-then-validate pattern)
  - `PATCH /admin/branches/:id {active: false}` → if conflict, returns `409 {error: 'branch_has_future_appointments'}` — **the UI must show the disabled-button gate, not a 500**
- **What NOT to do:** do not surface a raw toast on `409`. The user-facing affordance is the disabled primary CTA with the clear message — see `38` for the exact copy.

#### E1-S2 — Change branch operating hours (saves + flags affected appointments) · BACKLOG
- **Mockups:** `28-admin-branch-hours-editor.html`, `08-branch-hours-impact.html`, `36-confirmation-receipt.html` (success receipt reused)
- **Tokens:** `--warning-bg`, `--warning-border`, `--warning-soft`, `--warning-text`, `--danger-bg`, `--success-bg`
- **Components:** Step-number primitive + section cards + audit-log row
- **UX principle (P-02 Accuracy):** This is one of the two **distinct** conflict flows (BRD §4.6). Admin changes save the new hours + flag affected appointments; doctors see "Resolve" badges. **The system never silently invalidates.**
- **Critical UX rule:** Section 3b in `08` (PRD §4.6 doctor-not-at-branch edge case) is **required** — without it, the system can silently invalidate appointments assigned to a doctor who no longer works at the branch. The acknowledgment checkbox is not optional.
- **API contract:**
  - `PATCH /admin/branches/:id/operating-hours` → returns `200` with `{affected_count, affected_doctors: [...]}`. The UI then shows the 5-step confirmation in `08`.
  - **Do not** use a synchronous transaction; the audit row + flag write should be in the same transaction.

#### E1-S3 — Create / deactivate / assign-branch doctors · BACKLOG
- **Mockups:** `18-admin-doctors.html`, `31-admin-doctors-reassign.html`
- **Tokens:** `--brand-primary`, `--surface-card`, `--text-heading`, `--radius-lg`
- **Components:** Branch card (avatar + branch chips + specialty), doctor card grid
- **UX principle (P-01 Visibility):** Doctors appear as a card grid; reassigning branches uses a stacked vertical flow with the branch-multi-select chip.
- **API contract:** `POST /admin/doctors {full_name}`, `PATCH /admin/doctors/:id {branch_ids: [...]}` — branch_ids is the array (NOT scalar; mirrors `doctor_branch` junction table).

#### E1-S4 — Create / deactivate / assign-branch receptionists · BACKLOG
- **Mockups:** `19-admin-receptionists.html`
- **Tokens:** `--brand-primary`, `--surface-card`, `--text-heading`, `--radius-lg`, `--info-bg` (active vs inactive pill)
- **Components:** Card grid (mirrors E1-S3 doctors grid)
- **UX principle (P-01 Visibility):** Receptionists are branch-scoped — the UI must show the branch on each card so the admin can verify scoping.
- **API contract:** Scalar `branch_id` (NOT array; mirrors `receptionist.branch_id`).

---

### Epic 2 — Doctor schedule & types

#### E2-S1 — Configure weekly schedule with multi-period days · BACKLOG
- **Mockup:** `09-doctor-schedule.html`
- **Tokens:** `--brand-primary`, `--surface-soft` (inset slot rows), `--border-default`, `--radius-sm`
- **Components:** List by Day + Tabs (the one deviation from Stacked Vertical Flow; defended because multi-period editing needs day-segmentation)
- **UX principle (P-02 Accuracy):** Schedule changes that would conflict with existing appointments are **rejected** at the API layer. The UI must show the rejection as a ConflictModal with the 3-part pattern (what happened / why / what you can do) — see `29-conflict-modal.html`.
- **Tabular numerics:** All time cells use `font-variant-numeric: tabular-nums`.

#### E2-S2 — Block time (single date / range / multi-day) · BACKLOG
- **Mockup:** `10-doctor-block-time.html`
- **Tokens:** `--danger-bg`, `--danger-border`, `--warning-bg` (overlap warning)
- **Components:** Stacked vertical flow + warning info row
- **UX principle (P-02 Accuracy):** Block periods overlapping existing appointments are rejected with the ConflictModal pattern.

#### E2-S3 — Manage appointment types (create, edit, deactivate) · BACKLOG
- **Mockup:** `11-appointment-types.html`
- **Tokens:** `--brand-primary`, `--surface-card`, `--text-heading`, `--radius-lg`
- **Components:** Stacked vertical flow + status pills
- **UX principle:** Deactivating an appointment type must check for future appointments of that type. If any exist, the same disabled-button-with-clear-message pattern from `38` applies.

#### E2-S4 — Negative capability: doctor cannot reschedule ordinary patient appointments · BACKLOG
- **No mockup — purely a backend contract.**
- **The defense surface:** All doctor's "Reschedule" actions visible in mockups are **moves within the conflict-resolution flow** (`24-doctor-resolve-one.html`), not standalone reschedules. The doctor has no free-form "Reschedule any appointment" affordance in any v1 mockup. **Do not add one.** This is the negative-capability UX.

---

### Epic 3 — Booking core

#### E3-S1 — Availability engine · BACKLOG
- **Mockups:** `03-availability-calendar.html`, `16-recep-availability.html`, `34-patient-branch-picker.html`, `35-patient-type-picker.html`
- **Tokens:** `--surface-soft` (selected slot bg), `--border-default`, `--success-bg` (selected slot fill)
- **Components:** Agenda timeline, branch card, type card
- **UX principle (P-02 Accuracy):** The patient-conflict pre-warning in `03` (BR-031 / BR-033) is rendered **before submit**, not at submit. The API should support `?pre_check=true` to surface conflicts without committing.
- **Tabular numerics:** Every slot time cell.

#### E3-S2 — Guest booking (first-time) · BACKLOG
- **Mockups:** `02-doctor-picker.html`, `34`, `35`, `03`, `04`, `36`
- **Tokens:** `--brand-primary`, `--success-bg`, `--success-text`, `--radius-md`
- **Components:** 8-page stacked flow — each step is a separate route
- **UX principle (P-03 Simple steps):** The 8-page flow replaces one long form. Each step must remember prior selections (doctor, branch, type) via URL state.
- **Booking receipt:** `36` shows booking ref (dashed border, mono font), masked phone, "Add to calendar" CTA, phone-call fallback.

#### E3-S3 — Returning patient booking (known phone) · BACKLOG
- **Mockups:** Same as E3-S2; OTP step uses `21-patient-otp-modal.html`
- **Tokens:** `--brand-primary`, `--info-bg` (OTP resend hint), `--success-bg`
- **Components:** OTP modal (6 boxes, resend timer, phone-call fallback)
- **UX principle (P-01 Visibility):** The OTP screen must never leak patient names. It only knows a phone number — no PII lookup before authentication.

#### E3-S4 — Receptionist booking on behalf of patient · BACKLOG
- **Mockups:** `14-recep-create.html`, `26-recep-checkin.html` (confirmation step)
- **Tokens:** `--brand-primary`, `--success-bg`, `--info-bg`
- **Components:** Stepped form (mirrors E3-S2 patient flow)
- **UX principle (P-01 Visibility):** Branch pre-fill from `req.auth.claim.branch_ids[0]`. Doctor picker is branch-filtered. Recep cannot book at a branch they're not assigned to — this is enforced server-side; the UI must not show out-of-branch options.

#### E3-S5 — Receptionist reads doctor availability · BACKLOG
- **Mockup:** `16-recep-availability.html`
- **Tokens:** `--surface-soft`, `--border-default`
- **Components:** Agenda timeline (read-only — no slot-click handler)
- **UX principle (P-01 Visibility):** Read-only by design. No booking action from this view — the recep walks back to `13` (today's view) and clicks "+ Book walk-in."

---

### Epic 4 — Patient self-service

#### E4-S1 — Patient OTP verification · BACKLOG
- **Mockup:** `21-patient-otp-modal.html`
- **Tokens:** `--info-bg`, `--info-text`, `--brand-primary`
- **Components:** OTP modal with 6 boxes, resend timer, phone-call fallback
- **UX principle:** Resend timer must be visible. Phone-call fallback is a **secondary**, never a primary. The masked phone `+966 5XX XXX 5555` is the only identity cue.

#### E4-S2 — Patient cancellation · BACKLOG
- **Mockup:** `22-patient-cancel-confirm.html`
- **Tokens:** `--danger-bg`, `--danger-border`, `--warning-bg`, `--warning-text`
- **Components:** Cancel modal + cancellation reason (free-text fallback)
- **UX principle (P-02 Accuracy):** Cancelling writes one audit row. The UI must show "Atomic: cancel · audit: 1 row written" inline.

#### E4-S3 — Patient rescheduling · BACKLOG
- **Mockup:** `20-patient-reschedule.html`
- **Tokens:** `--brand-primary`, `--surface-soft`, `--success-bg`
- **Components:** Slot picker (agenda timeline) — same as `03`
- **UX principle (P-02 Accuracy):** Reschedule re-runs the availability engine and the patient-conflict pre-warning from `03`. Two slots with the same doctor within 30 days is rejected (BR-031).

#### E4-S4 — Deep-link entry to cancel/reschedule · BACKLOG
- **No new mockup — deep-link from SMS.**
- **The defense surface:** The deep-link lands on `21-patient-otp-modal.html` (must verify phone before showing the cancel/reschedule actions). The mockup already shows this gating.

---

### Epic 5 — Staff appointment management

#### E5-S1 — Mark Completed / No-show · BACKLOG
- **Mockup:** `12-mark-status.html`
- **Tokens:** `--brand-primary`, `--success-bg` (Completed), `--danger-bg` (No-show)
- **Components:** Quick-Action Sidebar (the one deviation for doctor during consultations)
- **UX principle (P-03 Simple steps):** The status pills are the same family as `13`. Mark Completed / No-show is a one-click action from the consultation view.

#### E5-S2 — Doctor cancellation with reason · BACKLOG
- **Mockup:** `25-doctor-cancel-reason.html`
- **Tokens:** `--danger-bg`, `--danger-border`, `--warning-soft`
- **Components:** Stacked vertical flow + reason picker (quick-pick + free-text fallback)
- **UX principle (P-01 Visibility):** Quick-pick reasons ("Patient no-show," "Doctor unavailable," "Clinic closure") are prominent; free-text is the fallback.

#### E5-S3 — Receptionist cancellation with reason · BACKLOG
- **Mockup:** `15-recep-cancel.html`
- **Same pattern as E5-S2** but with recep-specific quick-pick reasons.

#### E5-S4 — Today's branch view (receptionist dashboard) · BACKLOG
- **Mockup:** `13-recep-today.html`
- **Tokens:** `--brand-primary`, `--info-bg` (Scheduled), `--success-bg` (Completed), `--danger-bg` (Cancelled/No-show), `--warning-bg` (now-row), `--neutral-bg` (hour-label count)
- **Components:** Card List by Hour + status pills + quick-action buttons
- **UX principle (P-03 Simple steps):** At-a-glance for the multi-tasking recep. "Check in" is the most common action — it is one click, not a form.
- **The "now" row** (yellow background, `--warning-bg`) highlights the current-hour appointments. Don't drift this to brand teal — it must be visually distinct from the brand action color.

#### E5-S5 — No deletion (negative test) · BACKLOG
- **No mockup — purely a backend contract.**
- **The defense surface:** No v1 mockup has a "Delete" button on an appointment. The only mutating actions are: cancel, reschedule, mark status. **Do not add delete UI.** This is the negative-capability UX.

---

### Epic 6 — Recurring & conflict resolution

#### E6-S1 — Recurring appointment preview + partial-success create · BACKLOG
- **Mockups:** `07-recurring-preview.html`, `23-recurring-confirm.html`
- **Tokens:** `--brand-primary`, `--success-bg`, `--warning-bg`, `--danger-bg`
- **Components:** Stacked vertical flow + summary numbers (validation hero)
- **UX principle (P-01 Visibility):** "X created · Y skipped · Z needs resolution" — the patient sees every slot's outcome before committing. The summary numbers use `--text-display` (36px, weight 700).

#### E6-S2 — Resolve affected appointments (doctor) · BACKLOG
- **Mockups:** `06-resolve-affected.html` (Kanban), `24-doctor-resolve-one.html`, `37-doctor-resolution-saved.html`
- **Tokens:** `--brand-primary`, `--warning-bg`, `--success-bg`, `--danger-bg`
- **Components:** Kanban Queue (the one deviation from Stacked Vertical Flow; defended because bulk conflict resolution needs column visualization), audit-log row, success receipt
- **UX principle (P-02 Accuracy):** This is the doctor's primary defense surface for the "never silently invalidate" principle. The Kanban must show patient names + times + options (move to alternate slot, move to alternate branch, cancel).

#### E6-S3 — Branch-hours impact flag (admin) · BACKLOG
- **Mockups:** `08-branch-hours-impact.html` (impact-preview, see E1-S2) + `39-admin-branch-hours-resolution.html` (resolution-status, **Q3 resolved 2026-09-15**)
- **The resolution-status surface:** After the admin saves the branch-hours change, doctors receive "Resolve" badges on their next login. The admin needs a surface to track resolution progress *without* seeing patient detail. The new mockup `39` shows: a 4-number hero (Moved / Cancelled / Deferred / Remaining), a per-doctor breakdown with progress bars, a per-branch status, and a configuration-only audit-log block.
- **Privacy rule (BR-065 / E7-S3):** The admin sees aggregate counts only — no patient names. The mockup makes this rule visible via a privacy-note callout and an explicit "Out of admin's audit scope" block pointing doctors to their own Kanban (`06-resolve-affected`). Doctors' resolution actions are logged against the doctor's appointment audit scope, not the admin's.
- **Two hero states:** `in-progress` (yellow border, `--warning-bg`, "N of M resolved") and `complete` (teal border, `--success-bg`, "All N appointments resolved"). Production picks at render time based on `remaining > 0`.

#### E6-S4 — Per-occurrence recurring cancel / reschedule · BACKLOG
- **Mockup:** `33-recurring-occurrence-cancel.html`
- **Tokens:** `--warning-bg`, `--warning-border`, `--brand-primary`
- **Components:** Stacked vertical flow + occurrence picker

---

### Epic 7 — Cross-cutting

#### E7-S1 — Design system token wiring · BACKLOG
- **Source:** `docs/design/mockups/v1/imports/app/design-system.css` (574 lines, 1:1 with `docs/design/DESIGN-SYSTEM.md`)
- **Tokens:** All `:root` declarations (color, type, spacing, radius, elevation)
- **Component classes:** `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.pill`, `.section`, `.section-num`, `.summary-card`, `.summary-row`, `.field`, `.field-label`, `.conflict-modal`
- **What to do:** Import `design-system.css` (or extract its `:root` block into the web app's global stylesheet) so every screen pulls tokens, not raw hex values.
- **Anti-drift rule:** If a story needs a new token, update `DESIGN-SYSTEM.md` **first**, then wire CSS. Never the other way.

#### E7-S2 — Appointment audit (FR-051, NFR-005) · BACKLOG
- **Source:** `27-admin-audit-log.html`, `30-doctor-audit-drawer.html`
- **Format:** `actor · action · target · time · reason`
- **Tokens:** `--surface-card`, `--text-2xs`, `--text-xs`, `--text-sm`, `--border-default`, `--surface-divider`
- **Scope:** Doctor sees only own appointments; recep sees own branch; admin sees clinic-structure only (no patient detail) — per BR-065.

#### E7-S3 — Patient privacy filter (NFR-007) · BACKLOG
- **Source:** Cross-cutting; defended by every mockup's scope rules
- **The defense surface:** Admin's branch-hours impact (`08`) shows appointment counts only, never patient names. Admin's resolve-side (E6-S3, future) must also be count-only.
- **Token:** No new token needed; the pattern is "show counts, hide PII."

#### E7-S4 — Conflict modal global component · BACKLOG
- **Source:** `29-conflict-modal.html`
- **Pattern:** 3 parts — (1) what happened, (2) why, (3) what you can do (3 buttons: pick another slot, join waitlist, call clinic)
- **Tokens:** `--warning-bg`, `--warning-soft`, `--warning-text`, `--danger-bg`, `--danger-border`, `--brand-primary`
- **Use sites:** E3-S1, E3-S2, E3-S3, E6-S1 — every place atomic reservation can fail at the patient side

#### E7-S5 — Accessibility baseline (WCAG 2.1 AA) · BACKLOG
- **Source:** `DESIGN-SYSTEM.md` §2 colors (contrast ratios all ≥ 4.5:1)
- **Rules:**
  - Every interactive element has a focus ring (`:focus-visible` + `--ring-focus`)
  - All form inputs have associated `<label>`
  - Status pills have `aria-label` (color is never the only cue)
  - Tabular figures on time cells
  - Modal traps focus + Escape closes
  - Screen-reader text for icon-only buttons

#### E7-S6 — Branch timezone support · BACKLOG
- **Source:** `DESIGN-SYSTEM.md` §3.3 + architecture AD-9
- **The rule:** Store UTC; render in the *appointment's branch* timezone. The session's branch tz never relabels another branch's event. The mockups use Riyadh time (`+03`) as the default.

#### E7-S7 — No tentative client-side slot holds · BACKLOG
- **The defense surface:** No mockup has a "holding" state on a slot. Slots are either available or taken. The patient picks → submits → atomic reservation → success receipt (`36`). No "tentatively reserved for 5 minutes" UI.
- **Token:** No new token; this is a UX-negative rule.

#### E7-S8 — Performance & availability SLAs · BACKLOG
- **Source:** Architecture §3.2 availability engine
- **UX cue:** Mockup `03` shows "Slots refresh in real time." in the sidebar. The engineer must wire a `/availability` endpoint that responds in ≤ 300ms (per FR-018's 30-day rolling window + SLA).

#### E7-S9 — Product metrics instrumentation · BACKLOG
- **The defense surface:** Audit logs are the source of truth for product metrics. Don't add a second telemetry layer; reuse `E7-S2`.

#### E7-S10 — Design open questions parking lot · BACKLOG
- **See "Open questions" below.**

---

## 3 · The 3 UX principles — quick reference

These three principles defend every visible UX decision in the mockups. When in doubt, read them.

| # | Principle | What it means | The visible defense |
|---|---|---|---|
| **P-01** | **Visibility** | Every actor sees exactly the appointments and conflicts relevant to their scope. No patient PII leaked across scopes. | Doctor's Kanban (rich), admin's impact preview (counts only), audit log scope rules |
| **P-02** | **Accuracy** | The system never silently invalidates an appointment. | `06` Kanban, `08` Stacked impact, `38` deactivate gate, ConflictModal pattern |
| **P-03** | **Simple steps** | Patient flow is 8 focused screens; recep queue puts common actions one click away. | `02–05, 34–36` patient flow, `13` recep today |

**Where the asymmetry is intentional:** The doctor's Kanban (`06`) is rich with patient detail because the doctor needs to call patients to confirm moves. The admin's impact preview (`08`) shows counts only because the admin has oversight, not patient-PII access. **Do not unify these surfaces.** They look different on purpose.

---

## 4 · When the story conflicts with the mockup

If a sprint story reveals a UX gap, follow this decision tree:

1. **Is there an existing mockup that already shows it?** → Use the mockup as-is.
2. **Is there an existing primitive that extends to the new case?** → Extend the primitive (e.g., add a status pill variant).
3. **Is the gap truly new?** → Add a new mockup following the 8 primitives + 3 principles. Update `DESIGN-SYSTEM.md` **first** if a new token is needed.

**Never:**
- Add a new brand color, hex value, or component shape.
- Use brand teal for status pills (info-blue for Scheduled, success for Completed, danger for Cancelled/No-show).
- Show patient PII on an admin surface.
- Add a delete action on appointments.

---

## 5 · Open questions (E7-S10)

These are gaps that emerged in Phase 4 that need engineering input before they can ship.

| # | Question | Where it surfaces | Owner |
|---|---|---|---|
| Q1 | Should the doctor's resolve-one flow (`24`) lock the appointment type when moving to an alternate slot? BR-058 says yes; mockup shows it but doesn't lock. | E6-S2 | TBD |
| Q2 | The "all resolved" screen (`37`) shows a sample audit-log row. Should we surface the full row (expandable) or keep it as a sample? | E6-S2 | TBD |
| Q3 | Admin's branch-hours resolution side (E6-S3) — what surface does the admin see after doctors have resolved the 5 flagged appointments? | E6-S3 | **RESOLVED 2026-09-15** — `39-admin-branch-hours-resolution.html` ships the 4-number hero (Moved/Cancelled/Deferred/Remaining), per-doctor + per-branch breakdowns, configuration-only audit log, and a privacy callout enforcing BR-065 counts-only. Wire route added to shell.js + standalone-router.js. |
| Q4 | Recurring preview (`07`) — when the patient backs out after seeing "9 of 12 created," do we cancel the 9 or leave them? Mockup implies leave. | E6-S1 | TBD |
| Q5 | Phone-as-identity form (`04`) — should we add a "country code" picker? Default is +966 (Saudi). | E3-S2, E3-S3 | TBD |
| Q6 | `38-admin-branch-deactivate.html` shows both states (success + danger) in one mockup. Production needs to pick one at render time. | E1-S1 (already done) — but the disabled-state wiring is the open question | TBD |

---

## 6 · File map for engineers

| What you need | Where it is |
|---|---|
| Color tokens | `docs/design/DESIGN-SYSTEM.md` §2 OR `imports/app/design-system.css` `:root` |
| Type scale | `docs/design/DESIGN-SYSTEM.md` §3 |
| Spacing | `docs/design/DESIGN-SYSTEM.md` §4 |
| Component patterns | `docs/design/mockups/v1/imports/app/components.html` |
| The 8 primitives | This doc §1 |
| Story → mockup map | This doc §2 |
| UX principles | This doc §3 |
| Open questions | This doc §5 |
| Stakeholder walkthrough | `docs/design/mockups/v1/imports/app/index.html` |

---

## 7 · Status

✅ **Phase 5 UX handoff complete.** Engineers can pick up any story from E1-S2 onwards using the matrix in §2.
