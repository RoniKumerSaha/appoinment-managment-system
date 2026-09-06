# Mockup v1 — UX Flow Mockups

Static HTML/CSS mockups for the Multi-Branch Clinic Appointment Scheduling System.

> **Reorganized 2026-09-06** to the canonical BMad structure: `mockups/` for promoted artifacts, `imports/` for user-supplied visuals / wiring, top-level docs. A BMad mirror lives at `_bmad-output/planning-artifacts/ux-designs/ux-appoinment-managment-system-2026-09-06/`.

## How to use

**For stakeholder walkthrough:** Open `imports/app/index.html` — a connected application shell that lets you click through every flow as if it were a real app. Role switcher jumps between Patient / Doctor / Receptionist / Admin / Landing.

**For stakeholder review:** Open `mocks.html` — a single scrollable page showing all 31 mockups as thumbnails, with filter + search + grid-size controls.

## Conventions

- **Color**: Clinical Calm teal — `#0f766e` (primary), `#f0fdfa` (light), `#99f6e4` (border)
- **Default layout**: Sidebar `1fr 320px` with summary; stacked `760px` center without
- **Stacked Vertical Flow is the default pattern** when there's no specific reason to deviate
- **ConflictModal** = 3-part pattern (what happened / why / what you can do)
- **Atomicity cue** = "Atomic: `<op>`" + "audit: `<event>`" inline

## Directory layout

```
docs/design/mockups/v1/
├── README.md                        ← you are here
├── mocks.html                       ← stakeholder overview (all 31 mockups as thumbnails)
├── CHOICES.md                       ← selection state (resume from here)
│
├── mockups/                         ← 31 selected mockups
│   ├── 01-layout-direction.html     ← A · Clinical Calm + Sidebar
│   ├── 02-doctor-picker.html        ← E · Card-First + Sidebar
│   ├── 03-availability-calendar.html ← E · Agenda Timeline
│   ├── 04-patient-confirm.html      ← E · Stacked Vertical Flow
│   ├── 05-patient-self-service.html ← E · Stacked Vertical Flow
│   ├── 06-resolve-affected.html     ← C · Kanban Queue
│   ├── 07-recurring-preview.html    ← E · Stacked Vertical Flow
│   ├── 08-branch-hours-impact.html  ← E · Stacked Vertical Flow
│   ├── 09-doctor-schedule.html      ← B · List by Day + Tabs
│   ├── 10-doctor-block-time.html    ← E · Stacked Vertical Flow
│   ├── 11-appointment-types.html    ← E · Stacked Vertical Flow
│   ├── 12-mark-status.html          ← D · Quick-Action Sidebar
│   ├── 13-recep-today.html          ← D · Card List by Hour
│   ├── 14-recep-create.html         ← A · Stepped Form
│   ├── 15-recep-cancel.html         ← E · Stacked Vertical Flow
│   ├── 16-recep-availability.html   ← E · Stacked Vertical Flow
│   ├── 17-admin-branches.html       ← E · Stacked Vertical Flow
│   ├── 18-admin-doctors.html        ← B · Card Grid
│   ├── 19-admin-receptionists.html  ← B · Card Grid
│   ├── 20-patient-reschedule.html   ← E · Stacked (F-05 reschedule)
│   ├── 21-patient-otp-modal.html    ← E · OTP modal (F-03)
│   ├── 22-patient-cancel-confirm.html ← E · Cancel modal (F-04)
│   ├── 23-recurring-confirm.html    ← E · Recurring confirm (F-11)
│   ├── 24-doctor-resolve-one.html   ← E · Resolve single (F-09 single)
│   ├── 25-doctor-cancel-reason.html ← E · Doctor cancel (F-10)
│   ├── 26-recep-checkin.html        ← D · Walk-in check-in (F-13 walk-in)
│   ├── 27-admin-audit-log.html      ← E · Admin audit log (F-20)
│   ├── 28-admin-branch-hours-editor.html ← E · Hours editor (F-17 editor)
│   ├── 29-conflict-modal.html       ← E · ConflictModal showcase
│   ├── 30-doctor-audit-drawer.html  ← E · Audit drawer (shared primitive)
│   └── 31-admin-doctors-reassign.html ← E · Doctor branch reassign (F-18 reassign)
│
└── imports/                         ← user-supplied supporting visuals / wiring
    ├── app/                         ← connected app shell
    │   ├── index.html               ← shell entry point
    │   ├── shell.css                ← topbar + responsive styles
    │   ├── shell.js                 ← hash router + 32 routes + cross-link interception
    │   ├── standalone-router.js     ← drop-in fallback so each mockup navigates standalone too
    │   ├── design-system.css        ← shared stylesheet (linked by every mockup)
    │   ├── design-system.html       ← design-system showcase page
    │   ├── components.html          ← components showcase page
    │   └── logo.svg                 ← Logo 03 · Monoline Icon (selected winner)
    │
    └── logos/
        └── selected-logo-monoline-icon.html  ← Logo 03 · Monoline Icon
```

## Connected app shell

Open `imports/app/index.html` for a clickable walk-through of every flow:

- Topbar shows current actor + breadcrumb (computed from the route table)
- Role switcher jumps to each actor's home route
- "Open in new tab" anchor opens the current iframe URL
- URL hash `#/path` is shareable (e.g. `#/doctor/today` opens the doctor's mark-status view)
- Cross-link cues (e.g. "Book another", "← Schedule editor", "+ New appointment") are intercepted and route between mockups
- The demo `.badge` corner tag is hidden inside the shell — re-shown when you open a mockup standalone

32 routes total: 1 landing + 1 design-system + 8 patient + 9 doctor + 5 receptionist + 8 admin.

**Standalone browsing:** every mockup loads `imports/app/standalone-router.js`, which mirrors the shell's `data-route` interception but navigates by changing `window.location` to the sibling file. So opening any file directly (e.g. `mockups/02-doctor-picker.html`) still lets you click through the same flow — without the topbar or breadcrumb.

## Parts

| # | Flow ID | Actor | Flow | Pick |
|---|---------|-------|------|------|
| 01 | — | — | Layout direction | A |
| 02 | F-02 | Patient | Doctor/Branch/Type picker | E |
| 03 | F-02/F-15 | Patient | Availability calendar | E |
| 04 | F-03 | Patient | Patient details + confirmation | E |
| 05 | F-04/F-05 | Patient | Self-service (OTP + my appts) | E |
| 06 | F-09 | Doctor/Patient | Resolve affected appointments | C |
| 07 | F-11 | Patient | Recurring series preview | E |
| 08 | F-17 | Admin/Doctor | Branch hours change affected | E |
| 09 | F-06 | Doctor | Schedule editor | B |
| 10 | F-07 | Doctor | Block dates / periods | E |
| 11 | F-08 | Doctor | Manage appointment types | E |
| 12 | F-10 | Doctor | Cancel / mark status | D |
| 13 | F-12 | Receptionist | Today's branch view | D |
| 14 | F-13 | Receptionist | Create appointment on behalf | A |
| 15 | F-14 | Receptionist | Cancel appointment | E |
| 16 | F-15 | Receptionist | View doctor availability | E |
| 17 | F-16 | Admin | Manage branches | E |
| 18 | F-18 | Admin | Manage doctors | B |
| 19 | F-19 | Admin | Manage receptionists | B |
| 20 | F-05 | Patient | Reschedule appointment | E |
| 21 | F-03 | Patient | OTP verification modal | E |
| 22 | F-04 | Patient | Cancel confirmation modal | E |
| 23 | F-11 | Doctor | Recurring confirm · 9 of 12 | E |
| 24 | F-09 | Doctor | Resolve one appointment | E |
| 25 | F-10 | Doctor | Cancel · reason + audit | E |
| 26 | F-13 | Recep | Walk-in patient check-in | D |
| 27 | F-20 | Admin | Activity & audit log | E |
| 28 | F-17 | Admin | Edit operating hours | E |
| 29 | UX | All | ConflictModal · 4 variants | E |
| 30 | UX | Doctor | Audit log drawer | E |
| 31 | F-18 | Admin | Reassign branches | E |

## Logo

| # | Pick | File |
|---|------|------|
| Logo | **03 · Monoline Icon** | `imports/logos/selected-logo-monoline-icon.html` · SVG mirror at `imports/app/logo.svg` |

## BMad mirror

The same workspace is mirrored to `_bmad-output/planning-artifacts/ux-designs/ux-appoinment-managment-system-2026-09-06/`. The mirror holds the BMad-specific artifacts: `DESIGN.md`, `EXPERIENCE.md`, `.memlog.md`. Source-of-truth remains here under `docs/`.

## Resume protocol

All 31 parts + logo complete. 🎉 See `CHOICES.md` for the final pattern picks + pattern tally. App shell at `imports/app/index.html` ties everything together for stakeholder demos.

**Recent additions (12 new mockups, 2026-09):** parts 20-22 (patient reschedule/OTP/cancel modal), 23-25 (recurring confirm/resolve-one/cancel-reason), 26 (walk-in check-in), 27-28 (admin audit + hours editor), 29 (universal ConflictModal showcase), 30 (audit drawer), 31 (doctor branch reassign). Wireframe pages linked into `imports/app/shell.js` and `imports/app/standalone-router.js`.
