# MediSlot UX Workspace

BMad ux-designs workspace for the MediSlot project. Mirrors the human-authored source under `docs/design/` into the canonical BMad workspace shape.

## Layout

```
ux-appoinment-managment-system-2026-09-06/
├── README.md                          ← you are here
├── DESIGN.md                          ← visual spine (tokens, colors, typography, components-as-rendered)
├── EXPERIENCE.md                      ← behavioral spine (IA, voice, states, interactions, accessibility, journeys)
├── .memlog.md                         ← canonical decision log (append-only via memlog.py)
├── .working/                          ← scratch artifacts (creative-tool outputs, in-progress)
│
├── mockups/                           ← 31 selected mockup HTML files (winners)
│   ├── 01-layout-direction.html
│   ├── 02-doctor-picker.html
│   ├── 03-availability-calendar.html
│   ├── 04-patient-confirm.html
│   ├── 05-patient-self-service.html
│   ├── 06-resolve-affected.html
│   ├── 07-recurring-preview.html
│   ├── 08-branch-hours-impact.html
│   ├── 09-doctor-schedule.html
│   ├── 10-doctor-block-time.html
│   ├── 11-appointment-types.html
│   ├── 12-mark-status.html
│   ├── 13-recep-today.html
│   ├── 14-recep-create.html
│   ├── 15-recep-cancel.html
│   ├── 16-recep-availability.html
│   ├── 17-admin-branches.html
│   ├── 18-admin-doctors.html
│   ├── 19-admin-receptionists.html
│   ├── 20-patient-reschedule.html
│   ├── 21-patient-otp-modal.html
│   ├── 22-patient-cancel-confirm.html
│   ├── 23-recurring-confirm.html
│   ├── 24-doctor-resolve-one.html
│   ├── 25-doctor-cancel-reason.html
│   ├── 26-recep-checkin.html
│   ├── 27-admin-audit-log.html
│   ├── 28-admin-branch-hours-editor.html
│   ├── 29-conflict-modal.html
│   ├── 30-doctor-audit-drawer.html
│   └── 31-admin-doctors-reassign.html
│
├── imports/                           ← user-supplied supporting visuals / wiring
│   ├── app/                           ← connected app shell (index, shell.js, shell.css, standalone-router.js, logo.svg)
│   ├── logos/                         ← selected logo variants
│   └── mocks.html                     ← stakeholder overview (31 thumbnails + filter + search)
│
└── CHOICES.md                         ← selection state — pattern tally + deviation rationale
```

## Source-of-truth map

| This workspace | BMad source | Human source |
|---|---|---|
| `DESIGN.md` (tokens + components + rules) | this file | `docs/design/DESIGN-SYSTEM.md` |
| `EXPERIENCE.md` (IA + voice + states + flows) | this file | `docs/specs/UX-FLOWS.md` + `docs/design/user-flows/*.md` |
| `mockups/*.html` (31 selected winners) | mirror | `docs/design/mockups/v1/winners/*.html` |
| `imports/app/` (connected shell) | mirror | `docs/design/mockups/v1/app/` |
| `imports/logos/` (selected logos) | mirror | `docs/design/mockups/v1/logos/` |
| `imports/mocks.html` (overview) | mirror | `docs/design/mockups/v1/mocks.html` |
| `CHOICES.md` (selection state) | mirror | `docs/design/mockups/v1/CHOICES.md` |

## Status

**Draft.** Spine content is structure + sourced pointers. Full spine distillation requires a real Discovery → Finalize run via `/bmad-ux` (Update mode) — that captures decisions into `.memlog.md` rather than re-deriving from existing mockups.

## How to view

- **For stakeholder walkthrough:** open `imports/app/index.html` — the connected shell routes between all 31 winners.
- **For stakeholder review:** open `imports/mocks.html` — 31 thumbnails + filter + search.
- **For individual screen:** open any `mockups/NN-*.html` standalone (each loads `imports/app/standalone-router.js` for sibling navigation).

## Resume protocol

Decisions live in `.memlog.md`. The `/bmad-ux` skill in **Update** mode reads it first; do not hand-edit it. Use:

```bash
uv run _bmad/scripts/memlog.py append \
  --workspace _bmad-output/planning-artifacts/ux-designs/ux-appoinment-managment-system-2026-09-06 \
  --type <decision|change|override|assumption|event> \
  --text "..."
```
