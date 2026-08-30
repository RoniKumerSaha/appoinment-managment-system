# Changelog

All notable changes to the **Multi-Branch Clinic Appointment Scheduling System** project. Maintained retroactively from the initial commit.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a release process is established.

> **Status legend:** 🚀 shipped · 📝 documented · 🎨 designed · 🔧 tooling · � fix · ⚠ breaking

---

## [Unreleased]

### 🎨 Design system document — 2026-08-30
- **DESIGN-SYSTEM.md** introduced under `docs/`. Single source of truth for visual language: brand & personality, color tokens (brand / surface / text / semantic), typography scale (10–36px), spacing scale (4–32px), border radii, elevation, 13 components (Button × 4 variants, StatusPill, Card, Section, Field, Modal/ConflictModal, Toast, EmptyState, AppointmentCard, AuditLogDrawer, MetaCell, SegmentedControl, StepNumber), 5 layout patterns, iconography, voice & tone rules per role, accessibility (WCAG 2.1 AA contrast pairs), and canonical demo-data table.
- Every token sourced from existing 19 winners — not aspirational. Values are exact hex / px, not ranges.
- `docs/PROJECT-TREE.md` updated to reference `DESIGN-SYSTEM.md` in the `docs/` map and in the contributor reading order.
- Companion live HTML remains `docs/mockups/v1/app/components.html` — this document is the *why*, the HTML is the *what*.

### 🚀 UX consistency pass — 2026-08-30
- **Persona drift fixes** across patient-facing mockups: replaced `Ahmed M. Al-Falasi` / `+971 50 123 4567` (UAE) with `Fatima A. Al-Sayed` / `+966 5XX XXX 5555` (Saudi) in `04-patient-confirm.html`, `05-patient-self-service.html`, and `07-recurring-preview.html`.
- **Admin name** on `08-branch-hours-impact.html` corrected from `Nadia K.` to `Salem Al-Mutairi` to match the admin persona.
- **Doctor name** on `18-admin-doctors.html` corrected from `Dr. Abdullah Al-Rashid` to `Dr. Ahmed Al-Rashid` to match all other screens.
- **Removed fabricated feature** in `15-recep-cancel.html` — bullet "Send SMS + email cancellation to patient" was not in BRD/PRD/UX-FLOWS.
- **Reschedule success state** added to `05-patient-self-service.html` — inline banner "Your appointment has been moved to Sat, Aug 23, 11:15."
- **Shared component library** introduced at `docs/mockups/v1/app/components.html` with templates for `ConflictModal`, `Toast`, `StatusPill`, `AppointmentCard`, `EmptyState`, `AuditLogDrawer`.
- **Persona flows** added under `docs/user-flows/` — one scenario per role (Fatima / Dr. Ahmed / Reem / Salem) plus a `ux-consistency-report.md` ranking all gaps by severity.

### 🎨 Interactive mockup wiring — 2026-08-30
- **Cross-screen navigation** wired across all 19 winners via `data-route` attributes (106 routes total). Every clickable cue — Book, ← Back, Save, Cancel, Edit — now navigates between mockups.
- **Standalone fallback** added via `app/standalone-router.js`. Opening any winner file directly also navigates between siblings, without the shell.
- **Shell router** verified: all 19 wired routes map to valid entries in the `ROUTES` table in `app/shell.js`.
- **Misroute fixed** in `12-mark-status.html`: doctor's "Confirm cancel + release slot" was pointing at `/recep/today` — now correctly points at `/doctor/today`.

### 📝 Mockup cleanup — 2026-08-30
- Reduced `docs/mockups/v1/` from a flat dump of every design option to a curated set of 19 winners + 1 logo. See `docs/mockups/v1/CHOICES.md` for the rationale.
- Folder structure reorganized: `app/` (shell), `winners/` (19 selected screens), `logos/` (1 selected logo), `mocks.html` (overview grid), `README.md` (entry point), `CHOICES.md` (decision trail).

### 📝 Logo selection — 2026-08-30
- Logo 03 · Monoline Icon selected. Saved at `docs/mockups/v1/logos/selected-logo-monoline-icon.html` and mirrored to `docs/mockups/v1/app/logo.svg` for shell use.

---

## [0.1.0] — 2026-08-18

### � Initial scaffolding
- **BRD** (`docs/BRD.md`) — business requirements, role capability matrix, business rules (BR-001…063).
- **PRD** (`docs/PRD.md`) — product requirements, 51 functional requirements (FR-001…051), 10 non-functional requirements, recommended data model, availability algorithm, booking/rescheduling/recurring transactions, 15 critical-scenario acceptance criteria, MVP scope.
- **UX-FLOWS** (`docs/UX-FLOWS.md`) — 19 system flows (F-01 through F-19) traced to BRD and PRD. Shared UI primitives inventory. Cross-cutting concerns (ConflictModal pattern, atomicity discipline, audit visibility, time-zone handling, no-buffer / fixed-window / no-same-day rules). Open questions for design.
- **Mockup v1** (`docs/mockups/`) — initial dump of layout options, logo options, and per-flow screen explorations.

### 🔧 Tooling
- **Git ignore** configured (`.env`, `node_modules`, `.next`, `.puku` cache).
- **BMAD Method installed** (`.bmad/`) — agent definitions, scripts, custom configuration.

---

## Commit history (chronological)

| Commit | Date | Subject |
|---|---|---|
| `37ea99f` | 2026-08-18 | Initial commit |
| `4a87365` | 2026-08-18 | git ignore and BRD, PRD added |
| `6a36684` | 2026-08-18 | mock up option selected |
| `25db564` | 2026-08-18 | mockup updated |
| `8a860f0` | 2026-08-18 | picked a name for application |
| `3b02857` | 2026-08-30 | Logo selected |
| `ce014e9` | 2026-08-30 | bmad skill |
| `d5f1ebf` | 2026-08-30 | update mockup |
| `ccfc2bb` | 2026-08-30 | Wire data-route across 19 mockups + standalone fallback |
| `55b2743` | 2026-08-30 | UX consistency pass: persona fixes + shared component library |

---

## How to use this changelog

- **Reading the latest entry** tells you what's in the working tree right now.
- **Looking up a previous state** — read the commit hash in the table; `git show <hash>` reconstructs it.
- **Adding a new entry** — write the next `[Unreleased]` block at the top under the existing one, group by the section headings (`Added`, `Changed`, `Fixed`, `Removed`), and don't bump versions until release time.

---

## Conventions

- One entry per commit is fine for this stage of the project. When the release cadence is set, group multiple commits into a dated release section.
- Each bullet states the **what** and the **why** tersely. Long discussion lives in the linked documents (`PRD`, `UX-FLOWS`, `CHOICES`, `user-flows/ux-consistency-report`).
- File paths are relative to the project root so the document is portable across branches and forks.