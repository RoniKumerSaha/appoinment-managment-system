# Project Tree

A guided map of the **Multi-Branch Clinic Appointment Scheduling System** repository. Every tracked file, grouped by purpose, with one-line descriptions.

> **How to read this:** start at the top and follow the bullets. Each section says what the files are for and which skill / role owns them. If a file doesn't fit any section here, ask whether it should exist at all.

---

## Project root

```
.
├── .env                  # local secrets (git-ignored)
├── .git/                 # git history
├── .gitattributes        # line-ending rules (LF/CRLF normalization)
├── .gitignore            # local + node + .next + .puku exclusions
├── .claude/              # Claude / puku-cli agent state
├── .puku/                # puku-cli session + agent cache
├── _bmad/                # BMAD Method installation (agents, scripts, config)
├── docs/                 # All design + requirements artifacts (see below)
├── node_modules/         # npm dependencies (git-ignored)
└── .next/                # Next.js build output (git-ignored)
```

---

## `docs/` — Requirements + design + mockups

The single source of truth for what the product is and what it should look like. Code does not yet exist; this is design-only.

The `docs/` tree is split into three topical subfolders so each one has a single owner and a single rule of "what goes here". Anything that doesn't clearly belong to `specs/`, `design/`, or `meta/` is a smell — don't add it without asking.

```
docs/
├── specs/                # WHAT we are building & WHY.
│   │                     # Source of truth for rules, scope, contracts.
│   │                     # Owner: PM.   Reviewers: UX, Eng.
│   │
│   ├── BRD.md            # Business Requirements Document
│   │                     # Role capability matrix, business rules
│   │                     # (BR-001…063), MVP scope boundary, acceptance
│   │                     # scenarios.
│   │
│   ├── PRD.md            # Product Requirements Document
│   │                     # 51 functional requirements (FR-001…051),
│   │                     # 10 non-functional requirements, recommended
│   │                     # data model, availability algorithm, transaction
│   │                     # specifications, 15 critical-scenario tests.
│   │
│   └── UX-FLOWS.md       # System flows (F-01 through F-19)
│                         # 19 flows traced to BRD + PRD. Shared UI
│                         # primitive inventory. Cross-cutting concerns
│                         # (ConflictModal, atomicity discipline, audit
│                         # visibility). Open design questions.
│
├── design/               # HOW it looks & how it feels.
│   │                     # Source of truth for visual language and
│   │                     # personas.   Owner: UX.   Reviewers: PM, Eng.
│   │
│   ├── DESIGN-SYSTEM.md  # Visual language, components, voice & tone.
│   │                     # Color tokens, typography scale, spacing,
│   │                     # 13 components (Button, Pill, Card, Modal,
│   │                     # Toast, AuditLogDrawer, etc.), 5 layout
│   │                     # patterns, WCAG AA contrast notes.
│   │
│   ├── user-flows/       # Persona-driven journey flows.
│   │   ├── README.md
│   │   ├── patient.md    # Fatima — first booking on the bus,
│   │   │                 # reschedule, cancel in a panic.
│   │   ├── doctor.md     # Dr. Ahmed Al-Rashid — confirm schedule,
│   │   │                 # block conference, see patients, mark
│   │   │                 # outcomes, resolve flagged on iPad.
│   │   ├── receptionist.md   # Reem — front desk at Riyadh Olaya.
│   │   │                     # Open the day, walk-in, phone-cancel,
│   │   │                     # mark no-show, book next-week.
│   │   ├── admin.md      # Salem — operations manager. Onboard a
│   │   │                 # doctor, narrow branch hours, handle the
│   │   │                 # edge case where the doctor no longer
│   │   │                 # works the affected branch, deactivate an
│   │   │                 # empty branch.
│   │   └── ux-consistency-report.md
│   │                     # Audit of persona ↔ mockup ↔ system flow
│   │                     # consistency. 10 ranked blocker / high fixes.
│   │
│   └── mockups/
        └── v1/           # First design generation.
            │
            ├── README.md # Mockup entry point. Color, layout, and
            │             # pattern conventions. Folder map. Parts table.
            │
            ├── CHOICES.md    # Selection rationale: which 19 mockups +
            │                 # which 1 logo were chosen from all options.
            │
            ├── mocks.html    # Single-page overview of all 19 winners as
            │                 # thumbnails. Filter + search + grid-size
            │                 # controls. For stakeholder review.
            │
            ├── app/      # Connected app walkthrough.
            │   ├── index.html        # Shell entry. iframe + topbar +
            │   │                     # role switcher + breadcrumb +
            │   │                     # "open in new tab".
            │   ├── shell.css         # Topbar + responsive styles.
            │   ├── shell.js          # Hash router, 20 routes,
            │   │                     # capture-phase data-route injection
            │   │                     # into iframe.
            │   ├── standalone-router.js
            │   │                     # Drop-in fallback for browsing
            │   │                     # winners directly. Mirrors
            │   │                     # data-route → window navigation.
            │   │                     # Injects into every winner.
            │   ├── components.html   # Shared UI primitives —
            │   │                     # ConflictModal, Toast, StatusPill,
            │   │                     # AppointmentCard, EmptyState,
            │   │                     # AuditLogDrawer templates.
            │   │                     # Source-of-truth for upcoming
            │   │                     # wire-ins.
            │   └── logo.svg          # Logo 03 · Monoline Icon. Mirror
            │                         # of the selected logo, used by
            │                         # the shell.
            │
            ├── winners/  # 19 selected mockup screens. Each file is a
            │   │         # standalone HTML page.
            │   │
            │   ├── 01-layout-direction.html       # A · Clinical Calm + Sidebar
            │   ├── 02-doctor-picker.html          # E · Card-First + Sidebar
            │   ├── 03-availability-calendar.html  # E · Agenda Timeline
            │   ├── 04-patient-confirm.html        # E · Stacked Vertical Flow
            │   ├── 05-patient-self-service.html   # E · Stacked Vertical Flow
            │   ├── 06-resolve-affected.html       # C · Kanban Queue
            │   ├── 07-recurring-preview.html      # E · Stacked Vertical Flow
            │   ├── 08-branch-hours-impact.html    # E · Stacked Vertical Flow
            │   ├── 09-doctor-schedule.html        # B · List by Day + Tabs
            │   ├── 10-doctor-block-time.html      # E · Stacked Vertical Flow
            │   ├── 11-appointment-types.html      # E · Stacked Vertical Flow
            │   ├── 12-mark-status.html            # D · Quick-Action Sidebar
            │   ├── 13-recep-today.html            # D · Card List by Hour
            │   ├── 14-recep-create.html           # A · Stepped Form
            │   ├── 15-recep-cancel.html           # E · Stacked Vertical Flow
            │   ├── 16-recep-availability.html     # E · Stacked Vertical Flow
            │   ├── 17-admin-branches.html         # E · Stacked Vertical Flow
            │   ├── 18-admin-doctors.html          # B · Card Grid
            │   └── 19-admin-receptionists.html    # B · Card Grid
            │
            └── logos/
                └── selected-logo-monoline-icon.html
                                          # The one chosen logo (10 options
                                          # were considered; see CHOICES.md).
│
└── meta/                 # Repo hygiene — what's changing, where things live.
    │                     # Owner: anyone.   Reviewers: none (low-stakes).
    │
    ├── CHANGELOG.md      # Running log of every change since initial
    │                     # commit. Grouped by date, ordered newest first.
    │
    └── PROJECT-TREE.md   # This document.
```

---

## `_bmad/` — BMAD Method installation

The BMad Method's agent definitions, scripts, and project-local configuration. Used to drive multi-agent workflows (PM, UX Designer, etc.) via slash-commands in puku-cli.

```
_bmad/
├── config.toml           # Global BMAD config
├── config.user.toml      # Per-user overrides
│
├── _config/              # Built-in agent definitions
├── core/                 # Core utilities
├── render/               # Doc rendering helpers
├── scripts/              # resolve_customization.py + others
│
├── bmm/                  # BMad Method Module (the workflow layer)
│   ├── config.yaml       # Module config (user_name, project_name,
│   │                     # communication_language, planning_artifacts, etc.)
│   ├── module-help.csv   # Skill index
│   └── v6-shims/         # Backward-compatibility shims
│
└── custom/               # Per-project overrides
    ├── config.toml       # Team config
    ├── config.user.toml  # Personal config
    └── .gitignore
```

---

## Reading order for new contributors

1. `docs/specs/PRD.md` — what we're building.
2. `docs/specs/UX-FLOWS.md` — how each flow is supposed to work.
3. `docs/design/user-flows/` — what it feels like for each person.
4. `docs/design/mockups/v1/README.md` — what it looks like.
5. `docs/design/mockups/v1/winners/` — each screen.
6. `docs/design/mockups/v1/app/index.html` — open this to walk through it.
7. `docs/design/DESIGN-SYSTEM.md` — visual tokens & components (reference when building).
8. `docs/meta/CHANGELOG.md` — what's new.

---

## What is **not** in this repo (yet)

- **Source code.** No backend, no frontend framework, no DB schema migrations. The repo is design-only at this stage.
- **Tests.** Test plans exist as acceptance scenarios in `specs/PRD.md` §15 and `specs/UX-FLOWS.md`, but no test runner or test files.
- **CI / deployment configs.** Once code lands, expect `package.json`, Dockerfile, CI workflow, and infra manifests to appear at the project root.
- **`.env` contents.** The file exists for local development but is git-ignored. Sample values can go in `.env.example` once needed.